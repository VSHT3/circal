/* ------------------------------------------------------------------ *
 * The week strip: seven faces, one rotation.
 *
 * Not a grid. Seven of the same instrument at a smaller count, all at the same
 * rotation — so a ten o'clock meeting sits at the same angle on every face and
 * a recurring thing is a radial column across the strip. That is the one
 * question the dial cannot answer on its own (⌘Y says how *busy* a day is and
 * never *when*), and angle-is-time answers it for nothing.
 *
 * Nothing here touches the DOM. `WeekView` draws what this returns, and the
 * shell resolves the same layout to find where the dial has to zoom *to* —
 * before the strip is mounted, exactly as `lifeStage` is resolved before the
 * life grid exists.
 * ------------------------------------------------------------------ */

import { addDays, startOfWeek } from "./time";

export const WEEK_DAYS = 7;

/**
 * The readout under the strip, and each face's weekday and date above it.
 *
 * Fixed, both of them, for the reason `LIFE_META_H` is: the shell resolves
 * where a face's centre lands *before* the strip exists, and a caption that
 * grew by two pixels would land the dial two pixels off the face it is
 * zooming onto.
 */
export const WEEK_META_H = 30;
export const WEEK_CAPTION_H = 24;

/** Air between two faces, as a fraction of a cell. Small: the faces are the
 *  comparison, and pushing them apart is what turns a strip into seven
 *  separate pictures. */
const GUTTER = 0.08;

/**
 * The strip cannot be a row on a phone — seven faces across 390px is 55px
 * each, which is smaller than the arcs are long. Below this the faces keep a
 * usable diameter and the strip scrolls, which is the one arrangement that
 * does not concede the argument: a wrapped 4+3 block of circles *is* a grid.
 */
export const WEEK_MIN_FACE = 132;

export interface WeekLayout {
  /** Diameter of one face, in panel pixels. */
  size: number;
  /** Centre-to-centre distance between two faces. */
  pitch: number;
  /** Left edge of the first face. `0` once the strip scrolls. */
  inset: number;
  /** Top edge of the faces, under the captions. */
  top: number;
  /** Top edge of the whole group — captions, faces, readout. */
  groupTop: number;
  /** Captions plus faces plus readout. */
  groupHeight: number;
  /** Whether the seven fit the box, or the strip has to scroll. */
  scrolls: boolean;
}

export interface WeekStage {
  /** Local midnight of the strip's Monday. */
  from: Date;
  layout: WeekLayout;
  /** The whole panel box the layout was resolved against. */
  box: { width: number; height: number };
}

/**
 * How big seven faces can be in this box.
 *
 * Height-bound or width-bound, whichever bites first — the same question the
 * dial answers for one face, asked seven times over. A face is square, so the
 * width available to each is `width / 7` less its share of the gutters, and
 * the height is the box less the caption above and the readout below.
 *
 * The readout is inside the group rather than pinned to the foot of the panel,
 * and that is composition rather than arithmetic. Seven circles in a row are
 * necessarily about a seventh of the width tall, so in any landscape window
 * the strip is a wide short band with a great deal of black under it — and a
 * sentence alone at the bottom of that black is not the strip's readout, it is
 * a caption for the window. Grouped and centred, the three parts read as one
 * object; the leftover height stays where it belongs, which is outside it.
 */
export function weekLayout(width: number, height: number): WeekLayout {
  const room = Math.max(0, height - WEEK_CAPTION_H - WEEK_META_H);
  const byWidth = width / (WEEK_DAYS + (WEEK_DAYS - 1) * GUTTER);
  const size = Math.max(0, Math.min(byWidth, room));
  const scrolls = size < WEEK_MIN_FACE && room >= WEEK_MIN_FACE;
  // Scrolling: the faces take the height they can have and run off the side.
  const face = scrolls ? Math.min(room, WEEK_MIN_FACE) : size;
  const pitch = face * (1 + GUTTER);
  const used = pitch * (WEEK_DAYS - 1) + face;
  const groupHeight = WEEK_CAPTION_H + face + WEEK_META_H;
  const groupTop = Math.max(0, (height - groupHeight) / 2);
  return {
    size: face,
    pitch,
    // Centred while they fit; hard left once they do not, because a scroll
    // container that starts part-way in opens on half of Monday.
    inset: scrolls ? 0 : Math.max(0, (width - used) / 2),
    top: groupTop + WEEK_CAPTION_H,
    groupTop,
    groupHeight,
    scrolls,
  };
}

/**
 * The strip for a day, resolved against a panel box. `null` when the box has
 * not been measured yet — the shell asks for this on its first render, before
 * the `ResizeObserver` has said anything.
 */
export function weekStage(day: Date, panelWidth: number, panelHeight: number): WeekStage | null {
  const box = { width: panelWidth, height: panelHeight };
  if (box.width < 1 || box.height < WEEK_CAPTION_H + WEEK_META_H) return null;
  return { from: startOfWeek(day), layout: weekLayout(box.width, box.height), box };
}

/** The seven days of the strip, in day order. */
export function weekDays(from: Date): Date[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(from, i));
}

/**
 * Where one face's centre sits inside the panel's content box.
 *
 * The zoom's whole endpoint: the dial scales down onto this point, so it has
 * to be the same arithmetic the strip itself draws with — which is why both
 * callers go through this rather than each laying the row out for themselves.
 */
export function weekFaceCentre(layout: WeekLayout, index: number): { x: number; y: number } {
  return {
    x: layout.inset + index * layout.pitch + layout.size / 2,
    y: layout.top + layout.size / 2,
  };
}

/**
 * How far the dial has to shrink to become one face of the strip.
 *
 * The dial fills its panel, so its drawn diameter is the smaller side of the
 * box; the face's is `layout.size`. One number rather than `ZOOM_STEPS`'
 * geometric ladder, because this is a zoom of about four times rather than of
 * two orders of magnitude, and a ladder over that distance reads as a stutter.
 */
export function weekZoomScale(layout: WeekLayout, panelWidth: number, panelHeight: number): number {
  const dial = Math.min(panelWidth, panelHeight);
  if (dial <= 0 || layout.size <= 0) return 1;
  return layout.size / dial;
}
