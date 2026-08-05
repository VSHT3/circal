/* ------------------------------------------------------------------ *
 * ⌘L — one life, one screen, one dot per day.
 *
 * The day view is a single revolution. This is every revolution you get: the
 * same day, pulled back until it is three pixels wide and thirty thousand of
 * them fit in the window. Days you have spent are dim, today is the one lit
 * dot, the ones you have not are plain grey — the whole point being that the
 * dim part is not coming back.
 *
 * Three things about the implementation, all forced by the dot count:
 *
 * 1. **The field is a canvas.** Thirty thousand SVG circles is thirty thousand
 *    DOM nodes: the mount alone costs the best part of a second and nothing
 *    can be animated afterwards. The canvas is drawn once per layout or data
 *    change and otherwise left alone.
 * 2. **Nothing that follows the pointer is drawn on it.** Hover, selection,
 *    today's halo and the death mark are four SVG circles in an overlay, so
 *    moving the mouse never costs a redraw of the field underneath.
 * 3. **The zoom is a shared circle, not a scaled bitmap.** Arriving from the
 *    dial, a ring starts at the dial's own rim and shrinks onto today's dot
 *    while the field fades up around it; leaving, it runs the other way. The
 *    canvas itself only scales the last little bit, because a bitmap blown up
 *    two hundred times is mush.
 * ------------------------------------------------------------------ */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { DIAL, VIEW_SIZE } from "@/lib/dial";
import { colorOf, occurrencesOn, type CalEvent, type Calendar } from "@/lib/events";
import {
  dim,
  formatAge,
  formatCount,
  formatLifeDate,
  lifeCell,
  lifeCellAt,
  lifeDensity,
  lifeDotX,
  lifeDotY,
  lifeLayout,
  lifeRowTop,
  lifeSpan,
  lifeStats,
  lifeYearRange,
  LIFE_GUTTER,
  type LifeLayout,
  type LifeSpan,
} from "@/lib/life";
import { LIFE_EXPECTANCY_RANGE, store } from "@/lib/store";
import { WEEKDAYS, dayKey, fromDayKey, isSameDay, startOfDay } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { LifeViewProps } from "@/components/react/types";
import { DateField, NumberField } from "@/components/react/ui/primitives";
import { useElementSize } from "./hooks";

const EASE = [0.32, 0.72, 0, 1] as const;
const TAU = Math.PI * 2;
const DAY_MS = 86_400_000;

/**
 * How bright a day is. Two tones per state, alternating by month: a month is
 * not a whole number of weeks, so it cannot be a gap in a grid whose columns
 * are weeks — it is this instead, and the band drifting along the row is the
 * honest shape of the thing.
 *
 * Opaque greys rather than translucent white, for the reason the dial's
 * elapsed ring is: on true black the two are the same colour, and only one of
 * them can be composited wrong.
 */
const TONE = {
  past: [dim("#ffffff", 0.19), dim("#ffffff", 0.14)],
  future: [dim("#ffffff", 0.48), dim("#ffffff", 0.35)],
  /** How far an event's colour is dimmed once the day is behind you. */
  eventPast: 0.42,
} as const;

/** The accent, as the canvas needs it — a token cannot be read by `fillStyle`. */
const TODAY_COLOR = "#a3d9e4";

/** Rows the age rules are drawn on. */
const DECADE = 10;

interface Box {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/* --------------------------------- drawing -------------------------------- */

/**
 * The whole field in one pass, batched by colour: one `Path2D` per distinct
 * colour and one `fill` each, rather than thirty thousand `beginPath`/`fill`
 * pairs. Today is left out of the batch and drawn last — it is the only dot
 * with a different radius, and it belongs on top of its neighbours.
 */
function drawLife(
  canvas: HTMLCanvasElement,
  box: Box,
  layout: LifeLayout,
  span: LifeSpan,
  density: Map<string, string>,
  today: Date,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Backing store in device pixels, drawing in CSS pixels: a two-pixel dot is
  // four on a retina screen, and drawn at half the coordinates it would be a
  // grey smear instead.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  let lit: Point | null = null;

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

      if (cursor.getTime() === todayMs) {
        lit = { x, y };
        continue;
      }
      const past = cursor.getTime() < todayMs;
      const event = coloured ? density.get(dayKey(cursor)) : undefined;
      plot(
        event
          ? past
            ? dim(event, TONE.eventPast)
            : event
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
    ctx.fillStyle = TODAY_COLOR;
    ctx.beginPath();
    ctx.arc(lit.x, lit.y, Math.max(radius * 1.8, 2), 0, TAU);
    ctx.fill();
  }
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
  birth,
  expectancy,
  now,
  selected,
  events,
  calendars,
  onSelectDay,
}: LifeViewProps) {
  const [gridRef, width, height] = useElementSize<HTMLDivElement>();

  /**
   * The *day*, not the instant: `now` ticks every second, and every memo below
   * it would be thrown away sixty times a minute for a grid that changes once
   * at midnight. Only the percentage in the strip reads the instant.
   */
  const todayKey = dayKey(now);
  const today = useMemo(() => fromDayKey(todayKey), [todayKey]);

  const span = useMemo(
    () => (birth ? lifeSpan(fromDayKey(birth), expectancy) : null),
    [birth, expectancy],
  );
  const layout = useMemo(
    () => (span && width > 0 && height > 0 ? lifeLayout(width, height, span) : null),
    [span, width, height],
  );
  const stats = useMemo(() => (span ? lifeStats(span, now) : null), [span, now]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {span && stats && (
        // Two halves that give way in order: the birth date and age go first
        // (both are in the settings card), then the estimated end. What never
        // goes is the count and the percentage — they are the readout.
        <div className="flex shrink-0 items-baseline gap-3 px-1 pb-1.5">
          <span className="label hidden shrink-0 text-[10px] text-ink-3 sm:inline">
            Born {formatLifeDate(span.birth)} <span className="text-ink-4">·</span>{" "}
            <span className="text-ink-2">{formatAge(stats.age)}</span>
          </span>
          <span className="label ml-auto truncate text-[10px] text-ink-3">
            <span className="text-ink-2">{formatCount(stats.daysLived)}</span> lived{" "}
            <span className="text-ink-4">·</span> {formatCount(stats.daysLeft)} left{" "}
            <span className="text-ink-4">·</span>{" "}
            {/* Six decimals, so it visibly moves: a life is long enough that two
                would sit still for seven hours at a time. */}
            <span className="text-accent tabular-nums">{(stats.fraction * 100).toFixed(6)}%</span>
            <span className="hidden lg:inline">
              {" "}
              <span className="text-ink-4">·</span> until {formatLifeDate(span.death)}
            </span>
          </span>
        </div>
      )}

      {/* Measured first, drawn second: the layout is a function of this box, so
          the field cannot exist before the box has a size.

          Mounted unconditionally, including while the prompt is up, because
          `useElementSize` observes once: rendering the prompt *instead of* this
          div left the observer attached to nothing, and answering the prompt
          then produced a grid of zero by zero. */}
      <div ref={gridRef} className="relative min-h-0 flex-1">
        {span && layout && (
          <LifeGrid
            box={{ width, height }}
            layout={layout}
            span={span}
            today={today}
            selected={selected}
            events={events}
            calendars={calendars}
            onSelectDay={onSelectDay}
          />
        )}
        {!span && <BirthPrompt now={now} expectancy={expectancy} />}
      </div>
    </div>
  );
}

/* ---------------------------------- grid ---------------------------------- */

interface Hover extends Point {
  date: Date;
}

function LifeGrid({
  box,
  layout,
  span,
  today,
  selected,
  events,
  calendars,
  onSelectDay,
}: {
  box: Box;
  layout: LifeLayout;
  span: LifeSpan;
  today: Date;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  onSelectDay: (day: Date) => void;
}) {
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const density = useMemo(() => lifeDensity(events, calendars, span), [events, calendars, span]);

  /* The canvas is an external system: it is written to, not rendered. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawLife(canvas, box, layout, span, density, today);
  }, [box, layout, span, density, today]);

  /** A day's dot in box coordinates, or `null` for a day outside the life. */
  const dotOf = (date: Date): Point | null => {
    if (date < span.birth || date > span.death) return null;
    const { row, col } = lifeCell(layout, date);
    return { x: lifeDotX(layout, col), y: lifeDotY(layout, row) };
  };

  /**
   * Where the zoom lands: today's dot, or the middle of the field when today
   * is not in the span at all — a birth date in the future, an expectancy
   * already run out. Both are somebody's honest input, and a ring that
   * shrinks into a corner for no visible reason is not the answer to either.
   */
  const centre: Point = { x: box.width / 2, y: box.height / 2 };
  const todayDot = dotOf(today);
  const target = todayDot ?? centre;
  /** The dial's rim at this box size — where the ring comes from. */
  const dialRadius = (Math.min(box.width, box.height) / VIEW_SIZE) * DIAL.TRACK;

  const hoverDot = hover ? dotOf(hover.date) : null;
  const selectedDot = isSameDay(selected, today) ? null : dotOf(selected);
  const deathDot = dotOf(span.death);
  /** One rule per decade of age, on the line that decade's year starts. */
  const rules = Math.floor((layout.years - 1) / DECADE) + 1;

  function locate(e: ReactPointerEvent<HTMLCanvasElement>): { date: Date; at: Point } | null {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const date = lifeCellAt(layout, span, at.x, at.y);
    return date ? { date, at } : null;
  }

  return (
    <>
      {/* The decade rules and their labels: ten of each at most, so they are
          DOM and carry the app's own type rather than a canvas approximation of
          it. The age is on the left, the calendar year it falls in on the
          right — the grid is a life first and a calendar second. */}
      {Array.from({ length: rules }, (_, i) => {
        const age = i * DECADE;
        const row = age * layout.linesPerYear;
        return (
          <div key={age} aria-hidden className="pointer-events-none absolute inset-0">
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

      <motion.canvas
        ref={canvasRef}
        role="img"
        aria-label={`Your life in days, one dot per day, ${formatCount(span.days)} of them`}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ transformOrigin: `${target.x}px ${target.y}px` }}
        initial={reducedMotion ? false : { opacity: 0, scale: 1.7 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reducedMotion ? undefined : { opacity: 0, scale: 1.7 }}
        transition={{ duration: 0.55, ease: EASE }}
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

      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`}
      >
        {/* The estimate, marked rather than drawn: one dim red circumference on
            the last day the grid has. */}
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

        {/* The zoom: the dial's rim, arriving on one day — and on the way out,
            leaving from it.

            Its own curve, and a longer one than the crossfade: on the panel's
            ease-out the ring covered four fifths of its travel in the first
            150ms, while the dial it started from was still bright, so the one
            element carrying the sense of pulling back was the one nobody could
            see move. `easeInOut` keeps it moving through the middle of the
            transition, which is where the eye is. */}
        {!reducedMotion && (
          <motion.circle
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.25}
            initial={{ cx: centre.x, cy: centre.y, r: dialRadius, opacity: 0.75 }}
            animate={{
              cx: target.x,
              cy: target.y,
              r: Math.max(layout.radius, 1.5),
              opacity: [0.75, 0.7, 0],
            }}
            exit={{
              cx: centre.x,
              cy: centre.y,
              r: dialRadius,
              // Held visible across the exit and dropped at the very end: it
              // hands the eye to the dial's own track, which is exactly there.
              opacity: [0.6, 0.6, 0],
            }}
            transition={{ duration: 0.62, ease: "easeInOut" }}
          />
        )}
      </svg>

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
function BirthPrompt({ now, expectancy }: { now: Date; expectancy: number }) {
  const reducedMotion = useReducedMotion();
  const [date, setDate] = useState("");
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
