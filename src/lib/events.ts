/* ------------------------------------------------------------------ *
 * The event model, recurrence expansion and lane packing.
 *
 * Instants are stored as epoch milliseconds. ISO strings would need parsing
 * rules the moment a user crosses a DST boundary; a number plus the browser's
 * local calendar is unambiguous and JSON-safe.
 * ------------------------------------------------------------------ */

import { fuzzyScore } from "./fuzzy";
import { MINUTES_PER_DAY, addDays, daysBetween, minutesOfDay, startOfDay } from "./time";
import { instantKey, startsBetweenIn, type Recurrence, type Repeat } from "./recur";

export {
  FREQUENCIES,
  NEVER,
  REPEATS,
  REPEAT_LABELS,
  instantKey,
  keyToInstant,
  readRecurrence,
  recurrenceOf,
  repeatUnit,
  repeats,
  splitRule,
  type Recurrence,
  type Repeat,
  type SeriesSplit,
  type WeekdayRule,
} from "./recur";

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /**
   * The calendar's mark: a Phosphor icon name (`"barbell"`), a literal emoji
   * (`"🏋️"`), or `""` for the plain colour dot. Which of the two it is comes
   * from its own alphabet — see `isIconName` in `ui/icons.tsx`, the only
   * place that reads this — so a backup stores the value as itself.
   *
   * Only calendars carry one. Colour is what identifies an *event*, and it
   * can be overridden per event; a mark says which calendar an event is on,
   * which is a property of the calendar and not of the day.
   */
  icon: string;
  /**
   * Set when this calendar mirrors a remote ICS feed. Its events are pulled
   * whole on refresh and live in `Snapshot.feeds`, not `Snapshot.events` —
   * they are somebody else's data, so they are never edited and never
   * exported as yours.
   */
  feed?: Feed;
}

/**
 * Longest an **emoji** mark may be, in UTF-16 units. A family with four
 * members and three zero-width joiners is 11 and a flag with a skin-tone
 * modifier gets near it; past that it is a paste rather than a glyph.
 *
 * This used to cap *both* vocabularies and that was a data-loss bug, which is
 * why the two now have a number each. A mark is an emoji or a Phosphor name
 * (`isIconName` below is the whole discriminator), and the two have nothing in
 * common about length: one grapheme against a word list whose longest entry is
 * `currency-circle-dollar` at 22. One cap sized for the first silently
 * truncated ten of the 247 names in `marks.ts` into strings that match no path
 * and draw as the plain colour dot — and `person-simple-run` is one of the
 * five `SEED_MARKS`, so a brand-new install corrupted its own seed data the
 * first time a backup round-tripped it.
 */
export const ICON_MAX = 16;

/**
 * Longest a **Phosphor name** may be. Deliberately roomy rather than fitted:
 * the longest name this build ships is 22, and a cap set to 22 would have to
 * move every time an icon is added — which is exactly the maintenance nobody
 * did to the old one. The guard's job here is to refuse a paste, not to know
 * the table, so it sits at about twice the longest real name and never needs
 * touching. `readMark` is the only reader.
 */
export const ICON_NAME_MAX = 48;

/**
 * Which of the two vocabularies a mark is written in. A Phosphor name is
 * lowercase ASCII and hyphens; an emoji never is. That is the whole
 * discriminator, which is why the field needs no prefix and a stored backup
 * reads as itself.
 */
export function isIconName(icon: string): boolean {
  return /^[a-z0-9-]+$/.test(icon);
}

/**
 * The first grapheme of whatever was typed or pasted, for the emoji field.
 * `Intl.Segmenter` is what keeps a flag, a skin tone or a zero-width-joined
 * family one character rather than the two or seven code points it is made
 * of; the spread is the fallback, and it at least keeps surrogate pairs whole.
 */
export function firstGrapheme(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (typeof Intl.Segmenter === "function") {
    const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    return first ? first.segment.slice(0, ICON_MAX) : "";
  }
  return [...text][0]?.slice(0, ICON_MAX) ?? "";
}

/**
 * The one validator for a stored mark, whatever it arrived in — a `.json`
 * backup, a calendar record, an assistant's write. `readRecurrence` and
 * `readRemindLead`'s shape: one place that decides what the field legally is,
 * so its readers cannot form separate opinions about it.
 *
 * A vocabulary each, because the two fail differently and only one of them can
 * be shortened at all:
 *
 * - A **name** is kept whole or dropped. It is never sliced, and that is the
 *   whole fix: slicing a name manufactures an invalid value out of a valid one
 *   — `person-simple-run` became `person-simple-ru`, which matches no path in
 *   `marks.ts` and draws as the plain colour dot with nothing raised anywhere.
 *   Dropping an over-long one lands on that same dot, but *honestly*: `""` is
 *   already what an unknown name renders as, so a paste that happens to be
 *   lowercase reads as "no mark" rather than as a mark this build has broken.
 * - An **emoji** is truncated, because for that vocabulary truncation is
 *   meaningful: one grapheme is exactly what the field holds, and
 *   `firstGrapheme` is what keeps a flag or a ZWJ family whole while doing it.
 *
 * A name shorter than the cap is returned untouched even when this build
 * carries no path for it — a set that shrinks, or a backup that has been
 * through a newer build, must not come back with the mark missing.
 */
export function readMark(value: unknown): string {
  if (typeof value !== "string") return "";
  const mark = value.trim();
  if (mark === "") return "";
  if (isIconName(mark)) return mark.length <= ICON_NAME_MAX ? mark : "";
  return firstGrapheme(mark);
}

/**
 * The three states of `CalEvent.remindLead`, which is an *override* of
 * `settings.remindLead` in exactly the sense `CalEvent.color` overrides its
 * calendar's: the default is to name nothing and follow the setting, so
 * changing the setting still moves every event that never asked for its own.
 *
 * Here rather than in `remind.ts` for the reason `ICON_MAX` and `isIconName`
 * are here: this file owns what a `CalEvent` field legally *is*, and the
 * layer that fires reminders owns what one is *for*. Reading a `VALARM` is a
 * question about the field, and `ics.ts` sits below `remind.ts` in this
 * directory's one-way dependency order — putting the vocabulary up there
 * would have made the exporter import upwards, or spell the three states
 * itself.
 *
 * They are negative because a lead is minutes *before* a start and can only
 * be counted one way — which leaves the whole negative half-line free for
 * saying something other than a number of minutes, and leaves `0` meaning
 * what it has always meant here: "tell me as it starts". A scheme where `0`
 * doubled as off or as absent would make the one lead time this app was
 * built around unsayable.
 *
 * Silent is not a convenience. Per-event control exists so a recurring thing
 * you already know about can be told to stop nudging you, and without a
 * third state the only way to silence one event is to turn reminders off for
 * every event.
 */
export const REMIND_INHERIT = -1;
export const REMIND_SILENT = -2;

/**
 * The longest lead this app will store, in minutes — four weeks, which is the
 * longest any mainstream calendar UI offers. It bounds nothing the editor can
 * write (that Select offers `REMIND_LEADS`); it bounds what an imported
 * `VALARM` and a hand-edited backup may say, so a `TRIGGER` of `-P400D`
 * cannot make `dueReminders` scan a day four hundred days out every minute.
 */
export const REMIND_LEAD_MAX = 40_320;

/**
 * The lead this event names *for itself*, or `null` when it names none —
 * inheriting and silent are both "no number of its own".
 *
 * The exporter's question rather than the notifier's: an `.ics` may carry a
 * `VALARM` only for an event that named a lead, because materialising the
 * current setting into the file would turn a preference into data that comes
 * back as an override on the next import.
 */
export function ownLead(event: Pick<CalEvent, "remindLead">): number | null {
  return event.remindLead >= 0 ? event.remindLead : null;
}

/**
 * A stored or imported value read as a lead. Unreadable is `REMIND_INHERIT`,
 * which is what every event written before this field existed already was.
 *
 * One validator, four readers, for the reason `readRecurrence` is one:
 * `backup.readEvent` (untrusted JSON), `store.hydrateEvents` (a blob that
 * predates the field), `ics.ts`'s `VALARM` reader (a `TRIGGER` off somebody
 * else's feed) and the editor's own Select all have to agree about what a
 * legal lead is, and a copy of the bounds in each would be four opinions.
 * Whole minutes only — a `VALARM` of ninety seconds is not a lead this app
 * can count down in, and rounding it would be a guess.
 */
export function readRemindLead(value: unknown): number {
  if (value === REMIND_SILENT) return REMIND_SILENT;
  if (typeof value !== "number" || !Number.isInteger(value)) return REMIND_INHERIT;
  if (value < 0 || value > REMIND_LEAD_MAX) return REMIND_INHERIT;
  return value;
}

/* --------------------------------- guests --------------------------------- */

/**
 * The four replies circal is willing to print, in `PARTSTAT`'s own vocabulary
 * (RFC 5545 §3.2.12) minus the one it would have to lie about.
 *
 * `DELEGATED` is the omission, and it is not laziness. It says "I have handed
 * this to somebody else", which is neither yes nor no: printing `Declined`
 * claims a refusal the person never made, and `Accepted` claims they will be
 * there. The delegate arrives as an ATTENDEE line of its own carrying its own
 * `PARTSTAT`, so the fact that somebody *is* coming is already on the list —
 * what is left unsayable is only the relationship between the two, and circal
 * has no row for it. So a `PARTSTAT` this app does not model reads as
 * `needs-action`, which is also what an absent one means per the RFC: the
 * weakest of the four claims, and the only one that says nothing about intent.
 * Hence the label — `Invited` rather than `No reply`, because "invited" is
 * true of a delegation and of a silent guest alike, where "has not replied"
 * is a claim about the person and would be false for the first.
 *
 * `ROLE` and `RSVP` are read by nothing on purpose. `ROLE` splits required
 * from optional, which changes nothing this surface says and nothing the
 * arithmetic does — the organiser is the only person here who has a different
 * job, and it has its own field. `RSVP=TRUE` is the sender asking for an
 * answer, and circal has no channel to give one: printing the request would
 * put a demand on screen next to no way to meet it, which is exactly the
 * actionable look this whole feature refuses.
 */
export const PARTSTATS = ["needs-action", "accepted", "declined", "tentative"] as const;

export type Partstat = (typeof PARTSTATS)[number];

/** What each reply is called on screen. Here beside the vocabulary rather than
 *  in the editor for the reason `REPEAT_LABELS` is beside `REPEATS`: the word
 *  and the value are one decision, and a second surface printing its own
 *  synonyms is two apps. */
export const PARTSTAT_LABELS: Record<Partstat, string> = {
  "needs-action": "Invited",
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
};

/**
 * One `CAL-ADDRESS` as circal keeps it: what to call them, and where the
 * invitation went. `address` is the mailbox with the `mailto:` scheme taken
 * off — every mainstream producer writes one and it is noise on screen — and
 * any other URI scheme verbatim, because a `CAL-ADDRESS` is not required to be
 * mail and rewriting one would be inventing an address.
 *
 * `name` is `CN` and is legitimately empty: plenty of senders write the
 * mailbox and nothing else, and the surface falls back to the address rather
 * than printing a blank row.
 */
export interface Person {
  name: string;
  address: string;
}

/** A `Person` plus their answer. Nothing else off the line survives — see
 *  `PARTSTATS` for why `ROLE` and `RSVP` are dropped. */
export interface Attendee extends Person {
  status: Partstat;
}

/**
 * How many attendees one event may keep.
 *
 * An attendee list is the only field on this model that arrives from a
 * stranger and has no natural length: a mailing-list invitation carries
 * thousands of ATTENDEE lines, and `localStorage` is one ~5MB quota shared by
 * the whole origin — the same quota `FEED_BUDGET` already carves 2M characters
 * out of for subscriptions. That budget bounds a feed in *total* by dropping
 * whole events; it cannot see a single event that is itself megabytes of
 * addresses, which is what this bounds.
 *
 * 32 because it is above every guest list a person actually reads down — a
 * room, a standup, a class — and below the size where a list stops being names
 * and starts being a distribution list, which is announced rather than
 * answered. Losing the rest costs nothing the reader was going to read, and it
 * is not lost silently: `attendeeCount` keeps the real total so the surface can
 * say how many it is not showing.
 */
export const ATTENDEE_MAX = 32;

/** Longest `CN` kept. Longer than any human name with a team in brackets after
 *  it, and far longer than the 320px column can print — so this bounds a
 *  pasted paragraph in a display name, nothing a sender meant. */
export const GUEST_NAME_MAX = 64;

/** Longest address kept — RFC 5321 §4.5.3.1.3's own ceiling for a forward
 *  path, which makes it derived rather than chosen: nothing longer can be a
 *  mailbox, so nothing longer is an address being truncated. */
export const GUEST_ADDRESS_MAX = 254;

/**
 * Ceiling on the *printed* total. `attendeeCount` is only ever a number in a
 * sentence, so a hand-edited blob claiming a billion guests costs nothing but
 * a line nobody can read; past four digits the honest statement is already
 * "this went to a mailing list" and the exact figure has stopped being a fact
 * about a meeting.
 */
const ATTENDEE_COUNT_MAX = 9999;

function readText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A stored or imported reply, read as one of the four. Anything else — a
 * `DELEGATED`, a value no standard has, an absent property — is `needs-action`
 * for the reason `PARTSTATS` gives.
 */
export function readPartstat(value: unknown): Partstat {
  if (typeof value !== "string") return "needs-action";
  const lower = value.trim().toLowerCase();
  return (PARTSTATS as readonly string[]).includes(lower) ? (lower as Partstat) : "needs-action";
}

/**
 * One person, or `null` when there is nobody there. An address is the whole
 * requirement: a `CAL-ADDRESS` property with no value is a malformed line, and
 * a name with no mailbox behind it is a row the surface cannot explain.
 */
export function readPerson(value: unknown): Person | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const address = readText(record.address, GUEST_ADDRESS_MAX);
  if (!address) return null;
  return { name: readText(record.name, GUEST_NAME_MAX), address };
}

/**
 * The guest list and the number of people it stands for.
 *
 * One validator, three readers, for the reason `readRemindLead` is one:
 * `ics.ts` (ATTENDEE lines off somebody else's file), `backup.readEvent`
 * (untrusted JSON) and `store.hydrateEvents` (a blob that predates the field)
 * all have to agree about what a legal guest list is, and three copies of the
 * caps would be three opinions about when a calendar is too big to keep.
 *
 * Two rules beyond the caps. Duplicates are collapsed on the address, because
 * a merged reply legitimately restates a line and one person twice is a list
 * lying about its own size. And `attendeeCount` is never allowed to be smaller
 * than the list it labels — the count exists to say what the cap dropped, so a
 * hand-edited blob understating it must not be able to print "and -3 others".
 */
export function readGuests(
  list: unknown,
  count: unknown,
): { attendees: Attendee[]; attendeeCount: number } {
  const seen = new Set<string>();
  const people: Attendee[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      const person = readPerson(entry);
      if (!person) continue;
      const key = person.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({
        ...person,
        status: readPartstat((entry as Record<string, unknown>).status),
      });
    }
  }
  const attendees = people.slice(0, ATTENDEE_MAX);
  const claimed =
    typeof count === "number" && Number.isInteger(count) && count > 0 ? count : people.length;
  return {
    attendees,
    attendeeCount: Math.min(Math.max(claimed, people.length), ATTENDEE_COUNT_MAX),
  };
}

export interface Feed {
  url: string;
  /** Epoch ms of the last successful pull. `0` = never pulled. */
  fetchedAt: number;
  /** Why the last pull failed. `""` when it did not. */
  error: string;
}

export interface CalEvent extends Recurrence {
  id: string;
  title: string;
  calendarId: string;
  /** Epoch ms. For an all-day event this is local midnight of the first day. */
  start: number;
  /** Epoch ms, exclusive. */
  end: number;
  allDay: boolean;
  /**
   * The IANA zone this event's *rule* is read against — never its instants,
   * which stay epoch milliseconds throughout, as does `end - start`. `""`
   * is floating: read against the viewer's own midnight, which is every
   * event the user writes, including the travel case `AUDIT.md` leaves
   * open — one dragged onto a face in this browser reads the same way
   * wherever it is next opened. A non-empty name arrives only from a
   * feed's own DTSTART `TZID` (`fromIcs` is the one writer) and names the
   * clock `startsBetweenIn` walks the rule over, so a subscribed weekly
   * standup keeps its own 09:00 whatever zone the viewer is in. An all-day
   * event is never zoned — `fromIcs` never sets one on one — because its
   * date is the one the calendar printed, not an hour a transition could
   * move to either side of midnight.
   */
  tzid: string;
  location: string;
  url: string;
  notes: string;
  /**
   * Set when this event *replaces* one occurrence of another — iCalendar's
   * RECURRENCE-ID, which is how every real calendar says "the series is at
   * nine, but next Tuesday's one moved to four".
   *
   * A separate event rather than a patch stored on the series, because that
   * is what it is: it has its own time, title, place and colour, and the day
   * it replaces may not even be the day it lands on. `seriesId` is the id of
   * the event it overrides; `seriesKey` is the `instantKey` of the occurrence
   * being replaced, which the series then does not generate. Both `""` on an
   * ordinary event.
   */
  seriesId: string;
  seriesKey: string;
  /**
   * Overrides the calendar's colour for this event alone. Empty means "follow
   * the calendar", which is the default and what most events should stay on —
   * recolouring the calendar then still moves them.
   */
  color: string;
  /**
   * Overrides the calendar's mark for this event alone, in the same two
   * vocabularies and with the same precedence as `color`: empty means "follow
   * the calendar", so remarking a calendar still moves every event that never
   * asked for its own.
   *
   * The two channels are read independently — `markOf` and `colorOf` — so an
   * event may take its calendar's glyph in a colour of its own, or the other
   * way round, and neither answer implies the other.
   */
  icon: string;
  /**
   * A dated task: a moment rather than a span, so `end === start` and the
   * dial draws the pip it already draws for anything shorter than its own
   * cap — a mark at the right minute instead of an arc that lies about a
   * duration nobody gave it.
   *
   * An explicit field rather than "`end === start`, therefore a task": a
   * degenerate span is an arithmetic coincidence, and typing data by one is
   * how a five-minute event dragged to nothing silently becomes a to-do.
   * Undated tasks are deliberately not modelled — a list with no day on it
   * is a different product wearing this one as a skin.
   */
  task: boolean;
  /**
   * The occurrences that have been ticked off, as `instantKey`s.
   *
   * A list on the event rather than a boolean, for the reason `exdates` is
   * one: a repeating task is completed one occurrence at a time, and a flag
   * on the series would tick every Monday at once. Always the datetime form,
   * even for an all-day task — the two forms `exdates` carries exist because
   * EXDATE has two RFC value types, and nothing outside this app writes
   * these.
   */
  doneKeys: string[];
  /**
   * Whether this event leaves the time it covers on offer: a placeholder, a
   * tentative hold, somebody's birthday. Busy is normal, so `false` is the
   * default and the absent value both.
   *
   * Two halves, and the second is the one that matters. It is drawn hollow —
   * the same arc, outlined rather than filled, which costs no radius — and it
   * does **not** count as booked time: `freeGaps` books no block for it and
   * `dayLoad` leaves it out of the total, so the numbers the centre panel
   * prints and the slot the palette finds stop being lies about a day whose
   * only "meeting" was a birthday.
   *
   * An explicit flag for the reason `task` is one: nothing about a span says
   * how seriously it is meant, so inferring this from a title, a calendar or
   * a zero-width end would be typing data by coincidence. It is iCalendar's
   * `TRANSP` on the wire — `TRANSPARENT` is free, `OPAQUE` and an absent
   * property are busy — and named for the word the editor prints rather than
   * for the property, because the property is a spelling and not the idea.
   *
   * Meaningless on a task, which is why nothing consults both: a task has no
   * width to offer or withhold, so it already books nothing at all.
   */
  free: boolean;
  /**
   * How much warning this event gets, overriding `settings.remindLead` — the
   * same kind of field as `color`, and with the same default: name nothing
   * and follow what the app was told once, so changing that setting still
   * moves every event that never asked for its own.
   *
   * Three states in one number, and the vocabulary lives beside the lead
   * times in `remind.ts`: `REMIND_INHERIT` (the default), `REMIND_SILENT`
   * (never, whatever the setting says) and any whole count of minutes from
   * `0` up. Only `leadOf` reads which of the three it is — this is an
   * override rather than the lead, exactly as `CalEvent.color` is an
   * override rather than the colour, and one resolver is what keeps that
   * precedence in one place.
   */
  remindLead: number;
  /**
   * Who asked, off `ORGANIZER` — `null` on every event that arrived without
   * one, which is every event the user wrote here.
   *
   * Read and printed, never composed. Circal has no account, no server and no
   * outbound channel, so it cannot send an invitation and will not offer to:
   * an editable organiser field would be a claim about a message this app
   * cannot post. What the field is *for* is the other half of the same fact —
   * an `.ics` that arrives by mail carries the one name that answers "who is
   * asking", and dropping it left the reader looking at a meeting with no
   * sender.
   */
  organizer: Person | null;
  /**
   * Who was invited and what each of them said, off the `ATTENDEE` lines.
   *
   * Display only, for the reason above and one more: accepting or declining is
   * a message, so there is no control here to add, remove or answer for
   * anybody. An empty guest-list editor on an event you wrote yourself would
   * be a promise the app cannot keep.
   *
   * Capped at `ATTENDEE_MAX` — the one field on this model that arrives from a
   * stranger with no natural length. `attendeeCount` is what keeps that cap
   * honest.
   */
  attendees: Attendee[];
  /**
   * How many people the invitation actually named, which is `attendees.length`
   * except when the cap dropped some.
   *
   * Stored rather than derived because it is the one fact truncation destroys,
   * and a truncation the reader cannot see is the failure mode this exists to
   * prevent: the surface prints "and 40 others" off the difference, so the
   * number it prints is the number that arrived rather than the number that
   * fitted. `0` on an event with no guest list at all, so absent and empty
   * say the same thing.
   */
  attendeeCount: number;
}

/** One concrete appearance of an event on one day, clipped to that day. */
export interface Occurrence {
  /**
   * Stable across renders, and unique: an event may now appear more than once
   * on a day (an hourly rule, or a BYHOUR list), so the day alone no longer
   * identifies an occurrence — the start instant does.
   */
  key: string;
  event: CalEvent;
  start: Date;
  end: Date;
  /** Clipped to `[0, 1440]` — what the dial actually draws. */
  startMin: number;
  endMin: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /**
   * Where this day sits inside the occurrence's whole span, 1-based, and how
   * many days that span covers. `1 of 1` for anything inside a single day.
   *
   * `continuesBefore` / `continuesAfter` say only *that* an occurrence runs
   * past the day; a five-day holiday then prints an identical row on all five
   * of them. This is the position the row needs to say `Day 3 of 5`, and it
   * belongs here rather than in each surface because `dayAgenda` is the one
   * read path onto a day.
   */
  dayIndex: number;
  dayCount: number;
  /**
   * Whether *this* occurrence of a task has been ticked off. Resolved here
   * rather than at each surface because `dayAgenda` is the one read path onto
   * a day, and `doneKeys` is a list lookup no renderer should be doing.
   * Always `false` on an ordinary event.
   */
  done: boolean;
  /** 0 = outermost ring. Assigned by `packLanes`. */
  lane: number;
}

/* ------------------------------- occurrences ------------------------------ */

/**
 * The overrides in a set of events, indexed by the occurrence each replaces.
 *
 * Built once per query rather than per event: a feed of a hundred meetings
 * carries its exceptions as ordinary siblings in the same array, and scanning
 * for them inside the loop would be quadratic.
 */
function overridesIn(events: CalEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.seriesId || !event.seriesKey) continue;
    const keys = out.get(event.seriesId);
    if (keys) keys.add(event.seriesKey);
    else out.set(event.seriesId, new Set([event.seriesKey]));
  }
  return out;
}

const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 366 * DAY_MS;

/** Frequencies dense enough that a wider window loses the day it is asking
 *  about — see `lookbackCap`. */
const DENSE = new Set<Repeat>(["secondly", "minutely", "hourly"]);

/**
 * How far back a day's query will look for a start, given the rule.
 *
 * An event is on a day when it is *running* during it, so the exact lookback
 * is the event's own duration — and for a one-off that costs nothing, because
 * the window is only ever asked for a single instant however wide it is.
 *
 * A rule pays per period, and the lookback *is* its expansion window, so it is
 * capped. A year for the ordinary frequencies: expanding a weekly rule over
 * however many years the longest event in the store happens to span, on every
 * day render, is not a cost a day view should carry. A day for the sub-daily
 * three, and for a sharper reason — `startsBetween` caps what it returns and
 * keeps the *earliest* instants it found, so a wider window for a minutely
 * rule answers with last week's occurrences and the day vanishes rather than
 * gains its missing copies. Such a rule overlaps itself anyway: more
 * simultaneous copies than the dial has lanes, and the ones a day's window
 * finds already cover the whole face.
 */
function lookbackCap(repeat: Repeat): number {
  if (repeat === "never") return Infinity;
  return DENSE.has(repeat) ? DAY_MS : MAX_SPAN_MS;
}

/**
 * Every occurrence visible on `day`, clipped to it. An event that runs past
 * midnight is emitted on every day it touches, which is why earlier days are
 * scanned too: the tail of something that began on Monday belongs to
 * Wednesday's dial as much as to Monday's.
 */
export function occurrencesOn(events: CalEvent[], calendars: Calendar[], day: Date): Occurrence[] {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const replaced = overridesIn(events);
  const out: Occurrence[] = [];

  for (const event of events) {
    if (hidden.has(event.calendarId)) continue;

    const duration = Math.max(event.end - event.start, 0);
    // A task has no duration, and every overlap test below is written against
    // an exclusive `end`: at zero width `end <= dayStart` throws away a task
    // standing exactly at midnight. One millisecond of notional width is what
    // makes "an instant belongs to the day it starts on" fall out of the same
    // arithmetic as everything else, rather than needing a branch.
    const span = Math.max(duration, 1);
    // In milliseconds rather than in days: `start + duration > dayStart` is
    // the whole overlap test, so the window is tight by construction and needs
    // no DST reasoning. A flat day back was enough while nothing was longer
    // than one, and a five-day holiday from a feed then vanished on its third
    // morning.
    const from = dayStart.getTime() - Math.min(span, lookbackCap(event.repeat));
    const skip = replaced.get(event.id);

    for (const at of startsBetweenIn(event, event.start, from, dayEnd.getTime(), event.tzid)) {
      // An occurrence somebody moved is not drawn twice: the series skips it,
      // and the override event draws itself.
      if (skip?.has(instantKey(at))) continue;

      const start = new Date(at);
      const end = new Date(at + duration);
      if (at + span <= dayStart.getTime() || start >= dayEnd) continue;

      const continuesBefore = start < dayStart;
      const continuesAfter = end > dayEnd;
      // `end` is exclusive, so an occurrence finishing at midnight ends on the
      // day before — measuring the last day from `end - 1` is what keeps a
      // one-day event at `1 of 1` instead of claiming two.
      const firstDay = startOfDay(start);
      const lastDay = startOfDay(new Date(Math.max(at, at + duration - 1)));
      out.push({
        key: `${event.id}@${instantKey(start)}`,
        event,
        start,
        end,
        startMin: continuesBefore ? 0 : minutesOfDay(start),
        // `>=`, not `continuesAfter`: an event ending *exactly* at midnight ends
        // this day at 1440 rather than the next one at 0. `minutesOfDay` would
        // say 0, which is a negative duration everywhere it is measured and an
        // arc drawn backwards round the whole face.
        endMin: end >= dayEnd ? MINUTES_PER_DAY : minutesOfDay(end),
        continuesBefore,
        continuesAfter,
        dayIndex: daysBetween(firstDay, dayStart) + 1,
        dayCount: daysBetween(firstDay, lastDay) + 1,
        // A tick is per occurrence, so it is looked up per occurrence. The
        // list is empty on everything that is not a task, which is almost
        // every event in the store.
        done: event.doneKeys.length > 0 && event.doneKeys.includes(instantKey(start)),
        lane: 0,
      });
    }
  }

  out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return out;
}

/* -------------------------------- packing --------------------------------- */

/**
 * Push overlapping arcs onto concentric rings so neither is hidden. Greedy and
 * order-stable: the earliest event keeps the outer ring, each later one takes
 * the first ring whose occupant it does not touch. Timed events only — an
 * all-day event has no arc.
 *
 * `pad` widens the overlap test by the arc's round caps, so two events that
 * merely touch (10:00–11:00, 11:00–12:00) still share a ring, while two that
 * would visually collide do not.
 */
function packLanes(occurrences: Occurrence[], pad = 6): Occurrence[] {
  const laneEnds: number[] = [];
  return occurrences.map((occ) => {
    if (occ.event.allDay) return occ;
    // A task is a notch in the rim, not an occupant of it: it takes no lane
    // and pushes nothing out of one. Packed like an arc it would either be
    // buried under the meeting it happens during, or push that meeting inward
    // to make room for a mark two units wide — and a pip on the outer ring
    // during a booked hour is the honest picture of a task during a meeting.
    if (occ.event.task) return occ;
    let lane = laneEnds.findIndex((end) => end <= occ.startMin + pad);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = occ.endMin;
    return { ...occ, lane };
  });
}

/**
 * Timed occurrences with lanes assigned, plus the all-day ones kept apart.
 * Lane packing is face-independent: both dials put one day on one revolution,
 * so two events collide on screen exactly when they collide in time.
 */
export function dayAgenda(events: CalEvent[], calendars: Calendar[], day: Date) {
  const all = occurrencesOn(events, calendars, day);
  const allDay = all.filter((o) => o.event.allDay);
  const timed = packLanes(all.filter((o) => !o.event.allDay));
  return { timed, allDay, all: [...allDay, ...timed] };
}

/* ---------------------------------- tasks --------------------------------- */

/**
 * `doneKeys` with one occurrence ticked or un-ticked. The key's shape lives
 * here rather than at the two call sites — the store's commit and the
 * editor's switch — so a tick from the dial and a tick from the modal cannot
 * disagree about which occurrence they meant.
 */
export function toggleDoneKey(keys: string[], at: Date | number): string[] {
  const key = instantKey(at);
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

/* ------------------------------- free time -------------------------------- */

export interface Gap {
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

/**
 * The hours a day is measured against by default, before a setting says
 * otherwise. Free time is counted against these rather than against the
 * whole revolution: nobody reads "nineteen hours free" as an offer, and both
 * the palette's slot search and the dial's totals mean the same thing by the
 * word — see `Settings.wakingFrom` / `wakingTo`, which this seeds.
 */
export const DEFAULT_WAKING = { from: 8 * 60, to: 22 * 60 };

/**
 * The holes in a day, at least `minMinutes` wide, inside `[from, to]`.
 *
 * The dial already makes gaps the most legible thing on the face; this only
 * makes them addressable. Two kinds of occurrence do not occupy a gap. An
 * all-day event never did — an all-day "Berlin" does not stop you booking
 * lunch — and a **free** one does not either: it is exactly the placeholder
 * this function exists to find room around, and counting it made the palette
 * refuse a slot that a birthday was the only thing in.
 */
export function freeGaps(
  occurrences: Occurrence[],
  minMinutes: number,
  from: number,
  to: number,
): Gap[] {
  const busy = occurrences
    .filter((o) => !o.event.allDay && !o.event.free)
    .map((o) => ({ start: Math.max(o.startMin, from), end: Math.min(o.endMin, to) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const gaps: Gap[] = [];
  let cursor = from;
  for (const block of busy) {
    if (block.start - cursor >= minMinutes) gaps.push({ start: cursor, end: block.start });
    // Overlapping events are already sorted by start, so the frontier only
    // ever moves forwards — a short event nested inside a long one must not
    // drag it back and invent a gap that is actually booked.
    cursor = Math.max(cursor, block.end);
  }
  if (to - cursor >= minMinutes) gaps.push({ start: cursor, end: to });
  return gaps;
}

/**
 * What a day is made of: minutes spoken for, and minutes still on offer.
 *
 * The two are measured against *different* windows on purpose. Booked is the
 * whole revolution — a six o'clock run is time spent — while free is only
 * `waking`, the caller's own working-hours window, because "nineteen hours
 * free" is not an offer. They do not sum to anything and nobody adds them.
 *
 * Both come out of `freeGaps`, which already merges overlaps: two events on
 * the same hour are one hour booked, not two — and skips the occurrences that
 * book nothing, so a **free** event is absent from the booked total for the
 * same reason an all-day one is. That is the asymmetry above left exactly as
 * it was: what counts as booked has changed, the window it is counted over
 * has not.
 *
 * `null` for a day with nothing timed on it, which is how a caller tells
 * "nothing booked" from "no answer" — an all-day event is context, and it
 * books no hours. A day holding only free events is *not* that case: it has
 * something on it, and `0m booked` is the answer the line exists to give.
 */
export function dayLoad(
  occurrences: Occurrence[],
  waking: { from: number; to: number },
): { booked: number; free: number } | null {
  if (!occurrences.some((occ) => !occ.event.allDay)) return null;
  const idle = (from: number, to: number) =>
    freeGaps(occurrences, 1, from, to).reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  return {
    booked: MINUTES_PER_DAY - idle(0, MINUTES_PER_DAY),
    free: idle(waking.from, waking.to),
  };
}

/**
 * What a proposed span would land on top of, in the order the day reads.
 *
 * This exists for one surface: `⌘P` commits an event with no review step, and
 * it is the only way to write one onto a day the reader was never looking at.
 * The dial makes an overlap obvious the moment you see it — two arcs, two
 * lanes — so every other route to a new event already answers this. A typed
 * line does not, and the toast is the only thing left that can.
 *
 * Busy means exactly what `freeGaps` means by it, deliberately reusing the
 * rule rather than restating it: an all-day event is context and does not
 * clash (an all-day "Berlin" is not a conflict with lunch), a **free** one is
 * the placeholder you are meant to book over, and anything holding no minutes
 * at all — which is every task — is dropped on width, `freeGaps`' own test.
 * Three surfaces now read that one idea of busy: the totals line, the slot
 * search, and this. They cannot come to disagree about it.
 *
 * Touching ends do not clash, because `end` is exclusive here as everywhere:
 * a 10:00 meeting after a 09:00–10:00 one is the next thing, not a collision.
 *
 * Two things the caller owns. An **all-day** span must not be asked about —
 * it covers the revolution, so it would name everything on the day and say
 * nothing. And an event through midnight is answered for the part that lands
 * on `occurrences`' own day only; the tail belongs to the next day's query,
 * and asking two days a question the notice prints as one sentence is a
 * bigger claim than this is worth.
 */
export function clashesWith(
  occurrences: Occurrence[],
  startMin: number,
  endMin: number,
): Occurrence[] {
  if (endMin <= startMin) return [];
  return occurrences.filter(
    (occ) =>
      !occ.event.allDay &&
      !occ.event.free &&
      occ.endMin > occ.startMin &&
      occ.startMin < endMin &&
      occ.endMin > startMin,
  );
}

/* --------------------------------- search --------------------------------- */

/**
 * What a match outside the title gives up. A note is searchable but it is not
 * what the event is called, so a title match of the same quality wins.
 */
const FIELD_PENALTY = { location: 30, notes: 45 };

const penalise = (score: number | null, cost: number) => (score === null ? null : score - cost);

/**
 * How well an event answers a query, or `null` when it does not — the whole of
 * "does this match" for every surface that searches, so the palette's ranking
 * and the life grid's thread cannot disagree about what a hit is.
 *
 * Charged as a penalty rather than a multiplier: a score can be negative (a
 * long note matched across big gaps), and halving a negative promotes it.
 */
export function scoreEvent(event: CalEvent, query: string): number | null {
  const scores = [
    fuzzyScore(event.title, query),
    penalise(fuzzyScore(event.location, query), FIELD_PENALTY.location),
    penalise(fuzzyScore(event.notes, query), FIELD_PENALTY.notes),
  ].filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

/* --------------------------------- colour --------------------------------- */

/**
 * The preset colours, for calendars and for per-event overrides. Digital
 * pastels: high value, moderate saturation, tuned to glow a little against
 * true black without ever reading as a warning light. Two of these can share
 * a dial and still be told apart at a 14-unit stroke.
 */
export const PALETTE = [
  "#7ce3d8", // aqua
  "#8ecbff", // sky
  "#a5a8ff", // periwinkle
  "#c79bff", // violet
  "#ff9edb", // orchid
  "#ff9fb4", // rose
  "#ffb185", // tangerine
  "#ffdf8c", // butter
  "#c6ef8f", // pear
  "#8bf0b8", // mint
] as const;

/** Used only when an event points at a calendar that no longer exists. */
const ORPHAN_COLOR = PALETTE[0];

/** The event's own colour if it has one, else its calendar's. Takes only the
 *  two fields it reads, so a draft that is not an event yet can ask too. */
export function colorOf(
  event: Pick<CalEvent, "color" | "calendarId">,
  calendars: Calendar[],
): string {
  if (event.color) return event.color;
  return calendars.find((c) => c.id === event.calendarId)?.color ?? ORPHAN_COLOR;
}

/**
 * An event's mark: its own, and *only* its own unless inheritance is asked for.
 *
 * This is deliberately **not** `colorOf`'s rule. Colour inherits because every
 * event must have one — a calendar without a colour cannot be drawn — so the
 * fallback is the only thing that makes `CalEvent.color` an override rather
 * than a requirement. A mark is different: no mark is a perfectly good answer,
 * and a face where every arc has picked up its calendar's glyph is a face
 * wearing the same three symbols forty times, which says nothing that colour
 * was not already saying.
 *
 * So `inherit` defaults to `false` and comes from `settings.inheritMarks`,
 * which is off. Turn it on and a calendar's mark becomes a default its events
 * take unless they name their own — which is the useful reading when you have
 * one calendar per kind of thing.
 *
 * An event whose calendar is gone has no mark rather than an orphan glyph:
 * there is no equivalent of `ORPHAN_COLOR` here, because a wrong icon says
 * something specific and a missing one says nothing.
 */
export function markOf(
  event: Pick<CalEvent, "icon" | "calendarId">,
  calendars: Calendar[],
  inherit = false,
): string {
  if (event.icon) return event.icon;
  if (!inherit) return "";
  return calendars.find((c) => c.id === event.calendarId)?.icon ?? "";
}

/**
 * Relative luminance of a `#rgb` / `#rrggbb` colour, or `null` for anything
 * this does not spell — sRGB, linearised, per WCAG.
 */
function luminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = (at: number) => {
    const v = parseInt(full.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Ink for text drawn *on* a colour — an arc's label sits inside the stroke, so
 * it is set in the arc's own darkness rather than in the app's greys.
 *
 * Every `PALETTE` entry is a high-value pastel and takes black at around 10:1,
 * which is the strongest pairing available on this face. But `event.color` is
 * a free string and only `backup.ts` ever looks at an imported one's *type*,
 * so a hand-edited blob can carry `#101010`; the choice is made from the
 * colour itself. Unreadable spellings take black, which is what the ten
 * presets and every other light colour want.
 */
export function inkOn(color: string): string {
  const l = luminance(color);
  return l !== null && l < 0.4 ? "#ffffff" : "#000000";
}

/** Where an occurrence sits relative to `now`: before it, inside it, after it. */
export function statusOf(occ: Occurrence, now: Date): "past" | "now" | "upcoming" {
  if (now >= occ.end) return "past";
  return now >= occ.start ? "now" : "upcoming";
}

/**
 * Where an occurrence sits inside its own span — `Day 3/5` — and `null` for
 * anything living inside a single day, which is almost everything.
 *
 * One function rather than two, because the interior and the sidebar are the
 * same agenda at two sizes and this is the fact neither of them could say:
 * without it a five-day holiday prints an identical row on all five of its
 * days. Both surfaces uppercase it in CSS, so it is written in the app's own
 * voice here and shouted there.
 */
export function spanLabel(occ: Occurrence): string | null {
  return occ.dayCount > 1 ? `Day ${occ.dayIndex}/${occ.dayCount}` : null;
}
