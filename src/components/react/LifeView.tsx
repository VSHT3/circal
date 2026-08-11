/* ------------------------------------------------------------------ *
 * ⌘L — one life, one screen, one dot per day.
 *
 * The day view is a single revolution. This is every revolution you get: the
 * same day, pulled back until it is four pixels wide and thirty thousand of
 * them fit in the window. Days you have spent are dim, today is the one lit
 * dot, the ones you have not are plain grey — the whole point being that the
 * dim part is not coming back.
 *
 * Four things about the implementation, all forced by the dot count:
 *
 * 1. **The field is a canvas.** Thirty thousand SVG circles is thirty thousand
 *    DOM nodes: the mount alone costs the best part of a second and nothing
 *    can be animated afterwards.
 * 2. **It is drawn once, into an offscreen canvas.** The visible canvas only
 *    ever blits that bitmap, so a frame of animation costs one `drawImage`
 *    instead of thirty thousand arcs.
 * 3. **The reveal is a mask, not a redraw.** Arriving from the dial, a
 *    wavefront travels out from the day you were looking at and the dots fade
 *    up as it passes: one radial gradient in `destination-in` per frame. Going
 *    back, the same wave collapses onto that dot — and `usePresence` is what
 *    holds the unmount open until it has.
 * 4. **Nothing that follows the pointer is on the field.** Hover, selection and
 *    today's halo are SVG circles in an overlay, so moving the mouse never
 *    costs a repaint of the bitmap underneath.
 *
 * The other half of the transition — the dial itself shrinking onto that dot —
 * is in `App.tsx`, because it belongs to the panel that is leaving.
 * ------------------------------------------------------------------ */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  usePresence,
  useReducedMotion,
} from "motion/react";
import { Search, X } from "lucide-react";
import { colorOf, occurrencesOn, scoreEvent, type CalEvent, type Calendar } from "@/lib/events";
import {
  dayTally,
  dim,
  formatAge,
  formatCount,
  formatLifeDate,
  lifeCellAt,
  lifeDensity,
  lifeDot,
  lifeDotX,
  lifeDotY,
  lifeFraction,
  lifeMilestones,
  lifeRowTop,
  lifeStats,
  lifeYearRange,
  loupeCell,
  loupeCellAt,
  loupeLayout,
  loupeMonths,
  LIFE_GUTTER,
  LIFE_META_H,
  type LifeLayout,
  type LifePoint,
  type LifeSpan,
  type LifeStage,
  type LoupeLayout,
  type Milestone,
} from "@/lib/life";
import { LIFE_EXPECTANCY_RANGE, store } from "@/lib/store";
import { MONTHS, WEEKDAYS, addDays, dayKey, fromDayKey, isSameDay, startOfDay } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { LifeViewProps, ViewFlow } from "@/components/react/types";
import { useHotkeys, useNow } from "@/components/react/hooks";
import { DateField, IconButton, NumberField } from "@/components/react/ui/primitives";

const EASE = [0.32, 0.72, 0, 1] as const;
const TAU = Math.PI * 2;
const DAY_MS = 86_400_000;

/**
 * The wave.
 *
 * Long, because it is the transition and not a flourish: the dial spends its
 * own zoom collapsing onto one dot, and this starts while that is still on its
 * way so the two read as one movement rather than two animations queued up.
 *
 * The curve is nearly linear on purpose. Every ease-out worth the name puts
 * most of the travel in the first fifth of the duration, and a wavefront that
 * crosses the window in 120ms and then creeps is not a wave — it is a wipe
 * with a long tail. Constant speed, with just enough of a shoulder to stop
 * rather than hit the edge.
 */
const RIPPLE_OUT = { duration: 1.05, delay: 0.3, ease: [0.3, 0.35, 0.5, 1] as const };
/** Collapsing is the other way round: slow off the mark, then away. */
const RIPPLE_IN = { duration: 0.55, ease: [0.5, 0, 0.75, 0] as const };
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
const FADE_STEPS = 32;

/** The accent, as the canvas needs it — a token cannot be read by `fillStyle`. */
const TODAY_COLOR = "#a3d9e4";

/** Rows the age rules are drawn on. */
const DECADE = 10;

interface Box {
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
function dayLevel(month: number, past: boolean, searching: boolean): number {
  if (searching) return past ? SEARCH_TONE.past : SEARCH_TONE.future;
  return (past ? TONE.past : TONE.future)[month % 2]!;
}

/**
 * The ramp into nothing, quantised: `FADE_STEPS` is full brightness and `0` is
 * black. `smoothstep` on both ends — it has to leave full brightness without a
 * seam where it starts, and reach black without a last visible dot sitting on
 * the edge like a full stop.
 */
function fadeStep(ms: number, deathMs: number): number {
  const fadeMs = FADE_DAYS * DAY_MS;
  if (ms <= deathMs - fadeMs) return FADE_STEPS;
  const f = Math.max(0, (deathMs - ms) / fadeMs);
  return Math.round(f * f * (3 - 2 * f) * FADE_STEPS);
}

/* --------------------------------- drawing -------------------------------- */

/**
 * The whole field in one pass, batched by colour: one `Path2D` per distinct
 * colour and one `fill` each, rather than thirty thousand `beginPath`/`fill`
 * pairs.
 *
 * Today is drawn last and larger, and it takes its event's colour when it has
 * one — a day carrying something says so whether or not it is this one, and
 * the halo in the overlay is what marks it as today.
 */
function drawField(
  ctx: CanvasRenderingContext2D,
  box: Box,
  layout: LifeLayout,
  span: LifeSpan,
  density: Map<string, string>,
  today: Date,
  /** The days a search has lit, in their own colour, or `null` for no search. */
  found: Map<string, string> | null,
) {
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
    return (ramp[step] ??= dim("#ffffff", (level * step) / FADE_STEPS));
  };
  const tints = new Map<string, string[]>();
  const tint = (hex: string, step: number) => {
    if (step === FADE_STEPS) return hex;
    let ramp = tints.get(hex);
    if (!ramp) {
      ramp = new Array<string>(FADE_STEPS + 1);
      tints.set(hex, ramp);
    }
    return (ramp[step] ??= dim(hex, step / FADE_STEPS));
  };

  for (let index = 0; index < layout.years; index++) {
    const { year, offset, from, to } = lifeYearRange(span, index);
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
        const base = hit ?? event ?? (found ? "" : TODAY_COLOR);
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

/* -------------------------------- formatting ------------------------------- */

/**
 * How far away a day is, at this scale. `formatRelativeDay` stops being useful
 * past a week, and half of this grid is decades out — "Mar 12" for a date in
 * 2061 says the wrong thing entirely.
 */
function formatDistance(date: Date, today: Date): string {
  const days = Math.round((startOfDay(date).getTime() - today.getTime()) / DAY_MS);
  if (days === 0) return "today";
  const size = Math.abs(days);
  const amount = size < 31 ? `${size} day${size === 1 ? "" : "s"}` : years(size);
  return days > 0 ? `in ${amount}` : `${amount} ago`;
}

/** A month count under a year, and otherwise years to one decimal. Whole years
 *  lose the decimal — "23.0 years ago" reads as a rounding artefact, where
 *  "1.5 years" is genuinely more than "2" — and losing it is also the one case
 *  that can come out singular, which the label is now spoken aloud enough to
 *  care about. */
function years(size: number): string {
  if (size < 365) return `${Math.round(size / 30.44)} months`;
  const figure = (size / 365.25).toFixed(1).replace(/\.0$/, "");
  return `${figure} year${figure === "1" ? "" : "s"}`;
}

/** Whole years lived on `date` — the one figure that turns a date eighty rows
 *  down into something a reader can place. */
function ageOn(date: Date, birth: Date): number {
  const whole = date.getFullYear() - birth.getFullYear();
  const early =
    date.getMonth() < birth.getMonth() ||
    (date.getMonth() === birth.getMonth() && date.getDate() < birth.getDate());
  return Math.max(0, early ? whole - 1 : whole);
}

/**
 * One day, spoken. `load` is an exact count for the day the cursor is standing
 * on, and otherwise whether the field paints anything there: `density` knows
 * dated events and yearly rules, which is exactly what is drawn, and expanding
 * recurrence for 366 days to fill a list nobody is reading straight through is
 * a frame spent on nothing.
 */
function dayOptionLabel(date: Date, today: Date, birth: Date, load: number | boolean): string {
  const when = `${WEEKDAYS[date.getDay()]}, ${formatLifeDate(date)}, age ${ageOn(date, birth)}, ${formatDistance(date, today)}`;
  if (typeof load === "boolean") return `${when}, ${load ? "has events" : "nothing"}`;
  return load === 0 ? `${when}, nothing` : `${when}, ${load} event${load === 1 ? "" : "s"}`;
}

/* ---------------------------------- shell --------------------------------- */

export default function LifeView({
  stage,
  flow,
  birth,
  expectancy,
  now,
  milestones,
  selected,
  events,
  calendars,
  search,
  onClearSearch,
  onSelectDay,
}: LifeViewProps) {
  /**
   * The *day*, not the instant. The shell's clock ticks once a minute and the
   * grid changes once at midnight, so everything here is derived from the day
   * key: `today` is stable between midnights and the field is not rebuilt for
   * a clock that moved. The one number finer than a day is the percentage,
   * and it has its own clock in `LifePercent`.
   */
  const todayKey = dayKey(now);
  const today = useMemo(() => fromDayKey(todayKey), [todayKey]);
  const stats = useMemo(() => (stage ? lifeStats(stage.span, now) : null), [stage, now]);

  /**
   * The days the query lit. Built by handing the matching events to the same
   * `lifeDensity` the field itself is built from, so a searched day and a
   * carrying day are the same question asked of the same engine — including
   * which recurrence rules a grid this size will honour.
   */
  const found = useMemo(() => {
    const q = search.trim();
    if (!q || !stage) return null;
    return lifeDensity(
      events.filter((event) => scoreEvent(event, q) !== null),
      calendars,
      stage.span,
    );
  }, [search, events, calendars, stage]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Exactly `LIFE_META_H` tall, and not a pixel by accident: the shell
          subtracts that number to find where a dot lands on screen. */}
      <div
        className="flex shrink-0 items-center gap-3 px-1"
        style={{ height: LIFE_META_H }}
        aria-live="off"
      >
        {stage && stats && (
          <>
            {found ? (
              <SearchChip query={search} days={found.size} onClear={onClearSearch} />
            ) : (
              <span className="label hidden shrink-0 text-[10px] text-ink-3 sm:inline">
                Born {formatLifeDate(stage.span.birth)} <span className="text-ink-4">·</span>{" "}
                <span className="text-ink-2">{formatAge(stats.age)}</span>
              </span>
            )}
            <span className="label ml-auto truncate text-[10px] text-ink-3">
              <span className="text-ink-2">{formatCount(stats.daysLived)}</span> lived{" "}
              <span className="text-ink-4">·</span> {formatCount(stats.daysLeft)} left{" "}
              <span className="text-ink-4">·</span> <LifePercent span={stage.span} />
              <span className="hidden lg:inline">
                {" "}
                <span className="text-ink-4">·</span> until {formatLifeDate(stage.span.death)}
              </span>
            </span>
          </>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {stage ? (
          <LifeGrid
            stage={stage}
            flow={flow}
            today={today}
            selected={selected}
            events={events}
            calendars={calendars}
            found={found}
            milestones={milestones}
            onSelectDay={onSelectDay}
          />
        ) : (
          <BirthPrompt now={now} birth={birth} expectancy={expectancy} />
        )}
      </div>
    </div>
  );
}

/**
 * How many decimals the percentage carries, and it is derived rather than
 * chosen. One step of the last digit is `span / 10^(DECIMALS + 2)`, so the
 * figure is only alive if that lands between the clock below and the eye:
 *
 * | decimals | 80y (default) | 150y (the longest span the app draws) |
 * | -------- | ------------- | ------------------------------------- |
 * | 6        | 25.2s         | 47.3s                                 |
 * | 7        | 2.5s          | 4.7s                                  |
 * | 8        | 0.25s         | 0.47s                                 |
 *
 * Six was the first draft and is worse than the shell's own minute at a long
 * span, which is a figure with decimals on it that sits still. Eight steps
 * four times per tick of the clock below, so three in four values would never
 * be drawn — honest only on `requestAnimationFrame`, and a digit changing
 * faster than it can be read is noise. Seven is the only one inside five
 * seconds across the whole of `LIFE_EXPECTANCY_RANGE`.
 */
const PERCENT_DECIMALS = 7;

/**
 * The percentage, and the only thing in the app that needs a clock faster
 * than a minute. Every other printed instant in circal is `HH:MM` or coarser,
 * which is why this is a leaf: one text node re-rendering each second, and
 * the rest of the tree still.
 */
function LifePercent({ span }: { span: LifeSpan }) {
  const now = useNow(1000);
  return (
    <span className="text-accent tabular-nums">
      {(lifeFraction(span, now) * 100).toFixed(PERCENT_DECIMALS)}%
    </span>
  );
}

/**
 * What the grid is currently showing you, in the strip the age usually has.
 * The count is the point: "412 days" is the answer, and the field is the
 * shape of it.
 */
function SearchChip({
  query,
  days,
  onClear,
}: {
  query: string;
  days: number;
  onClear: () => void;
}) {
  return (
    <span className="label flex min-w-0 shrink items-center gap-1.5 text-[10px] text-ink-3">
      <Search size={11} strokeWidth={1.75} className="shrink-0 text-ink-3" />
      <span className="truncate text-ink-2">{query.trim()}</span>
      <span className="text-ink-4">·</span>
      <span className="shrink-0 text-ink-2">
        {formatCount(days)} day{days === 1 ? "" : "s"}
      </span>
      <IconButton label="Clear the search" onClick={onClear} className="ml-0.5 h-5 w-5 shrink-0">
        <X size={12} strokeWidth={1.75} />
      </IconButton>
    </span>
  );
}

/* ---------------------------------- grid ---------------------------------- */

interface Hover extends LifePoint {
  date: Date;
}

function LifeGrid({
  stage,
  flow,
  today,
  selected,
  events,
  calendars,
  found,
  milestones,
  onSelectDay,
}: {
  stage: LifeStage;
  flow: RefObject<ViewFlow>;
  today: Date;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  found: Map<string, string> | null;
  milestones: boolean;
  onSelectDay: (day: Date) => void;
}) {
  const reducedMotion = useReducedMotion();
  const { span, layout, box } = stage;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The field, drawn once. The visible canvas only ever blits this. */
  const fieldRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  /**
   * The loupe's own geometry, and `null` when the box cannot hold one worth
   * drawing. Sized against the field's dot, which is the thing it has to beat.
   */
  const loupe = useMemo(
    () =>
      loupeLayout(
        box.width - LOUPE_INSET * 2 - LOUPE_PAD * 2 - LOUPE_GUTTER,
        // A third of the field is all it may take. The whole span staying on
        // screen is the argument; a magnifier that eats the picture has lost it.
        box.height / 3 - LOUPE_PAD * 2 - LOUPE_HEADER_H - LOUPE_MONTHS_H,
        layout.radius,
      ),
    [box, layout.radius],
  );

  /**
   * Which half the loupe hangs in: the other one from the pointer, so it never
   * covers the dot being pointed at. Two thresholds rather than one, because a
   * single line across the field flips the card back and forth for every pixel
   * of jitter across it — and the card is 150px of chrome, not a tooltip.
   */
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const sideFor = (y: number, prev: "bottom" | "top"): "bottom" | "top" =>
    prev === "bottom"
      ? y > box.height * 0.62
        ? "top"
        : "bottom"
      : y < box.height * 0.5
        ? "bottom"
        : "top";

  /** The band of the field the card sits over, so the hover tip can keep out
   *  of it. The card's height is arithmetic rather than a measurement: it is
   *  every one of its parts and none of them grows. */
  const loupeTall = loupe ? LOUPE_PAD * 2 + LOUPE_HEADER_H + LOUPE_MONTHS_H + loupe.height : 0;
  const loupeBand = !loupe
    ? undefined
    : side === "bottom"
      ? { from: box.height - LOUPE_INSET - loupeTall, to: box.height }
      : { from: 0, to: LOUPE_INSET + loupeTall };

  const density = useMemo(() => lifeDensity(events, calendars, span), [events, calendars, span]);

  /**
   * The named days, and which one is open. The open mark is held by key and
   * resolved against the current list every render, so a span edited while a
   * card is up simply closes it instead of needing the key synced.
   */
  const marks = useMemo(
    () =>
      milestones
        ? lifeMilestones(span)
            .map((mark) => ({ mark, at: lifeDot(layout, span, mark.date) }))
            .filter((placed): placed is { mark: Milestone; at: LifePoint } => placed.at !== null)
        : [],
    [milestones, span, layout],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = marks.find((placed) => placed.mark.key === openKey) ?? null;

  useHotkeys({ escape: () => setOpenKey(null) }, open !== null);

  /**
   * Where the wave starts, and where the dial lands: the dot of the day the
   * shell is pointing at, which is the day you were looking at on the dial —
   * or the one you just clicked here, on the way back. Today's dot when that
   * day is off the grid, the middle of the field when today is too.
   */
  const centre: LifePoint = { x: box.width / 2, y: box.height / 2 };
  const focus = useCallback(
    (): LifePoint =>
      lifeDot(layout, span, flow.current.day) ?? lifeDot(layout, span, today) ?? centre,
    // `centre` is derived from `box`, which `layout` is derived from too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, span, today, flow],
  );

  /**
   * The wavefront, `0`…`1` of its reach. Seeded rather than assigned in an
   * effect: at `1` for one frame the whole field would flash into place before
   * the reveal had a chance to start.
   */
  const rippling = !reducedMotion && flow.current.from === "day";
  const reveal = useMotionValue(rippling ? 0 : 1);
  /** Fixed when an animation starts, so a mid-flight re-render cannot move the
   *  centre of the wave out from under it. */
  const originRef = useRef<LifePoint>(focus());

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const field = fieldRef.current;
    if (!canvas || !field) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(field, 0, 0, box.width, box.height);

    const progress = reveal.get();
    if (progress >= 1) return;

    // The mask. `destination-in` keeps what the gradient covers, so the dots
    // fade up through the wavefront's own shoulder instead of switching on.
    const from = originRef.current;
    const edge = progress * reach(box, from) * (1 + FEATHER);
    const feather = reach(box, from) * FEATHER;
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
    ctx.strokeStyle = TODAY_COLOR;
    ctx.globalAlpha = 0.3 * (1 - progress) ** 0.55;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(from.x, from.y, Math.max(0.01, edge - feather * 0.5), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [box, reveal]);

  /* The canvases are external systems: they are written to, not rendered. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Backing stores in device pixels, drawing in CSS pixels: a two-pixel dot
    // is four on a retina screen, and drawn at half the coordinates it would be
    // a grey smear instead.
    const dpr = window.devicePixelRatio || 1;
    // Built and filled before it is handed to the ref, never after: a value
    // living in a ref is not ours to mutate.
    const field = document.createElement("canvas");
    field.width = Math.round(box.width * dpr);
    field.height = Math.round(box.height * dpr);
    const ctx = field.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawField(ctx, box, layout, span, density, today, found);

    fieldRef.current = field;
    canvas.width = field.width;
    canvas.height = field.height;
    paint();
  }, [box, layout, span, density, today, found, paint]);

  useMotionValueEvent(reveal, "change", paint);

  /* Arriving: the wave leaves the dot the dial is collapsing onto. */
  useEffect(() => {
    if (!rippling) return;
    originRef.current = focus();
    const controls = animate(reveal, 1, RIPPLE_OUT);
    return () => controls.stop();
    // Mount only: a re-render must not restart the wave mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Leaving. `usePresence` holds the unmount open until the wave has collapsed
   * — and `flow` is read through a ref because the props of an element that is
   * being removed are frozen at the last render, so they cannot say which view
   * is arriving.
   */
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    if (isPresent) return;
    if (reducedMotion || flow.current.to !== "day") {
      safeToRemove?.();
      return;
    }
    originRef.current = focus();
    const controls = animate(reveal, 0, { ...RIPPLE_IN, onComplete: () => safeToRemove?.() });
    return () => controls.stop();
  }, [isPresent, safeToRemove, reducedMotion, flow, focus, reveal]);

  /** A day's dot, or `null` for a day outside the life. */
  const dotOf = (date: Date) => lifeDot(layout, span, date);

  const todayDot = dotOf(today);
  const selectedDot = isSameDay(selected, today) ? null : dotOf(selected);
  /** One rule per decade of age, on the line that decade's year starts. */
  const rules = Math.floor((layout.years - 1) / DECADE) + 1;

  /** The point pressed and the day under it. The point comes back either way:
   *  the loupe hangs off which half of the field the pointer is in, and that
   *  is a question the blanks between years can answer as well as a day can. */
  function locate(e: ReactPointerEvent<HTMLCanvasElement>): { date: Date | null; at: LifePoint } {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return { date: lifeCellAt(layout, span, at.x, at.y), at };
  }

  /* --------------------------- the keyboard path -------------------------- */

  /**
   * The grid's cursor, and the only way into it that is not a pointer.
   *
   * Off-screen and real, exactly as the year ring does it — but a life is
   * thirty thousand days, and a listbox of thirty thousand options is a wall
   * rather than a path. The options are one calendar *year* at a time, rebuilt
   * as the cursor crosses into the next: a row of this grid already is a
   * calendar year, so the year is the unit every label here speaks in, and 366
   * nodes is a list somebody can actually browse.
   *
   * `null` until a key is pressed, so the ring does not appear over a grid
   * nobody has touched. The seed is the day the shell is pointing at, which is
   * the day the dial was on.
   */
  const [cursor, setCursor] = useState<Date | null>(null);
  const [listFocused, setListFocused] = useState(false);

  /** Inside the life, both ends included. Every move goes through it, so the
   *  cursor cannot leave the field the labels are describing. */
  const clampDay = (date: Date): Date => {
    const at = startOfDay(date);
    if (at < span.birth) return span.birth;
    if (at > span.death) return span.death;
    return at;
  };

  /** Move the cursor, and hang the loupe out of the way of where it landed.
   *  Every keyboard move goes through this for the reason every one of them
   *  already goes through `clampDay`. */
  const aim = (date: Date) => {
    const next = clampDay(date);
    setCursor(next);
    const dot = dotOf(next);
    if (dot) setSide((prev) => sideFor(dot.y, prev));
  };

  const cursorDay = cursor ?? clampDay(dotOf(selected) ? selected : today);
  const cursorDot = dotOf(cursorDay);
  /** The cursor answers the same question the pointer does, so it goes through
   *  the same two things that answer it: the ring in the overlay, and the tip. */
  const active: Hover | null =
    hover ?? (listFocused && cursorDot ? { date: cursorDay, ...cursorDot } : null);
  const activeDot = active ? dotOf(active.date) : null;

  /** This year's days, clipped to the life. Rebuilt only when the cursor
   *  crosses a year, which is what keeps the list 366 nodes rather than
   *  thirty thousand. */
  const cursorYear = cursorDay.getFullYear();
  const options = useMemo(() => {
    const first = new Date(cursorYear, 0, 1);
    const last = new Date(cursorYear, 11, 31);
    const to = last > span.death ? span.death : last;
    const out: Date[] = [];
    for (let d = startOfDay(first < span.birth ? span.birth : first); d <= to; d = addDays(d, 1)) {
      out.push(d);
    }
    return out;
  }, [cursorYear, span]);
  const activeIndex = Math.max(
    0,
    options.findIndex((d) => isSameDay(d, cursorDay)),
  );

  /**
   * What the active day carries, counted properly. The other options read
   * their answer off `density`, which is what the field is actually painted
   * from — but that map only knows dated events and yearly rules, and the day
   * you are standing on deserves the same expansion the hover tip gets.
   */
  const activeTally = useMemo(
    () => dayTally(events, calendars, cursorDay),
    [events, calendars, cursorDay],
  );

  /**
   * ← → a day, ↑ ↓ a week — the columns are real Monday-to-Sunday weeks, so
   * seven days is straight up or down — and Page a year, which is one row of
   * this grid and lands on the same date. Home and End are the two ends of the
   * life, because at this scale they are the only two landmarks that need no
   * counting.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const DAYS: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };
    if (e.key in DAYS) {
      // ← and → step the year for the shell in this view. Inside the grid they
      // belong to the grid, so the press must not also reach the window.
      e.preventDefault();
      e.stopPropagation();
      aim(addDays(cursorDay, DAYS[e.key]));
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "PageDown" ? 1 : -1;
      aim(new Date(cursorDay.getFullYear() + step, cursorDay.getMonth(), cursorDay.getDate()));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      aim(e.key === "Home" ? span.birth : span.death);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpenKey(null);
      onSelectDay(cursorDay);
    }
  };

  return (
    <div
      className="absolute inset-0"
      // One handler for the canvas and the loupe together. Leaving the field
      // *for* the loupe must not clear the day the loupe is showing, and the
      // canvas cannot tell that press from a press that left the view.
      onPointerLeave={() => setHover(null)}
    >
      <canvas
        ref={canvasRef}
        // The picture, and only the picture. The listbox below says what is in
        // it and is the one thing here that can be navigated; two nodes
        // describing one field is a field described twice, and the canvas is
        // the half of it that cannot be read out.
        aria-hidden
        className="absolute inset-0 h-full w-full touch-none"
        onPointerMove={(e) => {
          const hit = locate(e);
          setSide((prev) => sideFor(hit.at.y, prev));
          // Bail on the same day: a pointer crossing one dot fires a dozen
          // moves, and each one that changes state re-renders the tip.
          if (hit.date?.getTime() === hover?.date.getTime()) return;
          setHover(hit.date ? { date: hit.date, ...hit.at } : null);
        }}
        // A press, not a click — as on the dial, where every gesture is a
        // pointer gesture and a click is one that did not move.
        onPointerUp={(e) => {
          const hit = locate(e);
          if (!hit.date) return;
          // A press on the field is also how a milestone card is dismissed:
          // the card is the only thing here that outlives the pointer.
          setOpenKey(null);
          onSelectDay(hit.date);
        }}
      />

      {/* The chrome — rules, gutters, marks — comes in behind the wave rather
          than with it: at full opacity from the first frame it would draw a
          decade rule across a field that is not there yet. */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        initial={rippling ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={reducedMotion ? undefined : { opacity: 0 }}
        transition={{ duration: 0.4, delay: rippling ? 0.55 : 0, ease: EASE }}
      >
        {/* The decade rules and their labels: ten of each at most, so they are
            DOM and carry the app's own type rather than a canvas approximation
            of it. The age is on the left, the calendar year it falls in on the
            right — the grid is a life first and a calendar second. */}
        {Array.from({ length: rules }, (_, i) => {
          const age = i * DECADE;
          const row = age * layout.linesPerYear;
          return (
            <div key={age} aria-hidden className="absolute inset-0">
              {age > 0 && (
                <span
                  className="absolute border-t border-hairline"
                  style={{
                    top: lifeRowTop(layout, row),
                    left: layout.offsetX,
                    width: layout.width,
                  }}
                />
              )}
              <span
                className="label absolute -translate-y-1/2 text-right text-[9px] text-ink-4"
                style={{ top: lifeDotY(layout, row), left: 0, width: LIFE_GUTTER.left - 6 }}
              >
                {age}
              </span>
              <span
                className="label absolute -translate-y-1/2 text-[9px] text-ink-4"
                style={{ top: lifeDotY(layout, row), left: layout.offsetX + layout.width + 6 }}
              >
                {layout.birthYear + age}
              </span>
            </div>
          );
        })}

        <svg
          aria-hidden
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`}
        >
          {/* The named days, under everything that follows the pointer: a
              milestone is a property of the grid, and today, the selection and
              the hover are all about where you are in it right now. */}
          {marks.map(({ mark, at }) => (
            <circle
              key={mark.key}
              cx={at.x}
              cy={at.y}
              r={Math.max(layout.radius * 2.9, 4)}
              fill="none"
              stroke={mark.key === openKey ? "var(--ink)" : "var(--ink-3)"}
              strokeWidth={1}
            />
          ))}
          {selectedDot && (
            <circle
              cx={selectedDot.x}
              cy={selectedDot.y}
              r={Math.max(layout.radius * 2.4, 3)}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1}
            />
          )}
          {todayDot && (
            <circle
              cx={todayDot.x}
              cy={todayDot.y}
              r={Math.max(layout.radius * 3.4, 4.5)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1}
              opacity={0.45}
            />
          )}
          {/* The pointer's ring and the keyboard's are one ring: they answer
              the same question, and two marks on this field at once would be
              two cursors. */}
          {activeDot && (
            <circle
              cx={activeDot.x}
              cy={activeDot.y}
              r={Math.max(layout.radius * 2.8, 3.6)}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1}
              opacity={0.7}
            />
          )}
        </svg>
      </motion.div>

      {/*
        The keyboard, and everything that is not a pointer. One tab stop with a
        cursor inside it — the year ring's shape, at the one scale where the
        options cannot all exist at once, so they are this year's and the list
        is rebuilt as the cursor leaves it.
      */}
      <ul
        role="listbox"
        tabIndex={0}
        aria-label={`Your life in days, ${formatCount(span.days)} of them. Arrows move a day, up and down a week, page keys a year`}
        aria-activedescendant={`life-day-${activeIndex}`}
        className="sr-only"
        onFocus={() => setListFocused(true)}
        onBlur={() => setListFocused(false)}
        onKeyDown={onKeyDown}
      >
        {/* No handler of their own: the list is clipped to a pixel, so a
            pointer never reaches an option. Choosing is Enter, on the box. */}
        {options.map((date, i) => (
          <li key={i} id={`life-day-${i}`} role="option" aria-selected={i === activeIndex}>
            {dayOptionLabel(
              date,
              today,
              span.birth,
              i === activeIndex ? activeTally.count : density.has(dayKey(date)),
            )}
          </li>
        ))}
      </ul>

      {/* Hit areas for the named days. Real buttons rather than pointer
          handling on the canvas: four of them is a tab order somebody can
          actually use, where thirty thousand dots is not. The ring itself is
          drawn in the overlay above, so the button is a target and nothing
          else. */}
      {marks.map(({ mark, at }) => (
        <button
          key={mark.key}
          type="button"
          aria-expanded={mark.key === openKey}
          title={`${mark.title} · ${formatLifeDate(mark.date)}`}
          aria-label={`${mark.title}, ${formatLifeDate(mark.date)}`}
          onPointerEnter={() => setHover(null)}
          onClick={() => setOpenKey(mark.key === openKey ? null : mark.key)}
          className="absolute z-10 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full outline-offset-1 focus-visible:outline focus-visible:outline-ink"
          style={{ left: at.x, top: at.y }}
        />
      ))}

      {open && (
        <MilestoneCard
          mark={open.mark}
          at={open.at}
          today={today}
          box={box}
          onGo={() => {
            setOpenKey(null);
            onSelectDay(open.mark.date);
          }}
          onClose={() => setOpenKey(null)}
        />
      )}

      {loupe && active && (
        <Loupe
          layout={loupe}
          span={span}
          year={active.date.getFullYear()}
          side={side}
          today={today}
          selected={selected}
          active={active.date}
          density={density}
          found={found}
          reducedMotion={!!reducedMotion}
          // The loupe writes the field's own hover: one cursor, one ring, one
          // tip, wherever the pointer happens to be standing.
          onAim={(date) => {
            const dot = dotOf(date);
            if (dot) setHover({ date, ...dot });
          }}
          onPick={(date) => {
            setOpenKey(null);
            onSelectDay(date);
          }}
        />
      )}

      {active && (
        <DayTip
          hover={active}
          today={today}
          events={events}
          calendars={calendars}
          box={box}
          avoid={loupeBand}
        />
      )}
    </div>
  );
}

/* ------------------------------- milestones ------------------------------- */

/**
 * What a named day has to say.
 *
 * It takes the pointer, unlike the hover tip: the prose is there to be read
 * and the row at the bottom is there to be clicked, so this is a small popover
 * rather than a label. Dismissed by Escape, by pressing the field, or by the
 * mark that opened it.
 *
 * `Go to this day` is not a courtesy. The button that opens this card sits on
 * top of its own dot, so those three or four days cannot be selected by
 * clicking them any more, and this is where the click goes instead.
 */
function MilestoneCard({
  mark,
  at,
  today,
  box,
  onGo,
  onClose,
}: {
  mark: Milestone;
  at: LifePoint;
  today: Date;
  box: Box;
  onGo: () => void;
  onClose: () => void;
}) {
  const reducedMotion = useReducedMotion();
  // Same flip as the tip, for the same reason: a card clamped at the edge
  // covers the dot it is about.
  const flip = at.x > box.width * 0.55;
  const lift = at.y > box.height * 0.55;

  return (
    <motion.div
      role="dialog"
      aria-label={mark.title}
      initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: EASE }}
      className={cn(
        "absolute z-20 w-[300px] max-w-[calc(100%-16px)] rounded-[12px] border border-hairline bg-surface p-3.5 shadow-[0_24px_56px_-20px_rgba(0,0,0,0.95)]",
        flip && "-translate-x-full",
        lift && "-translate-y-full",
      )}
      style={{ left: at.x + (flip ? -14 : 14), top: at.y + (lift ? -14 : 14) }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="label text-[11px] text-ink">{mark.title}</div>
          <div className="label mt-1 text-[10px] text-ink-3">
            {formatLifeDate(mark.date)} <span className="text-ink-4">·</span>{" "}
            {formatDistance(mark.date, today)}
          </div>
        </div>
        <IconButton label={`Close ${mark.title}`} onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      </div>

      {mark.note.map((paragraph) => (
        <p key={paragraph.slice(0, 24)} className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">
          {paragraph}
        </p>
      ))}

      <button
        type="button"
        onClick={onGo}
        className="mt-3.5 h-8 w-full rounded-[8px] bg-surface-2 text-[12.5px] text-ink-2 transition-colors hover:bg-white/10 hover:text-ink"
      >
        Go to this day
      </button>
    </motion.div>
  );
}

/* ----------------------------------- tip ---------------------------------- */

function DayTip({
  hover,
  today,
  events,
  calendars,
  box,
  avoid,
}: {
  hover: Hover;
  today: Date;
  events: CalEvent[];
  calendars: Calendar[];
  box: Box;
  /** A band of the field the tip must not land in — the loupe, when it is up.
   *  The two are the same answer at two scales, and one over the other is the
   *  bigger one hidden by the smaller. */
  avoid?: { from: number; to: number };
}) {
  /**
   * One day's recurrence expansion, for the day under the pointer. The field's
   * colours come from `lifeDensity`, which counts only dated events and yearly
   * rules; the tip is about *this* day, so it says what is actually on it —
   * repeats included.
   */
  const occurrences = useMemo(
    () => occurrencesOn(events, calendars, hover.date),
    [events, calendars, hover.date],
  );

  // Flipped near the edges rather than clamped: a tip that stops moving still
  // covers the dot you are pointing at.
  const flip = hover.x > box.width * 0.62;
  // The tallest this card gets — two label rows, three events and a "+n more".
  // A measured height would need a layout read per pointer move to place a
  // card that is about to move again; the clearance only has to be generous.
  const TIP_H = 120;
  const clash = (top: number) => !!avoid && top < avoid.to && top + TIP_H > avoid.from;
  let lift = hover.y > box.height * 0.68;
  // Whichever side it wanted, take the other one when that side is the loupe
  // — and only if the other one is actually clear, or this trades one
  // collision for the same collision.
  if (lift && clash(hover.y - 12 - TIP_H) && !clash(hover.y + 12)) lift = false;
  else if (!lift && clash(hover.y + 12) && !clash(hover.y - 12 - TIP_H)) lift = true;

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 w-max max-w-[220px] rounded-[10px] border border-hairline bg-surface px-2.5 py-2 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)]",
        flip && "-translate-x-full",
        lift && "-translate-y-full",
      )}
      style={{ left: hover.x + (flip ? -12 : 12), top: hover.y + (lift ? -12 : 12) }}
    >
      <div className="label text-[10px] text-ink">
        {WEEKDAYS[hover.date.getDay()].slice(0, 3)} <span className="text-ink-4">·</span>{" "}
        {formatLifeDate(hover.date)}
      </div>
      <div className="label mt-0.5 text-[10px] text-ink-3">{formatDistance(hover.date, today)}</div>
      {occurrences.slice(0, 3).map((occ) => (
        <div key={occ.key} className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-2">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: colorOf(occ.event, calendars) }}
          />
          <span className="truncate">{occ.event.title || "Untitled"}</span>
        </div>
      ))}
      {occurrences.length > 3 && (
        <div className="label mt-1 text-[10px] text-ink-4">+{occurrences.length - 3} more</div>
      )}
    </div>
  );
}

/* --------------------------------- loupe ---------------------------------- */

/**
 * The magnifier: one year of the field, blown up and held over it.
 *
 * The view's invariant is the whole life in one viewport, so this is not a
 * zoom and there is no pan — the eighty years stay exactly where they were and
 * exactly the size they were, and the loupe is a second, larger picture of the
 * year the pointer is already in. Everything it draws comes from the same
 * `density`, the same `found` and the same `dayLevel` the field is painted
 * from, so the two cannot disagree about a day.
 *
 * It is also the only way to *act* on a day at this scale. Pointing at a four
 * pixel dot to read it is hard and clicking the right one is worse, so the
 * loupe writes to the same `hover` the field does and commits the same way:
 * point here, the ring moves over there, press and the day opens.
 */

/** The weekday gutter, the strip of month names above the cells, the header
 *  row and the card's own padding. Fixed, because the shell has to know the
 *  band this card occupies before the card exists. */
const LOUPE_GUTTER = 14;
const LOUPE_MONTHS_H = 13;
const LOUPE_HEADER_H = 17;
const LOUPE_PAD = 8;
/** How far the card stands off the edge of the field. */
const LOUPE_INSET = 10;

/** Monday, Wednesday, Friday — the three that place the other four without
 *  spending a gutter on prose. A column here is a week, which is the one thing
 *  about this picture that is not the field's own orientation, so it says so. */
const LOUPE_ROWS: Record<number, string> = { 0: "M", 2: "W", 4: "F" };

/**
 * What the grey channel is multiplied by in here, and it is a correction
 * rather than a preference.
 *
 * The field's dot covers about a third of its cell — `π·r²` over `pitchX ·
 * pitchY`, which at the desktop split is 0.36 — and the loupe's covers half of
 * its square one, `π · 0.4²` = 0.50. So the same `TONE` puts forty per cent
 * more light per unit area on this card than on the field it is held over, and
 * a pale slab bright enough to compete with the event colours is the one thing
 * the grey channel here is not allowed to be. `0.36 / 0.50` is the number.
 *
 * The *ratio* inside `TONE` is untouched, so past still reads against future
 * and the month band still drifts across the plate; only the absolute light
 * comes down.
 */
const LOUPE_GAIN = 0.7;

function Loupe({
  layout,
  span,
  year,
  side,
  today,
  selected,
  active,
  density,
  found,
  reducedMotion,
  onAim,
  onPick,
}: {
  layout: LoupeLayout;
  span: LifeSpan;
  year: number;
  side: "bottom" | "top";
  today: Date;
  selected: Date;
  /** The day the field and the loupe are both pointing at. */
  active: Date;
  density: Map<string, string>;
  found: Map<string, string> | null;
  reducedMotion: boolean;
  onAim: (date: Date) => void;
  onPick: (date: Date) => void;
}) {
  /**
   * The dots, as elements rather than as data. A pointer move inside one year
   * re-renders this card for the rings alone, and a memoised array of 366
   * elements is one React bails out of instead of diffing.
   */
  const { cells, carried } = useMemo(() => {
    const { offset, from, to } = lifeYearRange(span, year - span.birth.getFullYear());
    const deathMs = span.death.getTime();
    const todayMs = today.getTime();
    const marked = found ?? density;
    const nodes: ReactElement[] = [];
    const cursor = new Date(year, 0, 1);
    let counted = 0;

    for (let doy = from; doy <= to; doy++) {
      cursor.setMonth(0, 1 + doy);
      const slot = offset + doy;
      const at = cursor.getTime();
      const key = dayKey(cursor);
      const step = fadeStep(at, deathMs);
      const hit = found ? found.get(key) : undefined;
      const event = found ? undefined : density.get(key);
      // Today keeps the accent only when nothing louder has claimed the dot,
      // exactly as the field does it — the ring below is what says "today".
      const base = hit ?? event ?? (at === todayMs && !found ? TODAY_COLOR : "");
      if (marked.has(key)) counted++;

      nodes.push(
        <circle
          key={doy}
          cx={Math.floor(slot / 7) * layout.pitch + layout.pitch / 2}
          cy={(slot % 7) * layout.pitch + layout.pitch / 2}
          r={hit ? layout.radius * 1.55 : layout.radius}
          fill={
            base
              ? dim(base, step / FADE_STEPS)
              : dim(
                  "#ffffff",
                  (dayLevel(cursor.getMonth(), at < todayMs, found !== null) * step * LOUPE_GAIN) /
                    FADE_STEPS,
                )
          }
        />,
      );
    }
    return { cells: nodes, carried: counted };
  }, [layout, span, year, today, density, found]);

  const months = useMemo(() => loupeMonths(span, year), [span, year]);

  /** A day's centre in the cell group. Three rings ride on this and they have
   *  to sit on the dot the loop above drew, not near it. */
  const ringAt = (date: Date) => {
    const { col, row } = loupeCell(date);
    return { cx: col * layout.pitch + layout.pitch / 2, cy: row * layout.pitch + layout.pitch / 2 };
  };
  const rings = [
    { date: today, stroke: "var(--accent)", scale: 1.9, opacity: 0.5 },
    { date: selected, stroke: "var(--ink)", scale: 1.7, opacity: 1 },
    { date: active, stroke: "var(--ink)", scale: 2.1, opacity: 0.7 },
  ].filter(({ date }) => date.getFullYear() === year && date >= span.birth && date <= span.death);

  /** The pointer, in cell coordinates. `null` on a blank — the leading days of
   *  the first week and the trailing days of the last — and a blank is ignored
   *  rather than clearing the day, or crossing one would drop the card. */
  const dayUnder = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return loupeCellAt(
      layout,
      span,
      year,
      e.clientX - rect.left - LOUPE_GUTTER,
      e.clientY - rect.top - LOUPE_MONTHS_H,
    );
  };

  return (
    <motion.div
      // True black, never `bg-surface`: every dot on it is an opaque grey
      // computed against the canvas, so on a lighter card an empty day would
      // be *darker* than its ground — which inverts the one rule this view
      // has, that ink is light.
      className="absolute left-1/2 z-20 rounded-[12px] border border-hairline bg-void shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9)]"
      style={{
        padding: LOUPE_PAD,
        ...(side === "bottom" ? { bottom: LOUPE_INSET } : { top: LOUPE_INSET }),
      }}
      initial={reducedMotion ? false : { opacity: 0, x: "-50%", y: side === "bottom" ? 8 : -8 }}
      animate={{ opacity: 1, x: "-50%", y: 0 }}
      transition={{ duration: 0.16, ease: EASE }}
    >
      <div
        className="label flex items-center gap-1.5 text-[10px] text-ink-3"
        style={{ height: LOUPE_HEADER_H }}
      >
        <span className="text-ink-2 tabular-nums">{year}</span>
        <span className="text-ink-4">·</span>
        <span>age {ageOn(active, span.birth)}</span>
        <span className="ml-auto tabular-nums">
          <span className="text-ink-2">{formatCount(carried)}</span>{" "}
          {found ? "found" : `day${carried === 1 ? "" : "s"}`}
        </span>
      </div>

      <svg
        width={LOUPE_GUTTER + layout.width}
        height={LOUPE_MONTHS_H + layout.height}
        // The card is the one surface at this scale where a day is bigger than
        // the pointer, so it takes presses. `touch-none` for the reason the
        // field has it: a drag across it must not scroll the page.
        className="block touch-none"
        onPointerMove={(e) => {
          const date = dayUnder(e);
          if (date) onAim(date);
        }}
        onPointerUp={(e) => {
          const date = dayUnder(e);
          if (date) onPick(date);
        }}
      >
        {/* The months place a column; the weekdays only explain the transpose.
            So the first is text at `ink-3` and the second is furniture. */}
        {months.map(({ month, col }) => (
          <text
            key={month}
            className="label fill-ink-3 text-[9px]"
            x={LOUPE_GUTTER + col * layout.pitch}
            y={LOUPE_MONTHS_H - 4}
          >
            {MONTHS[month].slice(0, 3)}
          </text>
        ))}
        {Object.entries(LOUPE_ROWS).map(([row, name]) => (
          <text
            key={row}
            className="label fill-ink-4 text-[9px]"
            x={0}
            y={LOUPE_MONTHS_H + Number(row) * layout.pitch + layout.pitch / 2 + 3}
          >
            {name}
          </text>
        ))}
        <g transform={`translate(${LOUPE_GUTTER}, ${LOUPE_MONTHS_H})`}>
          {cells}
          {rings.map(({ date, stroke, scale, opacity }) => {
            const { cx, cy } = ringAt(date);
            return (
              <circle
                key={stroke + scale}
                cx={cx}
                cy={cy}
                r={layout.radius * scale}
                fill="none"
                stroke={stroke}
                strokeWidth={1}
                opacity={opacity}
              />
            );
          })}
        </g>
      </svg>
    </motion.div>
  );
}

/* --------------------------------- prompt --------------------------------- */

/**
 * The one question this view has to ask.
 *
 * Not a modal over an empty grid: there is no grid until it is answered, so it
 * *is* the view until then. The answer goes straight to the store, like every
 * other setting, and is editable afterwards in the settings card.
 */
function BirthPrompt({ now, birth, expectancy }: { now: Date; birth: string; expectancy: number }) {
  const reducedMotion = useReducedMotion();
  const [date, setDate] = useState(birth);
  const [years, setYears] = useState(expectancy);

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? fromDayKey(date) : null;
  const valid =
    !!parsed &&
    !Number.isNaN(parsed.getTime()) &&
    parsed <= startOfDay(now) &&
    years >= LIFE_EXPECTANCY_RANGE.min &&
    years <= LIFE_EXPECTANCY_RANGE.max;

  return (
    <div className="absolute inset-0 grid place-items-center p-6">
      <motion.div
        className="w-[380px] max-w-full rounded-[14px] border border-hairline bg-surface p-4"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: EASE }}
      >
        {/* The line that is this view, borrowed rather than written: it says
            in seven words what the grid behind this card takes thirty thousand
            dots to say, and somebody staring at an empty span needs the reason
            before the question. Attributed, because it is not ours. */}
        <p className="text-[14px] leading-[1.5] text-ink-3 italic">You are a worm through time.</p>
        <div className="label mt-1 text-[10px] text-ink-3">Hiss incantation · Control</div>

        <div className="mt-4 text-[17px] font-medium text-ink">Your life, in days</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          One dot per day, from the day you were born to a day nobody knows. It needs the first date
          and a guess at the number of years — both stay in this browser, and both can be changed
          later.
        </p>

        {/* Rows, not `<label>`s: both fields carry their own accessible name
            (the native control inside them is what a screen reader reads), and
            a label wrapping a component cannot be tied to it. */}
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="label text-ink-3">Born</span>
            <DateField
              label="Date of birth"
              value={date}
              onChange={setDate}
              min="1900-01-01"
              max={dayKey(now)}
              className="w-[170px]"
            >
              <span className="truncate tabular-nums">
                {parsed && valid ? formatLifeDate(parsed) : "Pick a date"}
              </span>
            </DateField>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="label text-ink-3">Expect</span>
            <NumberField
              label="Life expectancy in years"
              value={years}
              onChange={setYears}
              suffix="years"
              min={LIFE_EXPECTANCY_RANGE.min}
              max={LIFE_EXPECTANCY_RANGE.max}
              className="w-[170px]"
            />
          </div>
        </div>

        <button
          type="button"
          disabled={!valid}
          onClick={() => store.setLife(date, years)}
          className="mt-4 h-9 w-full rounded-[9px] bg-ink text-[13.5px] font-medium text-void transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-35"
        >
          Show me
        </button>
      </motion.div>
    </div>
  );
}
