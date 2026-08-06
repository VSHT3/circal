/* ------------------------------------------------------------------ *
 * The event model, recurrence expansion and lane packing.
 *
 * Instants are stored as epoch milliseconds. ISO strings would need parsing
 * rules the moment a user crosses a DST boundary; a number plus the browser's
 * local calendar is unambiguous and JSON-safe.
 * ------------------------------------------------------------------ */

import { MINUTES_PER_DAY, addDays, minutesOfDay, startOfDay } from "./time";
import { instantKey, startsBetween, type Recurrence } from "./recur";

export {
  FREQUENCIES,
  NEVER,
  REPEATS,
  REPEAT_LABELS,
  instantKey,
  recurrenceOf,
  repeatUnit,
  repeats,
  type Recurrence,
  type Repeat,
  type WeekdayRule,
} from "./recur";

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

/**
 * Every occurrence visible on `day`, clipped to it. An event that runs past
 * midnight is emitted on both days, which is why the previous day is scanned
 * too: its tail belongs to this day's dial.
 */
export function occurrencesOn(events: CalEvent[], calendars: Calendar[], day: Date): Occurrence[] {
  const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const replaced = overridesIn(events);
  const out: Occurrence[] = [];

  for (const event of events) {
    if (hidden.has(event.calendarId)) continue;

    const duration = event.end - event.start;
    // The previous day is scanned too: an event running past midnight has its
    // tail on this day's dial, and its start belongs to yesterday.
    const from = addDays(dayStart, -1).getTime();
    const skip = replaced.get(event.id);

    for (const at of startsBetween(event, event.start, from, dayEnd.getTime())) {
      // An occurrence somebody moved is not drawn twice: the series skips it,
      // and the override event draws itself.
      if (skip?.has(instantKey(at))) continue;

      const start = new Date(at);
      const end = new Date(at + duration);
      if (end <= dayStart || start >= dayEnd) continue;

      const continuesBefore = start < dayStart;
      const continuesAfter = end > dayEnd;
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
