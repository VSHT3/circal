/* ------------------------------------------------------------------ *
 * In-tab reminders — the pure half. Given the shell's minute tick, which
 * occurrences should raise a notification right now, and what it should say.
 *
 * The React half (permission, `new Notification(...)`, the fired-key ref
 * that survives across ticks) lives in the component that calls this; this
 * module knows nothing of the DOM and never mutates its inputs.
 * ------------------------------------------------------------------ */

import { type Calendar, type CalEvent, occurrencesOn } from "./events";
import { formatDuration, formatTimeShort, startOfDay, type Clock } from "./time";

const MINUTE_MS = 60_000;

/** The lead times the settings panel and the event editor offer, in minutes. */
export const REMIND_LEADS: readonly number[] = [0, 5, 10, 15, 30, 60];

/**
 * A lead, as both surfaces that offer one print it. One voice, because the
 * settings panel and the event editor are answering the same question about
 * the same number, and two vocabularies for it is how "an hour before" and
 * "60 min before" end up being read as two different settings. `0` is the
 * one that is not a duration, and it is the one that says what the whole
 * feature is for.
 */
export function remindLabel(minutes: number): string {
  return minutes === 0 ? "As it starts" : `${formatDuration(minutes)} before`;
}

/**
 * The three states of `CalEvent.remindLead`, which is an *override* of
 * `settings.remindLead` in exactly the sense `CalEvent.color` overrides its
 * calendar's: the default is to name nothing and follow the setting, so
 * changing the setting still moves every event that never asked for its own.
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
 * How much warning this event gets, given what the setting says — `null` for
 * an event that gets none.
 *
 * The single place the three states are read, the way `colorOf` is the single
 * place colour precedence lives: every other surface asks this and is handed
 * one answer, so "which state is it in" cannot come to mean two things in two
 * files. `fallback` is `settings.remindLead`; whether reminders are switched
 * on at all is the shell's own gate and deliberately not asked here — this
 * function answers about the event, not about the browser.
 */
export function leadOf(event: Pick<CalEvent, "remindLead">, fallback: number): number | null {
  if (event.remindLead === REMIND_SILENT) return null;
  return ownLead(event) ?? fallback;
}

/**
 * A stored or imported value read as a lead. Unreadable is `REMIND_INHERIT`,
 * which is what every event written before this field existed already was.
 *
 * One validator, three readers, for the reason `readRecurrence` is one:
 * `backup.readEvent` (untrusted JSON), `store.hydrateEvents` (a blob that
 * predates the field) and the editor's own Select all have to agree about
 * what a legal lead is, and three copies of the bounds would be three
 * opinions. Whole minutes only — a `VALARM` of ninety seconds is not a lead
 * this app can count down in, and rounding it would be a guess.
 */
export function readRemindLead(value: unknown): number {
  if (value === REMIND_SILENT) return REMIND_SILENT;
  if (typeof value !== "number" || !Number.isInteger(value)) return REMIND_INHERIT;
  if (value < 0 || value > REMIND_LEAD_MAX) return REMIND_INHERIT;
  return value;
}

export interface Reminder {
  /** The occurrence's own key — one notification per occurrence, ever. */
  key: string;
  event: CalEvent;
  start: Date;
  /** Whole minutes from `now` to `start`, as `leadOf` resolved it. `0` means
   *  it is starting. */
  lead: number;
}

/**
 * Every reminder that comes due in the minute beginning at `now`.
 *
 * Each occurrence is tested against its *own* lead — `leadOf(event,
 * defaultLead)`, so an event that named one gets that and everything else
 * gets the setting's. `defaultLead` is therefore the fallback rather than
 * the lead: nothing here decides which of the three states an event is in.
 *
 * The test is unchanged in every way that made it correct, only restated per
 * occurrence: the moment a reminder should be raised is `start - lead`, and
 * it is raised when that instant falls in `[minute, minute + 60_000)` —
 * half-open, so a tick never fires the same occurrence twice and none falls
 * through the gap between two ticks. It never catches up: an occurrence
 * whose moment has already passed is not returned, even in `fired`'s
 * absence — a notification for a meeting that started an hour ago (tab
 * asleep, lid shut) is worse than none, which is the whole reason this
 * checks "due this minute" rather than "not yet fired".
 */
export function dueReminders(
  events: CalEvent[],
  calendars: Calendar[],
  now: Date,
  defaultLead: number,
  fired: ReadonlySet<string>,
): Reminder[] {
  // Floored to the minute the tick belongs to, not taken raw. `useNow` fires a
  // few milliseconds *after* `:00`, so an unfloored window starts at
  // `10:17:00.09` and an event at `10:17:00.000` falls just in front of it —
  // one missed notification per event, and only for the events that are
  // exactly on the minute, which is all of them.
  const minute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;

  // One day per distinct lead in use, because a lead is now a property of the
  // event rather than one number for the whole calendar: a 60-minute lead
  // legitimately looks into tomorrow while a 0-minute one looks at today, and
  // an occurrence can only come due `lead` minutes before it starts, so the
  // day it starts on is the only day worth asking about. Distinct leads, not
  // events — a calendar of two hundred meetings on the setting's own lead is
  // still one query, which is what it was before this field existed.
  const days = new Map<number, Date>();
  for (const event of events) {
    const lead = leadOf(event, defaultLead);
    if (lead === null) continue;
    const day = startOfDay(new Date(minute + lead * MINUTE_MS));
    days.set(day.getTime(), day);
  }

  const seen = new Set<string>();
  const out: Reminder[] = [];
  for (const d of days.values()) {
    for (const occ of occurrencesOn(events, calendars, d)) {
      // Silent, and it is the only state that answers nothing: an event the
      // user has told to stop nudging them is skipped whatever the setting
      // says, which is the whole reason the third state exists.
      const lead = leadOf(occ.event, defaultLead);
      if (lead === null) continue;
      // No minute, so no "ten minutes before" — an all-day event has nothing
      // for a lead time to count down to. A dated task does have one, and is
      // the thing most worth being nudged toward: the whole reason to give a
      // to-do a time is to be told when it arrives.
      if (occ.event.allDay) continue;
      // Except once it is ticked off. A reminder for something already done
      // is the one notification guaranteed to be wrong.
      if (occ.done) continue;
      // The tail of a multi-day event does not start on this day; only the
      // day `start` actually falls on may raise it, or a five-day trip fires
      // once per day it is drawn on. Occurrences hidden by their calendar
      // are already absent from `occurrencesOn`'s output.
      if (occ.continuesBefore) continue;
      if (seen.has(occ.key)) continue;
      if (fired.has(occ.key)) continue;

      const raiseAt = occ.start.getTime() - lead * MINUTE_MS;
      if (raiseAt < minute || raiseAt >= minute + MINUTE_MS) continue;

      seen.add(occ.key);
      out.push({ key: occ.key, event: occ.event, start: occ.start, lead });
    }
  }

  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/** What the notification says. */
export function reminderText(reminder: Reminder, clock: Clock): { title: string; body: string } {
  // An empty notification title renders as the page origin instead, which
  // reads as more alarming than a placeholder ever would.
  const title = reminder.event.title || "Untitled";
  // A task is *due*; an event *starts*. One word, and it is the difference
  // between being told to do something and being told to be somewhere.
  const verb = reminder.event.task ? "Due now" : "Starts now";
  const when = reminder.lead === 0 ? verb : `in ${formatDuration(reminder.lead)}`;
  return { title, body: `${when} · ${formatTimeShort(reminder.start, clock)}` };
}

/* -------------------------------------------------------------------------- *
 * The document title
 * -------------------------------------------------------------------------- */

/**
 * The tab title's countdown to the next thing today: the first timed,
 * non-past occurrence, which is the same subject `CenterPanel`'s headline
 * row already resolves — an all-day event is context there and is never it
 * here either. `occurrencesOn` already returns the day in start order, so
 * the first survivor of the filter is the answer.
 *
 * Rounds *down*, as `untilText` does: a title promising more time than is
 * left is worse than a plain one. An occurrence already running reads `now`
 * rather than `0m` — `0m` is a countdown that has arrived and stays arrived
 * for the whole meeting, and "Now" is the word `CenterPanel`'s headline row
 * already uses for exactly this state. Its own end is deliberately not
 * counted down to: that is a second sentence on a line with room for one.
 *
 * Returns the whole suffix, ready to append to whatever the tab's own title
 * already is — `null` when there is nothing due today.
 */
export function titleCountdown(
  events: CalEvent[],
  calendars: Calendar[],
  now: Date,
): string | null {
  const next = occurrencesOn(events, calendars, startOfDay(now)).find(
    (occ) => !occ.event.allDay && occ.end.getTime() > now.getTime(),
  );
  if (!next) return null;
  const title = next.event.title || "Untitled";
  const minutes = Math.floor((next.start.getTime() - now.getTime()) / MINUTE_MS);
  return `· ${minutes > 0 ? formatDuration(minutes) : "now"} · ${title}`;
}
