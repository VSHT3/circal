/* ------------------------------------------------------------------ *
 * The year face: one revolution, one year.
 *
 * The same argument the dial makes about a day, made about a year — and it
 * has to be the same argument, or ⌘Y is a calendar widget bolted to the side
 * of an instrument. So: the same 1000-unit space, the same `polar`, the same
 * crop, one mark per day in day order, clockwise from the top.
 *
 * Angle is day-of-year and nothing else — no week grid, no month blocks —
 * because that is the ordering a row of the life grid uses, and it is what
 * lets ⌘Y ⇄ ⌘L be an unroll of the same days rather than a crossfade between
 * two unrelated pictures.
 *
 * There is no second axis. Radius inside the marks was a daylight figure for
 * one draft — sunrise and sunset as two curves round the year — and it was
 * the wrong thing on the right screen: interesting, and never what you came
 * to a calendar to find out. The interior belongs to the readout.
 * ------------------------------------------------------------------ */

import { DIAL, VIEW_SIZE } from "./dial";

export const YEAR = {
  /**
   * One mark per day, growing *outwards* from `DAY_INNER` with the day's
   * count. Every day gets one, empty or not — the life grid draws every day
   * as a dot too, and a ring with holes in it stops being a year.
   *
   * The inner edge is therefore a rule and the outer edge is ragged, which is
   * the right way round: the eye reads the raggedness as the data and the
   * rule as the axis it is measured from.
   *
   * Fifty-eight units of travel, which is a lot for a bar — and it has to be.
   * The interior is empty, so this ring *is* the face, and at the twenty units
   * it started with the whole year read as a hairline round a hole.
   *
   * Pulled in from 336/396 to leave the magnifier somewhere to go.
   */
  DAY_INNER: 328,
  DAY_OUTER: 386,
  /** What a day with nothing on it draws. At the size a year renders that is
   *  a square, which is a dot — the same thing the same day is in the life
   *  grid. */
  DAY_STUB: 8,
  /**
   * Width of one mark. A year is 365 slots of 0.986°, which at this radius is
   * a 6.2-unit chord — 4.4 of stroke leaves under two units of black between
   * neighbours, and below about that the marks weld into a solid ring.
   */
  DAY_WIDTH: 4.4,
  /** Occurrences on a day before its mark is at full length. Past five, a day
   *  is simply full and the extra says nothing a longer bar could show. */
  DAY_FULL_COUNT: 5,

  /**
   * The magnification under the pointer, in the units it is measured in.
   *
   * A day grows **outwards**, tip first, and thickens. It grew inwards for a
   * draft, on the argument that the outer tip is the datum and pushing it out
   * makes a hovered empty day look like a booked one — which is true and is
   * the wrong trade. Only one day is ever magnified, it is unmistakably the
   * magnified one, and it is the only day whose count the readout is printing
   * in words at the same moment. Growing away from the centre is what reads
   * as the day coming up to meet you; growing towards it read as a smudge.
   */
  GROW_OUT: 28,
  /** …and half as much again as wide, which is what the pushing is for. */
  GROW_WIDTH: 1.25,
  /**
   * How far the neighbours give way, in *day slots*, at the peak of the push.
   *
   * A slot is 6 units at this radius and a magnified mark is 5.5 units wider
   * than a resting one, so a little under a slot each side is very nearly
   * exactly the air the growth takes up: the ring keeps its rhythm instead of
   * the hovered day eating its neighbours.
   */
  PUSH: 0.9,
  /** Width of the bell, in days: `magnify(1)` is a half, which is the "and
   *  its two neighbours, less so" the effect is made of. */
  SIGMA: 1.2,
  /** Where the push peaks, in days — just outside the hovered mark, where the
   *  room is actually needed. */
  SIGMA_PUSH: 1.15,
  /**
   * Where both curves are cut, in days.
   *
   * It has to be far enough out that the value there is already invisible,
   * because the cut is a step and every step in these curves is a day that
   * visibly snaps as the pointer crosses it. `magnify` is under a millionth
   * here; `spread`, which has a long tail, is 0.3% of a push — three
   * hundredths of a unit, which is nothing. It was 3.4 and `spread` was still
   * 6% there.
   */
  REACH: 4.5,

  /** Today's pip, just inside the ring. A halo rather than a fill, for the
   *  reason the life grid's is: the day's own colour is its events', and
   *  being today is not one of them. */
  TODAY_PIP: 3.4,
  TODAY_RING: 306,

  /**
   * Month boundaries, outside the marks — the same relationship the hour ticks
   * have to the dial's track, and far enough out to clear a magnified tip
   * (`DAY_OUTER + GROW_OUT` = 414). They sit at month *edges* and the names at
   * month *middles*, so the two are never at the same angle and the radial gap
   * between them costs nothing.
   */
  TICK_INNER: 422,
  TICK_OUTER: 434,

  /** Ring the month names are centred on. Deliberately `DIAL.ZONE`: the
   *  outermost text of both faces sits on the same circle, so ⌘D ⇄ ⌘Y is one
   *  object relabelled rather than two drawings of different sizes. */
  MONTH: DIAL.ZONE,
} as const;

/* -------------------------------- the angle -------------------------------- */

/** 365, or 366. Measured rather than tabulated, so the leap rule lives in one
 *  place — the platform's. */
export function daysInYear(year: number): number {
  return Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000);
}

/** 0 for 1 January. `Date.UTC` on the calendar fields, so a DST boundary
 *  inside the year cannot shift a day by one — the same reason `life.ts`
 *  rounds. */
export function dayOfYear(date: Date): number {
  return Math.round(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
      Date.UTC(date.getFullYear(), 0, 1)) /
      86_400_000,
  );
}

/** The date at `index` days into `year`, local. */
export function dateOfYear(year: number, index: number): Date {
  return new Date(year, 0, 1 + index);
}

/**
 * The *leading edge* of day `index`'s slot, in degrees clockwise from the top.
 * 1 January starts at 12 o'clock. Fractional indices are meaningful, which is
 * how a month boundary and a slot centre are both expressed here.
 */
export function yearAngle(index: number, days: number): number {
  return (index * 360) / days;
}

/** The centre of day `index`'s slot — where its mark is drawn. */
export function dayAngle(index: number, days: number): number {
  return yearAngle(index + 0.5, days);
}

/**
 * Inverse of `yearAngle`: a point in viewBox units → where it falls in the
 * year, as a *fraction* of a day, always inside `[0, days)`.
 *
 * Fractional because the magnification is continuous while the day named in
 * the readout is not. Quantising the bulge to whole days makes it lurch a
 * slot at a time under a pointer that is moving smoothly, which is the one
 * thing a magnifier must not do.
 */
export function yearAtPoint(x: number, y: number, days: number): number {
  const deg = (Math.atan2(y - DIAL.C, x - DIAL.C) * 180) / Math.PI + 90;
  const wrapped = ((deg % 360) + 360) % 360;
  return (wrapped / 360) * days;
}

/** Which slot a fractional position in the year falls in. */
export function dayOfYearAt(exact: number, days: number): number {
  // `floor` of a value that can round up to exactly `days` lands one past the
  // end of the year, which is a day that does not exist.
  return Math.min(days - 1, Math.floor(exact));
}

/**
 * The day whose slot a point falls in. Exact inverse of `dayAngle`, and it
 * must stay so — the same contract `minutesAtPoint` has with `angleAt`.
 */
export function dayAtPoint(x: number, y: number, days: number): number {
  return dayOfYearAt(yearAtPoint(x, y, days), days);
}

/**
 * How far day `index` is from a fractional position in the year, the short
 * way round. 31 December and 1 January are neighbours, so a pointer on 2
 * January has to magnify the end of the old year as well as the start of the
 * new one; measured linearly it would be 364 days away and stay flat.
 */
export function ringDelta(index: number, at: number, days: number): number {
  const raw = index - at;
  return raw - days * Math.round(raw / days);
}

/* ------------------------------- the radius -------------------------------- */

/** Outer end of a day's mark, given how many occurrences land on it. */
export function markRadius(count: number): number {
  const inner = YEAR.DAY_INNER + YEAR.DAY_STUB;
  if (count <= 0) return inner;
  const t = Math.min(1, count / YEAR.DAY_FULL_COUNT);
  return inner + t * (YEAR.DAY_OUTER - inner);
}

/* ----------------------------- magnification ------------------------------- */

/**
 * How much of the bulge a day `distance` days from the pointer gets: 1 under
 * it, a half either side, a fifteenth two out, nothing past `REACH`.
 *
 * A Gaussian rather than a cosine bell or a clamped parabola, because it is
 * the only one of the three with no corner anywhere: every kink in this curve
 * is a day that visibly snaps as the pointer crosses it.
 */
export function magnify(distance: number): number {
  const x = Math.abs(distance);
  if (x > YEAR.REACH) return 0;
  return Math.exp(-(x * x) / (YEAR.SIGMA * YEAR.SIGMA));
}

/**
 * How far a day `distance` days from the pointer gives way, as a share of
 * `PUSH`, signed towards its own side.
 *
 * Zero under the pointer (that day is not going anywhere), a peak at
 * `SIGMA_PUSH` where the room is actually wanted, and back to zero further
 * out — so the rest of the year stays exactly where it was and the ring keeps
 * its rhythm. Normalised so the peak is 1.
 */
export function spread(distance: number): number {
  const x = Math.abs(distance);
  if (x > YEAR.REACH) return 0;
  const t = x / YEAR.SIGMA_PUSH;
  return Math.sign(distance) * t * Math.exp(0.5 - (t * t) / 2);
}

/* -------------------------------- the unroll ------------------------------- */

export interface Vec {
  x: number;
  y: number;
}

/**
 * The face's own coordinates, in the panel's pixels.
 *
 * The `<svg>` is `xMidYMid meet` over `VIEW_BOX`, so it is scaled to the
 * shorter side and centred on the longer one. Anything drawn *beside* the SVG
 * — the unroll's canvas — has to reproduce that or it starts a few pixels off
 * every mark, which on a transition between two exact positions is the one
 * error you cannot hide.
 */
export function faceToPanel(width: number, height: number) {
  const u = Math.min(width, height) / VIEW_SIZE;
  const ox = (width - VIEW_SIZE * u) / 2 - DIAL.PAD * u;
  const oy = (height - VIEW_SIZE * u) / 2 - DIAL.PAD * u;
  return { u, at: (x: number, y: number): Vec => ({ x: ox + x * u, y: oy + y * u }) };
}

/**
 * A circle straightening into a line, and the whole reason the year is a ring.
 *
 * Day ⇄ life is a zoom because the dial *is* the dot. Year ⇄ life is an
 * unroll because a year in day order round a circle *is* a row of the life
 * grid rolled up — a stricter identity than the zoom's, and one a month grid
 * could never have claimed.
 *
 * The maths is the honest version rather than a fly-to-target: at `t` the days
 * lie on a circle whose curvature is `(1 - t) / radius`, so the radius grows
 * without bound and the arc flattens, while the arc *length* eases from the
 * ring's circumference to the row's width. Interpolating positions directly
 * would scatter 365 particles at a line; this keeps them on one curve the
 * whole way, which is what makes it read as paper unrolling rather than as a
 * transition effect.
 *
 * `from` is where 1 January sits now, `to` where it is going. Everything is
 * measured forward along the year from there, so the anchor never drifts.
 */
export function unroller(t: number, from: Vec, to: Vec, radius: number, length: number) {
  const anchor = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  const arc = 2 * Math.PI * radius * (1 - t) + length * t;
  const k = (1 - t) / radius;

  /** `at` is 0…1 along the year. Returns the point and the outward normal —
   *  the direction a mark's length still runs in, which is radial on the ring
   *  and straight up once the line is flat. */
  return (at: number): { point: Vec; out: Vec } => {
    const s = at * arc;
    // Straight, and `1/k` is no longer a number. `sin θ / k → s` and
    // `(1 - cos θ) / k → 0` in the limit, which is exactly the line.
    if (k < 1e-9) {
      return { point: { x: anchor.x + s, y: anchor.y }, out: { x: 0, y: -1 } };
    }
    const theta = s * k;
    return {
      point: { x: anchor.x + Math.sin(theta) / k, y: anchor.y + (1 - Math.cos(theta)) / k },
      out: { x: Math.sin(theta), y: -Math.cos(theta) },
    };
  };
}

/* -------------------------------- the months ------------------------------- */

export interface MonthMark {
  month: number;
  /** Leading edge of the month — where its tick goes. */
  edge: number;
  /** Angular middle of the month — where its name goes. */
  mid: number;
}

/** The twelve boundaries and the twelve label anchors, in degrees. */
export function monthMarks(year: number): MonthMark[] {
  const days = daysInYear(year);
  const marks: MonthMark[] = [];
  for (let month = 0; month < 12; month++) {
    const from = dayOfYear(new Date(year, month, 1));
    const to = month === 11 ? days : dayOfYear(new Date(year, month + 1, 1));
    marks.push({
      month,
      edge: yearAngle(from, days),
      mid: yearAngle((from + to) / 2, days),
    });
  }
  return marks;
}
