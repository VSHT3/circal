/* ------------------------------------------------------------------ *
 * The week: seven faces, one rotation.
 *
 * Seven of the same instrument at a smaller count, all at the same rotation —
 * so a ten o'clock meeting sits at the same angle on every face and a
 * recurring thing is a shape you can see repeat across the week. That is the
 * one question the rest of the app cannot answer (⌘Y says how *busy* a day is
 * and never *when*), and angle-is-time answers it for nothing.
 *
 * It was a single row for one release, on the argument that a wrapped block of
 * circles is a grid and a grid is what this view exists not to be. The
 * argument was about the wrong thing. Seven circles across a landscape window
 * are necessarily a seventh of it wide — about 210px, where an arc is four
 * pixels long and a name cannot be printed anywhere near it — and a comparison
 * you cannot read is not a comparison. What carries the idea is that every
 * face keeps the same rotation and the reading order is still day order;
 * neither of those cares how many rows it takes. So the arrangement is now
 * whichever one makes the faces biggest in the box, and in a landscape window
 * that is two rows of a face nearly twice the size.
 *
 * Nothing here touches the DOM. `WeekView` draws what this returns, and the
 * shell resolves the same layout to find where the dial has to zoom *to* —
 * before the strip is mounted, exactly as `lifeStage` is resolved before the
 * life grid exists.
 * ------------------------------------------------------------------ */

import { addDays, startOfWeek } from "./time";

export const WEEK_DAYS = 7;

/**
 * The readout under the grid, and each face's weekday and date above it.
 *
 * Fixed, both of them, for the reason `LIFE_META_H` is: the shell resolves
 * where a face's centre lands *before* the grid exists, and a caption that
 * grew by two pixels would land the dial two pixels off the face it is
 * zooming onto.
 */
export const WEEK_META_H = 30;
export const WEEK_CAPTION_H = 24;

/** Air between two faces on a row, as a fraction of a face. Small: the faces
 *  are the comparison, and pushing them apart is what turns a week into seven
 *  separate pictures. */
const GUTTER = 0.08;
/** Air between two rows, on top of the caption that already sits there. Less
 *  than the horizontal gutter for exactly that reason — the caption is 24px of
 *  vertical air the columns do not get. */
const ROW_GUTTER = 0.05;

/**
 * Below this a face is smaller than the arcs drawn on it. Nothing in the box
 * can fix that, so the grid takes the widest row that clears the floor and
 * runs off the bottom instead — vertical, because a row that scrolls sideways
 * hides days behind an edge nobody looks at, where a column of them is the
 * scroll direction every phone already has.
 */
export const WEEK_MIN_FACE = 132;

/**
 * Where a face is big enough to carry the dial's own scale — the half-hour
 * ticks and the four hours the face is navigated by.
 *
 * Arithmetic, not taste: the numerals are 30 units in a 1000-unit viewBox, so
 * they land at `0.03 × size` pixels. At 320 that is 9.6px, which is the
 * smallest a numeral is read at rather than seen at; below it they are the
 * grey fringe the reduced face exists to avoid, and the readout is answering
 * in real pixels anyway.
 */
export const WEEK_SCALE_FACE = 320;

/**
 * How many rows the seven may be dealt into. Not every count: five and six
 * leave rows of one, which reads as a face that fell off the row above it.
 */
const ROW_CHOICES = [1, 2, 3, 4, 7] as const;

export interface WeekLayout {
  /** Diameter of one face, in panel pixels. */
  size: number;
  /** How many faces on each row, in day order. Widest row first, so a ragged
   *  last row is short rather than the other way round. */
  rows: number[];
  /** Centre-to-centre distance between two faces on a row. */
  pitch: number;
  /** Centre-to-centre distance between two rows: a caption, a face, a gutter. */
  rowPitch: number;
  /** The box the rows are centred in. */
  width: number;
  /** Top edge of the first row's faces, under its caption. */
  top: number;
  /** Top edge of the whole group — captions, faces, readout. */
  groupTop: number;
  /** Every row and its caption, plus the readout. */
  groupHeight: number;
  /** Whether the group fits the box, or has to scroll down out of it. */
  scrolls: boolean;
}

export interface WeekStage {
  /** Local midnight of the week's Monday. */
  from: Date;
  layout: WeekLayout;
  /** The whole panel box the layout was resolved against. */
  box: { width: number; height: number };
}

/** Seven dealt into `rows` rows, as evenly as they go. The remainder lands on
 *  the first rows rather than the last, so the short row is at the bottom. */
function rowCounts(rows: number): number[] {
  const base = Math.floor(WEEK_DAYS / rows);
  const extra = WEEK_DAYS % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The biggest face `cols` of them can be, given the width alone. */
function byWidth(width: number, cols: number): number {
  return width / (cols + (cols - 1) * GUTTER);
}

/** The biggest face `rows` rows of them can be, given the height alone —
 *  every row costing a caption, and the group costing one readout. */
function byHeight(height: number, rows: number): number {
  const room = height - WEEK_META_H - rows * WEEK_CAPTION_H;
  return room / (rows + (rows - 1) * ROW_GUTTER);
}

/**
 * How big seven faces can be in this box, and how to arrange them.
 *
 * Every arrangement is tried and the one with the biggest face wins, ties
 * going to the flatter one: a face's diameter is the whole of what this view
 * can be read at, and which of the five shapes delivers it is a fact about the
 * window rather than a preference. A landscape window lands on 4 + 3, a
 * portrait one on 3 + 2 + 2 or 2 + 2 + 2 + 1, and a box shaped like a column
 * on seven singles.
 *
 * The readout is inside the group rather than pinned to the foot of the panel:
 * grouped and centred, the captions, the faces and the sentence read as one
 * object, and the leftover height stays outside it where it belongs.
 */
export function weekLayout(width: number, height: number): WeekLayout {
  let rows = 1;
  let size = 0;
  for (const r of ROW_CHOICES) {
    const s = Math.max(0, Math.min(byWidth(width, Math.ceil(WEEK_DAYS / r)), byHeight(height, r)));
    // A hair of hysteresis, so two arrangements that come out equal to the
    // pixel do not swap on a one-pixel resize.
    if (s > size + 0.5) {
      size = s;
      rows = r;
    }
  }

  // Nothing fits: take the widest row that still clears the floor and let the
  // grid run off the bottom. Only worth doing if the height can show one
  // floor-sized face at all — a grid that scrolls *and* is too small to read
  // has conceded twice.
  const oneRow = Math.max(0, height - WEEK_CAPTION_H - WEEK_META_H);
  const scrolls = size < WEEK_MIN_FACE && oneRow >= WEEK_MIN_FACE;
  if (scrolls) {
    const cols = Math.max(
      1,
      ...ROW_CHOICES.map((r) => Math.ceil(WEEK_DAYS / r)).filter(
        (c) => byWidth(width, c) >= WEEK_MIN_FACE,
      ),
    );
    rows = Math.ceil(WEEK_DAYS / cols);
    size = Math.min(byWidth(width, cols), oneRow);
  }

  const groupHeight = rows * (WEEK_CAPTION_H + size) + (rows - 1) * ROW_GUTTER * size + WEEK_META_H;
  // Hard to the top once it scrolls: a scroll container that starts part-way
  // in opens on half of Monday.
  const groupTop = scrolls ? 0 : Math.max(0, (height - groupHeight) / 2);
  return {
    size,
    rows: rowCounts(rows),
    pitch: size * (1 + GUTTER),
    rowPitch: WEEK_CAPTION_H + size * (1 + ROW_GUTTER),
    width,
    top: groupTop + WEEK_CAPTION_H,
    groupTop,
    groupHeight,
    scrolls,
  };
}

/**
 * The grid for a day, resolved against a panel box. `null` when the box has
 * not been measured yet — the shell asks for this on its first render, before
 * the `ResizeObserver` has said anything.
 */
export function weekStage(day: Date, panelWidth: number, panelHeight: number): WeekStage | null {
  const box = { width: panelWidth, height: panelHeight };
  if (box.width < 1 || box.height < WEEK_CAPTION_H + WEEK_META_H) return null;
  return { from: startOfWeek(day), layout: weekLayout(box.width, box.height), box };
}

/** The seven days of the week, in day order. */
export function weekDays(from: Date): Date[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(from, i));
}

/**
 * Where one face's centre sits inside the panel's content box.
 *
 * The zoom's whole endpoint: the dial scales down onto this point, so it has
 * to be the same arithmetic the grid itself draws with — which is why both
 * callers go through this rather than each laying the faces out for
 * themselves. Every row is centred on its own, so the short one sits under the
 * middle of the one above it.
 */
export function weekFaceCentre(layout: WeekLayout, index: number): { x: number; y: number } {
  let row = 0;
  let col = index;
  while (row < layout.rows.length - 1 && col >= layout.rows[row]) {
    col -= layout.rows[row];
    row += 1;
  }
  const count = layout.rows[row];
  const used = count * layout.size + (count - 1) * GUTTER * layout.size;
  return {
    x: Math.max(0, (layout.width - used) / 2) + col * layout.pitch + layout.size / 2,
    y: layout.top + row * layout.rowPitch + layout.size / 2,
  };
}

/**
 * How far the dial has to shrink to become one face of the grid.
 *
 * The dial fills its panel, so its drawn diameter is the smaller side of the
 * box; the face's is `layout.size`. One number rather than `ZOOM_STEPS`'
 * geometric ladder, because this is a zoom of about three times rather than of
 * two orders of magnitude, and a ladder over that distance reads as a stutter.
 */
export function weekZoomScale(layout: WeekLayout, panelWidth: number, panelHeight: number): number {
  const dial = Math.min(panelWidth, panelHeight);
  if (dial <= 0 || layout.size <= 0) return 1;
  return layout.size / dial;
}
