/* ------------------------------------------------------------------ *
 * The event model, recurrence expansion and lane packing.
 *
 * Instants are stored as epoch milliseconds. ISO strings would need parsing
 * rules the moment a user crosses a DST boundary; a number plus the browser's
 * local calendar is unambiguous and JSON-safe.
 * ------------------------------------------------------------------ */

import { MINUTES_PER_DAY, addDays, isSameDay, minutesOfDay, startOfDay, dayKey } from "./time";

export const REPEATS = ["never", "daily", "weekly", "monthly", "yearly"] as const;
export type Repeat = (typeof REPEATS)[number];

export const REPEAT_LABELS: Record<Repeat, string> = {
  never: "Never",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

export interface Calendar {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

export interface CalEvent {
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
  repeat: Repeat;
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

/**
 * Does `event` start on `date`, and if so, when? Returns the concrete instants
 * for that occurrence. Recurrence is intentionally shallow — the five rules
 * Radical's editor offers, no RRULE, no exceptions.
 */
function occurrenceStartingOn(event: CalEvent, date: Date): { start: Date; end: Date } | null {
  const seed = new Date(event.start);
  const duration = event.end - event.start;

  if (event.repeat === "never") {
    return isSameDay(seed, date) ? { start: seed, end: new Date(event.end) } : null;
  }

  // A recurrence never fires before its seed.
  if (startOfDay(date).getTime() < startOfDay(seed).getTime()) return null;

  const fires =
    event.repeat === "daily" ||
    (event.repeat === "weekly" && date.getDay() === seed.getDay()) ||
    (event.repeat === "monthly" && date.getDate() === seed.getDate()) ||
    (event.repeat === "yearly" &&
      date.getMonth() === seed.getMonth() &&
      date.getDate() === seed.getDate());
  if (!fires) return null;

  const start = startOfDay(date);
  start.setHours(seed.getHours(), seed.getMinutes(), 0, 0);
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
        endMin: continuesAfter ? MINUTES_PER_DAY : minutesOfDay(hit.end),
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
export function packLanes(occurrences: Occurrence[], pad = 6): Occurrence[] {
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

/* --------------------------------- helpers -------------------------------- */

export function colorOf(event: CalEvent, calendars: Calendar[]): string {
  return calendars.find((c) => c.id === event.calendarId)?.color ?? "#a3d9e4";
}

/** Where an occurrence sits relative to `now`: before it, inside it, after it. */
export function statusOf(occ: Occurrence, now: Date): "past" | "now" | "upcoming" {
  if (now >= occ.end) return "past";
  return now >= occ.start ? "now" : "upcoming";
}
