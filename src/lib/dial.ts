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
const DEG_PER_MINUTE = 360 / MINUTES_PER_DAY;

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
 * Clockwise arc on radius `r` — or the same arc traced anticlockwise, from
 * `to` back to `from`, when `back` is set. A sweep of a full turn is drawn as
 * two half-turns because a single elliptical arc whose endpoints coincide
 * renders as nothing.
 *
 * The direction is invisible on a stroke and decisive for text: a glyph on a
 * path takes its up-vector from the way the path is going, so a label on a
 * clockwise arc reads upright at the top of the face and upside down at the
 * bottom. See `arcLabel`.
 */
export function arcPath(r: number, from: number, to: number, back = false): string {
  const sweep = to - from;
  const flag = back ? 0 : 1;
  const head = back ? to : from;
  if (sweep >= 359.999) {
    const start = polar(r, head);
    const half = polar(r, back ? head - 180 : head + 180);
    return [
      `M ${start.x} ${start.y}`,
      `A ${r} ${r} 0 1 ${flag} ${half.x} ${half.y}`,
      `A ${r} ${r} 0 1 ${flag} ${start.x} ${start.y}`,
    ].join(" ");
  }
  const a = polar(r, head);
  const b = polar(r, back ? from : to);
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} ${flag} ${b.x} ${b.y}`;
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

/**
 * Weight of the line that traces a free event's outline, in user units.
 *
 * Derived from the stroke it is hollowing out rather than picked: the same
 * `<Face>` is drawn seven to a row at about a quarter of dial scale, so a
 * number chosen against the dial's own pixels is a number that means
 * something else on the strip. An eighth of `ARC_WIDTH` leaves ten units of
 * black between the two edges — wider than the `SEAM` two arcs keep between
 * them, so the hollow reads as a hole rather than as a thick line.
 */
export const ARC_HAIRLINE = DIAL.ARC_WIDTH / 8;

/**
 * The outline of a round-capped arc: what a *free* event is drawn as, in place
 * of the filled stroke a busy one gets.
 *
 * Hollow rather than fainter, and alpha was never available here: a past arc
 * is already drawn at 0.42, so "free" meaning "dimmer" would make a past
 * meeting and a future placeholder the same picture. What the outline says is
 * "this footprint, with none of the event in it" — which is why the travel
 * run-up borrows the same construction and dots the hairline (`travelDots`):
 * a free event is a whole arc of that, a commute is a run-up of one.
 *
 * Traced at `ARC_HAIRLINE / 2` *inside* the filled arc's own silhouette, so
 * stroking the result at that weight paints exactly the same footprint: the
 * two edges land on the filled arc's edges, and the ends land where its round
 * caps do. That is what keeps `capInset`'s promise — a caller hands the same
 * `from`/`to` it hands `arcPath`, and painted length is still duration.
 *
 * Three shapes out of one construction. A full turn is two concentric
 * circles, closed and uncapped, for the reason `arcPath` closes one: an inset
 * once the ends meet is a notch at midnight. A degenerate sweep is the two
 * caps alone, which is a ring — the hollow of the dot the filled path
 * collapses to. Anything between is the racetrack: out along the far edge,
 * round the cap, back along the near one.
 *
 * `width` is the stroke being hollowed, so a hovered arc passes its grown one.
 */
export function hollowPath(
  r: number,
  from: number,
  to: number,
  // Annotated, not inferred: `DIAL` is `as const`, so a bare default types
  // this as the literal 14 and the grown width the docstring offers is a type
  // error at the one call site that finally passed one.
  width: number = DIAL.ARC_WIDTH,
): string {
  const off = (width - ARC_HAIRLINE) / 2;
  if (to - from >= 360) return `${arcPath(r + off, from, to)} ${arcPath(r - off, from, to)}`;
  const outer = { head: polar(r + off, from), tail: polar(r + off, to) };
  const inner = { head: polar(r - off, from), tail: polar(r - off, to) };
  const large = to - from > 180 ? 1 : 0;
  return [
    `M ${outer.head.x} ${outer.head.y}`,
    `A ${r + off} ${r + off} 0 ${large} 1 ${outer.tail.x} ${outer.tail.y}`,
    // The cap: a semicircle of the arc's own half-width, centred on the
    // instant the tip stands for, carried on in the direction of travel.
    `A ${off} ${off} 0 0 1 ${inner.tail.x} ${inner.tail.y}`,
    `A ${r - off} ${r - off} 0 ${large} 0 ${inner.head.x} ${inner.head.y}`,
    `A ${off} ${off} 0 0 1 ${outer.head.x} ${outer.head.y}`,
    "Z",
  ].join(" ");
}

/* --------------------------------- travel --------------------------------- */

/**
 * Centre-to-centre spacing of the run-up's dots, in user units of outline
 * length.
 *
 * The run-up is drawn as the *outline* of the band it books — `hollowPath`,
 * the free arc's own construction — with that hairline dotted rather than
 * continuous. Two encodings composed, each keeping its meaning: an outline is
 * the footprint with none of the event in it, which is what a commute is, and
 * a broken line is an estimate, which is what a hand-typed one is. A filled
 * dashed band was built first and came out heavy: at `ARC_WIDTH` the run-up
 * has the visual weight of the meeting it leads into, so the pair read as one
 * event with a fault in it rather than as an approach.
 *
 * 4.5 against the 1.75-unit hairline leaves rather more black than ink, which
 * is the proportion that reads as dotted rather than as a worn line.
 *
 * It does not survive the whole strip, and that is measured rather than
 * hoped: at a floor-sized face a dot is 0.335 css px every 0.877, about a
 * tenth of a pixel's coverage, so the run-up is simply absent there. A
 * continuous hairline survives that size — the free arc's faint hoop does —
 * and a fatter dot would too, but a dot fat enough to read at the floor is a
 * bead at dial scale, and doubling it on hover welded the beads into a chain.
 * Absent is the better failure: nothing on the strip is drawn *wrongly*, the
 * arc the run-up leads into is unchanged, and a face 180 px across draws a
 * minute in a tenth of a pixel — the dial is where a departure is read.
 */
const TRAVEL_DOT_PITCH = 4.5;

/**
 * A dot pattern for the outline of a run-up of `sweep` degrees on radius `r`,
 * fitted so the loop closes on a whole number of dots.
 *
 * Fitted rather than fixed because the outline is a closed racetrack: a
 * repeating pattern that does not divide into its length leaves a pinch where
 * the pattern wraps, at whichever end of the run-up the arithmetic lands it.
 * The length is the racetrack's own — two edges of `sweep` at `r ± off`, whose
 * arc lengths sum to twice the centre line's, plus the two semicircular caps,
 * which together make one circle of `off`.
 *
 * `width` is the band being outlined, so a caller whose arc has grown under
 * the pointer hands the grown one and the dots stay evenly spaced round the
 * longer loop rather than crowding at its ends.
 *
 * A zero-length dash under a round cap paints a dot of the stroke's own
 * width; 0.01 rather than 0 because a genuinely empty dash is a case
 * renderers disagree about.
 */
export function travelDots(r: number, sweep: number, width: number = DIAL.ARC_WIDTH): string {
  const off = (width - ARC_HAIRLINE) / 2;
  const length = 2 * ((Math.abs(sweep) * Math.PI) / 180) * r + 2 * Math.PI * off;
  const dots = Math.max(3, Math.round(length / TRAVEL_DOT_PITCH));
  return `0.01 ${length / dots - 0.01}`;
}

/* --------------------------------- labels ---------------------------------- */

/**
 * The arc-label voice, in user units.
 *
 * 11 on a 14-unit stroke, because the label sits *inside* the stroke: a mono
 * cap is about 0.7 of the size, so 7.7 of ink with 3.1 of arc left either
 * side of it, identically on every lane. Beside an arc it could only ever
 * work on one — `LANE_STEP - ARC_WIDTH` leaves 13 units of black between two
 * lanes, and the hour numerals come down to 333 just outside the first.
 */
export const ARC_LABEL_SIZE = 11;
/** Advance of one mono glyph at that size, so a string's width is arithmetic.
 *  `getComputedTextLength` is a layout read, and there is one label per arc
 *  per frame of a drag. */
const ARC_LABEL_ADVANCE = ARC_LABEL_SIZE * 0.6;
/**
 * Clear air kept inside each of the arc's painted tips.
 *
 * Two units, because a tip is a round cap: five units in from its extreme
 * point the cap still stands 4.9 either side of the centre line, and an
 * 11-unit glyph needs 3.85. Any more comes straight off the budget, and the
 * budget is what decides whether a half-hour arc gets a name at all.
 */
const ARC_LABEL_PAD = 2;
/**
 * Fewest glyphs worth printing, the ellipsis counted.
 *
 * Where this lands, in minutes, is a fact about the geometry rather than a
 * threshold anybody chose: an hour is 11 glyphs on the outer lane and 7 on
 * the fifth, three quarters of an hour is 8 and 4, and half an hour is 5 out
 * at the rim and nothing further in. So a word gets printed from about
 * forty-five minutes, a stub from about half an hour, and the arcs below that
 * stay the honest dots they already were.
 */
const ARC_LABEL_MIN = 5;

/**
 * Half a cap, in user units: how far a glyph's ink sits from the baseline it
 * stands on, and therefore how far the label's path has to be moved to put
 * that ink on the arc's centre line. A mono cap is about 0.7 of the size.
 */
const ARC_LABEL_BASELINE = ARC_LABEL_SIZE * 0.35;

/**
 * How much of the budget a mark takes, in glyphs.
 *
 * The glyph is drawn square at `ARC_LABEL_SIZE`, which is 1.67 mono advances,
 * and it needs a gap after it or it reads as the first letter of the name. Two
 * is that, rounded to the unit the budget is counted in — the whole point of
 * counting glyphs rather than units is that one number decides this on every
 * lane at once.
 */
const ARC_MARK_GLYPHS = 2;

/** Where a mark rides on the arc, in viewBox units. The angle is baked into
 *  `rotate` because a glyph on a ring stands radially, exactly as the letters
 *  beside it do. */
export interface ArcMark {
  x: number;
  y: number;
  /** Degrees, for a `rotate()` about `(x, y)`. */
  rotate: number;
  /** Side of the square the glyph is drawn in, centred on `(x, y)`. */
  size: number;
}

export interface ArcLabel {
  /** Path to set the text on, turned so the glyphs read upright. */
  d: string;
  /** The title, cut to what the sweep can hold. */
  text: string;
  /**
   * Where the text sits along that path, as `textPath`'s own percentage. `50`
   * with nothing before it; pushed along by half the mark's width when there
   * is one, so that the *pair* is centred rather than the name alone.
   */
  startOffset: number;
  /** The mark before the name, or `null` — no mark, or no room for one. */
  mark: ArcMark | null;
}

/**
 * An event's name along its own arc, with its mark before it, or `null` when
 * there is no room for a name at all.
 *
 * `from` and `to` are the arc's *painted* ends — an event's own span, less
 * whatever a neighbouring event's seam claimed, and not the centre line that
 * `capInset` shortens. Half a stroke of paint sits past each end of that
 * centre line, and a label that ignored it would forfeit 14 units on every
 * arc: enough to leave every half-hour event on the face anonymous.
 *
 * The budget is in *glyphs*, never in minutes: the same hour is 73 units of
 * paint on the outer lane and 48 on the fifth, so a duration threshold would
 * label an event at the rim and crop the same event two lanes in.
 *
 * **A mark never costs the name its last characters.** It rides along only
 * when what is left still clears `ARC_LABEL_MIN` on its own, so a tight arc
 * drops the glyph and keeps the word rather than the other way round: the
 * label exists to say which event this is, and two more letters of the title
 * do that better than a symbol shared with everything on the same calendar.
 */
export function arcLabel(
  r: number,
  from: number,
  to: number,
  title: string,
  mark = "",
): ArcLabel | null {
  const text = title.trim();
  if (!text) return null;
  const length = (((to - from) * Math.PI) / 180) * r;
  const room = length - 2 * ARC_LABEL_PAD;
  const budget = Math.floor(room / ARC_LABEL_ADVANCE);
  const marked = mark !== "" && budget - ARC_MARK_GLYPHS >= ARC_LABEL_MIN;
  const glyphs = marked ? budget - ARC_MARK_GLYPHS : budget;
  if (glyphs < ARC_LABEL_MIN) return null;
  // The ellipsis is a glyph of the same advance, so a cut title fills the
  // budget exactly: `glyphs - 1` characters and the stub.
  const cut = text.length <= glyphs ? text : `${text.slice(0, glyphs - 1).trimEnd()}…`;
  // Anticlockwise through the bottom half of the face, where a clockwise path
  // hangs every glyph upside down. The flip has to land somewhere, and at the
  // three and nine o'clock boundaries the text is vertical either way.
  const mid = ((((from + to) / 2) % 360) + 360) % 360;
  const back = mid > 90 && mid < 270;
  // Glyphs stand *on* a text path's baseline, so their ink is a half-cap off
  // the arc's centre line — outward on a clockwise path, inward on a flipped
  // one, which is the letters hanging half off the stroke. `dominant-baseline`
  // is the CSS answer to it and WebKit ignores it on a `textPath` (measured:
  // `central`, a `dy`, and no rule at all render byte-identical bounding
  // boxes), so the correction is geometry instead: the label rides its own
  // radius, a half-cap the other side of the arc's, and lands centred in the
  // stroke on every engine.
  const labelR = r + (back ? ARC_LABEL_BASELINE : -ARC_LABEL_BASELINE);
  const labelLength = (((to - from) * Math.PI) / 180) * labelR;
  const d = arcPath(labelR, from, to, back);
  if (!marked) return { d, text: cut, startOffset: 50, mark: null };

  // The run is `mark + text`, centred on the path's own midpoint. The text
  // takes everything after the mark's slot, so its centre moves out by half
  // that slot — which is all `startOffset` is.
  const markWidth = ARC_MARK_GLYPHS * ARC_LABEL_ADVANCE;
  const textWidth = cut.length * ARC_LABEL_ADVANCE;
  // The glyph sits at the *start* of its slot rather than in the middle of it,
  // so the two units the slot has spare all land between it and the first
  // letter. Centred, that slack was split, and half of it read as a symbol
  // stuck to the D of "Design".
  const lead = (markWidth + textWidth) / 2 - ARC_LABEL_SIZE / 2;
  // A distance along the label's own path is a distance along its
  // circumference, so it is an angle; which way it leans depends on which way
  // the path was drawn.
  const lean = ((lead / labelR) * 180) / Math.PI;
  const at = (from + to) / 2 + (back ? lean : -lean);
  const { x, y } = polar(r, at);
  return {
    d,
    text: cut,
    startOffset: 50 + (markWidth / 2 / labelLength) * 100,
    // A glyph on a ring stands radially, the same way the letters do — and on
    // the flipped path it is upside down for the same reason they are.
    mark: { x, y, rotate: back ? at + 180 : at, size: ARC_LABEL_SIZE },
  };
}
