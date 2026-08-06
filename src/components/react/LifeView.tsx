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
 * 4. **Nothing that follows the pointer is on the field.** Hover, selection,
 *    today's halo and the death mark are SVG circles in an overlay, so moving
 *    the mouse never costs a repaint of the bitmap underneath.
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
  type PointerEvent as ReactPointerEvent,
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
import { colorOf, occurrencesOn, type CalEvent, type Calendar } from "@/lib/events";
import {
  dim,
  formatAge,
  formatCount,
  formatLifeDate,
  lifeCellAt,
  lifeDensity,
  lifeDot,
  lifeDotX,
  lifeDotY,
  lifeRowTop,
  lifeStats,
  lifeYearRange,
  LIFE_GUTTER,
  LIFE_META_H,
  type LifeLayout,
  type LifePoint,
  type LifeSpan,
  type LifeStage,
} from "@/lib/life";
import { LIFE_EXPECTANCY_RANGE, store } from "@/lib/store";
import { WEEKDAYS, dayKey, fromDayKey, isSameDay, startOfDay } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { LifeViewProps, ViewFlow } from "@/components/react/types";
import { DateField, NumberField } from "@/components/react/ui/primitives";

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
 * How bright a day is. Two tones per state, alternating by month: a month is
 * not a whole number of weeks, so it cannot be a gap in a grid whose columns
 * are weeks — it is this instead, and the band drifting along the row is the
 * honest shape of the thing.
 *
 * Solid past, faint future. The lived half is the part you own and the part
 * that carries events, and every reader arrives expecting the filled portion
 * of a progress figure to be the spent one. Neither state may go to near-black
 * though: the argument of this view is the whole span in one viewport, and a
 * half you cannot see is a half that is not there.
 *
 * Opaque greys rather than translucent white, for the reason the dial's
 * elapsed ring is: on true black the two are the same colour, and only one of
 * them can be composited wrong.
 */
const TONE = {
  past: [dim("#ffffff", 0.58), dim("#ffffff", 0.45)],
  future: [dim("#ffffff", 0.23), dim("#ffffff", 0.17)],
  /** How far an event's colour is dimmed while its day is still ahead of you. */
  eventFuture: 0.45,
} as const;

/** The accent, as the canvas needs it — a token cannot be read by `fillStyle`. */
const TODAY_COLOR = "#a3d9e4";

/** Rows the age rules are drawn on. */
const DECADE = 10;

interface Box {
  width: number;
  height: number;
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
) {
  ctx.clearRect(0, 0, box.width, box.height);

  const paths = new Map<string, Path2D>();
  const plot = (color: string, x: number, y: number, r: number) => {
    let path = paths.get(color);
    if (!path) {
      path = new Path2D();
      paths.set(color, path);
    }
    // `arc` starts at angle 0, which is exactly this point: the `moveTo` is
    // what stops each dot being joined to the previous one by a line.
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, TAU);
  };

  const todayMs = today.getTime();
  const coloured = density.size > 0;
  const radius = layout.radius;
  let lit: { at: LifePoint; color: string } | null = null;

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
      const event = coloured ? density.get(dayKey(cursor)) : undefined;

      if (cursor.getTime() === todayMs) {
        lit = { at: { x, y }, color: event ?? TODAY_COLOR };
        continue;
      }
      const past = cursor.getTime() < todayMs;
      plot(
        event
          ? past
            ? event
            : dim(event, TONE.eventFuture)
          : (past ? TONE.past : TONE.future)[cursor.getMonth() % 2],
        x,
        y,
        radius,
      );
    }
  }

  for (const [color, path] of paths) {
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
  const amount =
    size < 31
      ? `${size} day${size === 1 ? "" : "s"}`
      : size < 365
        ? `${Math.round(size / 30.44)} months`
        : // Whole years lose the decimal: "23.0 years ago" reads as a rounding
          // artefact, where "1.5 years" is genuinely more than "2".
          `${(size / 365.25).toFixed(1).replace(/\.0$/, "")} years`;
  return days > 0 ? `in ${amount}` : `${amount} ago`;
}

/* ---------------------------------- shell --------------------------------- */

export default function LifeView({
  stage,
  flow,
  birth,
  expectancy,
  now,
  selected,
  events,
  calendars,
  onSelectDay,
}: LifeViewProps) {
  /**
   * The *day*, not the instant: `now` ticks every second, and the field would
   * be redrawn sixty times a minute for a grid that changes once at midnight.
   * Only the percentage in the strip reads the instant.
   */
  const todayKey = dayKey(now);
  const today = useMemo(() => fromDayKey(todayKey), [todayKey]);
  const stats = useMemo(() => (stage ? lifeStats(stage.span, now) : null), [stage, now]);

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
            <span className="label hidden shrink-0 text-[10px] text-ink-3 sm:inline">
              Born {formatLifeDate(stage.span.birth)} <span className="text-ink-4">·</span>{" "}
              <span className="text-ink-2">{formatAge(stats.age)}</span>
            </span>
            <span className="label ml-auto truncate text-[10px] text-ink-3">
              <span className="text-ink-2">{formatCount(stats.daysLived)}</span> lived{" "}
              <span className="text-ink-4">·</span> {formatCount(stats.daysLeft)} left{" "}
              <span className="text-ink-4">·</span>{" "}
              {/* Six decimals, so it visibly moves: a life is long enough that
                  two would sit still for seven hours at a time. */}
              <span className="text-accent tabular-nums">{(stats.fraction * 100).toFixed(6)}%</span>
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
            onSelectDay={onSelectDay}
          />
        ) : (
          <BirthPrompt now={now} birth={birth} expectancy={expectancy} />
        )}
      </div>
    </div>
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
  onSelectDay,
}: {
  stage: LifeStage;
  flow: RefObject<ViewFlow>;
  today: Date;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  onSelectDay: (day: Date) => void;
}) {
  const reducedMotion = useReducedMotion();
  const { span, layout, box } = stage;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The field, drawn once. The visible canvas only ever blits this. */
  const fieldRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const density = useMemo(() => lifeDensity(events, calendars, span), [events, calendars, span]);

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
    drawField(ctx, box, layout, span, density, today);

    fieldRef.current = field;
    canvas.width = field.width;
    canvas.height = field.height;
    paint();
  }, [box, layout, span, density, today, paint]);

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
  const hoverDot = hover ? dotOf(hover.date) : null;
  const selectedDot = isSameDay(selected, today) ? null : dotOf(selected);
  const deathDot = dotOf(span.death);
  /** One rule per decade of age, on the line that decade's year starts. */
  const rules = Math.floor((layout.years - 1) / DECADE) + 1;

  function locate(e: ReactPointerEvent<HTMLCanvasElement>): { date: Date; at: LifePoint } | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const date = lifeCellAt(layout, span, at.x, at.y);
    return date ? { date, at } : null;
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Your life in days, one dot per day, ${formatCount(span.days)} of them`}
        className="absolute inset-0 h-full w-full touch-none"
        onPointerMove={(e) => {
          const hit = locate(e);
          // Bail on the same day: a pointer crossing one dot fires a dozen
          // moves, and each one that changes state re-renders the tip.
          if (hit?.date.getTime() === hover?.date.getTime()) return;
          setHover(hit ? { date: hit.date, ...hit.at } : null);
        }}
        onPointerLeave={() => setHover(null)}
        // A press, not a click — as on the dial, where every gesture is a
        // pointer gesture and a click is one that did not move.
        onPointerUp={(e) => {
          const hit = locate(e);
          if (hit) onSelectDay(hit.date);
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
          {/* The estimate, marked rather than drawn: one dim red circumference
              on the last day the grid has. */}
          {deathDot && (
            <circle
              cx={deathDot.x}
              cy={deathDot.y}
              r={Math.max(layout.radius * 2.2, 2.6)}
              fill="none"
              stroke="var(--danger)"
              strokeWidth={1}
              opacity={0.5}
            />
          )}
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
          {hoverDot && (
            <circle
              cx={hoverDot.x}
              cy={hoverDot.y}
              r={Math.max(layout.radius * 2.8, 3.6)}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1}
              opacity={0.7}
            />
          )}
        </svg>
      </motion.div>

      {hover && (
        <DayTip hover={hover} today={today} events={events} calendars={calendars} box={box} />
      )}
    </>
  );
}

/* ----------------------------------- tip ---------------------------------- */

function DayTip({
  hover,
  today,
  events,
  calendars,
  box,
}: {
  hover: Hover;
  today: Date;
  events: CalEvent[];
  calendars: Calendar[];
  box: Box;
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
  const lift = hover.y > box.height * 0.68;

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
        <div className="text-[17px] font-medium text-ink">Your life, in days</div>
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
