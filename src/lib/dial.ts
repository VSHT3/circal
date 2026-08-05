/* ------------------------------------------------------------------ *
 * Dial geometry.
 *
 * One revolution = 24 hours, **noon at the top**, clockwise. That single
 * choice fixes everything else: 6 PM sits at 3 o'clock, midnight at the
 * bottom, 6 AM at 9 o'clock, and the waking half of the day occupies the
 * top half of the circle — which is why the layout reads as a day and not
 * as a clock face.
 *
 * All numbers below are in the SVG user units of a 1000×1000 viewBox, so a
 * component only ever sets the rendered pixel size once and every radius,
 * stroke and font scales with it.
 * ------------------------------------------------------------------ */

import { MINUTES_PER_DAY } from "./time";

export const DIAL = {
  /** The coordinate space. C is both cx and cy. */
  SIZE: 1000,
  C: 500,
  /**
   * Nothing is drawn outside the track, so the viewBox is cropped to
   * `PAD PAD (SIZE-2·PAD)` — otherwise a fifth of the rendered box would be
   * empty margin and the dial would sit small in its own window.
   */
  PAD: 44,

  /** Elapsed-day ring — the outermost drawn element. */
  TRACK: 400,
  TRACK_WIDTH: 3,

  /** Hour ticks live just inside the track. */
  TICK_OUTER: 396,
  TICK_INNER: 380,
  /** Half-hour ticks are the same ring, shorter and dimmer. */
  TICK_INNER_MINOR: 387,

  /** Ring the hour numerals are centred on. */
  LABELS: 340,

  /** 24-hour dial: one lane ring, stepping inwards for overlaps. */
  LANE: 293,
  LANE_STEP: 27,
  ARC_WIDTH: 14,

  /**
   * 12-hour dial: the day is two turns, so it is drawn as two concentric
   * bands — morning inside, afternoon outside — and the whole day is still
   * visible at once. `BAND_SPLIT` is the radius that decides which band a
   * drag lands in.
   */
  LANE_PM: 300,
  LANE_AM: 212,
  LANE_STEP_12: 22,
  BAND_SPLIT: 245,

  /** Inner edge of the drag-to-create annulus, clear of the centre panel. */
  DRAG_INNER: 150,

  /** The now-hand runs from the track through the centre and a little past. */
  HAND_WIDTH: 1.6,
  HAND_TAIL: 26,
} as const;

/** Side of the cropped viewBox, in user units — the overlay's scale basis. */
export const VIEW_SIZE = DIAL.SIZE - 2 * DIAL.PAD;
export const VIEW_BOX = `${DIAL.PAD} ${DIAL.PAD} ${VIEW_SIZE} ${VIEW_SIZE}`;

/** Which face the dial wears. `24h` = one turn a day; `12h` = two. */
export type Clock = "24h" | "12h";

/** Minutes in one revolution of the face. */
export const TURN: Record<Clock, number> = { "24h": MINUTES_PER_DAY, "12h": 720 };

/**
 * Minutes since midnight → degrees clockwise from the top.
 *  - `24h`: noon at the top, midnight at the bottom, one turn a day.
 *  - `12h`: a conventional clock face — 12 at the top, two turns a day.
 */
export function angleAt(minutes: number, clock: Clock = "24h"): number {
  return clock === "24h"
    ? (minutes - MINUTES_PER_DAY / 2) * (360 / MINUTES_PER_DAY)
    : (minutes % TURN["12h"]) * (360 / TURN["12h"]);
}

/** Degrees clockwise from 12 o'clock → point on the circle of radius `r`. */
export function polar(r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: DIAL.C + r * Math.cos(rad), y: DIAL.C + r * Math.sin(rad) };
}

/**
 * Clockwise arc on radius `r`. `to` may exceed `from` by up to 360°; a sweep
 * of a full turn is drawn as two half-turns because a single elliptical arc
 * whose endpoints coincide renders as nothing.
 */
export function arcPath(r: number, from: number, to: number): string {
  // A 12-hour face wraps: an event that crosses 12 comes back with a smaller
  // angle than it started at, and an arc must always sweep forwards.
  if (to < from) to += 360;
  const sweep = to - from;
  if (sweep >= 359.999) {
    const half = polar(r, from + 180);
    const start = polar(r, from);
    return [
      `M ${start.x} ${start.y}`,
      `A ${r} ${r} 0 1 1 ${half.x} ${half.y}`,
      `A ${r} ${r} 0 1 1 ${start.x} ${start.y}`,
    ].join(" ");
  }
  const a = polar(r, from);
  const b = polar(r, to);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

/**
 * Inverse of `angleAt`: a point in viewBox units → minutes since midnight.
 * On the 12-hour face an angle names two times a day, so the caller passes
 * which half it means — the drag ring reads that off the pointer's radius.
 */
export function minutesAtPoint(x: number, y: number, clock: Clock = "24h", pm = false): number {
  const raw = (Math.atan2(x - DIAL.C, DIAL.C - y) * 180) / Math.PI;
  const deg = ((raw % 360) + 360) % 360;
  const minutes =
    clock === "24h"
      ? MINUTES_PER_DAY / 2 + deg * (MINUTES_PER_DAY / 360)
      : deg * (TURN["12h"] / 360) + (pm ? TURN["12h"] : 0);
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * A stroked arc with round caps grows by half a stroke width at each end, so
 * a 15-minute event would render ~40 minutes long. Shrink the sweep by that
 * overhang (never past a dot) so an arc's *painted* extent is its duration.
 */
export function capInset(r: number): number {
  return ((DIAL.ARC_WIDTH / 2 / r) * 180) / Math.PI;
}
