/* ------------------------------------------------------------------ *
 * Dial geometry.
 *
 * One revolution = one day, always. The two faces differ only in what sits
 * at the top and how the hours are named:
 *
 *   12h  noon at the top, midnight at the bottom, hours read 12 · 1…11 · 12
 *        with AM/PM captions — the twelve hours, twice.
 *   24h  midnight at the top, noon at the bottom, hours read 00 · 1…23.
 *
 * Both run clockwise at 0.25° per minute, so an event's arc is the same
 * length on either face; switching is a 180° rotation and a relabel.
 *
 * All numbers below are in the SVG user units of a 1000×1000 viewBox, so a
 * component only ever sets the rendered pixel size once and every radius,
 * stroke and font scales with it.
 * ------------------------------------------------------------------ */

import { MINUTES_PER_DAY, type Clock } from "./time";

export const DIAL = {
  /** The coordinate space. C is both cx and cy. */
  SIZE: 1000,
  C: 500,
  /**
   * The viewBox is cropped to `PAD PAD (SIZE-2·PAD)`; without it a fifth of
   * the rendered box would be empty margin and the dial would sit small in
   * its own window. What fixes the number is the *second zone's* ring, the
   * only thing drawn outside the track: its numerals reach 453 and its
   * caption runs further to the right of the topmost one, so the crop has to
   * leave 470 units of radius, not the 461 the numerals alone would need.
   */
  PAD: 30,

  /** Your own day's ring — track for the elapsed trail, or for your band. */
  TRACK: 400,
  TRACK_WIDTH: 3,

  /** Hour ticks live just inside the track. */
  TICK_OUTER: 396,
  TICK_INNER: 380,
  /** Half-hour ticks are the same ring, shorter and dimmer. */
  TICK_INNER_MINOR: 387,

  /** Ring the hour numerals are centred on. */
  LABELS: 340,

  /** Centre of the outermost event lane, and the step inwards per lane. */
  LANE: 293,
  LANE_STEP: 27,
  ARC_WIDTH: 14,
  /**
   * Black between two arcs that abut on one lane, in user units — a little over
   * a quarter of the stroke. Below about this the two round caps read as one
   * welded line; much more and a pair of back-to-back events look scheduled
   * further apart than they are.
   */
  SEAM: 4,

  /** Inner edge of the drag-to-create annulus, clear of the centre panel. */
  DRAG_INNER: 165,

  /**
   * The now-hand is a spoke, not a diameter: it runs inwards from the track
   * and fades out before `HAND_INNER`, which clears the readout and the
   * agenda card. A hand through the centre crosses both.
   */
  HAND_WIDTH: 1.7,
  HAND_INNER: 205,
  /** Round pip on the track marking the exact minute. */
  HAND_PIP: 3.6,

  /**
   * The second zone's lightcycle band, and the ring its quarter-hours are
   * named on. Both belong to the other place, so they sit together outside
   * everything of yours, and 21 units of black separate the band from your
   * track — a few units apart the two bands read as one line accidentally
   * doubled, which is the whole reason your own band is *on* the track
   * rather than beside it. There is deliberately no second radius for your
   * own light: the day's light and the day's progress are the same ring's
   * worth of information.
   *
   * `ZONE` is the outermost thing on the face and the reason `PAD` is what
   * it is: a 15-unit numeral centred here reaches 453, and the caption
   * beside the topmost one runs another 131 units to the right at worst.
   * That caption runs *horizontally*, outwards from a numeral, so it never
   * crosses the band inside it — keep the band inside the numerals if either
   * radius moves.
   */
  ZONE_BAND: 424,
  ZONE: 446,
} as const;

/** Side of the cropped viewBox, in user units — the overlay's scale basis. */
export const VIEW_SIZE = DIAL.SIZE - 2 * DIAL.PAD;
export const VIEW_BOX = `${DIAL.PAD} ${DIAL.PAD} ${VIEW_SIZE} ${VIEW_SIZE}`;

/** Degrees of arc per minute — one revolution per day on both faces. */
export const DEG_PER_MINUTE = 360 / MINUTES_PER_DAY;

/** The minute that sits at the top of the face. */
function origin(clock: Clock): number {
  return clock === "12h" ? MINUTES_PER_DAY / 2 : 0;
}

/** Minutes since midnight → degrees clockwise from the top of the face. */
export function angleAt(minutes: number, clock: Clock = "12h"): number {
  return (minutes - origin(clock)) * DEG_PER_MINUTE;
}

/** Degrees clockwise from 12 o'clock → point on the circle of radius `r`. */
export function polar(r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: DIAL.C + r * Math.cos(rad), y: DIAL.C + r * Math.sin(rad) };
}

/**
 * Clockwise arc on radius `r`. A sweep of a full turn is drawn as two
 * half-turns because a single elliptical arc whose endpoints coincide renders
 * as nothing.
 */
export function arcPath(r: number, from: number, to: number): string {
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
 * Used by drag-to-create, so the result is always inside `[0, 1440)`.
 */
export function minutesAtPoint(x: number, y: number, clock: Clock = "12h"): number {
  const raw = (Math.atan2(x - DIAL.C, DIAL.C - y) * 180) / Math.PI;
  const deg = ((raw % 360) + 360) % 360;
  const minutes = origin(clock) + deg / DEG_PER_MINUTE;
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

/**
 * How much of an abutting end an arc gives up, in degrees, so that the black
 * between two arcs on one lane is never thinner than `DIAL.SEAM`.
 *
 * Two round caps whose painted ends land on the same instant touch at a single
 * point on the centre line and fall away from it either side, which leaves a
 * pinched black cusp rather than a gap: back-to-back events read as one bent
 * line with a dent in it. Half the seam comes off each end, so the join stays
 * centred on the instant the two events actually share.
 *
 * It closes what is missing rather than subtracting a fixed amount: two events
 * with minutes between them are left exactly as they were, and an arc dragged
 * up against its neighbour arrives at the seam smoothly instead of snapping to
 * it. `gap` is in minutes; `Infinity` for an end with nothing beside it.
 */
export function seamTrim(r: number, gap: number): number {
  const seam = ((DIAL.SEAM / r) * 180) / Math.PI;
  return Math.max(0, (seam - gap * DEG_PER_MINUTE) / 2);
}
