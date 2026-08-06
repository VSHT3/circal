/* ------------------------------------------------------------------ *
 * The event model, recurrence expansion and lane packing.
 *
 * Instants are stored as epoch milliseconds. ISO strings would need parsing
 * rules the moment a user crosses a DST boundary; a number plus the browser's
 * local calendar is unambiguous and JSON-safe.
 * ------------------------------------------------------------------ */

import {
  MINUTES_PER_DAY,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  isSameDay,
  minutesOfDay,
  startOfDay,
  dayKey,
} from "./time";

export const REPEATS = ["never", "daily", "weekly", "monthly", "yearly"] as const;
export type Repeat = (typeof REPEATS)[number];

/** Bare frequencies, because the row that prints them also prints an
 *  interval beside them: "Every week — every 2 weeks" reads as a fault. */
export const REPEAT_LABELS: Record<Repeat, string> = {
  never: "Never",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** The unit an `interval` counts, singular at one. */
export function repeatUnit(repeat: Repeat, n: number): string {
  const unit = { never: "", daily: "day", weekly: "week", monthly: "month", yearly: "year" }[
    repeat
  ];
  return n === 1 ? unit : `${unit}s`;
}

/**
 * The recurrence half of an event. Flat on `CalEvent` rather than nested,
 * because `repeat === "never"` is the cheapest and most-asked question in the
 * app; everything below it only matters once the answer is no.
 *
 * Deliberately a subset of RFC 5545 — the parts a shared calendar actually
 * sends. What is not modelled (BYMONTH, BYWEEKNO, BYYEARDAY, RDATE,
 * per-occurrence RECURRENCE-ID overrides) is dropped on parse rather than
 * approximated: an approximated rule puts a meeting on a day it is not on and
 * says nothing about having done so.
 */
export interface Recurrence {
  repeat: Repeat;
  /** Fire every nth period. `1` = every one, and never less. */
  interval: number;
  /**
   * The last instant an occurrence may *start*, epoch ms, inclusive. `0` =
   * forever. RRULE's COUNT is walked into one of these on the way in: two
   * ways to bound one series is one too many, and they name the same series.
   */
  until: number;
  /**
   * Weekdays a weekly rule fires on, `0` = Sunday. Empty means the seed's own
   * weekday, which is what an editor that never touched this produces. On a
   * monthly rule it holds the single weekday `nth` counts.
   */
  byDay: number[];
  /**
   * Monthly only. `0` = on the seed's day of the month; `1`–`5` = that
   * numbered `byDay` weekday of the month; `-1` = the last one.
   */
  nth: number;
  /**
   * Days the series skips, as local `YYYY-MM-DD`. Day keys rather than
   * instants, because an event fires at most once per day here — so the day
   * *is* an occurrence's identity, and a stored instant would stop matching
   * the moment the series' time of day was edited.
   */
  exdates: string[];
}

/** An event that happens once. Every construction site spreads this. */
export const NEVER: Recurrence = {
  repeat: "never",
  interval: 1,
  until: 0,
  byDay: [],
  nth: 0,
  exdates: [],
};

/** The recurrence fields alone, copied out of anything carrying them — an
 *  importer hands one over whole rather than restating six fields. */
export function recurrenceOf(source: Recurrence): Recurrence {
  return {
    repeat: source.repeat,
    interval: source.interval,
    until: source.until,
    byDay: [...source.byDay],
    nth: source.nth,
    exdates: [...source.exdates],
  };
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  /**
   * Set when this calendar mirrors a remote ICS feed. Its events are pulled
   * whole on refresh and live in `Snapshot.feeds`, not `Snapshot.events` —
   * they are somebody else's data, so they are never edited and never
   * exported as yours.
   */
  feed?: Feed;
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
  location: string;
  url: string;
  notes: string;
  /**
   * Overrides the calendar's colour for this event alone. Empty means "follow
   * the calendar", which is the default and what most events should stay on —
   * recolouring the calendar then still moves them.
   */
  color: string;
}

/** One concrete appearance of an event on one day, clipped to that day. */
export interface Occurrence {
  /** Stable across renders: an event repeats at most once per day. */
  key: string;
  event: CalEvent;
  start: Date;
  end: Date;
  /** Clipped to `[0, 1440]` — what the dial actually draws. */
  startMin: number;
  endMin: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** 0 = outermost ring. Assigned by `packLanes`. */
  lane: number;
}

/* ------------------------------- recurrence ------------------------------- */

/** Monday-start, because RFC 5545's default WKST is MO — and an interval of
 *  weeks has to count from a fixed edge or "every 2 weeks" drifts. */
function weekStart(d: Date): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/**
 * Which of its month's Tuesdays a Tuesday is — 1 for the first. Counted from
 * the end when `fromEnd`, so `-1` is the last one in the month and `-2` the
 * one before it: RFC 5545 spells both, and a rule this cannot represent is a
 * meeting that vanishes.
 */
function weekdayPosition(d: Date, fromEnd: boolean): number {
  return fromEnd
    ? -(Math.floor((daysInMonth(d.getFullYear(), d.getMonth()) - d.getDate()) / 7) + 1)
    : Math.floor((d.getDate() - 1) / 7) + 1;
}

/**
 * The occurrence's start on `day`: the seed's time of day, on that date.
 * Wall clock rather than elapsed time, so a series keeps its hour across a
 * DST boundary — nine in the morning stays nine in the morning.
 */
function startOn(day: Date, seed: Date): Date {
  const start = startOfDay(day);
  start.setHours(seed.getHours(), seed.getMinutes(), 0, 0);
  return start;
}

/** The weekdays a rule fires on, defaulting to the seed's own. */
function weekdaysOf(rule: Recurrence, seed: Date): number[] {
  return rule.byDay.length ? rule.byDay : [seed.getDay()];
}

/** `day` of `month`, or `null` when that month is too short for it. */
function monthDayOf(month: Date, day: number): Date | null {
  const y = month.getFullYear();
  const m = month.getMonth();
  return day <= daysInMonth(y, m) ? new Date(y, m, day) : null;
}

/** The date a monthly rule names inside `month`, or `null` when that month
 *  has no such date — no 31st, no fifth Friday. */
function monthlyDay(rule: Recurrence, seed: Date, month: Date): Date | null {
  const y = month.getFullYear();
  const m = month.getMonth();
  if (rule.nth === 0) return monthDayOf(month, seed.getDate());

  const weekday = weekdaysOf(rule, seed)[0];
  const last = daysInMonth(y, m);
  if (rule.nth < 0) {
    const lastMatch = last - ((new Date(y, m, last).getDay() - weekday + 7) % 7);
    const date = lastMatch + (rule.nth + 1) * 7;
    return date >= 1 ? new Date(y, m, date) : null;
  }
  const firstMatch = 1 + ((weekday - new Date(y, m, 1).getDay() + 7) % 7);
  return monthDayOf(month, firstMatch + (rule.nth - 1) * 7);
}

/**
 * Does the rule fire on `date`? O(1) at every frequency, which is what keeps
 * `occurrencesOn` a filter over the event list rather than an expansion of
 * every series from its seed up to the day on screen.
 *
 * A rule naming a date some months do not have — the 31st, 29 February, a
 * fifth Friday — simply does not fire in those months. That is RFC 5545
 * §3.3.10 on an invalid instance, and it is the only answer that does not
 * invent a date the sender never wrote.
 */
function fires(rule: Recurrence, seed: Date, date: Date): boolean {
  const every = Math.max(1, Math.trunc(rule.interval));
  switch (rule.repeat) {
    case "never":
      return false;
    case "daily":
      return daysBetween(seed, date) % every === 0;
    case "weekly":
      return (
        weekdaysOf(rule, seed).includes(date.getDay()) &&
        Math.round(daysBetween(weekStart(seed), weekStart(date)) / 7) % every === 0
      );
    case "monthly": {
      const months =
        (date.getFullYear() - seed.getFullYear()) * 12 + (date.getMonth() - seed.getMonth());
      if (months % every !== 0) return false;
      if (rule.nth === 0) return date.getDate() === seed.getDate();
      if (date.getDay() !== weekdaysOf(rule, seed)[0]) return false;
      return weekdayPosition(date, rule.nth < 0) === rule.nth;
    }
    case "yearly":
      return (
        (date.getFullYear() - seed.getFullYear()) % every === 0 &&
        date.getMonth() === seed.getMonth() &&
        date.getDate() === seed.getDate()
      );
  }
}

/**
 * How far a walk will go looking for the end of a COUNT. Generous, because
 * the fallback is "unbounded" and the two failure modes are not symmetric:
 * over-running a bound shows occurrences that should have stopped, guessing
 * one too early deletes them, and only the second loses data.
 */
const WALK_CAP = 2000;

/**
 * Where an RRULE `COUNT` lands, as the `until` this model stores instead.
 *
 * Counting is by the *rule*, before EXDATE: RFC 5545 subtracts exceptions
 * from the generated set, so an excluded day still spends one of the count.
 * Returns `null` for a count this refuses to walk — read as unbounded.
 */
export function countedUntil(rule: Recurrence, start: number, count: number): number | null {
  if (rule.repeat === "never" || count < 1 || count > WALK_CAP) return null;
  const seed = new Date(start);
  const seedDay = startOfDay(seed);
  const every = Math.max(1, Math.trunc(rule.interval));

  if (rule.repeat === "daily") {
    return startOn(addDays(seedDay, (count - 1) * every), seed).getTime();
  }

  if (rule.repeat === "weekly") {
    // In week order, so the nth instance is the nth one a reader would count.
    const days = [...weekdaysOf(rule, seed)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    let seen = 0;
    let week = weekStart(seedDay);
    for (let step = 0; step < WALK_CAP; step++) {
      for (const weekday of days) {
        const day = addDays(week, (weekday + 6) % 7);
        if (day < seedDay) continue;
        if (++seen === count) return startOn(day, seed).getTime();
      }
      week = addDays(week, 7 * every);
    }
    return null;
  }

  // Monthly and yearly both step whole periods and skip the ones with no such
  // date, exactly as `fires` does — a skipped month spends nothing.
  const stepMonths = rule.repeat === "monthly" ? every : every * 12;
  const firstOfMonth = new Date(seedDay.getFullYear(), seedDay.getMonth(), 1);
  let seen = 0;
  for (let step = 0; step < WALK_CAP; step++) {
    const month = addMonths(firstOfMonth, step * stepMonths);
    const day =
      rule.repeat === "monthly" ? monthlyDay(rule, seed, month) : monthDayOf(month, seed.getDate());
    if (!day || day < seedDay) continue;
    if (++seen === count) return startOn(day, seed).getTime();
  }
  return null;
}

/**
 * Does `event` start on `date`, and if so, when? Returns the concrete
 * instants for that occurrence, or `null` when the series does not reach it.
 */
function occurrenceStartingOn(event: CalEvent, date: Date): { start: Date; end: Date } | null {
  const seed = new Date(event.start);
  const duration = event.end - event.start;

  if (event.repeat === "never") {
    return isSameDay(seed, date) ? { start: seed, end: new Date(event.end) } : null;
  }

  // A recurrence never fires before its seed.
  if (startOfDay(date).getTime() < startOfDay(seed).getTime()) return null;
  if (!fires(event, seed, date)) return null;
  // Checked after the rule, never as part of it: EXDATE is subtracted from
  // the generated set rather than consulted while generating it.
  if (event.exdates.length > 0 && event.exdates.includes(dayKey(date))) return null;

  const start = startOn(date, seed);
  // UNTIL bounds the *start*, inclusive. Without it a series that ended in
  // 2023 repeats onto today's dial forever.
  if (event.until > 0 && start.getTime() > event.until) return null;
  return { start, end: new Date(start.getTime() + duration) };
}

/**
 * Every occurrence visible on `day`, clipped to it. An event that runs past
 * midnight is emitted on both days, which is why the previous day is scanned
 * too: its tail belongs to this day's dial.
 */
export function occurrencesOn(events: CalEvent[], calendars: Calendar[], day: Date): Occurrence[] {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const out: Occurrence[] = [];

  for (const event of events) {
    if (hidden.has(event.calendarId)) continue;

    for (const anchor of [addDays(dayStart, -1), dayStart]) {
      const hit = occurrenceStartingOn(event, anchor);
      if (!hit) continue;
      if (hit.end <= dayStart || hit.start >= dayEnd) continue;

      const continuesBefore = hit.start < dayStart;
      const continuesAfter = hit.end > dayEnd;
      out.push({
        key: `${event.id}@${dayKey(anchor)}`,
        event,
        start: hit.start,
        end: hit.end,
        startMin: continuesBefore ? 0 : minutesOfDay(hit.start),
        // `>=`, not `continuesAfter`: an event ending *exactly* at midnight ends
        // this day at 1440 rather than the next one at 0. `minutesOfDay` would
        // say 0, which is a negative duration everywhere it is measured and an
        // arc drawn backwards round the whole face.
        endMin: hit.end >= dayEnd ? MINUTES_PER_DAY : minutesOfDay(hit.end),
        continuesBefore,
        continuesAfter,
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

/* ------------------------------- free time -------------------------------- */

export interface Gap {
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

/**
 * The hours a day is actually booked in. Free time is counted against these
 * rather than against the whole revolution: nobody reads "nineteen hours
 * free" as an offer, and both the palette's slot search and the dial's
 * totals mean the same thing by the word.
 */
export const WAKING = { from: 8 * 60, to: 22 * 60 };

/**
 * The holes in a day, at least `minMinutes` wide, inside `[from, to]`.
 *
 * The dial already makes gaps the most legible thing on the face; this only
 * makes them addressable. All-day events do not occupy a gap — an all-day
 * "Berlin" does not stop you booking lunch.
 */
export function freeGaps(
  occurrences: Occurrence[],
  minMinutes: number,
  from: number,
  to: number,
): Gap[] {
  const busy = occurrences
    .filter((o) => !o.event.allDay)
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

/** The event's own colour if it has one, else its calendar's. */
export function colorOf(event: CalEvent, calendars: Calendar[]): string {
  if (event.color) return event.color;
  return calendars.find((c) => c.id === event.calendarId)?.color ?? ORPHAN_COLOR;
}

/** Where an occurrence sits relative to `now`: before it, inside it, after it. */
export function statusOf(occ: Occurrence, now: Date): "past" | "now" | "upcoming" {
  if (now >= occ.end) return "past";
  return now >= occ.start ? "now" : "upcoming";
}
