/* ------------------------------------------------------------------ *
 * The life grid's canvas: the field, and the wave that reveals it.
 *
 * Thirty thousand dots are drawn, never rendered — so this half of the
 * view is pixels and arithmetic with no React in it at all, which is why
 * it can live on its own. `drawField` builds the picture once into an
 * offscreen canvas; `paintReveal` is every frame of the transition, and
 * costs one `drawImage`, one radial gradient and one arc.
 *
 * The tone tables come with them, because the loupe draws the same days
 * at a different pitch and the two disagreeing about which of those a day
 * is would be the magnifier lying about the thing it magnifies.
 * ------------------------------------------------------------------ */

import {
  lifeDotX,
  lifeDotY,
  lifeYearRange,
  type LifeLayout,
  type LifePoint,
  type LifeSpan,
} from "@/lib/life";
import { dayKey } from "@/lib/time";
import { THEME_PALETTES, washHex, type ThemeName } from "@/lib/theme";

const TAU = Math.PI * 2;
const DAY_MS = 86_400_000;

/** How wide the wavefront's own gradient is, as a share of its travel. */
const FEATHER = 0.16;

/**
 * How bright a day is, as a level rather than a colour: everything here is
 * multiplied by the end-of-life fade before it reaches `dim`.
 *
 * Two tones per state, alternating by month. A month is not a whole number of
 * weeks, so in a grid whose columns are weeks it cannot be a gap — tone is the
 * only channel left for it, and the band drifting along the row is the honest
 * shape of the thing. It is a fine line: six alternations across fifty-odd
 * columns is close enough to the dot pitch that too much contrast between the
 * pair stops reading as months and starts reading as vertical striping. This
 * pair is the tested one; widen it and the field moirés.
 *
 * Solid past, faint future. The lived half is the part you own, and every
 * reader arrives expecting the filled portion of a progress figure to be the
 * spent one. Neither state may go to near-black though: the argument of this
 * view is the whole span in one viewport, and a half you cannot see is a half
 * that is not there.
 *
 * This is the grey channel and it carries time, which is the one thing the
 * layout already says — a dot's row is its year. So it stops at the field: an
 * event's colour is never dimmed by how far off it is. Colour is the only
 * channel with data in it, and the days ahead that carry something are exactly
 * the ones you can still do anything about. The end-of-life fade is the sole
 * exception, and it is not distance: it is the grid running out, which every
 * dot is subject to or none is.
 *
 * Opaque greys rather than translucent white, for the reason the dial's
 * elapsed ring is: on true black the two are the same colour, and only one of
 * them can be composited wrong.
 */
const TONE = {
  past: [0.58, 0.45],
  future: [0.23, 0.17],
} as const;

/**
 * The field under an active search. The horizon survives — a thread with no
 * sense of lived-against-left is a pattern rather than an answer — but both
 * sides drop far enough that a lit day is the only thing the eye lands on.
 * No month band down here: at this level the pair would be one colour, and a
 * second rhythm across an answer is noise either way.
 */
const SEARCH_TONE = { past: 0.13, future: 0.06 } as const;

/**
 * How the grid ends. The expectancy is a guess, and a guess drawn as an edge
 * is a claim about a date — so the last few days ramp to black and the field
 * trails off instead of stopping.
 *
 * A week, and it is a count of days rather than a share of the span on
 * purpose. A share scales with the life, and any share big enough to see is
 * years of it: the last decade goes grey and the softness stops reading as an
 * edge condition and starts reading as data about your seventies. Seven dots
 * is the smallest thing that is unmistakably a fade and not a ragged row.
 */
const FADE_DAYS = 7;
/** Quantisation of that ramp: a dot reuses its neighbour's colour instead of
 *  minting one of thirty thousand. */
export const FADE_STEPS = 32;

/* The accent a canvas needs is `THEME_PALETTES[theme].accent`, via `drawField`. */

export interface Box {
  width: number;
  height: number;
}

/**
 * A day's grey level: its month band, dimmed for the past, or the flat pair a
 * search leaves behind when it takes the colour channel whole.
 *
 * Shared, because the loupe draws the same days as the field and the two
 * disagreeing about which of those a day is would be the magnifier lying
 * about the thing it magnifies.
 */
export function dayLevel(month: number, past: boolean, searching: boolean): number {
  if (searching) return past ? SEARCH_TONE.past : SEARCH_TONE.future;
  return (past ? TONE.past : TONE.future)[month % 2]!;
}

/**
 * The ramp into nothing, quantised: `FADE_STEPS` is full brightness and `0` is
 * black. `smoothstep` on both ends — it has to leave full brightness without a
 * seam where it starts, and reach black without a last visible dot sitting on
 * the edge like a full stop.
 */
export function fadeStep(ms: number, deathMs: number): number {
  const fadeMs = FADE_DAYS * DAY_MS;
  if (ms <= deathMs - fadeMs) return FADE_STEPS;
  const f = Math.max(0, (deathMs - ms) / fadeMs);
  return Math.round(f * f * (3 - 2 * f) * FADE_STEPS);
}

/**
 * The whole field in one pass, batched by colour: one `Path2D` per distinct
 * colour and one `fill` each, rather than thirty thousand `beginPath`/`fill`
 * pairs.
 *
 * Today is drawn last and larger, and it takes its event's colour when it has
 * one — a day carrying something says so whether or not it is this one, and
 * the halo in the overlay is what marks it as today.
 */
export function drawField(
  ctx: CanvasRenderingContext2D,
  box: Box,
  layout: LifeLayout,
  span: LifeSpan,
  density: Map<string, string>,
  today: Date,
  /** The days a search has lit, in their own colour, or `null` for no search. */
  found: Map<string, string> | null,
  theme: ThemeName,
) {
  const P = THEME_PALETTES[theme];
  ctx.clearRect(0, 0, box.width, box.height);

  // Two batches, because a hit is drawn fatter than the field it sits in and
  // a `Path2D` carries no radius — one map per radius, hits filled last so a
  // lit day is never half-covered by the day beside it.
  const paths = new Map<string, Path2D>();
  const hits = new Map<string, Path2D>();
  const plot = (into: Map<string, Path2D>, color: string, x: number, y: number, r: number) => {
    let path = into.get(color);
    if (!path) {
      path = new Path2D();
      into.set(color, path);
    }
    // `arc` starts at angle 0, which is exactly this point: the `moveTo` is
    // what stops each dot being joined to the previous one by a line.
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, TAU);
  };

  const todayMs = today.getTime();
  const coloured = density.size > 0;
  const radius = layout.radius;
  // Enough over the field to read as a mark rather than a brighter dot, and
  // never under a pixel and a half at the densest layout this view will pick.
  const hitRadius = Math.max(radius * 1.55, 1.6);
  let lit: { at: LifePoint; color: string } | null = null;

  const deathMs = span.death.getTime();

  // `dim` mints a string per call and this loop runs thirty thousand times, so
  // every colour is looked up by (base, fade step) and built once. Greys go in
  // their own table keyed by level, because they are all but two of the dots
  // and a numeric key costs nothing to make.
  const greys = new Map<number, string[]>();
  const grey = (level: number, step: number) => {
    let ramp = greys.get(level);
    if (!ramp) {
      ramp = new Array<string>(FADE_STEPS + 1);
      greys.set(level, ramp);
    }
    return (ramp[step] ??= washHex(theme, P.ink, (level * step) / FADE_STEPS));
  };
  const tints = new Map<string, string[]>();
  const tint = (hex: string, step: number) => {
    if (step === FADE_STEPS) return hex;
    let ramp = tints.get(hex);
    if (!ramp) {
      ramp = new Array<string>(FADE_STEPS + 1);
      tints.set(hex, ramp);
    }
    return (ramp[step] ??= washHex(theme, hex, step / FADE_STEPS));
  };

  for (let index = 0; index < layout.years; index++) {
    const { year, offset, from, to } = lifeYearRange(span, index, layout.weekStart);
    const firstRow = index * layout.linesPerYear;
    // One Date per year, walked with `setMonth`, which rolls over: day 59 of a
    // year is Feb 29 or Mar 1 depending on the year, and that is the calendar's
    // decision to make rather than this loop's.
    const cursor = new Date(year, 0, 1);

    for (let doy = from; doy <= to; doy++) {
      cursor.setMonth(0, 1 + doy);
      const slot = offset + doy;
      const line = Math.floor(slot / layout.colsPerLine);
      const x = lifeDotX(layout, slot - line * layout.colsPerLine);
      const y = lifeDotY(layout, firstRow + line);
      const key = coloured || found ? dayKey(cursor) : "";
      const at = cursor.getTime();
      const past = at < todayMs;
      const step = fadeStep(at, deathMs);

      // A search answers one question, so it takes the colour channel whole:
      // an unrelated event's colour on a day that did not match is noise in
      // the middle of the answer.
      const hit = found ? found.get(key) : undefined;
      const event = found ? undefined : density.get(key);
      const level = dayLevel(cursor.getMonth(), past, found !== null);

      if (at === todayMs) {
        const base = hit ?? event ?? (found ? "" : P.accent);
        lit = { at: { x, y }, color: base ? tint(base, step) : grey(level, step) };
        continue;
      }
      if (hit) plot(hits, tint(hit, step), x, y, hitRadius);
      else if (event) plot(paths, tint(event, step), x, y, radius);
      else plot(paths, grey(level, step), x, y, radius);
    }
  }

  for (const [color, path] of paths) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  for (const [color, path] of hits) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }

  if (lit) {
    ctx.fillStyle = lit.color;
    ctx.beginPath();
    ctx.arc(lit.at.x, lit.at.y, Math.max(radius * 1.9, 2.2), 0, TAU);
    ctx.fill();
  }
}

/** Furthest a wavefront leaving `from` has to travel to clear the box. */
function reach(box: Box, from: LifePoint): number {
  return Math.max(
    Math.hypot(from.x, from.y),
    Math.hypot(box.width - from.x, from.y),
    Math.hypot(from.x, box.height - from.y),
    Math.hypot(box.width - from.x, box.height - from.y),
  );
}

/**
 * One frame of the reveal: the field blitted whole, then masked back to the
 * wave that has reached it. Everything about a frame is here rather than in
 * the view because nothing about it is state — a progress, a centre, and the
 * field that was drawn once.
 *
 * `progress >= 1` is the resting case and is deliberately the cheap one: a
 * single `drawImage`, which is what the grid costs for the rest of its life.
 */
export function paintReveal(
  ctx: CanvasRenderingContext2D,
  box: Box,
  field: HTMLCanvasElement,
  progress: number,
  from: LifePoint,
  theme: ThemeName,
) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(field, 0, 0, box.width, box.height);

  if (progress >= 1) return;

  // The mask. `destination-in` keeps what the gradient covers, so the dots
  // fade up through the wavefront's own shoulder instead of switching on.
  const travel = reach(box, from);
  const edge = progress * travel * (1 + FEATHER);
  const feather = travel * FEATHER;
  const wave = ctx.createRadialGradient(
    from.x,
    from.y,
    Math.max(0, edge - feather),
    from.x,
    from.y,
    Math.max(0.01, edge),
  );
  wave.addColorStop(0, "rgba(0,0,0,1)");
  wave.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = wave;
  ctx.fillRect(0, 0, box.width, box.height);

  // The crest, drawn back on top: one thin accent circumference, brightest
  // when the wave leaves the dot and gone by the time it clears the box.
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = THEME_PALETTES[theme].accent;
  ctx.globalAlpha = 0.3 * (1 - progress) ** 0.55;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(from.x, from.y, Math.max(0.01, edge - feather * 0.5), 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
