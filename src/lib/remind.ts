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

/** The lead times the settings panel offers, in minutes. */
export const REMIND_LEADS: readonly number[] = [0, 5, 10, 15, 30, 60];

export interface Reminder {
  /** The occurrence's own key — one notification per occurrence, ever. */
  key: string;
  event: CalEvent;
  start: Date;
  /** Whole minutes from `now` to `start`. `0` means it is starting. */
  lead: number;
}

/**
 * Every reminder that comes due in the minute beginning at `now`.
 *
 * The window is `[target, target + 60_000)`, `target = now + leadMinutes`
 * minutes — half-open so a tick never fires the same occurrence twice and
 * none falls through the gap between two ticks. It never catches up: an
 * occurrence whose target minute has already passed is not returned, even if
 * it is still in `fired`'s absence — a notification for a meeting that
 * started an hour ago (tab asleep, lid shut) is worse than none, which is
 * the whole reason this checks "due this minute" rather than "not yet
 * fired".
 */
export function dueReminders(
  events: CalEvent[],
  calendars: Calendar[],
  now: Date,
  leadMinutes: number,
  fired: ReadonlySet<string>,
): Reminder[] {
  // Floored to the minute the tick belongs to, not taken raw. `useNow` fires a
  // few milliseconds *after* `:00`, so an unfloored window starts at
  // `10:17:00.09` and an event at `10:17:00.000` falls just in front of it —
  // one missed notification per event, and only for the events that are
  // exactly on the minute, which is all of them.
  const minute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const target = new Date(minute + leadMinutes * MINUTE_MS);
  const windowStart = target.getTime();
  const windowEnd = windowStart + MINUTE_MS;

  const nowDay = startOfDay(new Date(minute));
  const targetDay = startOfDay(target);
  // A 60-minute lead legitimately pushes the target past midnight, so both
  // days must be scanned; when they coincide (the common case) this is one
  // query, not two.
  const days = nowDay.getTime() === targetDay.getTime() ? [nowDay] : [nowDay, targetDay];

  const seen = new Set<string>();
  const out: Reminder[] = [];
  for (const d of days) {
    for (const occ of occurrencesOn(events, calendars, d)) {
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

      const startMs = occ.start.getTime();
      if (startMs < windowStart || startMs >= windowEnd) continue;

      seen.add(occ.key);
      out.push({ key: occ.key, event: occ.event, start: occ.start, lead: leadMinutes });
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
