/* ------------------------------------------------------------------ *
 * ⌘Y — the whole year on one revolution.
 *
 * The same instrument as the dial, asked a bigger question: angle is the day
 * of the year, clockwise from 1 January at the top, one mark per day growing
 * outwards with what is on it.
 *
 * It was twelve month blocks in a 4×3 grid, which shared code with the life
 * view but no argument with either of the other two screens — and being a
 * grid, it could only ever crossfade into one. Day order round a circle is a
 * row of the life grid rolled up, which is what lets ⌘Y ⇄ ⌘L be an unroll of
 * the same days rather than two unrelated pictures dissolving.
 *
 * The interior is the readout and nothing else. It carried a daylight figure
 * for one draft — sunrise and sunset as two curves round the year — which was
 * the wrong thing on the right screen: a picture that is interesting and is
 * never what you came to a calendar to find out.
 *
 * That readout is HTML rather than SVG text, for the reason `CenterPanel` is:
 * real typography, scaled by `u` — pixels per user unit — so it stays in
 * proportion with the ring at any window size.
 * ------------------------------------------------------------------ */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  usePresence,
  useReducedMotion,
} from "motion/react";
import type { YearViewProps } from "@/components/react/types";
import { DIAL, VIEW_BOX, VIEW_SIZE, polar } from "@/lib/dial";
import { LIFE_META_H, dayTally, formatLifeDate, lifeDot, type LifeStage } from "@/lib/life";
import {
  YEAR,
  dateOfYear,
  dayAngle,
  dayAtPoint,
  dayOfYear,
  daysInYear,
  faceToPanel,
  markPath,
  markRadius,
  monthMarks,
  unroller,
  type Vec,
} from "@/lib/year";
import { MONTHS, WEEKDAYS } from "@/lib/time";
import { UNROLL_IN_MS, UNROLL_OUT_MS } from "@/lib/motion";
import { useElementSize } from "./hooks";
import { cn } from "@/lib/utils";

/** The accent, spelled out — an SVG `fill` cannot read a Tailwind token. */
const ACCENT = "#a3d9e4";
/** An empty day's mark. At the size a year renders this is a square, which is
 *  a dot — the same thing the same day is in the life grid. */
const EMPTY_MARK = "#3a3a3e";

/** How far a highlight overhangs the mark it is drawn round. */
const MARK_PAD = 4;

interface Mark {
  angle: number;
  outer: number;
  color: string;
  count: number;
}

/**
 * When the days stop following the flattening curve and start going to the
 * places they actually occupy.
 *
 * A year is not always one line of the life grid — `lifeLayout` splits it
 * across up to six, whichever leaves the biggest dot — so the straightened
 * ring is only ever the *first* of them. Blending onto the true dots over the
 * back half is what turns one long line into the two or four it really is,
 * and because both curves are continuous it still reads as one movement
 * rather than as unroll-then-rearrange.
 */
const SETTLE_FROM = 0.34;

/**
 * The unroll's curve, and pointedly *not* the app's `EASE`.
 *
 * The angle the year still subtends falls as roughly `(1 - t)²` — a circle
 * whose curvature has merely halved is still a semicircle — so almost all of
 * the *visible* straightening happens in the first half of `t`. On `EASE`,
 * which spends two thirds of its travel in the first quarter of its time, the
 * ring was a line 150 ms in and the whole movement was over before the eye
 * found it.
 *
 * So this leans the other way: slow off the mark, which spends real time on
 * the part of the curve that actually looks like unrolling, then away and a
 * settle.
 */
const UNROLL_EASE: [number, number, number, number] = [0.72, 0, 0.28, 1];

/** How long the ring's own chrome — the months, the readout, the glow — takes
 *  to get out of the way of the transition, and to come back. */
const CHROME_MS = 260;

/* ------------------------------- the readout ------------------------------- */

/**
 * What the centre says, in the dial's order: the day being pointed at, else
 * the year itself. The ring is the shape of the year; this is the sentence.
 *
 * The resting state is the year and not the selected day, because the
 * selected day is already drawn — a readout repeating the white mark six
 * inches away is the same fact twice, which is the mistake the sidebar and
 * the centre panel spent a rewrite untangling.
 */
function Readout({
  year,
  date,
  tally,
  today,
  u,
}: {
  year: number;
  date: Date | null;
  tally: Mark | null;
  today: Date;
  u: number;
}) {
  if (!date) {
    return (
      <Centre u={u}>
        <span
          className="font-medium text-ink tabular-nums"
          style={{ fontSize: `${72 * u}px`, lineHeight: 1, letterSpacing: "-0.04em" }}
        >
          {year}
        </span>
        <span className="label text-ink-3" style={{ fontSize: `${11 * u}px` }}>
          {year === today.getFullYear() ? formatLifeDate(today) : `${daysInYear(year)} days`}
        </span>
      </Centre>
    );
  }

  return (
    <Centre u={u}>
      <span className="label text-ink-3" style={{ fontSize: `${11 * u}px` }}>
        {WEEKDAYS[date.getDay()].slice(0, 3)}
      </span>
      <span
        className="font-medium text-ink tabular-nums"
        style={{ fontSize: `${46 * u}px`, lineHeight: 1, letterSpacing: "-0.025em" }}
      >
        {date.getDate()} {MONTHS[date.getMonth()].slice(0, 3)}
      </span>
      <span
        className={cn("tabular-nums", tally && tally.count > 0 ? "text-ink-2" : "text-ink-4")}
        style={{ fontSize: `${14 * u}px` }}
      >
        {tally && tally.count > 0
          ? `${tally.count} event${tally.count === 1 ? "" : "s"}`
          : "Nothing"}
      </span>
    </Centre>
  );
}

function Centre({ u, children }: { u: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-1/2 left-1/2 flex flex-col items-center text-center whitespace-nowrap"
      style={{ transform: "translate(-50%, -50%)", gap: `${6 * u}px` }}
    >
      {children}
    </div>
  );
}

/* --------------------------------- the face -------------------------------- */

export default function YearView({
  year,
  today,
  selected,
  events,
  calendars,
  stage,
  flow,
  onSelectDay,
}: YearViewProps) {
  const reducedMotion = useReducedMotion();
  const [stageRef, width, height] = useElementSize<HTMLDivElement>();
  const u = Math.min(width, height) / VIEW_SIZE;

  const days = daysInYear(year);
  const listRef = useRef<HTMLUListElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  /**
   * The keyboard's cursor, and it is a cursor rather than a selection: naming
   * a day here *leaves* for the dial (`goDay`), so a listbox that committed on
   * every arrow press would fall out of the view on the first one. Arrows
   * move, Enter chooses — which is what a listbox is.
   *
   * `null` until the keyboard is used, so arriving does not announce a day
   * nobody asked about.
   */
  const [cursor, setCursor] = useState<number | null>(null);
  const selectedIndex = selected.getFullYear() === year ? dayOfYear(selected) : null;
  /** Reset on a new year: day 300 of the year you just left is not a place. */
  const [seededYear, setSeededYear] = useState(year);
  if (seededYear !== year) {
    setSeededYear(year);
    setCursor(null);
  }

  /**
   * What every day of the year carries. 365 `occurrencesOn` calls — the same
   * price the month grid paid, memoised, so a hover never pays it again.
   */
  const marks = useMemo(() => {
    const out: Mark[] = new Array(days);
    for (let i = 0; i < days; i++) {
      const { count, colors } = dayTally(events, calendars, dateOfYear(year, i));
      out[i] = {
        angle: dayAngle(i, days),
        outer: markRadius(count),
        color: colors[0] ?? EMPTY_MARK,
        count,
      };
    }
    return out;
  }, [year, days, events, calendars]);

  /**
   * The marks as one path per colour. A year of individual elements is 365
   * nodes to diff on every pointer move; batched it is a handful — the same
   * trick the life grid's field uses for thirty thousand. Everything that
   * follows the pointer is drawn over the top, so a hover never repaints the
   * year.
   */
  const strokes = useMemo(() => {
    const byColor = new Map<string, string[]>();
    for (const mark of marks) {
      const list = byColor.get(mark.color);
      if (list) list.push(markPath(mark.angle, mark.outer));
      else byColor.set(mark.color, [markPath(mark.angle, mark.outer)]);
    }
    return [...byColor].map(([color, paths]) => ({ color, d: paths.join(" ") }));
  }, [marks]);

  const months = useMemo(() => monthMarks(year), [year]);

  const isThisYear = year === today.getFullYear();
  const todayIndex = isThisYear ? dayOfYear(today) : null;

  /* ------------------------------ interaction ----------------------------- */

  const dayAt = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): number | null => {
      const ctm = e.currentTarget.getScreenCTM();
      if (!ctm) return null;
      const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      // Generous inwards, because the ring is the only thing on the face and
      // an empty interior is not December — but it is not a day either, and
      // neither are the corners of a square panel.
      const r = Math.hypot(x - DIAL.C, y - DIAL.C);
      if (r < YEAR.TODAY_RING - 30 || r > YEAR.MONTH) return null;
      return dayAtPoint(x, y, days);
    },
    [days],
  );

  /**
   * Clamped at both ends of the year rather than rolling into the next one:
   * rolling would have to commit a day to change the `year` prop, and
   * committing is what leaves this view. Years are the top bar's stepper, and
   * ← / → while the ring does not hold focus.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const at = cursor ?? selectedIndex ?? 0;
    const MOVES: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 7,
      ArrowUp: -7,
      PageDown: 28,
      PageUp: -28,
    };
    if (e.key in MOVES) {
      // ← and → belong to the shell in this view (they step the year); inside
      // the ring they belong to the ring, so the shell must not also see them.
      e.preventDefault();
      e.stopPropagation();
      setCursor(Math.min(days - 1, Math.max(0, at + MOVES[e.key])));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setCursor(e.key === "Home" ? 0 : days - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectDay(dateOfYear(year, at));
    }
  };

  const active = hover ?? cursor;
  const activeMark = active === null ? null : marks[active];
  const activeIndex = active ?? selectedIndex ?? 0;

  /* -------------------------------- the unroll ---------------------------- */

  /**
   * Year ⇄ life is an unroll, and this face owns both halves of it: it is the
   * one with the ring's geometry, and both halves have to agree about it to
   * the pixel.
   *
   * `flow` is read through a ref because a panel that is *leaving* has props
   * frozen at its last render, which is one render too early to know what is
   * arriving. `usePresence` then holds the unmount open until the ring has
   * finished becoming the row — the same contract the life view has with the
   * dial's zoom.
   *
   * `stage` is null when there is no life to unroll into (no birth date, or a
   * panel too small to be a field), and a year at either end of the span may
   * have no dot for 1 January. Either way this falls back to the crossfade
   * every other pair of views gets.
   */
  const [isPresent, safeToRemove] = usePresence();
  /**
   * Which half is in the air. Seeded on mount from the flow, because a panel
   * arriving from the life grid has to hand over on its very first frame —
   * measured only after that, so `canUnroll` gates the *drawing* rather than
   * the decision. A `flight` that turns out to be undrawable is inert, and
   * the ring simply appears, which is the crossfade every other pair gets.
   */
  const [flight, setFlight] = useState<"out" | "in" | null>(() =>
    !reducedMotion && flow.current.from === "life" ? "in" : null,
  );
  const canUnroll = !reducedMotion && stage !== null && width > 0 && height > 0;
  if (!isPresent && canUnroll && flow.current.to === "life" && flight !== "out") setFlight("out");
  /** The ring hands over to the canvas for the duration: two drawings of the
   *  same 365 marks, one over the other, is a doubled year. */
  const flying = flight !== null && canUnroll;

  useEffect(() => {
    if (isPresent) return;
    if (!canUnroll || flow.current.to !== "life") safeToRemove?.();
  }, [isPresent, safeToRemove, canUnroll, flow]);

  return (
    <motion.div
      ref={stageRef}
      className="relative h-full w-full"
      // No fade when the ring is rolling up out of the grid: the canvas
      // arrives already drawn on the dots it is lifting off, and dimming that
      // first frame is the one thing that would give the join away.
      initial={reducedMotion || flight === "in" ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      {/* The ring, and the frame it hangs in. While the unroll is in the air
          the frame gets out of the way — the months and the readout belong to
          a face, and the days are on their way to being a grid. A plain CSS
          transition, because it is the same fade in both directions and
          `flying` already says which one. */}
      <svg
        viewBox={VIEW_BOX}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full touch-none select-none"
        style={{ opacity: flying ? 0 : 1, transition: `opacity ${CHROME_MS}ms var(--ease)` }}
        role="presentation"
        onPointerMove={(e) => setHover(dayAt(e))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          const index = dayAt(e);
          if (index === null) return;
          // Focus moves to the list so the arrows carry on from where the
          // pointer stopped, rather than starting again at the selection.
          setCursor(index);
          listRef.current?.focus();
          onSelectDay(dateOfYear(year, index));
        }}
      >
        <defs>
          <radialGradient id="year-glow">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.045" />
            <stop offset="62%" stopColor="#fff" stopOpacity="0.014" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={DIAL.C} cy={DIAL.C} r={YEAR.DAY_INNER} fill="url(#year-glow)" />

        {/* The year, one mark per day — unless it is in the air, in which case
            the canvas below has it and two drawings of the same 365 marks
            would be a doubled year. */}
        {!flying && (
          <>
            <g pointerEvents="none" strokeWidth={YEAR.DAY_WIDTH} strokeLinecap="butt">
              {strokes.map((stroke) => (
                <path key={stroke.color} d={stroke.d} stroke={stroke.color} fill="none" />
              ))}
            </g>

            {/* Today: a pip inside the ring, not a brighter mark. What a day
                carries is its events' colour, and being today is not one of
                them — the same reason the life grid haloes its dot rather
                than filling it. */}
            {todayIndex !== null && (
              <circle
                cx={polar(YEAR.TODAY_RING, dayAngle(todayIndex, days)).x}
                cy={polar(YEAR.TODAY_RING, dayAngle(todayIndex, days)).y}
                r={YEAR.TODAY_PIP}
                fill={ACCENT}
              />
            )}
          </>
        )}

        {/* Month boundaries, and their names outside them. */}
        <g pointerEvents="none">
          {months.map(({ month, edge, mid }) => {
            const from = polar(YEAR.TICK_INNER, edge);
            const to = polar(YEAR.TICK_OUTER, edge);
            const label = polar(YEAR.MONTH, mid);
            return (
              <g key={month}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className="stroke-ink-4"
                  strokeWidth={1.2}
                />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className={cn(
                    "font-mono font-medium",
                    isThisYear && today.getMonth() === month ? "fill-accent" : "fill-ink-3",
                  )}
                  fontSize={14}
                  letterSpacing="0.18em"
                >
                  {MONTHS[month].slice(0, 3).toUpperCase()}
                </text>
              </g>
            );
          })}
        </g>

        {/* The day the shell is on — a full-length white mark, because it is
            where the dial will land and where the unroll leaves from. */}
        {!flying && selectedIndex !== null && (
          <Spoke angle={dayAngle(selectedIndex, days)} stroke="#fff" opacity={0.92} />
        )}
        {!flying && activeMark && active !== selectedIndex && (
          <Spoke
            angle={activeMark.angle}
            stroke={activeMark.count > 0 ? activeMark.color : "#ffffff"}
            opacity={0.45}
          />
        )}
      </svg>

      {/*
        The keyboard and everything that is not a pointer.

        Off-screen and real, rather than 365 `role="option"` groups inside the
        SVG: the marks up there are one path per colour and cannot carry a name
        each, and a ring of 365 tab stops — which is what the month grid it
        replaced actually had — is a wall rather than a path. One stop, arrows
        inside it, and the ring draws the cursor.
      */}
      <ul
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label={`${year}, one mark per day`}
        aria-activedescendant={`year-day-${activeIndex}`}
        className="sr-only"
        onKeyDown={onKeyDown}
      >
        {/* No handler of their own: the list is clipped to a pixel, so a
            pointer never reaches an option. Choosing is Enter, on the box. */}
        {marks.map((mark, i) => (
          <li key={i} id={`year-day-${i}`} role="option" aria-selected={i === activeIndex}>
            {dayLabel(year, i, mark.count)}
          </li>
        ))}
      </ul>

      <div style={{ opacity: flying ? 0 : 1, transition: `opacity ${CHROME_MS}ms var(--ease)` }}>
        <Readout
          year={year}
          date={active === null ? null : dateOfYear(year, active)}
          tally={activeMark}
          today={today}
          u={u}
        />
      </div>

      {flying && stage && (
        <Unroll
          stage={stage}
          year={year}
          days={days}
          marks={marks}
          box={{ width, height }}
          direction={flight === "out" ? "out" : "in"}
          onDone={() => (flight === "out" ? safeToRemove?.() : setFlight(null))}
        />
      )}
    </motion.div>
  );
}

/* --------------------------------- pieces ---------------------------------- */

/** A day's mark at full length, over the ring: the selection and the cursor
 *  are the same object at two weights. */
function Spoke({ angle, stroke, opacity }: { angle: number; stroke: string; opacity: number }) {
  const a = polar(YEAR.DAY_INNER - MARK_PAD, angle);
  const b = polar(YEAR.DAY_OUTER + MARK_PAD, angle);
  return (
    <line
      pointerEvents="none"
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      stroke={stroke}
      strokeWidth={YEAR.DAY_WIDTH + 1.6}
      strokeOpacity={opacity}
    />
  );
}

/* --------------------------------- unroll ---------------------------------- */

interface UnrollProps {
  stage: LifeStage;
  year: number;
  days: number;
  marks: Mark[];
  box: { width: number; height: number };
  /** `out` is the ring becoming the row; `in` is the row becoming the ring. */
  direction: "out" | "in";
  onDone: () => void;
}

/**
 * The ring unrolling into its row of the life grid, and back.
 *
 * A canvas, for the reason the life grid is one: this is 365 elements moving
 * every frame, and 365 SVG nodes with their attributes rewritten sixty times
 * a second is a diff per node per frame. Here it is one `clearRect` and 365
 * strokes, which is a fraction of a millisecond.
 *
 * The mark keeps its colour the whole way across. It is the same day at both
 * ends — that is the entire claim the transition is making — so recolouring
 * it in flight would be the one detail that gave the game away.
 */
function Unroll({ stage, year, days, marks, box, direction, onDone }: UnrollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progress = useMotionValue(direction === "out" ? 0 : 1);
  const { layout, span } = stage;

  /**
   * Everything that does not change between frames: where each day starts on
   * the ring, and where it is going in the grid. Computed once — `lifeDot` is
   * cheap, but 365 of it per frame is not.
   */
  const plan = useMemo(() => {
    const face = faceToPanel(box.width, box.height);
    const centre = face.at(DIAL.C, DIAL.C);
    const radius = YEAR.DAY_INNER * face.u;
    const targets = marks.map((_, i) => {
      const at = lifeDot(layout, span, dateOfYear(year, i));
      return at ? ({ x: at.x, y: at.y + LIFE_META_H } as Vec) : null;
    });
    /** 1 January's dot. The unroll is measured forward from it, so it is the
     *  one day that never leaves its own path. */
    const anchor = targets.find((target) => target !== null) ?? { x: centre.x, y: centre.y };
    /**
     * How long the straightened year is.
     *
     * Measured to 31 December's own dot when the year is on one line, which
     * is the desktop case — the ring then straightens onto exactly the row it
     * is becoming, with neither end to reel back in. When `lifeLayout` has
     * split the year across two lines or six, there is no single line to land
     * on and this is the rest of the first one; the settle does the rest.
     */
    const tail = targets[targets.length - 1];
    const length =
      tail && Math.abs(tail.y - anchor.y) < 1
        ? tail.x - anchor.x
        : layout.width - (anchor.x - layout.offsetX);

    return {
      radius,
      /** 1 January's inner end, which is the top of the ring. */
      head: { x: centre.x, y: centre.y - radius } as Vec,
      anchor,
      length,
      dot: layout.radius,
      width: YEAR.DAY_WIDTH * face.u,
      /** A mark's own length, ring-side. */
      lengths: marks.map((mark) => (mark.outer - YEAR.DAY_INNER) * face.u),
      /** Where each day lands. `null` for a day outside the life — a year at
       *  either end of the span has some, and they have nowhere to go. */
      targets,
    };
  }, [box.width, box.height, layout, span, marks, year]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.lineCap = "round";

    const t = progress.get();
    const roll = unroller(t, plan.head, plan.anchor, plan.radius, plan.length);
    // Smoothstep, so neither end of the settle has a corner in it.
    const raw = Math.min(1, Math.max(0, (t - SETTLE_FROM) / (1 - SETTLE_FROM)));
    const settle = raw * raw * (3 - 2 * raw);

    for (let i = 0; i < days; i++) {
      const { point, out } = roll((i + 0.5) / days);
      const target = plan.targets[i];
      const x = target ? point.x + (target.x - point.x) * settle : point.x;
      const y = target ? point.y + (target.y - point.y) * settle : point.y;

      const width = plan.width + (plan.dot * 2 - plan.width) * settle;
      const length = plan.lengths[i] * (1 - settle);
      // Round caps add half a width at each end, so take it back off — the
      // same inset an arc on the dial gets, and for the same reason.
      const painted = Math.max(0, length - width);

      ctx.globalAlpha = target ? 1 : 1 - settle;
      ctx.strokeStyle = marks[i].color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + out.x * painted, y + out.y * painted);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [box.width, box.height, days, marks, plan, progress]);

  useMotionValueEvent(progress, "change", paint);

  /* The canvas is an external system: it is written to, not rendered. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    paint();
  }, [box.width, box.height, paint]);

  useEffect(() => {
    const controls = animate(progress, direction === "out" ? 1 : 0, {
      duration: (direction === "out" ? UNROLL_OUT_MS : UNROLL_IN_MS) / 1000,
      ease: UNROLL_EASE,
      onComplete: onDone,
    });
    return () => controls.stop();
    // Mount only: a re-render must not restart a transition mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/** What a screen reader is told a mark is. The grid this replaced named the
 *  date and stopped there — which is the half the eye already had. */
function dayLabel(year: number, index: number, count: number): string {
  const date = dateOfYear(year, index);
  const when = `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${year}`;
  return count === 0 ? `${when}, nothing` : `${when}, ${count} event${count === 1 ? "" : "s"}`;
}
