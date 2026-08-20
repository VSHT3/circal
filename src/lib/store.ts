/* ------------------------------------------------------------------ *
 * The store. One module-level object, a listener set and localStorage.
 *
 * There is no server: circal is a local instrument. That makes an external
 * store read through `useSyncExternalStore` the right shape — every panel
 * (dial, agenda, sidebar, palette) reads the same snapshot without threading
 * a dozen props through the shell, and a second tab picks up writes via the
 * `storage` event.
 *
 * Three properties this file is responsible for, all learned the hard way:
 *
 * 1. A write that fails must *say so*. `localStorage` throws on quota and in
 *    private mode, and the app looked identical either way — the UI showed the
 *    event saved while the disk did not have it.
 * 2. A second tab must not overwrite this one. Every action re-reads the blob
 *    before deriving from it (`fresh()`), so two tabs racing lose an *edit* at
 *    worst, never the other tab's events.
 * 3. Somebody else's calendar must not be able to cost you yours. A mirrored
 *    feed is the one unbounded thing in the store, and inside the blob every
 *    one of its events competed with yours for a single origin quota — so a
 *    fat subscription made every later save of your own fail. Feeds are one
 *    key each now, outside the blob and on a budget.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import {
  MINUTES_PER_DAY,
  addDays,
  addMonths,
  clamp,
  dayKey,
  isZone,
  startOfDay,
  weekStartFor,
  type Clock,
  type WeekStart,
} from "./time";
import { notify } from "./notify";
import {
  DEFAULT_WAKING,
  NEVER,
  PALETTE,
  instantKey,
  REMIND_INHERIT,
  keyToInstant,
  readGraves,
  readGuests,
  readPerson,
  readRecurrence,
  readRemindLead,
  readStamp,
  type CalEvent,
  type Calendar,
  type Grave,
  type Repeat,
} from "./events";
import { applyRemove, applySplit, applyToggleDone, applyTruncate, applyUpdate } from "./mutate";
import { pruneGraves, restamped } from "./merge";
import { DEFAULT_DURATION, MIN_DURATION } from "./quickadd";
import { REMIND_LEADS } from "./remind";
import { clearedStamps, countStamped, keptEvents, movedEvents } from "./travel";
import type { PickedPlace } from "./places";

const KEY = "circal.v1";

/**
 * A subscription's cached events: one key per calendar, `circal.feed.<id>`.
 *
 * Out of the blob because they are not the user's data and there is no bound
 * on them — a shared work calendar is thousands of VEVENTs. Split, a feed
 * that will not fit fails on its own key and says so on its own calendar,
 * and the blob that holds your day stays small enough to always write.
 */
const FEED_PREFIX = "circal.feed.";

const feedKey = (id: string) => `${FEED_PREFIX}${id}`;

/**
 * Stored characters of mirrored feed events allowed in total, shared equally
 * between the subscriptions — one feed may spend the lot, four get a quarter
 * each. A total rather than a per-feed cap is the only form that bounds
 * anything: the quota is per origin, so five caps of "one each" is five.
 *
 * Two million of the ~5M a browser gives an origin leaves three for your own
 * events, which is tens of thousands of them. Re-divided on every pull, so a
 * fifth subscription shrinks the other four as each is next refreshed rather
 * than all at once — a pull is cheap and half an hour away at worst.
 */
const FEED_BUDGET = 2_000_000;

/**
 * Bumped when a stored field changes meaning rather than shape. `clock: "24h"`
 * used to name the noon-at-top AM/PM face; it now names the 0–23 face, so a
 * blob written before this bump would silently show the wrong dial. Events
 * survive the bump — only settings reset.
 *
 * Still 2: `secondZone`, `place`, `feeds`, `birth`, `lifeExpectancy`,
 * `arcLabels`, the five `ambient*` fields, the full RFC 5545 recurrence fields
 * (`interval`, `until`, `wkst`, the `byMonth` / `byWeekNo` / `byYearDay` /
 * `byMonthDay` / `byDay` / `byHour` / `byMinute` / `bySecond` / `bySetPos`
 * limits, `exdates`, `rdates`) and the series-override pair (`seriesId`,
 * `seriesKey`) are all new *fields*, and a blob without them has them filled
 * in on read. Nothing already stored changed meaning, so there is no reason to
 * throw away anyone's dial preference.
 *
 * Still 2 through the `clock` default going to `24h`, too. A default is what a
 * blob says when it says nothing; every blob that already exists says `12h` or
 * `24h` out loud, and neither of those changed meaning.
 * Still 2 through `task`, `doneKeys`, `moon`, `remind`, `remindLead` and
 * `free` as well: six more fields, filled in on read, none of them a change
 * to what anything already stored means — `moon` arrives from a stored
 * `moonPhase` through `migrateSettings`, which is a shape changing rather
 * than a meaning. And still 2 through the per-event `remindLead` override:
 * an event without one inherits, which is exactly what every event in every
 * blob written before it was already doing, so nothing stored says anything
 * new — and a bump here would throw away the setting the override overrides.
 */
const SCHEMA = 2;

/**
 * The nine places the totals line can take, row-major. `center` is the one
 * that is not a corner of the stage: it hangs under the agenda card, which is
 * where the line was born and where it belongs unless it is in the way.
 */
export const TOTALS_POSITIONS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;

export type TotalsPosition = (typeof TOTALS_POSITIONS)[number];

/**
 * When an event's name is printed along its own arc. `hover` is the density
 * escape hatch — a dozen names on one revolution is text where the shape
 * should be — and it is the weakest of the three, since a hovered arc already
 * thickens and the centre already prints what it is. On a touch device it is
 * `off` by another name.
 */
export const ARC_LABEL_MODES = ["always", "hover", "off"] as const;

export type ArcLabelMode = (typeof ARC_LABEL_MODES)[number];

/**
 * How long the dial has to be left alone before it takes the window, in
 * minutes. `0` is never, which is the default: a mode that arrives on its own
 * has to be asked for once.
 *
 * A list rather than a free number, because the useful range is one decision
 * (a break, lunch, gone for the day) and a spinner invites tuning something
 * that has one right answer per desk.
 */
export const AMBIENT_DELAYS = [0, 1, 2, 5, 10, 30, 60] as const;

export type AmbientDelay = (typeof AMBIENT_DELAYS)[number];

/**
 * How many days may pass without a `.json` backup before the main screen says
 * so, offered as a short fixed list for the same reason `AMBIENT_DELAYS` is: a
 * backup cadence is one decision (a week, a fortnight, a month, a quarter) and
 * a free number field invites tuning a value with no wrong answer worth typing.
 */
export const BACKUP_INTERVALS = [7, 14, 30, 60, 90] as const;

export type BackupInterval = (typeof BACKUP_INTERVALS)[number];

/**
 * The three starts the week strip, the mini-month and the life grid may cut
 * on, in the order the picker offers them — Monday first, since it is the
 * default every blob before this setting existed already drew.
 */
export const WEEK_STARTS: readonly WeekStart[] = [1, 0, 6];

export interface Settings {
  /** Which face the dial wears — see `lib/dial.ts`. */
  clock: Clock;
  /**
   * The zone this browser was last seen in, IANA. Remembered rather than
   * chosen: it is the only "before" there is to compare against, and a
   * device that has moved since the last launch is drawing every floating
   * event on a clock it was not written on. `""` is a first run — nothing to
   * compare, and therefore nothing to ask. See `lib/travel.ts`.
   */
  deviceZone: string;
  /**
   * The zones the travel notice's "keep them as they are" answer has stamped
   * events with — what the settings row counts and what its Clear takes off,
   * and nothing else.
   *
   * Remembered because `CalEvent.tzid` has a second writer: `ics.ts`'s
   * DTSTART reader, whose events land in this same `events` list carrying
   * real zones out of a file. Without this, "clear the stamps" would flatten
   * a colleague's imported 09:00 New York standup to floating and walk its
   * rule against the reader's clock.
   *
   * A list rather than one name: two journeys kept in a row stamp two
   * different zones, and a single field would leave the first journey's
   * stamps with no way back — which is the thing this exists to provide.
   * Emptied by the Clear it serves, since by then nothing carries them.
   */
  stampedZones: string[];
  /** IANA zone for the dial's second ring. `""` = the ring is off. */
  secondZone: string;
  /** Whether that ring is captioned with the city, the offset, both, neither. */
  showZoneName: boolean;
  showZoneOffset: boolean;
  /** The second zone's own band, on its own rim, with its own two halves. */
  zoneDaylight: boolean;
  zoneMoonlight: boolean;
  /** Where the sun is computed for, chosen by city. `null` = no lightcycle. */
  place: PickedPlace | null;
  /** The two halves of your band, each its own switch. */
  daylight: boolean;
  /** The hours the sun is down, in violet. */
  moonlight: boolean;
  /**
   * Whether an event's name is printed along its arc, and when. Unlike the
   * totals line this is not the same fact twice: an unlabelled 30-minute arc
   * is 7.5° of colour and says who it belongs to only once you point at it.
   */
  arcLabels: ArcLabelMode;
  /**
   * Whether an event with no mark of its own borrows its calendar's.
   *
   * Off. Colour inherits because every event needs one; a mark does not, and
   * a face where forty arcs have all picked up the same three glyphs says
   * nothing colour was not already saying. On, it becomes what it is useful
   * as: a default for people who keep one calendar per kind of thing. See
   * `markOf`, which takes this as its `inherit` argument rather than reading
   * settings itself.
   */
  inheritMarks: boolean;
  /**
   * Whether the centre prints what the day is made of — booked against free.
   * Off: the ring already draws the shape, and this is the sentence version
   * of it, which not everybody wants under their agenda.
   */
  totals: boolean;
  /** Where that line sits: nine places on the face, `center` under the card. */
  totalsAt: TotalsPosition;
  /** Whether a fifteen-minute step of a drag on the dial clicks, and whether
   *  it taps. Two channels, because a device that can do both is not
   *  necessarily somewhere you want either. */
  tickSound: boolean;
  tickHaptics: boolean;
  /**
   * The one date the life view needs: `YYYY-MM-DD`, local. `""` means it has
   * never been asked for, which is what puts the prompt on screen the first
   * time that view is opened.
   */
  birth: string;
  /** Years the life grid runs for, from the birthday. An estimate the user
   *  owns — no actuarial table is going to know better. */
  lifeExpectancy: number;
  /**
   * Whether the life grid marks its round numbers: the ten-thousandth day,
   * the twenty-thousandth, the midpoint of the estimate. On, because the
   * problem they solve is the view's own — thirty thousand identical dots and
   * nothing for the eye to land on between the decade rules. A switch, because
   * a life measured in round numbers is not everybody's idea of a good time.
   */
  milestones: boolean;
  /**
   * Whether pointing at a day brings its year up on a card over the field, at
   * a size a day can be read and hit at. On: four pixels is legible as a
   * picture and not as a day, and every other surface in this app can be
   * pointed at. A switch because it is the largest thing in this app that
   * appears without being clicked, and somebody who came here for the
   * eighty-year picture and nothing else is entitled to just the picture.
   */
  lifeLoupe: boolean;
  /**
   * The line under the year ring's centre. The dial's interior answers the
   * day; a year has no equivalent answer worth printing, so this is a
   * standing one instead, and it is the user's to write. `""` prints nothing.
   */
  yearQuote: string;
  /**
   * Ambient is a display mode, so what it shows is its own question. These
   * six are what the face is allowed to differ on — everything else (the
   * geometry, the events, the hand) is the same dial, because it *is* the same
   * dial.
   */
  ambientAfter: number;
  /** Brightness follows the lightcycle: full by day, a little over half in the
   *  middle of the night. Nothing to follow without a place, so it is off by
   *  consequence rather than by setting there. */
  ambientDim: boolean;
  /**
   * The band's two halves, in ambient — its own pair, not the working face's.
   * Only the *place* is shared, because there is only one of those: a person
   * is somewhere, and where they are is not a property of a mode.
   *
   * The halves are, though. On the working face the band shares the rim with
   * a day's arcs and half of it is a legibility trade; on a face that is
   * nothing but the rim, it is the picture.
   */
  ambientDaylight: boolean;
  ambientMoonlight: boolean;
  /** The second zone's numerals and its band, in ambient. */
  ambientZoneRing: boolean;
  /** Names along the arcs, in ambient. Its own mode, because 11px mono is
   *  read from a chair and this face is read from across a room. */
  ambientArcLabels: ArcLabelMode;
  /**
   * The sidebar's moon: the lit part of it and nothing else, the terminator
   * drawn as an ellipse over it, in the app's own greyscale.
   *
   * It lives in the sidebar rather than on the face because of the rule that
   * governs this app's one instrument: every radius the dial gains costs
   * `PAD` and legibility, and the moon is not a fact about the *day* the way
   * the lightcycle band is. It is the one complication here that is pure
   * eyecandy, and eyecandy belongs in the column you can close.
   *
   * A switch rather than a choice of register. A second drawing — the disc
   * riding behind a watchmaker's aperture, in night blue with stars — was
   * offered here and was the only chrome in circal that was neither greyscale
   * nor flat; two answers to one question, one of them arguing with the rest
   * of the screen, is worse than the answer this app's own voice gives.
   */
  moon: boolean;
  /**
   * Notifications for what is about to start, while this tab is open.
   *
   * Deliberately the whole feature. Reminders with the tab *closed* need a
   * push service, which needs a server, which is the one thing this product
   * has said it will not have — so the panel says so in words rather than
   * leaving the absence to be discovered.
   */
  remind: boolean;
  /** Minutes of warning, from `REMIND_LEADS`. `0` fires as it starts. */
  remindLead: number;
  /**
   * Whether the main screen says so when this browser has gone too long
   * without a `.json` backup.
   *
   * On, unlike `remind`: a reminder is a convenience the user opts into, but
   * a calendar that lives in one `localStorage` is one "Clear site data" from
   * gone, and Safari and Firefox can offer no live mirror to catch it — so on
   * those the nudge is the only warning there is, and a data-safety prompt
   * defaulting to off is one nobody ever meets. The mirror suppresses it where
   * a rolling copy is already being written, so it only ever speaks to the
   * browsers with no other answer.
   */
  backupNudge: boolean;
  /** Days without a `.json` backup before the nudge appears, from
   *  `BACKUP_INTERVALS`. `sane()` pins a stray value to one the panel offers. */
  backupInterval: number;
  /**
   * What a new event is worth before anybody says otherwise: the length ⌘N
   * opens with, and the length quick-add gives a line that named a time and
   * no duration. `DEFAULT_DURATION` is still the constant behind it, because
   * the parser has to have an answer with no store in reach.
   *
   * One number for both, for the reason there was one constant for both: two
   * ways of adding an event must not disagree about what an event is.
   */
  defaultDuration: number;
  /**
   * The calendar a new event lands on, by id, or `""` for the first one that
   * is not a subscription.
   *
   * An id rather than an index, and resolved at the moment of use rather than
   * clamped on load: a calendar can be removed by another tab, and a setting
   * that quietly rewrote itself to the survivor would be a preference the user
   * never expressed. A stale id simply falls back.
   */
  defaultCalendar: string;
  /**
   * Which weekday the week is considered to start on. One setting rather
   * than three, because it is not really about the week strip — it is also
   * the mini-month's grid and the life grid's own columns (`LifeLayout` and
   * `LoupeLayout` both carry it as `weekStart`), and those three surfaces
   * would drift apart the moment they each had their own answer.
   */
  weekStart: WeekStart;
  /**
   * The window free time is counted against, in minutes since midnight —
   * `DEFAULT_WAKING`'s two fields, now a setting rather than a constant.
   * "Free" only means something measured against hours you would use, and
   * the palette's slot search and the dial's totals line have to keep
   * meaning the same thing by the word, which is why both read this rather
   * than each carrying a copy.
   */
  wakingFrom: number;
  wakingTo: number;
}

/** The switches: every field of `Settings` that is a plain boolean. */
type BooleanSetting = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

export interface Snapshot {
  schema: number;
  /** The user's own events. These are what export writes and import merges. */
  events: CalEvent[];
  calendars: Calendar[];
  /**
   * Events pulled from subscribed feeds, keyed by their calendar's id. Kept
   * apart from `events` so a refresh can replace a feed wholesale, and so
   * nobody's Google calendar ends up inside a circal backup.
   *
   * A read model assembled from the `circal.feed.*` keys — the one field of
   * this interface that is never serialised into the blob.
   */
  feeds: Record<string, CalEvent[]>;
  settings: Settings;
  /**
   * Epoch ms of the last settings change. `0` predates stamping.
   *
   * One stamp for the whole object rather than one per field: nobody would
   * recognise a per-field merge of these, and a document whose dial came from
   * one machine and whose life span came from the other is a document neither
   * person wrote.
   */
  settingsAt: number;
  /**
   * The ids this browser has deleted, and when — a sibling of `events` and
   * deliberately not a `deletedAt` field on `CalEvent`. A tombstone inside
   * `events` would make every reader of that array wrong until it learned to
   * filter (`dayAgenda`, `occurrencesOn`, `lifeDensity`, `scoreEvent`, the
   * palette, the year ring's tallies, `mcp/domain.ts`); a sibling list means
   * no reader changes at all, and `events` still holds exactly the events
   * that exist. Only this file, `mutate.ts`, `backup.ts`, `mirror.ts` and
   * `merge.ts` know graves exist.
   */
  graves: Grave[];
}

/** The blob: everything but the feed mirror, which has keys of its own. */
type Persisted = Omit<Snapshot, "feeds">;

export const DEFAULT_SETTINGS: Settings = {
  // The 0–23 face. It is the one that matches the instrument: a revolution is
  // a day here, not half of one, so an hour has exactly one place on it and
  // `13` is where `13` is. AM/PM is a preference, and it is one click away.
  clock: "24h",
  // Unknown until the first launch writes it, and written silently there: a
  // browser with nothing stored has no "before", and the question this field
  // exists to ask is only ever about a change.
  deviceZone: "",
  // Nothing stamped, which is every browser that has never travelled and
  // every one that answered "move".
  stampedZones: [],
  secondZone: "",
  showZoneName: true,
  showZoneOffset: true,
  // Off: the captions describe a ring that is already there, but a band is
  // another ring, and chrome does not get to appear unasked.
  zoneDaylight: false,
  zoneMoonlight: false,
  place: null,
  // Both on, because the band *is* the track: with one half off the ring
  // simply stops at dusk (or at dawn), and an incomplete ring reads as a
  // rendering fault rather than as a choice.
  daylight: true,
  moonlight: true,
  // Always, which is the one default here that a switch does not have to earn.
  // The glyph budget means a label only appears where the sweep can hold one,
  // so it cannot crowd the face — and the dial's own argument is legibility,
  // which an unlabelled ring of four coloured ticks loses. Hiding the fix
  // behind an off switch would concede the point.
  arcLabels: "always",
  // Off, and it is the one mark decision with a default worth arguing about:
  // see `markOf`. A calendar's glyph repeated down every arc of the day is
  // decoration, so it is asked for rather than assumed.
  inheritMarks: false,
  // Off. The ring is already the picture of a day's load; the line under the
  // card is the same fact in words, and words earn their place by being asked
  // for.
  totals: false,
  totalsAt: "center",
  // On: the drag is the one gesture in the app with a granularity you cannot
  // see mid-move, and a detent you have to look at is not a detent. Both are
  // heard only as the result of a deliberate drag, and never on load.
  tickSound: true,
  tickHaptics: true,
  // Unknown, and it stays unknown until asked for: a birth date is the one
  // piece of the user in this app, so nothing invents one.
  birth: "",
  // Eighty. High enough to be a life rather than a countdown, round enough to
  // read as the estimate it is.
  lifeExpectancy: 80,
  // On. Three or four marks on thirty thousand dots is a constellation rather
  // than furniture, and the alternative is a field with no landmarks in it at
  // all: the decade rules name the rows, and nothing names a day.
  milestones: true,
  // On. The grid's one weakness was always that a dot is four pixels, and a
  // magnifier that only appears while you are pointing costs the picture
  // nothing when you are not.
  lifeLoupe: true,
  // The default is an instruction rather than an observation, which is what
  // saves it from being a fortune cookie: a ring returns you to the same
  // angle, and this is the one thing to do about that.
  yearQuote: "don't end up in the same place",
  // Never, until asked for. Everything else in this file appears because the
  // user did something; a mode that arrives on a timer is the one thing that
  // could appear because they did not.
  ambientAfter: 0,
  // On, and it is the reason the mode is worth having: a face that does not
  // know it is night is a lamp. Costs nothing where no place is set — there is
  // no curve to follow, so it does not dim.
  ambientDim: true,
  // Both on, for the same reason the working face's pair is: the band *is*
  // the track, and with one half off the ring stops at dusk. Here it is also
  // the whole picture — ambient is the mode that is nothing but the rim.
  ambientDaylight: true,
  ambientMoonlight: true,
  // Off. A second place's numerals are a working reference — you look them up
  // — and this face is not looked *up*.
  ambientZoneRing: false,
  // Off, for the reason `arcLabels` defaults to `always`: the argument is
  // legibility, and at this distance the label is the illegible part.
  ambientArcLabels: "off",
  // Off. It is the only thing in this app that draws something the calendar
  // does not contain, so it has to be asked for by name.
  moon: false,
  // Off, and it is the one default here that is a promise rather than a
  // preference: nothing in circal has ever interrupted anybody, and the first
  // thing that can must be switched on deliberately.
  remind: false,
  // Ten minutes. Long enough to walk somewhere, short enough that the thing
  // is still the next thing when it lands.
  remindLead: 10,
  // On. This is the one interruption in the app that defends against losing
  // everything rather than missing one thing, and the browsers it is aimed at
  // have no other warning — so unlike `remind` it earns the aggressive default.
  backupNudge: true,
  // Thirty days. A month is long enough that a working calendar has changed
  // enough to be worth saving again, short enough that a lost month is a loss
  // and not a catastrophe.
  backupInterval: 30,
  // An hour, which is what `DEFAULT_DURATION` has always been and what a
  // VEVENT with no DTEND is read as. This setting exists to be *changed* — a
  // day of thirty-minute meetings is a real working life — not to have a new
  // opinion by default.
  defaultDuration: DEFAULT_DURATION,
  // The first calendar that is not a subscription, whichever that turns out
  // to be. Naming one here would be naming a seed calendar, and the seed is
  // not something a returning user still has.
  defaultCalendar: "",
  // Monday, which is what the app has always drawn and what most of the
  // world already expects — ISO 8601's own answer, and the one that needed
  // no setting until this one arrived to make it a choice rather than an
  // assumption.
  weekStart: 1,
  // `DEFAULT_WAKING`'s own pair: this setting exists to replace the constant,
  // not to disagree with it on day one.
  wakingFrom: DEFAULT_WAKING.from,
  wakingTo: DEFAULT_WAKING.to,
};

/** The three every install starts with. Unstamped for `seed`'s reason: they
 *  are what a browser holds before anybody has told it anything. */
const DEFAULT_CALENDARS: Calendar[] = [
  {
    id: "personal",
    name: "Personal",
    color: PALETTE[0],
    icon: "house",
    visible: true,
    updatedAt: 0,
  },
  { id: "work", name: "Work", color: PALETTE[3], icon: "briefcase", visible: true, updatedAt: 0 },
  { id: "family", name: "Family", color: PALETTE[5], icon: "users", visible: true, updatedAt: 0 },
];

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------------------------- seed ---------------------------------- */

/**
 * A first run against an empty dial teaches nothing, so seed one plausible
 * day — anchored on *today* rather than a fixed date, so the shape (a morning
 * gap, a stacked afternoon, a late call) is legible whenever it is opened.
 *
 * Every line here earns its place by being a shape nobody guesses at: the
 * afternoon stack is the only thing that says lanes exist, the pip at half
 * six is the only thing that says a task does, the run is a rule with both an
 * interval and a bound on it, and the trip is the multi-day all-day span that
 * the dial deliberately draws nothing for.
 */
function seed(): CalEvent[] {
  const today = startOfDay(new Date());
  const base = today.getTime();
  const at = (h: number, m = 0) => base + (h * 60 + m) * 60_000;
  const tomorrow = addDays(today, 1);
  const make = (
    title: string,
    calendarId: string,
    start: number,
    end: number,
    extra: Partial<CalEvent> = {},
  ): CalEvent => ({
    id: newId(),
    title,
    calendarId,
    start,
    end,
    allDay: false,
    tzid: "",
    location: "",
    url: "",
    notes: "",
    ...NEVER,
    seriesId: "",
    seriesKey: "",
    color: "",
    icon: "",
    task: false,
    doneKeys: [],
    free: false,
    remindLead: REMIND_INHERIT,
    organizer: null,
    attendees: [],
    attendeeCount: 0,
    // Demo data nobody wrote, so there is nothing here a merge should defend:
    // a first run is the one document in this app with no history, and the
    // first edit to one of these stamps it like any other change.
    updatedAt: 0,
    ...extra,
  });

  return [
    // Every other day, and it stops. A plain `daily` forever gave every day of
    // the year a mark, so the year ring read as a wall with no empty day left
    // in it — and an unbounded rule is also the one shape the editor's own
    // controls cannot show you being used.
    make("Morning run", "personal", at(7, 15), at(8, 0), {
      repeat: "daily",
      interval: 2,
      // Inclusive, and it bounds a *start*: the last run is the last
      // on-interval morning inside the month.
      until: addMonths(today, 1).getTime(),
      icon: "person-simple-run",
    }),
    make("Cas", "personal", at(10, 45), at(11, 30), { location: "Kitchen table" }),
    // The trip's colour rather than Personal's, because it is the trip. That
    // is the whole of what an event's own colour is for — a calendar is one
    // label and this is not a second one — and it is invisible as a feature
    // until two events on one calendar disagree about it.
    make("Packing", "personal", at(13, 15), at(13, 50), { color: PALETTE[6] }),
    // One task in the seed, because a pip on the rim is not a shape anybody
    // guesses at: the demo day has to contain the thing the feature is.
    make("Water the plants", "personal", at(18, 30), at(18, 30), { task: true }),
    make("Design review", "work", at(14, 0), at(16, 20), { location: "Studio" }),
    // Sky, not the Work violet under it: two arcs of one colour on adjacent
    // lanes are told apart by radius alone, and this pair is the only place
    // the face says anything about overlapping at all.
    make("Sync with Anna", "work", at(14, 15), at(15, 15), {
      url: "https://meet.example.com/x",
      color: PALETTE[1],
    }),
    make("Call home", "family", at(21, 10), at(21, 40)),
    // A week from tomorrow, and the only event here with no arc anywhere: an
    // all-day span is `Day 3/7` where the time column goes, seven lit marks on
    // the year ring and seven dots in the grid, and nothing at all on a dial.
    make("Trip", "personal", tomorrow.getTime(), addDays(tomorrow, 7).getTime(), {
      allDay: true,
      color: PALETTE[6],
      icon: "suitcase-rolling",
    }),
  ];
}

/* --------------------------------- state ---------------------------------- */

const EMPTY: Snapshot = {
  schema: SCHEMA,
  events: [],
  calendars: DEFAULT_CALENDARS,
  feeds: {},
  settings: DEFAULT_SETTINGS,
  // Nothing has been chosen and nothing deleted. The zero is what tells a
  // merge to decline: a document with no settings stamp is either one written
  // before stamping existed or one nobody has said anything to yet, and both
  // want today's adopt rather than a union of somebody else's calendar with a
  // demo day.
  settingsAt: 0,
  graves: [],
};

/**
 * Two keys that lost their shape rather than their meaning.
 *
 * `night` split into the pair `daylight` / `moonlight`: a blob still carrying
 * the old key keeps the choice it names — the dark half — and loses the key.
 * `moonPhase` was `off | minimal | aperture` while the sidebar had two
 * registers; with one drawing left it is the switch `moon`, and either
 * register counts as on. Neither is a `SCHEMA` bump: a bump resets settings,
 * and losing the choice is the thing this carries across.
 */
function migrateSettings(
  stored: Partial<Settings> & { night?: boolean; moonPhase?: string },
): Partial<Settings> {
  const { night, moonPhase, ...rest } = stored;
  return {
    ...(night === undefined ? {} : { moonlight: night }),
    ...(moonPhase === undefined ? {} : { moon: moonPhase !== "off" }),
    ...rest,
  };
}

/** Bounds on the life grid: 1 to 150 years, and a birth date that parses.
 *  A stored `NaN` here would draw a grid of `Invalid Date`. */
export const LIFE_EXPECTANCY_RANGE = { min: 1, max: 150 } as const;

/**
 * How long the year ring's line is allowed to be. The centre is a circle
 * roughly 300 units across at the readout's height, and a quote past this
 * either wraps into the ring or shrinks the year above it. Enforced here
 * rather than only on the input, because a backup can carry any string.
 */
export const YEAR_QUOTE_MAX = 72;

/**
 * The stored values that can be wrong rather than merely absent: a place with
 * no zone cannot be shown in its own picker, a remembered device zone has to
 * be one `Intl` still resolves, a life span has to be a date and a number of
 * years the grid can actually draw, and a position or a mode has to be one
 * the panel knows how to show.
 */
function sane(settings: Settings): Settings {
  const years = Math.round(settings.lifeExpectancy);
  // Clamped into the day before they are compared, so a value that only
  // needed rounding is not thrown away for the sin of the one beside it.
  const wakingFrom = Number.isFinite(settings.wakingFrom)
    ? clamp(Math.round(settings.wakingFrom), 0, MINUTES_PER_DAY)
    : DEFAULT_SETTINGS.wakingFrom;
  const wakingTo = Number.isFinite(settings.wakingTo)
    ? clamp(Math.round(settings.wakingTo), 0, MINUTES_PER_DAY)
    : DEFAULT_SETTINGS.wakingTo;
  // Both revert together rather than one clamping onto the other: an
  // inverted or zero-width window is a day with no free time in it, which
  // reads as a broken feature rather than a choice, and the pair is the
  // unit the setting was written as.
  const waking =
    wakingFrom < wakingTo
      ? { wakingFrom, wakingTo }
      : { wakingFrom: DEFAULT_SETTINGS.wakingFrom, wakingTo: DEFAULT_SETTINGS.wakingTo };
  return {
    ...settings,
    place: settings.place?.zone ? settings.place : null,
    // A zone nothing can resolve is worse here than none at all: the notice
    // compares it against the live one and would name a place that does not
    // exist, or ask about a move nobody made. `isZone` is the same probe
    // `backup.readEvent` puts a feed's TZID through, and `""` reads as a
    // first run — which is silent.
    deviceZone: isZone(settings.deviceZone) ? settings.deviceZone : "",
    // Storable wrong the same way, and worse when it is: a garbage entry here
    // scopes the Clear to nothing while the row still counts, so the verb
    // would be offered and do nothing. Deduplicated because it is a set of
    // zones written one journey at a time, and a repeat says nothing new.
    stampedZones: Array.isArray(settings.stampedZones)
      ? [
          ...new Set(
            settings.stampedZones.filter((zone) => typeof zone === "string" && isZone(zone)),
          ),
        ]
      : [],
    birth: /^\d{4}-\d{2}-\d{2}$/.test(settings.birth) ? settings.birth : "",
    lifeExpectancy: Number.isFinite(years)
      ? Math.min(LIFE_EXPECTANCY_RANGE.max, Math.max(LIFE_EXPECTANCY_RANGE.min, years))
      : DEFAULT_SETTINGS.lifeExpectancy,
    // Trimmed and capped, never rejected: a line the user typed is theirs,
    // and the only thing the face cannot survive is an unbounded one.
    yearQuote:
      typeof settings.yearQuote === "string"
        ? settings.yearQuote.trim().slice(0, YEAR_QUOTE_MAX)
        : DEFAULT_SETTINGS.yearQuote,
    totalsAt: TOTALS_POSITIONS.includes(settings.totalsAt)
      ? settings.totalsAt
      : DEFAULT_SETTINGS.totalsAt,
    arcLabels: ARC_LABEL_MODES.includes(settings.arcLabels)
      ? settings.arcLabels
      : DEFAULT_SETTINGS.arcLabels,
    ambientArcLabels: ARC_LABEL_MODES.includes(settings.ambientArcLabels)
      ? settings.ambientArcLabels
      : DEFAULT_SETTINGS.ambientArcLabels,
    // A delay off the list is a timer the panel cannot show, which is the
    // worst kind: the mode would arrive on a schedule nothing on screen names.
    ambientAfter: (AMBIENT_DELAYS as readonly number[]).includes(settings.ambientAfter)
      ? settings.ambientAfter
      : DEFAULT_SETTINGS.ambientAfter,
    // A lead off the list is a warning the panel cannot show, and unlike a
    // stale ambient delay this one is a notification arriving at a time
    // nothing on screen ever named.
    remindLead: REMIND_LEADS.includes(settings.remindLead)
      ? settings.remindLead
      : DEFAULT_SETTINGS.remindLead,
    // An interval off the list is a nudge on a schedule nothing on screen
    // names — the same fault a stale ambient delay is, and pinned the same way.
    backupInterval: (BACKUP_INTERVALS as readonly number[]).includes(settings.backupInterval)
      ? settings.backupInterval
      : DEFAULT_SETTINGS.backupInterval,
    // Clamped rather than dropped: a duration is a number the user typed, so
    // a value out of range is a slip rather than a corrupt record. The floor
    // is the editor's own minimum and the ceiling is a day — past that a
    // "default event" is an all-day one, which is a different thing.
    defaultDuration:
      Number.isFinite(settings.defaultDuration) && settings.defaultDuration > 0
        ? Math.min(MINUTES_PER_DAY, Math.max(MIN_DURATION, Math.round(settings.defaultDuration)))
        : DEFAULT_SETTINGS.defaultDuration,
    // Not checked against the calendars: this runs on load, and the list it
    // would be checked against can change in another tab a second later.
    // `defaultCalendarId` resolves it at the moment it is used.
    defaultCalendar: typeof settings.defaultCalendar === "string" ? settings.defaultCalendar : "",
    weekStart: WEEK_STARTS.includes(settings.weekStart)
      ? settings.weekStart
      : DEFAULT_SETTINGS.weekStart,
    ...waking,
  };
}

/**
 * The recurrence qualifiers and series-override fields a blob written before
 * them does not carry. Absent is not the same as wrong — an older event
 * simply has no interval — but `undefined` reaches the expansion maths as
 * `NaN`, which is a series that fires on no day at all. So they are filled
 * in here, at the one boundary, rather than guarded for at every read.
 *
 * The unchanged case returns the same object: `parse` runs again whenever
 * another tab writes, and rebuilding every event each time is a copy nobody
 * asked for. That fast path is why this is a *hydrator* and not a validator —
 * re-reading thirty fields of every event on every cross-tab write is a cost
 * the store refuses. It asks about shape; when the shape is wrong it hands
 * the rule to `readRecurrence`, which is the one place that decides what a
 * legal rule is, so the answer the store gives is the answer a backup and an
 * .ics import give.
 */
function hydrateEvents(value: unknown): CalEvent[] {
  if (!Array.isArray(value)) return [];
  return (value as CalEvent[]).map((event) => {
    const {
      interval,
      until,
      wkst,
      byMonth,
      byWeekNo,
      byYearDay,
      byMonthDay,
      byDay,
      byHour,
      byMinute,
      bySecond,
      bySetPos,
      exdates,
      rdates,
      seriesId,
      seriesKey,
      icon,
      task,
      doneKeys,
      free,
      remindLead,
      organizer,
      attendees,
      attendeeCount,
      tzid,
      updatedAt,
    } = event;
    if (
      typeof interval === "number" &&
      typeof until === "number" &&
      typeof wkst === "number" &&
      Array.isArray(byMonth) &&
      Array.isArray(byWeekNo) &&
      Array.isArray(byYearDay) &&
      Array.isArray(byMonthDay) &&
      Array.isArray(byDay) &&
      Array.isArray(byHour) &&
      Array.isArray(byMinute) &&
      Array.isArray(bySecond) &&
      Array.isArray(bySetPos) &&
      Array.isArray(exdates) &&
      Array.isArray(rdates) &&
      typeof seriesId === "string" &&
      typeof seriesKey === "string" &&
      typeof icon === "string" &&
      typeof task === "boolean" &&
      Array.isArray(doneKeys) &&
      typeof free === "boolean" &&
      // The one field asked about validity rather than only shape, and the
      // only one where the two differ: every neighbour here is a boolean, a
      // string or an array, where being the right type *is* being legal, but
      // a lead has a range. A stored `4000000` is a number, and left alone it
      // makes `dueReminders` scan a day seven years out, every minute, for
      // ever. Two integer comparisons in the common case is what that costs.
      remindLead === readRemindLead(remindLead) &&
      // Shape, like every neighbour but the lead: a stored guest list was
      // written by this app off `readGuests`, so being an array *is* being
      // legal here, and the boundaries that face a stranger — an `.ics` and a
      // backup's JSON — are the ones that re-read every row. `organizer` is
      // asked for null-or-object because `null` is its ordinary value and the
      // fast path has to recognise it; the count is asked about validity for
      // one cheap reason, that a stored `NaN` would print "and NaN others".
      (organizer === null || typeof organizer === "object") &&
      Array.isArray(attendees) &&
      Number.isInteger(attendeeCount) &&
      typeof tzid === "string" &&
      // Validity, like the lead and for the same shape of reason: a stored
      // `NaN` here is a number, and every merge comparison against it is an
      // inequality that silently answers `false`. A feed's mirrored events
      // come through here carrying `0` and keep it, which costs nothing — a
      // feed never merges, it is re-pulled whole.
      updatedAt === readStamp(updatedAt)
    ) {
      return event;
    }
    return {
      ...event,
      ...readRecurrence(event),
      seriesId: typeof seriesId === "string" ? seriesId : "",
      seriesKey: typeof seriesKey === "string" ? seriesKey : "",
      icon: typeof icon === "string" ? icon : "",
      task: task === true,
      doneKeys: Array.isArray(doneKeys) ? doneKeys : [],
      // Busy is what every event in a blob written before this field was
      // already doing, so the absent value and the default say the same
      // thing. It is in the shape question above as well as here: the fast
      // path returns the event untouched, so a field left out of it is a
      // field a stored blob never gains.
      free: free === true,
      // In the shape question above for the same reason `free` is: a field
      // left out of the fast path is a field a stored blob never gains, so
      // an event written before this one existed would keep arriving without
      // it and reach `leadOf` as `undefined` — neither of the three states,
      // and silently not the inheriting one.
      remindLead: readRemindLead(remindLead),
      // A blob written before the invite path existed carries no guests at
      // all, which is what those events had: nobody asked them. In the shape
      // question above for `free`'s reason — a field left out of the fast path
      // is a field a stored blob never gains, and `attendees` reaching the
      // editor as `undefined` is a crash rather than an empty list.
      organizer: readPerson(organizer),
      ...readGuests(attendees, attendeeCount),
      // A blob written before this field existed carries every event
      // floating, which is what those events already were — nothing zoned
      // an event but `fromIcs`'s own DTSTART reader.
      tzid: typeof tzid === "string" ? tzid : "",
      // A blob written before stamping existed says `0` for every event, and
      // that is the answer the merge needs: an unstamped record cannot be
      // compared with a stamped one, so a document full of them is one the
      // merge declines rather than one whose every event loses.
      updatedAt: readStamp(updatedAt),
    };
  });
}

/**
 * The same boundary, for calendars. A blob written before marks existed has no
 * `icon`, and `undefined` would reach `isIconName` as a crash rather than as a
 * missing glyph. Same unchanged-returns-the-same-array rule and the same
 * reason: this runs on every cross-tab write.
 *
 * No `SCHEMA` bump — nothing stored changed *meaning*, a field arrived.
 */
function hydrateCalendars(value: unknown): Calendar[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_CALENDARS;
  return (value as Calendar[]).map((calendar) =>
    // The stamp is asked about validity rather than shape, `readStamp`'s own
    // reason: every merge decision about this record is an inequality on it.
    typeof calendar.icon === "string" && calendar.updatedAt === readStamp(calendar.updatedAt)
      ? calendar
      : {
          ...calendar,
          icon: typeof calendar.icon === "string" ? calendar.icon : "",
          updatedAt: readStamp(calendar.updatedAt),
        },
  );
}

function parse(stored: Partial<Snapshot>): Persisted {
  // A stale schema means the stored values no longer mean what they say.
  const settings =
    stored.schema === SCHEMA
      ? { ...DEFAULT_SETTINGS, ...migrateSettings(stored.settings ?? {}) }
      : DEFAULT_SETTINGS;
  return {
    schema: SCHEMA,
    events: hydrateEvents(stored.events),
    calendars: hydrateCalendars(stored.calendars),
    // Both of these can be stored *wrong* rather than merely missing, and both
    // draw something broken if they are.
    settings: sane(settings),
    settingsAt: readStamp(stored.settingsAt),
    // Dropped on read rather than on write, which is the only place the
    // passage of time can be noticed: nothing mutates a grave, so a TTL
    // enforced at the write would keep every one of them until the next
    // deletion. `pruneGraves` is the merge's own rule, called here so the two
    // cannot come to disagree about how long a deletion is remembered.
    graves: pruneGraves(readGraves(stored.graves), Date.now()),
  };
}

/* ----------------------------- feed payloads ------------------------------ */

/** `localStorage`, or `null` where there is none — SSR, and a browser that
 *  refuses the API outright rather than throwing on use. */
function disk(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * id → the exact string read from its key, and what it hydrated to.
 *
 * `fresh()` runs on every action and feeds are the one unbounded thing it
 * reads; without this, a single subscription re-parses thousands of events
 * every time you nudge an arc. Reference-stable output is also what lets
 * `sameFeeds` tell a real change from a re-read.
 */
const feedCache = new Map<string, { raw: string; events: CalEvent[] }>();

/** Every subscription's cached events, by calendar id. */
function readFeeds(calendars: Calendar[]): Record<string, CalEvent[]> {
  const store = disk();
  if (!store) return {};
  const feeds: Record<string, CalEvent[]> = {};
  const live = new Set<string>();
  for (const calendar of calendars) {
    if (!calendar.feed) continue;
    live.add(calendar.id);
    const raw = store.getItem(feedKey(calendar.id));
    if (raw === null) continue;
    const hit = feedCache.get(calendar.id);
    if (hit?.raw === raw) {
      feeds[calendar.id] = hit.events;
      continue;
    }
    try {
      const events = hydrateEvents(JSON.parse(raw));
      feedCache.set(calendar.id, { raw, events });
      feeds[calendar.id] = events;
    } catch {
      // A corrupt payload is a cache miss, not a crash: the next pull replaces
      // it, and until then the calendar simply draws nothing.
    }
  }
  for (const id of feedCache.keys()) if (!live.has(id)) feedCache.delete(id);
  return feeds;
}

/** Same keys, same arrays — so `fresh()` can leave the snapshot alone. */
function sameFeeds(a: Record<string, CalEvent[]>, b: Record<string, CalEvent[]>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((id) => a[id] === b[id]);
}

/**
 * Payloads whose calendar is gone — removed in another tab, or dropped by a
 * restore. Nothing will ever read them again and they are the largest thing
 * in storage, so they are swept wherever the calendar list is replaced.
 *
 * Keys are collected before any are removed: `key(i)` walks a list that
 * shortens under a `removeItem`, and every second orphan would survive.
 */
function sweepFeeds(calendars: Calendar[]) {
  const store = disk();
  if (!store) return;
  const live = new Set(calendars.filter((c) => c.feed).map((c) => c.id));
  const orphans: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(FEED_PREFIX) && !live.has(key.slice(FEED_PREFIX.length))) orphans.push(key);
  }
  for (const key of orphans) {
    store.removeItem(key);
    feedCache.delete(key.slice(FEED_PREFIX.length));
  }
}

function dropFeed(id: string) {
  feedCache.delete(id);
  disk()?.removeItem(feedKey(id));
}

/** What one subscription may spend, given how many are sharing the budget. */
function feedBudget(calendars: Calendar[]): number {
  return Math.floor(FEED_BUDGET / Math.max(1, calendars.filter((c) => c.feed).length));
}

const grouped = (n: number) => n.toLocaleString("en-US");

/**
 * The events kept when the whole set will not fit.
 *
 * Recurring events first — a rule is a few hundred characters that describe
 * years, so dropping one to make room for a dated event is the worst trade on
 * the table — then nearest today, outwards in both directions. The kept set
 * is returned in the feed's own order: a trimmed cache should differ from a
 * whole one only by what is missing.
 */
function trimFeed(events: CalEvent[], budget: number): CalEvent[] {
  const now = Date.now();
  const distance = (e: CalEvent) => (e.repeat === "never" ? Math.abs(e.start - now) : 0);
  const sized = events.map((e) => ({ e, size: JSON.stringify(e).length + 1 }));

  const kept = new Set<CalEvent>();
  let used = 2; // The brackets.
  for (const { e, size } of [...sized].sort((a, b) => distance(a.e) - distance(b.e))) {
    if (used + size > budget) break;
    used += size;
    kept.add(e);
  }
  return events.filter((e) => kept.has(e));
}

/**
 * Persist one feed's events, within `budget`, and say what did not fit.
 *
 * Both failures are reported on the calendar's own meta line rather than as a
 * toast: a subscription is a background thing, and the panel that lists it is
 * the place its state belongs. That line is one `.label` wide and truncates,
 * so both messages lead with the fact and keep it under twenty characters —
 * a fault whose text is cut off before it says anything is a decoration.
 *
 * Overflow trims *and* counts, because a feed silently drawing two thirds of
 * itself is exactly what this split exists to make visible. A refused write
 * keeps the events in memory: the session works, the reload will not.
 */
function storeFeed(
  id: string,
  events: CalEvent[],
  budget: number,
): { cached: CalEvent[]; error: string } {
  let cached = events;
  let raw = JSON.stringify(events);
  let error = "";
  if (raw.length > budget) {
    cached = trimFeed(events, budget);
    raw = JSON.stringify(cached);
    error = `${grouped(cached.length)}/${grouped(events.length)} cached`;
  }
  try {
    disk()?.setItem(feedKey(id), raw);
    feedCache.set(id, { raw, events: cached });
  } catch {
    // No room even for the trimmed set. Drop the key rather than leave a stale
    // payload claiming to be this pull.
    dropFeed(id);
    return { cached, error: "Not cached — no room" };
  }
  return { cached, error };
}

/**
 * A blob written before feeds had keys of their own carries them inline. Move
 * them across once, then rewrite the blob without them — leave it and the
 * next launch reads and moves the same megabytes again.
 *
 * Deliberately not a `SCHEMA` bump: a bump resets settings, and where a
 * payload is stored is not something a setting means.
 */
function migrateFeeds(legacy: Record<string, unknown>, base: Persisted) {
  const store = disk();
  if (!store) return;
  const budget = feedBudget(base.calendars);
  for (const [id, events] of Object.entries(legacy)) {
    if (store.getItem(feedKey(id)) === null) storeFeed(id, hydrateEvents(events), budget);
  }
  try {
    const raw = JSON.stringify(base);
    store.setItem(KEY, raw);
    lastRaw = raw;
  } catch {
    // The payloads are already out of the blob, where they can be dropped
    // independently, and the next successful write finishes the job — but the
    // blob still carries the megabytes that would not fit, so every launch
    // will do this again until something gives. Same failure `write` reports
    // and the same reason for reporting it: a storage refusal the user cannot
    // see is one they cannot act on.
    notify("Not saved — this browser is refusing to store data", "error");
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The snapshot a blob describes, with its feed keys attached — and the one
 * place a legacy inline `feeds` field is moved out of the way.
 *
 * Shared by `load()` and `fresh()` because either can be the first to see a
 * blob: hydration happens at the first `subscribe`, but anything acting
 * before that reaches `fresh()` instead, and a migration only one of them ran
 * would depend on which. Sweeping here is safe against another tab mid-pull —
 * a subscription's calendar is committed to the blob before its payload is
 * ever written, so the calendars read a line above already know about it.
 */
function hydrate(raw: string): Snapshot {
  const stored: Partial<Snapshot> = JSON.parse(raw);
  const base = parse(stored);
  if (stored.feeds) migrateFeeds(stored.feeds, base);
  sweepFeeds(base.calendars);
  return { ...base, feeds: readFeeds(base.calendars) };
}

/**
 * The snapshot a browser with nothing stored starts from. The only place
 * `weekStart` is defaulted to the reader's own locale rather than to Monday:
 * a stored blob keeps whatever it already had, so this cannot overwrite a
 * choice, and it is not a `SCHEMA` bump because where a default came from is
 * not a change of meaning. Only reached with a real `Storage` in hand — SSR
 * and the MCP server's Node return `EMPTY` a line above and never arrive
 * here — so `navigator` exists; `globalThis` keeps it total anyway.
 */
function freshInstall(): Snapshot {
  const weekStart = weekStartFor(globalThis.navigator?.language ?? "");
  return { ...EMPTY, events: seed(), settings: { ...DEFAULT_SETTINGS, weekStart } };
}

function load(): Snapshot {
  const store = disk();
  if (!store) return EMPTY;
  try {
    const raw = store.getItem(KEY);
    lastRaw = raw;
    return raw ? hydrate(raw) : freshInstall();
  } catch {
    // A corrupted blob must not brick the app; start clean rather than throw.
    // But an empty dial is what this app looks like on its first run, so
    // saying nothing here is indistinguishable from the calendar having been
    // eaten — the same argument the error boundary makes, one layer down.
    notify("Saved data could not be read — starting empty", "error");
    return EMPTY;
  }
}

let snapshot: Snapshot = EMPTY;
/** The blob as this tab last saw it. A different string means someone else wrote. */
let lastRaw: string | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

/**
 * Undo is in-memory and session-scoped: a reload starts fresh.
 *
 * A step is the snapshot to go back to, plus whether the action that created
 * it owns the *settings* in it. Almost none do — `setClock` and its siblings
 * commit with `record: false`, so they never push a step at all, and an undo
 * that restored the recorded settings wholesale would silently roll back a
 * setting the user changed after the step they are undoing. `restore` is the
 * one action that legitimately replaces settings as part of an undoable
 * change, so it is the one that sets this.
 */
interface UndoStep {
  snapshot: Snapshot;
  ownsSettings: boolean;
}

const UNDO_DEPTH = 60;
let past: UndoStep[] = [];
let future: UndoStep[] = [];

function emit() {
  for (const listener of listeners) listener();
}

/**
 * The part of a snapshot an undo step can restore, as a string.
 *
 * `feeds` is a live mirror of somebody else's calendar and is never undoable,
 * and a feed pull also stamps `fetchedAt` on the calendar it belongs to — so
 * neither counts as the base moving. `graves` and `settingsAt` are out for a
 * second reason: a grave list is pruned on every read, so a tab that sat idle
 * past a grave's ninetieth day would read the passage of time as another tab
 * having written and throw away sixty undo steps for it. Neither can move
 * without `events` or `settings` moving with it, so nothing is missed.
 * Everything else does count.
 */
function baseSignature(s: Snapshot): string {
  return JSON.stringify([
    s.events,
    s.calendars.map(({ feed: _feed, ...rest }) => rest),
    s.settings,
  ]);
}

/**
 * The snapshot, re-read if another tab has written since we last looked.
 *
 * Every action derives its next state from this rather than from the module's
 * `snapshot`, which closes the window between another tab's write and the
 * `storage` event that tells us about it. Without it, two tabs editing in the
 * same second silently drop one tab's event.
 */
function fresh(): Snapshot {
  const store = disk();
  if (!store) return snapshot;
  try {
    const raw = store.getItem(KEY);
    if (raw !== lastRaw) {
      lastRaw = raw;
      snapshot = raw ? hydrate(raw) : EMPTY;
      return snapshot;
    }
    // The blob has not moved, but a feed lives in a key of its own — another
    // tab pulling a subscription changes nothing this comparison can see.
    const feeds = readFeeds(snapshot.calendars);
    if (!sameFeeds(feeds, snapshot.feeds)) snapshot = { ...snapshot, feeds };
  } catch {
    // Unreadable storage is the same situation as no storage: keep going on
    // what is in memory.
  }
  return snapshot;
}

function write(next: Snapshot) {
  snapshot = next;
  try {
    // Without `feeds`: they are persisted a key at a time by `storeFeed`, and
    // serialising them here as well is what put somebody else's calendar in
    // competition with yours for one quota.
    const { feeds: _feeds, ...persisted } = next;
    const raw = JSON.stringify(persisted);
    localStorage.setItem(KEY, raw);
    lastRaw = raw;
  } catch {
    // Private mode, or the quota is full. The session keeps working on the
    // in-memory snapshot, but nothing here will survive the reload — and that
    // is exactly the failure the user has to hear about, because the UI is
    // otherwise indistinguishable from a successful save.
    notify("Not saved — this browser is refusing to store data", "error");
  }
  emit();
}

/**
 * `record: false` for changes not worth an undo step (settings, feed pulls).
 * `ownsSettings` for the one undoable change that also replaces settings.
 */
function commit(next: Snapshot, record = true, ownsSettings = false) {
  if (record) {
    past.push({ snapshot, ownsSettings });
    if (past.length > UNDO_DEPTH) past.shift();
    future = [];
  }
  write(next);
}

/**
 * A settings change, stamped.
 *
 * Every action that replaces `settings` goes through here, so there is one
 * answer to when the whole object was last written — which is all a merge
 * reads (`merge.ts`, rule 5). Stamped unconditionally rather than only when a
 * value actually moved: a settings action already commits and already writes
 * the blob, and a comparison of thirty-eight fields to save the mirror one
 * write is a cost in the wrong place.
 *
 * `setDeviceZone` is the one settings write that does **not** come through
 * here, and it says why on itself.
 */
function withSettings(base: Snapshot, settings: Settings): Snapshot {
  return { ...base, settings, settingsAt: Date.now() };
}

/**
 * A recorded step, rebased onto whatever is true *now* for the parts an undo
 * step does not own, and stamped as the change it is. Feeds are a live mirror
 * and never owned; settings are owned only by `restore`.
 *
 * The stamping is what stops an undo from being silently reverted. A step
 * carries the events as they were, *with the stamps they had*, so an undo of
 * yesterday's edit would put back a record the other machine's copy outranks
 * — and the next merge would undo the undo, with nothing on screen to say so.
 * An undo is a change the user just made, so `restamped` treats it as one:
 * what it alters is stamped now, and what it removes (undoing a creation) is
 * buried rather than merely dropped.
 */
function rebase(step: UndoStep, current: Snapshot): Snapshot {
  const now = Date.now();
  return {
    ...step.snapshot,
    ...restamped(step.snapshot, current, now),
    feeds: current.feeds,
    settings: step.ownsSettings ? step.snapshot.settings : current.settings,
    // The settings that are being put back are being written now, and the ones
    // that are not owned have not moved — so the stamp follows whichever of the
    // two this step is carrying.
    settingsAt: step.ownsSettings ? now : current.settingsAt,
  };
}

/**
 * The external-store subscription `useStore` is built on.
 *
 * Exported because it is the whole of this module's cross-tab behaviour — the
 * `storage` listener that decides when another tab's write invalidates our
 * undo history lives here and nowhere else, and a contract reachable only
 * through a mounted React tree cannot be defended by a test.
 */
export function subscribe(listener: () => void): () => void {
  // First subscriber pulls localStorage in. Doing it at module scope would run
  // during SSR bundling and during hydration, before the client has committed —
  // this keeps the first render deterministic.
  if (!hydrated) {
    hydrated = true;
    snapshot = load();
  }
  listeners.add(listener);

  const onStorage = (e: StorageEvent) => {
    // A feed key is another tab pulling a subscription. Re-read the mirror and
    // leave the history alone: a payload is never part of the base, so it can
    // never be the thing an undo step would land on top of.
    if (e.key?.startsWith(FEED_PREFIX)) {
      const feeds = readFeeds(snapshot.calendars);
      if (sameFeeds(feeds, snapshot.feeds)) return;
      snapshot = { ...snapshot, feeds };
      emit();
      return;
    }
    if (e.key !== KEY) return;
    const before = baseSignature(snapshot);
    snapshot = load();
    // Undoing onto a base another tab has moved on from would resurrect the
    // events it just deleted. Ours is the stale history; drop it.
    //
    // But only when the base actually moved. A feed pull in a background tab
    // still stamps `fetchedAt` on the calendar, and dropping sixty steps of
    // the foreground tab's history because a subscription refreshed itself is
    // a data loss the user cannot even attribute to anything they did.
    if (baseSignature(snapshot) !== before) {
      past = [];
      future = [];
    }
    emit();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStore(): Snapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

/**
 * A holding name for a subscription until its ICS says what it is called.
 * Exported because the settings panel names a feed the same way when adding
 * it, and `setFeedEvents` recognises that name as "still a placeholder".
 */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Subscription";
  }
}

/* --------------------------------- actions -------------------------------- */

export const store = {
  /**
   * The current state, outside React. For the two callers that act on the
   * whole store rather than render it — export, and the launch-time feed pull
   * — where a value captured in a mount effect's closure would be the
   * pre-hydration snapshot.
   */
  snapshot(): Snapshot {
    return fresh();
  },

  create(event: Omit<CalEvent, "id">): CalEvent {
    const base = fresh();
    // Stamped here rather than in the draft: `draftEvent` and `duplicateOf`
    // hand back `0`, because a record nobody has saved has not been changed,
    // and this is the line where it becomes a record at all.
    const created: CalEvent = { ...event, id: newId(), updatedAt: Date.now() };
    commit({ ...base, events: [...base.events, created] });
    return created;
  },

  update(id: string, patch: Partial<CalEvent>) {
    const base = fresh();
    commit({ ...base, events: applyUpdate(base.events, id, patch, Date.now()) });
  },

  /** Recorded in history like any other edit — a tick is a keystroke away and
   *  ⌘Z is the only way back from the wrong one. */
  toggleDone(id: string, at: Date | number) {
    const base = fresh();
    commit({ ...base, events: applyToggleDone(base.events, id, at, Date.now()) });
  },

  /** The graves ride in the same commit as the removal, which is what makes
   *  them believable: a deletion that landed without its grave is an id the
   *  next merge brings straight back. */
  remove(id: string) {
    const base = fresh();
    const removed = applyRemove(base.events, id, Date.now());
    commit({ ...base, events: removed.events, graves: [...base.graves, ...removed.graves] });
  },

  /** One commit, not two — a second would be a second ⌘Z press for one edit,
   *  and the state between them would be a series with no future. */
  splitSeries(id: string, at: number, tail: Omit<CalEvent, "id">): CalEvent | null {
    const base = fresh();
    const split = applySplit(base.events, id, at, tail, newId, Date.now());
    if (!split.created) return null;
    commit({ ...base, events: split.events });
    return split.created;
  },

  truncateSeries(id: string, at: number) {
    const base = fresh();
    const cut = applyTruncate(base.events, id, at, Date.now());
    commit({ ...base, events: cut.events, graves: [...base.graves, ...cut.graves] });
  },

  /* ------------------------------ calendars ------------------------------- */

  toggleCalendar(id: string) {
    const base = fresh();
    const now = Date.now();
    commit(
      {
        ...base,
        // Stamped like any other change to the record. Visibility is stored
        // state, so a merge that ignored it would put a calendar the user
        // hid on this machine back on the face from the other one.
        calendars: base.calendars.map((c) =>
          c.id === id ? { ...c, visible: !c.visible, updatedAt: now } : c,
        ),
      },
      false,
    );
  },

  /**
   * A calendar of one's own. The colour is the caller's when it named one, and
   * otherwise the next step round the palette — the same walk a feed and an
   * import already take, so three ways of arriving at a calendar do not
   * disagree about what colour the next one is.
   */
  addCalendar(name: string, color?: string, icon = ""): Calendar {
    const base = fresh();
    const calendar: Calendar = {
      id: newId(),
      name,
      color: color || PALETTE[(base.calendars.length * 3) % PALETTE.length],
      icon,
      visible: true,
      updatedAt: Date.now(),
    };
    commit({ ...base, calendars: [...base.calendars, calendar] });
    return calendar;
  },

  /**
   * Rename, recolour, remark. A subscription may be renamed here too, and the
   * rename sticks: `setFeedEvents` only takes the host's name while the
   * calendar is still carrying the placeholder it was given before the first
   * pull.
   */
  updateCalendar(id: string, patch: Partial<Pick<Calendar, "name" | "color" | "icon">>) {
    const base = fresh();
    const now = Date.now();
    commit({
      ...base,
      calendars: base.calendars.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now } : c)),
    });
  },

  /**
   * Removes a calendar and *keeps* its events. A subscription's payload lives
   * in `feeds` and goes with it, but the user's own events are moved to the
   * first calendar still standing: a calendar is a label, and deleting a label
   * is not a way to ask for a year of appointments to be deleted with it.
   *
   * `null` when it may not go — the last calendar that is not a feed stays,
   * because every new event needs somewhere to be written and a `calendarId`
   * nothing resolves is an event with no colour and no visibility switch.
   */
  removeCalendar(id: string): { into: Calendar | null; moved: number } | null {
    const base = fresh();
    const target = base.calendars.find((c) => c.id === id);
    if (!target) return null;
    const rest = base.calendars.filter((c) => c.id !== id);
    const into = rest.find((c) => !c.feed) ?? null;
    if (!target.feed && !into) return null;
    const moved = base.events.filter((e) => e.calendarId === id).length;
    if (moved > 0 && !into) return null;
    const { [id]: _dropped, ...feeds } = base.feeds;
    dropFeed(id);
    const now = Date.now();
    commit({
      ...base,
      calendars: rest,
      events:
        moved === 0 || !into
          ? base.events
          : // Reparenting is an edit to each event, so each one is stamped:
            // unstamped, the other machine's copies still point at the
            // calendar this just buried, and they would win.
            base.events.map((e) =>
              e.calendarId === id ? { ...e, calendarId: into.id, updatedAt: now } : e,
            ),
      // A calendar is a record like any other, so its deletion leaves the same
      // mark. Without it the other machine's copy of the calendar comes back
      // on the next merge, taking the events this action just reparented with
      // it — the label would return and the reparenting would look undone.
      graves: [...base.graves, { id, at: now }],
      feeds,
    });
    return { into, moved };
  },

  /* ------------------------------- settings ------------------------------- */

  setClock(clock: Clock) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, clock }), false);
  },

  setTotalsAt(totalsAt: TotalsPosition) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, totalsAt }), false);
  },

  setArcLabels(arcLabels: ArcLabelMode) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, arcLabels }), false);
  },

  setAmbientArcLabels(ambientArcLabels: ArcLabelMode) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, ambientArcLabels }), false);
  },

  /** Minutes of warning before an event starts; `0` fires as it does. */
  setRemindLead(remindLead: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, remindLead })), false);
  },

  /** Days without a `.json` backup before the main-screen nudge appears;
   *  `sane()` pins a stray value to one `BACKUP_INTERVALS` offers. */
  setBackupInterval(backupInterval: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, backupInterval })), false);
  },

  /** How long ⌘N and a quick-add line with no length make an event. Sanitised
   *  because it comes from a field somebody types into. */
  setDefaultDuration(defaultDuration: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, defaultDuration })), false);
  },

  /** The calendar a new event lands on; `""` is "the first one that is not a
   *  subscription", which is also what a since-deleted id falls back to. */
  setDefaultCalendar(defaultCalendar: string) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, defaultCalendar }), false);
  },

  /** Minutes of stillness before the dial takes the window; `0` is never. */
  setAmbientAfter(ambientAfter: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, ambientAfter })), false);
  },

  /** `""` turns the second ring off. */
  setSecondZone(secondZone: string) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, secondZone }), false);
  },

  /* --------------------------------- travel -------------------------------- */

  /**
   * Remember the zone this browser is in, having asked nothing. The first
   * launch's silent write, and nothing else: every other path through here
   * moves the zone *and* answers for the events in one commit, because the
   * two must not be separable — a stamped zone with the old device zone
   * still recorded would ask the same question again on the next launch.
   *
   * The one settings write that does **not** stamp `settingsAt`, and the
   * omission is load-bearing rather than an oversight. This fires
   * unprompted on the first launch of a browser that holds nothing but seed
   * data, and a stamp there would make that demo day a document the merge is
   * willing to union into somebody's real calendar the moment they connect
   * their mirror file — eight events nobody wrote, propagated to both
   * machines. It is also the only write here that is not a *choice*: the app
   * is recording where it is, and `merge.ts` compares choices.
   */
  setDeviceZone(deviceZone: string) {
    const base = fresh();
    commit({ ...base, settings: { ...base.settings, deviceZone } }, false);
  },

  /**
   * "Move them with me": every floating event's wall clock survives the
   * journey, so a 09:00 meeting is 09:00 where you now are. Returns how many
   * events actually moved, for the notice.
   *
   * **One commit, recorded**, which is the safety net that makes either answer
   * survivable: one ⌘Z puts every instant back. The device zone rides in the
   * same commit — two would be two undo presses for one decision, and the
   * state between them is a calendar that has been moved and is about to be
   * asked about again.
   *
   * It is deliberately *not* `ownsSettings`, and that is why undoing either
   * answer restores the events without winding the remembered zone back: an
   * undo that "fully" undid this would put the prompt straight back in front
   * of somebody who has already answered it. A reader tidying that asymmetry
   * away is reintroducing the loop — leave it.
   */
  moveEventsToZone(from: string, to: string): number {
    const base = fresh();
    const now = Date.now();
    // Stamped where they moved, and nowhere else: `movedEvents` hands back the
    // same object for an event it did not touch, which is the comparison the
    // count below already trusts.
    const events = movedEvents(base.events, from, to).map((e, i) =>
      e === base.events[i] ? e : { ...e, updatedAt: now },
    );
    const moved = events.reduce((n, e, i) => (e === base.events[i] ? n : n + 1), 0);
    commit({
      ...base,
      events,
      settings: { ...base.settings, deviceZone: to },
      settingsAt: now,
    });
    return moved;
  },

  /**
   * "Keep them as they are": instants untouched, and every floating event
   * stamped with the zone it was written in so the app can go on saying so.
   * Same one recorded commit, and the same deliberate lack of `ownsSettings`,
   * for the reasons above.
   *
   * `from` is recorded in `stampedZones` in that same commit — it is the only
   * record of which zones on these events this app put there rather than an
   * `.ics` import, and the settings row's Clear is scoped to it.
   */
  keepEventsInZone(from: string, to: string): number {
    const base = fresh();
    const now = Date.now();
    const events = keptEvents(base.events, from, to).map((e, i) =>
      e === base.events[i] ? e : { ...e, updatedAt: now },
    );
    const stamped = events.reduce((n, e, i) => (e === base.events[i] ? n : n + 1), 0);
    // Only when something actually took the stamp: an answer that changed
    // nothing must not leave a zone behind for the row to count against.
    const zones = countStamped(events, [from]) > 0 ? [from] : [];
    commit({
      ...base,
      events,
      settings: {
        ...base.settings,
        deviceZone: to,
        stampedZones: [...new Set([...base.settings.stampedZones, ...zones])],
      },
      settingsAt: now,
    });
    return stamped;
  },

  /**
   * The stamps this app applied, taken back off in one undoable step — and
   * only those: an imported `.ics` event's zone came out of a file and is not
   * this row's to flatten (see `travel.ts`'s `stampedBy`).
   *
   * The remembered zones are emptied in the same commit, since nothing carries
   * them afterwards and a list left behind is a row offering to clear nothing.
   *
   * This is the one travel action that **does** own its settings, which is the
   * opposite of the two answers above and for a different question: no prompt
   * is at stake here, and an undo that brought the stamps back but not the
   * list that names them would leave them on the events with no way to take
   * them off again. It is `restore`'s trade, one row wide.
   */
  clearEventZones(): number {
    const base = fresh();
    const zones = base.settings.stampedZones;
    const cleared = countStamped(base.events, zones);
    if (cleared === 0) return 0;
    const now = Date.now();
    commit(
      {
        ...base,
        events: clearedStamps(base.events, zones).map((e, i) =>
          e === base.events[i] ? e : { ...e, updatedAt: now },
        ),
        settings: { ...base.settings, stampedZones: [] },
        settingsAt: now,
      },
      true,
      true,
    );
    return cleared;
  },

  setPlace(place: PickedPlace | null) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, place }), false);
  },

  /**
   * The year ring's standing line. Capped but deliberately not trimmed: this
   * runs on every keystroke, and a `trim()` here eats the space between two
   * words the moment it is typed.
   */
  setYearQuote(yearQuote: string) {
    const base = fresh();
    commit(
      withSettings(base, { ...base.settings, yearQuote: yearQuote.slice(0, YEAR_QUOTE_MAX) }),
      false,
    );
  },

  /**
   * The life span. `birth` is a `YYYY-MM-DD` day key or `""`; both go through
   * the same clamp the stored blob does, because the prompt's number field can
   * hand over an empty string and a life of `NaN` years draws nothing.
   */
  setLife(birth: string, lifeExpectancy: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, birth, lifeExpectancy })), false);
  },

  /** Which weekday the strip, the mini-month and the life grid all cut their
   *  columns on. `sane()` is what pins a stray value to one of the three the
   *  picker offers. */
  setWeekStart(weekStart: WeekStart) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, weekStart })), false);
  },

  /** The window free time is counted against, in minutes since midnight.
   *  `sane()` is what reverts an inverted or zero-width pair to the default —
   *  both fields travel together because the shape the setting is wrong in
   *  is the pair, not either half of it. */
  setWaking(wakingFrom: number, wakingTo: number) {
    const base = fresh();
    commit(withSettings(base, sane({ ...base.settings, wakingFrom, wakingTo })), false);
  },

  /**
   * Every boolean setting, each its own switch. Derived from `Settings`
   * rather than listed: the list was already six names long, and a seventh
   * switch should not be able to exist without a way to set it.
   */
  setToggle(key: BooleanSetting, on: boolean) {
    const base = fresh();
    commit(withSettings(base, { ...base.settings, [key]: on }), false);
  },

  /* ----------------------------- subscriptions ---------------------------- */

  /** Starts empty; `lib/feeds.ts` pulls it and fills `Snapshot.feeds`. */
  addFeed(url: string, name: string): Calendar {
    const base = fresh();
    const calendar: Calendar = {
      id: newId(),
      name,
      color: PALETTE[(base.calendars.length * 3) % PALETTE.length],
      // A subscription is somebody else's calendar and there is nothing to
      // read its subject off; the mark stays the dot until you name one.
      icon: "",
      visible: true,
      updatedAt: Date.now(),
      feed: { url, fetchedAt: 0, error: "" },
    };
    commit({ ...base, calendars: [...base.calendars, calendar] }, false);
    return calendar;
  },

  /**
   * Replaces the feed's cached events wholesale — a pull is not a merge.
   * `name` renames the calendar only when it is still the host placeholder the
   * user was given before the feed said what it was actually called.
   *
   * The payload is written to its own key *before* the commit, so what the
   * dial draws is exactly what survives a reload: `storeFeed` may keep less
   * than it was handed, and a snapshot holding the full set while the disk
   * holds two thirds of it is the same lie this file's first rule is about.
   */
  setFeedEvents(id: string, events: CalEvent[], name?: string) {
    const base = fresh();
    const target = base.calendars.find((c) => c.id === id);
    if (!target) return;
    const rename = name && target.feed && target.name === hostLabel(target.feed.url);
    const { cached, error } = storeFeed(id, events, feedBudget(base.calendars));
    commit(
      {
        ...base,
        calendars: base.calendars.map((c) =>
          c.id === id && c.feed
            ? {
                ...c,
                name: rename ? name : c.name,
                feed: { ...c.feed, fetchedAt: Date.now(), error },
              }
            : c,
        ),
        feeds: { ...base.feeds, [id]: cached },
      },
      false,
    );
  },

  setFeedError(id: string, error: string) {
    const base = fresh();
    commit(
      {
        ...base,
        calendars: base.calendars.map((c) =>
          c.id === id && c.feed ? { ...c, feed: { ...c.feed, error } } : c,
        ),
      },
      false,
    );
  },

  /* -------------------------------- import -------------------------------- */

  /**
   * Adds a calendar and its events in one undoable step. The caller supplies
   * each event's own id — an .ics import must know a parent's id before its
   * override does, to write it into `seriesId`, and generating it here would
   * be too late for that.
   */
  addCalendarWithEvents(name: string, events: Omit<CalEvent, "calendarId">[]): Calendar {
    const base = fresh();
    const now = Date.now();
    const calendar: Calendar = {
      id: newId(),
      name,
      color: PALETTE[(base.calendars.length * 3) % PALETTE.length],
      icon: "",
      visible: true,
      updatedAt: now,
    };
    commit({
      ...base,
      calendars: [...base.calendars, calendar],
      // Stamped here rather than by the caller, which is the same bargain
      // `create` strikes: an import is where these records begin to exist, and
      // `importIcs` hands over drafts carrying `0`.
      events: [
        ...base.events,
        ...events.map((e) => ({ ...e, calendarId: calendar.id, updatedAt: now })),
      ],
    });
    return calendar;
  },

  /**
   * Whole-store restore from a backup. One undo step, so a misfire is not
   * fatal.
   *
   * Restamped, and `adopt` below deliberately is not — the asymmetry is the
   * point, and a reader tidying it into consistency is reintroducing the bug
   * this work exists to fix. A restore is a file the *user* chose to make
   * true, so it is a change they just made and it should win the next merge;
   * an adopt is a document from outside this browser, and restamping that
   * would make whichever machine adopted last win every merge wholesale.
   * `restamped` also buries what the backup does not carry, which is what
   * stops the other machine resurrecting every event this restore dropped.
   */
  restore(next: Pick<Snapshot, "events" | "calendars" | "settings" | "settingsAt" | "graves">) {
    // Only for its side effect: `commit` records the *current* snapshot as the
    // step to undo onto, and a stale one would undo into another tab's past.
    fresh();
    // A backup carries subscriptions but never their payloads, so a restore
    // that drops one has to drop its cache too — nothing would ever read those
    // megabytes again, and they are the largest thing in storage. Undoing back
    // to the subscription brings the calendar, not the mirror; it re-pulls.
    sweepFeeds(next.calendars);
    const now = Date.now();
    commit(
      {
        schema: SCHEMA,
        ...restamped(next, snapshot, now),
        // Through the same clamp a stored blob goes through: a backup is
        // external input, and `readSettings` only guarantees the *types*.
        settings: sane({ ...DEFAULT_SETTINGS, ...next.settings }),
        settingsAt: now,
        feeds: readFeeds(next.calendars),
      },
      true,
      // The one undoable action that replaces settings, so the one whose undo
      // step has to carry them back.
      true,
    );
  },

  /**
   * A whole-store replacement that came from outside this browser — the
   * mirror file, written by something that is not a circal tab. Undoable and
   * owns its settings, exactly as `restore` does, so a wrong answer from an
   * assistant is one ⌘Z away.
   *
   * It says nothing itself because the caller is the only one that can say
   * anything useful: it knows which file moved and whether this was a sync or
   * a reconnect, and this action knows neither.
   */
  adopt(next: Pick<Snapshot, "events" | "calendars" | "settings" | "settingsAt" | "graves">) {
    // Only for its side effect, the same reason `restore` calls it: `commit`
    // records the *current* snapshot as the step to undo onto.
    fresh();
    sweepFeeds(next.calendars);
    commit(
      {
        schema: SCHEMA,
        // Taken as it stands, stamps and all. Restamping here is the one thing
        // this action must never do: what arrives is either a merge or another
        // writer's document, and re-dating it would make this browser's copy
        // outrank the other machine's on every field it never touched. See
        // `restore` above for the other half of the asymmetry.
        events: next.events,
        calendars: next.calendars,
        graves: next.graves,
        settings: sane({ ...DEFAULT_SETTINGS, ...next.settings }),
        settingsAt: next.settingsAt,
        feeds: readFeeds(next.calendars),
      },
      true,
      true,
    );
  },

  /* --------------------------------- undo --------------------------------- */

  /**
   * Both rebase the recorded step onto what is true now: today's `feeds`
   * always, and today's `settings` unless the step being undone is the one
   * that replaced them.
   *
   * A feed is a live mirror, not something the user did — undoing an event
   * they created should not roll a subscription back sixty steps. And every
   * settings action commits with `record: false`, so restoring the recorded
   * settings wholesale would silently revert a switch the user flipped
   * *after* the change they are undoing.
   */
  undo(): boolean {
    const step = past.pop();
    if (!step) return false;
    const current = fresh();
    future.push({ snapshot: current, ownsSettings: step.ownsSettings });
    write(rebase(step, current));
    return true;
  },

  redo(): boolean {
    const step = future.pop();
    if (!step) return false;
    const current = fresh();
    past.push({ snapshot: current, ownsSettings: step.ownsSettings });
    write(rebase(step, current));
    return true;
  },
};

/**
 * The calendar a new event belongs on: the one the settings name, if it still
 * exists and is still yours to write to, and otherwise the first calendar that
 * is not a subscription.
 *
 * Resolved here rather than clamped in `sane` because the answer depends on
 * the calendars, which another tab can change between one launch and the
 * next — and a setting that rewrote itself in response would be a preference
 * the user never expressed. A feed's calendar is refused outright: its events
 * are a mirror and nothing may be written into it.
 */
export function defaultCalendarId(calendars: Calendar[], preferred: string): string {
  const named = preferred ? calendars.find((c) => c.id === preferred && !c.feed) : undefined;
  return named?.id ?? calendars.find((c) => !c.feed)?.id ?? DEFAULT_CALENDARS[0].id;
}

/**
 * A blank event on `day`, used by ⌘N, by drag-to-create on the dial, and by a
 * drag across the year ring.
 *
 * A span that covers the whole revolution is an all-day event, not a
 * twenty-four-hour appointment: a ring drawn from midnight back round to
 * midnight is the gesture for "this day", and an arc that is the entire face
 * says nothing an all-day event does not say better.
 *
 * More than one revolution is that same rule at the year's scale — as many
 * all-day days as the span covers. The dial can only ever hand over exactly
 * one (its sweep is clamped to the day), so anything past 1440 arrives from a
 * drag across the year ring, and rounding is what keeps the dial's own
 * fractional overshoot landing on one day rather than two.
 *
 * The all-day end is calendar arithmetic and not `base + n × 1440 minutes`,
 * because a day is not always 1440 minutes long: a span across a
 * spring-forward is 23 hours, and adding the minutes lands `end` at 23:00 on
 * the last evening rather than on the midnight after it. `end` is exclusive
 * and has to *be* a midnight, or the last day of a trip drops off the dial.
 */
export function draftEvent(
  day: Date,
  startMin: number,
  endMin: number,
  calendarId: string,
  repeat: Repeat = "never",
): Omit<CalEvent, "id"> {
  const base = startOfDay(day).getTime();
  const span = endMin - startMin;
  const allDay = span >= MINUTES_PER_DAY;
  const days = Math.round(span / MINUTES_PER_DAY);
  return {
    title: "",
    calendarId,
    start: allDay ? base : base + startMin * 60_000,
    end: allDay ? addDays(startOfDay(day), days).getTime() : base + endMin * 60_000,
    allDay,
    tzid: "",
    location: "",
    url: "",
    notes: "",
    ...NEVER,
    repeat,
    seriesId: "",
    seriesKey: "",
    color: "",
    icon: "",
    task: false,
    doneKeys: [],
    // Busy: a gesture that named a time meant that time to be spoken for.
    free: false,
    // Inheriting, which is the only answer a gesture gives: the drag named a
    // time, not how much warning it wants about it.
    remindLead: REMIND_INHERIT,
    // Nobody, and no way to make it anybody: circal has no channel to send an
    // invitation on, so a draft has no guest list and the editor offers no
    // control that would make one. These fields only ever arrive from a file
    // somebody else wrote.
    organizer: null,
    attendees: [],
    attendeeCount: 0,
    // A draft has never been saved, so it has never been changed. `create` and
    // `update` are where a record gets its stamp; a `0` reaching storage would
    // be an event that predates stamping, which is the conservative loser in
    // every merge rather than a lie.
    updatedAt: 0,
  };
}

/**
 * The same draft as a task: one minute of the day rather than a span, so
 * `start === end`.
 *
 * A function of its own rather than a fifth argument to `draftEvent`, because
 * everything that file's comment above says about spans — the all-day
 * threshold, the multi-day rounding, the exclusive midnight — is exactly what
 * a task does not have. Two shapes, two constructors; the editor's Task
 * switch converts between them.
 */
export function taskDraft(day: Date, startMin: number, calendarId: string): Omit<CalEvent, "id"> {
  return { ...draftEvent(day, startMin, startMin, calendarId), task: true };
}

/**
 * A copy of an event, as the draft a new one is written from.
 *
 * Everything the user wrote comes across, the rule included: ⌘-dragging one
 * occurrence of a weekly standup an hour later gives back a weekly series an
 * hour later, which is the reading a plain drag already has — the deltas
 * apply to the event's own instants, never to the occurrence you had hold of.
 * It is also why a duplicate asks no `EditScope` question: nothing existing is
 * being edited, so there is no occurrence for the question to be about.
 *
 * Seven fields deliberately do not come across. `updatedAt` is the mechanical
 * one: a copy is a record that begins to exist at the commit, so it carries
 * `0` here and `create` stamps it — the same rule `draftEvent` follows.
 * `seriesId`/`seriesKey` name a
 * relationship to *another* event, and two events cannot both claim one
 * occurrence — so a copy of an override is an ordinary event on the day it
 * used to replace. And `doneKeys` are ticks against work that was done once; a
 * duplicate arriving pre-ticked is a to-do list that lies. The overrides *of*
 * a series are not copied either, for the first reason: an override is its own
 * event, and a duplicate is one event.
 *
 * The guest list is the fourth kind of the same argument, and the sharpest.
 * `organizer`/`attendees`/`attendeeCount` are a record of an invitation
 * somebody else sent, and a copy the user just made is not that invitation:
 * nothing was asked of anybody, so a duplicate showing "Ada is coming" is the
 * app inventing an RSVP to a meeting that has no organiser and no channel to
 * have been sent on. Exactly the promise the editor refuses to offer a control
 * for, arriving through the back door instead.
 *
 * `exdates`/`rdates` travel *with* the shift rather than beside it. Both name
 * instants, so a series moved an hour later and handed its old keys is a copy
 * that quietly fires on every day the original skipped. A day-form key is
 * re-emitted as a day, which is what carries a whole-day exclusion across a
 * drag that crossed midnight.
 */
export function duplicateOf(event: CalEvent, shiftMs = 0): Omit<CalEvent, "id"> {
  const { id: _id, ...rest } = event;
  const seed = new Date(event.start);
  const shiftKey = (key: string) => {
    const at = keyToInstant(key, seed);
    if (at === null) return key;
    const moved = new Date(at + shiftMs);
    return key.includes("T") ? instantKey(moved) : dayKey(moved);
  };
  return {
    ...rest,
    start: event.start + shiftMs,
    end: event.end + shiftMs,
    // A bound is an instant too, and `0` is "unbounded" rather than 1970.
    until: rest.until > 0 ? rest.until + shiftMs : 0,
    exdates: shiftMs === 0 ? rest.exdates : rest.exdates.map(shiftKey),
    rdates: shiftMs === 0 ? rest.rdates : rest.rdates.map(shiftKey),
    seriesId: "",
    seriesKey: "",
    doneKeys: [],
    organizer: null,
    attendees: [],
    attendeeCount: 0,
    updatedAt: 0,
  };
}

/* ---------------------------------- intro --------------------------------- */

/**
 * Whether this browser has seen the app introduce itself, on its own key
 * rather than in `settings`.
 *
 * Two reasons, and both are about what the value *is*. A `SCHEMA` bump resets
 * settings, and replaying the intro because the settings version moved is the
 * app introducing itself to somebody who has been using it for a year. And it
 * is not a preference: nobody chose it, and it is never shown as one — the
 * only control over it is `Play again`, which sets it back.
 *
 * Outside the blob is also the only place it survives a corrupted one, which
 * is exactly the reload where an unasked-for animation is least welcome.
 */
const INTRO_KEY = "circal.intro";

export function introSeen(): boolean {
  try {
    return disk()?.getItem(INTRO_KEY) === "1";
  } catch {
    // Private mode refuses the read. Answering "seen" is the conservative
    // half: an intro that never plays is a smaller failure than one that
    // plays on every load.
    return true;
  }
}

export function setIntroSeen(seen: boolean) {
  try {
    if (seen) disk()?.setItem(INTRO_KEY, "1");
    else disk()?.removeItem(INTRO_KEY);
  } catch {
    // Nothing to say and nothing lost: the worst case is one more sweep.
  }
}

/* ------------------------------- backup clock ----------------------------- */

/**
 * When this browser last wrote a `.json` backup, epoch ms — the state the
 * main-screen nudge reads to know whether one is overdue.
 *
 * On its own key rather than in `settings`, for a reason `circal.intro`'s is
 * one half of: it is not a preference nobody chose it. But the deciding half
 * is `exportBackup`, which serialises `settings` into the very file it writes.
 * A backup time living in `settings` would be stamped into every backup and
 * read back on restore, so a `.json` carried to a second browser would tell
 * that browser it had backed up when it never has — silencing the one warning
 * those browsers get — and a year-old file restored later would reset the
 * clock to a lie. The fact is about *this* device's copy on disk, so it stays
 * with the device and never rides along in the data.
 *
 * Reactive, unlike `introSeen`: the nudge has to vanish the instant a backup
 * is taken, so a write here notifies the same listeners `useStore` runs on.
 */
const BACKUP_KEY = "circal.backup";

let lastBackup = 0;
let lastBackupRead = false;

/**
 * The stored backup time, and whether the key was there at all. A time in the
 * future is incoherent — a clock the device once had set wrong, most likely —
 * and would read as "backed up" forever, so it is clamped to now on the way in,
 * the same job `sane()` does for the settings that can be stored wrong rather
 * than merely absent. `present` is false only when the key does not exist,
 * which is a browser that has never opened circal since the nudge shipped.
 */
function readLastBackup(): { at: number; present: boolean } {
  try {
    const raw = disk()?.getItem(BACKUP_KEY);
    if (raw === null || raw === undefined) return { at: 0, present: false };
    const at = Number(raw);
    return { at: Number.isFinite(at) && at > 0 ? Math.min(at, Date.now()) : 0, present: true };
  } catch {
    // Storage refused the read; treat it as present-but-unknown so we do not
    // stamp a first-run time this reload will not be able to persist anyway.
    return { at: 0, present: true };
  }
}

/**
 * The backup clock, read once and kept warm. On the very first read of a
 * browser that has no key yet, the clock is started at now rather than left at
 * zero: "never backed up" measured from the epoch is due the instant the app
 * opens, which hands a chore to somebody who has not made a single event.
 * There is no honest earlier anchor to use instead — an event's `start` is when
 * it happens, not when it was written, and the seed events a fresh install
 * carries are not the user's work — so first run is the earliest moment there
 * could be anything to lose, and that is where the interval begins.
 *
 * Stamped silently, without `emit()`: this runs inside the snapshot getter
 * `useSyncExternalStore` calls during render, and notifying listeners from
 * there would loop. The value is cached, so every later getter call is stable.
 */
function backupSnapshot(): number {
  if (!lastBackupRead) {
    lastBackupRead = true;
    const stored = readLastBackup();
    if (stored.present) {
      lastBackup = stored.at;
    } else {
      lastBackup = Date.now();
      try {
        disk()?.setItem(BACKUP_KEY, String(lastBackup));
      } catch {
        // No disk: the in-memory value still starts the interval for this
        // session, and a browser that cannot persist has nothing to lose.
      }
    }
  }
  return lastBackup;
}

/**
 * Move the backup clock to `at`, in memory and on disk, and tell the nudge.
 * The one write path behind both events that reset the interval — a real
 * backup and a dismiss — so they cannot drift on how the value is stored.
 */
function stampBackup(at: number) {
  lastBackup = at;
  lastBackupRead = true;
  try {
    disk()?.setItem(BACKUP_KEY, String(at));
  } catch {
    // No disk means no persisted clock, but the in-memory value still hides
    // the nudge for this session — the same graceful degradation `write` takes.
  }
  emit();
}

/** Record that a `.json` backup was just written. Only `exportBackup` calls
 *  this, and only when a file actually landed — a cancelled save panel is not
 *  a backup and must not quiet the nudge. */
export function markBackedUp(at: number = Date.now()) {
  stampBackup(at);
}

/**
 * Dismiss the nudge: restart the interval without claiming a backup. "Not now"
 * is not "never" — the setting is where never lives — so this pushes the clock
 * forward by one interval rather than turning the feature off. It advances the
 * same timestamp a backup does because that is the only new state this feature
 * has: the value means "when the nudge's countdown last started", and both a
 * backup and a not-now start it.
 */
export function dismissBackupNudge() {
  stampBackup(Date.now());
}

export function useLastBackup(): number {
  return useSyncExternalStore(subscribe, backupSnapshot, () => 0);
}
