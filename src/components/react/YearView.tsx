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
  useSpring,
  type MotionValue,
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
  magnify,
  markRadius,
  monthMarks,
  ringDelta,
  spread,
  unroller,
  type Vec,
} from "@/lib/year";
import { MONTHS, WEEKDAYS, clamp, daysBetween, formatDayRange } from "@/lib/time";
import { UNROLL_IN_MS, UNROLL_OUT_MS } from "@/lib/motion";
import { cue } from "@/lib/feedback";
import { useElementSize, useHotkeys } from "./hooks";
import { cn } from "@/lib/utils";

/** The accent, spelled out — an SVG `fill` cannot read a Tailwind token. */
const ACCENT = "#a3d9e4";
/** An empty day's mark. At the size a year renders this is a square, which is
 *  a dot — the same thing the same day is in the life grid. */
const EMPTY_MARK = "#3a3a3e";

/**
 * How white an *empty* day goes when it is the one being pointed at. Empty,
 * and only empty: a day with events already says what it is with its colour,
 * and washing that out to name it trades the one piece of information this
 * face carries for a highlight the growth is already giving. So light is what
 * a day with nothing on it gets instead of a colour, and the two never
 * compete.
 */
const LIT_HOVER = 0.95;

/**
 * How the three parts of the magnifier are spread across the neighbourhood,
 * as exponents on `magnify`'s bell.
 *
 * The bell is the *shape* — 0.78 at one day out and 0.37 at two, which is
 * what makes it read as a magnifier over five marks rather than as one day
 * changing size — and these decide how much of each part the middle keeps.
 * Length is the gentlest, so the two neighbours either side visibly come
 * along; width is steeper, because every unit of it has to be borrowed from
 * the black between marks; light is the steepest, so the day the readout is
 * naming is unmistakably the one.
 *
 * They are here and not in `YEAR` on purpose: the bell is geometry and is
 * tested, these are how hard the drawing leans on it.
 */
const FALLOFF = { length: 1.4, width: 4, light: 3.5 } as const;

/**
 * The bulge arriving and leaving. Stiff, because it answers a pointer and a
 * highlight that lags one is not a highlight — and underdamped by a hair, so
 * the day pops rather than inflating.
 */
const MAGNIFY_SPRING = { stiffness: 520, damping: 22, mass: 0.6 } as const;

/**
 * The bulge sliding from one slot to the next. Critically damped, unlike the
 * one above: overshoot in *size* is a pop, and overshoot in *position* is the
 * magnifier running past the day it is naming and coming back. Fast enough
 * that a slow read still feels attached to the pointer, and slow enough that
 * a sweep of the ring is a wave rather than 365 jumps.
 */
const SLIDE_SPRING = { stiffness: 700, damping: 44, mass: 0.7 } as const;

interface Mark {
  angle: number;
  outer: number;
  color: string;
  count: number;
}

/**
 * A range being dragged across the ring, in day slots — the dial's `Draw` at
 * the year's scale, and the same three fields for the same reason: two
 * positions on a ring do not say which way round the pointer travelled, so the
 * sweep is accumulated per pointer event rather than measured from the grab.
 */
interface Span {
  /** The day the press landed on. */
  from: number;
  /** The day the pointer was last seen on. */
  at: number;
  /** Signed days swept since the grab; clockwise positive. */
  sweep: number;
}

/** The two ends of a drag, in the order the year has them. Both inclusive: a
 *  range of one day is a day, not a zero-length nothing. */
function resolveSpan({ from, sweep }: Span): { lo: number; hi: number } {
  return sweep >= 0 ? { lo: from, hi: from + sweep } : { lo: from + sweep, hi: from };
}

/**
 * The event about to exist, as slots on the ring: white while the range is
 * still under the pointer, the draft's own colour once the editor has one to
 * pick. One notion rather than two, so the picture does not change shape at
 * the moment the modal arrives — the days it covers are drawn as days that
 * carry it, which is what they will look like when it is saved.
 */
interface Pending {
  lo: number;
  hi: number;
  color: string;
}

/** The draft's days as slots in the year on screen, or `null` when it does not
 *  reach into this one. A multi-day event can start in the year before and end
 *  in the year after, so both ends clip to the ring rather than being trusted. */
function draftSlots(from: Date, to: Date, year: number, days: number): [number, number] | null {
  const first = from.getFullYear();
  const last = to.getFullYear();
  if (last < year || first > year) return null;
  return [first < year ? 0 : dayOfYear(from), last > year ? days - 1 : dayOfYear(to)];
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
 * What the centre says, in the dial's order: the range being dragged, else the
 * day being pointed at, else the year itself. The ring is the shape of the
 * year; this is the sentence.
 *
 * The resting state is the year and not the selected day, because the
 * selected day is already drawn — a readout repeating the white mark six
 * inches away is the same fact twice, which is the mistake the sidebar and
 * the centre panel spent a rewrite untangling.
 *
 * Under it, the standing line. The dial's interior answers what a day is made
 * of; a year has no equivalent answer worth printing every time you open it,
 * so the space goes to something the user wrote instead. It appears only at
 * rest: pointing at a day is a question, and a quote is not an answer to it.
 */
function Readout({
  year,
  date,
  span,
  tally,
  today,
  quote,
  u,
}: {
  year: number;
  date: Date | null;
  /** The range under a live drag, both ends inclusive. */
  span: { from: Date; to: Date } | null;
  tally: Mark | null;
  today: Date;
  quote: string;
  u: number;
}) {
  // A range, printed the way the dial prints one: the value and its size, and
  // nothing above them. The hovered day carries a weekday because a day has
  // one; a run of days has no single fact of that kind, and inventing a label
  // for the sake of the third line is how a readout starts saying nothing.
  if (span) {
    const days = daysBetween(span.from, span.to) + 1;
    return (
      <Centre u={u}>
        <span
          className="font-medium text-ink tabular-nums"
          style={{ fontSize: `${38 * u}px`, lineHeight: 1, letterSpacing: "-0.025em" }}
        >
          {formatDayRange(span.from, span.to)}
        </span>
        <span className="text-ink-2 tabular-nums" style={{ fontSize: `${14 * u}px` }}>
          {days} days
        </span>
      </Centre>
    );
  }

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
        {quote && (
          // The one place in the app where a line is allowed to wrap: it is
          // the user's sentence and the ring is round, so the width is capped
          // well inside the numerals rather than left to the viewport.
          //
          // `ink-3`, the same tone as the date above it. `ink-4` is the ticks
          // and the disabled, and 12.5px of it on true black is a line you
          // can see is there without being able to read it. What keeps this
          // subordinate to the date is the italic and the gap, not the grey.
          <span
            className="text-ink-3 italic"
            style={{
              fontSize: `${12.5 * u}px`,
              lineHeight: 1.45,
              maxWidth: `${230 * u}px`,
              marginTop: `${12 * u}px`,
              whiteSpace: "normal",
            }}
          >
            {quote}
          </span>
        )}
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
  settings,
  stage,
  flow,
  draft,
  onSelectDay,
  onCreateSpan,
}: YearViewProps) {
  const reducedMotion = useReducedMotion();
  const [stageRef, width, height] = useElementSize<HTMLDivElement>();
  const u = Math.min(width, height) / VIEW_SIZE;

  const days = daysInYear(year);
  const listRef = useRef<HTMLUListElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** The two tick channels, as `cue` wants them. */
  const channels = useMemo(
    () => ({ sound: settings.tickSound, haptics: settings.tickHaptics }),
    [settings.tickSound, settings.tickHaptics],
  );

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
   * Which slot the bulge is centred on, and how much of it is up.
   *
   * Motion values rather than state: both change every frame while the
   * pointer moves, and neither may cost a React render — 365 marks re-diffed
   * at 60 Hz is what the canvas exists to avoid. The *day* is state, because
   * the readout and the listbox name it and it only changes once per slot
   * crossed.
   *
   * The position is a spring on the slot's *centre*, not the pointer's exact
   * place in the year. Following the pointer continuously was the first
   * draft, and it meant the bulge only ever landed wholly on one mark when
   * the pointer happened to be at that mark's midpoint: anywhere else the
   * two marks either side of the pointer split it between them and neither
   * reached full size, so the day the readout was naming looked no different
   * from its neighbour. Snapping to the slot fixes which mark is the
   * subject; the spring is what stops the snap being a lurch, which is the
   * one thing a magnifier must not do.
   */
  const pointerAt = useSpring(0, reducedMotion ? { duration: 0 } : SLIDE_SPRING);
  const amount = useSpring(0, reducedMotion ? { duration: 0 } : MAGNIFY_SPRING);

  /**
   * Move the bulge to a day, the short way round: the spring's value is a
   * position on a ring, so a slide from 31 December to 1 January must travel
   * one slot forwards and not 364 slots back through the year.
   *
   * `jump` for the first day of a hover, and for the keyboard picking the
   * ring up cold. There is nothing on screen to be continuous with at that
   * moment — the bulge is down — and sliding to it would sweep a swell
   * across two months of a ring nobody was pointing at.
   */
  const slideTo = useCallback(
    (day: number, jump = false) => {
      const at = pointerAt.get();
      const to = at + ringDelta(day + 0.5, at, days);
      if (jump) pointerAt.jump(to);
      else pointerAt.set(to);
    },
    [pointerAt, days],
  );

  /**
   * The keyboard drives the same bulge the pointer does, so the cursor and
   * the hover are one thing seen twice — and the pointer wins while it is on
   * the ring, where `onMove` has already placed it.
   *
   * One effect, not two: a second one setting `amount` would run after this
   * and put it back to zero every time the keyboard was the only thing on.
   * Motion values are an external system, which is what an effect is for.
   */
  useEffect(() => {
    if (hover !== null) {
      amount.set(1);
      return;
    }
    if (cursor === null) {
      amount.set(0);
      return;
    }
    slideTo(cursor, amount.get() < 0.01);
    amount.set(1);
  }, [hover, cursor, slideTo, amount]);

  const months = useMemo(() => monthMarks(year), [year]);

  const isThisYear = year === today.getFullYear();
  const todayIndex = isThisYear ? dayOfYear(today) : null;

  /* ------------------------------ interaction ----------------------------- */

  /**
   * Where a pointer event is, in the two terms this face asks in: which day
   * the angle names, and whether the radius is on the ring at all.
   *
   * Both, rather than `null` off the ring, because the two gestures want
   * different answers. A hover is only a hover over the marks — the corners of
   * a square panel are not pointing at December, and neither is the empty
   * middle — but once the ring has been *grabbed*, the angle is the whole of
   * the question and the corners are on it too, exactly as the dial's whole
   * face is the gesture surface once a drag has the capture.
   */
  const locate = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>): { day: number; onRing: boolean } | null => {
      const ctm = e.currentTarget.getScreenCTM();
      if (!ctm) return null;
      const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const r = Math.hypot(x - DIAL.C, y - DIAL.C);
      return {
        day: dayAtPoint(x, y, days),
        onRing: r >= YEAR.TODAY_RING - 30 && r <= YEAR.MONTH,
      };
    },
    [days],
  );

  /**
   * The last day the pointer was on, for the tick.
   *
   * `setHover` cannot answer this: React bails out of an identical value, so
   * a `pointermove` that stayed inside the same slot is indistinguishable
   * from one that crossed into a new one by the time state has settled — and
   * a tick per pointer event rather than per day is not a tick, it is noise.
   */
  const ticked = useRef<number | null>(null);

  /** The range being drawn, or `null`. See `Span`. */
  const [span, setSpan] = useState<Span | null>(null);

  /**
   * Escape abandons a range in flight, from here rather than the shell's
   * hotkeys for the reason the dial's does: a drag is the one thing on this
   * face you can start by accident, and before this the only way out of one
   * was to let go, which made the event. The capture is left alone — the
   * release that follows finds no span and does nothing.
   *
   * Armed only while there is a range, as the life view's milestone card is:
   * `useHotkeys` calls `preventDefault` on any combo it has a handler for, and
   * an always-on Escape here would be swallowing the key for every panel that
   * opens over this view.
   */
  useHotkeys({ escape: () => setSpan(null) }, span !== null);

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const hit = locate(e);
    if (span) {
      if (!hit || hit.day === span.at) return;
      // The sweep is clamped and the pointer is not, exactly as the dial's ring
      // drag is: a range that has run to 31 December stops dead there and
      // starts following back the instant the pointer turns. Rolling into the
      // next year would have to commit a day to change the `year` prop, and
      // committing is what leaves this view — the same reason the arrows clamp.
      const sweep = clamp(
        span.sweep + ringDelta(hit.day, span.at, days),
        -span.from,
        days - 1 - span.from,
      );
      const moved = sweep !== span.sweep;
      setSpan({ ...span, at: hit.day, sweep });
      setHover(hit.day);
      ticked.current = hit.day;
      slideTo(hit.day);
      // `step` rather than the hover's `slide`: an edge landing on a mark is
      // what that cue is, and a range being drawn has one in hand. A range
      // pinned at the end of the year goes quiet, which is the feedback that
      // says there is no more year.
      if (moved) cue("step", channels);
      return;
    }
    if (!hit || !hit.onRing) {
      setHover(null);
      ticked.current = null;
      return;
    }
    setHover(hit.day);
    if (hit.day !== ticked.current) {
      const arriving = ticked.current === null;
      ticked.current = hit.day;
      slideTo(hit.day, arriving);
      // The quieter of the two drag cues, and gated like them: crossing a day
      // is the same event as crossing a detent. A slow read is one tick per
      // day; a fast sweep is a rip, which is what running a finger along a
      // comb does and is the right answer for a ring of 365 teeth.
      cue("slide", channels);
    }
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const hit = locate(e);
    if (!hit || !hit.onRing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Focus moves to the list so the arrows carry on from where the pointer
    // stopped, rather than starting again at the selection.
    setCursor(hit.day);
    listRef.current?.focus();
    setSpan({ from: hit.day, at: hit.day, sweep: 0 });
  };

  /**
   * The release. A press that never crossed a day is a click and a click names
   * the day and leaves for it, which is the grammar this face already had — and
   * the same rule the dial's arcs follow, where a press that moved nothing
   * opens the event instead of writing to it.
   *
   * Anything wider is a range, and a range of days is a multi-day event: the
   * ring gesture one scale up. It hands over to the editor rather than writing
   * straight through, because an event still needs a name.
   */
  const onUp = () => {
    if (!span) return;
    const { lo, hi } = resolveSpan(span);
    setSpan(null);
    if (span.sweep === 0) {
      onSelectDay(dateOfYear(year, lo));
      return;
    }
    cue("opened", channels);
    onCreateSpan(dateOfYear(year, lo), hi - lo + 1);
  };

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
  /** The range as the readout wants it: two inclusive day slots, and only ever
   *  while the pointer is down — the editor prints its own dates once it is up. */
  const range = span === null ? null : resolveSpan(span);

  /**
   * The draft in the editor, clipped to this year. Memoised because it is what
   * the ring's canvas repaints on, and a fresh object every render would repaint
   * it on every clock tick.
   */
  const drafted = useMemo((): Pending | null => {
    if (!draft) return null;
    const slots = draftSlots(draft.from, draft.to, year, days);
    return slots && { lo: slots[0], hi: slots[1], color: draft.color };
  }, [draft, year, days]);

  /** The pointer wins while it is down: the range being dragged *is* the draft
   *  that is about to open, and drawing both would double the same fact. */
  const pending: Pending | null =
    range === null ? drafted : { lo: range.lo, hi: range.hi, color: "#ffffff" };

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
        onPointerMove={onMove}
        onPointerLeave={() => {
          // Not while a range is in flight: the capture keeps the events coming
          // and the gesture is still on, wherever the pointer has got to.
          if (span) return;
          setHover(null);
          ticked.current = null;
        }}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => setSpan(null)}
      >
        <defs>
          <radialGradient id="year-glow">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.045" />
            <stop offset="62%" stopColor="#fff" stopOpacity="0.014" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={DIAL.C} cy={DIAL.C} r={YEAR.DAY_INNER} fill="url(#year-glow)" />

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
      </svg>

      {/* The year itself, on a canvas over the frame.

          The marks used to be one `<path>` per colour in the SVG, which is
          the right shape for a drawing that never moves — and this one does.
          The day under the pointer swells and its neighbours give way, every
          frame, off a fractional position: 365 SVG nodes re-diffed at 60 Hz
          is exactly the cost a canvas does not have. */}
      {!flying && (
        <Ring
          marks={marks}
          days={days}
          box={{ width, height }}
          selected={selectedIndex}
          today={todayIndex}
          pending={pending}
          at={pointerAt}
          amount={amount}
        />
      )}

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
          span={range && { from: dateOfYear(year, range.lo), to: dateOfYear(year, range.hi) }}
          tally={activeMark}
          today={today}
          quote={settings.yearQuote}
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

/**
 * The year, one mark per day, magnified under the pointer.
 *
 * The day the pointer is on grows towards the centre and thickens, its
 * neighbours grow half as much, and everything within a few days gives way
 * so the swelling does not eat the rhythm of the ring. Straight out of the
 * macOS Dock, and for the same reason: at 0.99° a day the thing you are
 * pointing at is smaller than the pointer, and a highlight that only changed
 * its colour would leave you counting teeth.
 *
 * It grows **inwards**. The outer tip is the datum — it is the whole of what
 * this face says about the day — so magnifying it outwards would make a
 * hovered empty day look like a booked one.
 *
 * Driven off motion values rather than props: the position changes on every
 * `pointermove` and the amount is a spring, and 365 SVG nodes re-diffed at
 * 60 Hz is precisely the cost this canvas exists not to pay. One `clearRect`
 * and 365 strokes is a fraction of a millisecond.
 */
function Ring({
  marks,
  days,
  box,
  selected,
  today,
  pending,
  at,
  amount,
}: {
  marks: Mark[];
  days: number;
  box: { width: number; height: number };
  selected: number | null;
  today: number | null;
  /** The event about to exist, or `null`. Drawn on the days it covers as a day
   *  that carries it: one more thing on the day, in its ink. */
  pending: Pending | null;
  at: MotionValue<number>;
  amount: MotionValue<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.lineCap = "butt";

    const face = faceToPanel(box.width, box.height);
    const centre = at.get();
    const strength = amount.get();
    // The pending range hoisted to two numbers, so the loop is a comparison
    // rather than a null check three hundred and sixty-five times.
    const from = pending ? pending.lo : Infinity;
    const to = pending ? pending.hi : -Infinity;
    const ink = pending ? pending.color : "";

    for (let i = 0; i < days; i++) {
      const mark = marks[i];
      // The slot's own middle against the pointer's exact place, so the day
      // being pointed at gets the whole bulge rather than half of it.
      const delta = strength > 0.001 ? ringDelta(i + 0.5, centre, days) : YEAR.REACH + 1;
      const lift = strength * magnify(delta);
      const shift = strength * YEAR.PUSH * spread(delta);

      // The tip goes out, the baseline stays. It is the day rising to meet
      // the pointer, and the three parts of it lean on the bell by different
      // amounts: the neighbours come along in length and barely at all in
      // width or light, so the emphasis stays on the one day being named.
      //
      // A day the pending event covers is drawn as a day that *carries* it —
      // one more thing on it, in its ink — so the picture does not change shape
      // when the drag hands over to the editor or when the editor saves. It is
      // the ghost arc's job in this face's own terms.
      const carries = i >= from && i <= to;
      const angle = dayAngle(i + shift, days);
      const base = carries ? markRadius(mark.count + 1) : mark.outer;
      const grown = base + YEAR.GROW_OUT * lift ** FALLOFF.length;
      const inner = face.at(...radial(YEAR.DAY_INNER, angle));
      const outer = face.at(...radial(grown, angle));

      ctx.lineWidth = YEAR.DAY_WIDTH * (1 + YEAR.GROW_WIDTH * lift ** FALLOFF.width) * face.u;
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.strokeStyle = carries ? ink : mark.color;
      ctx.stroke();

      // Light instead of a colour, never over one. An empty day has nothing
      // to say with its fill, so the magnifier lights it; a day with events
      // is already saying it, and washing that to white to announce a hover
      // spends the only information this face carries on a highlight the
      // growth has already given.
      //
      // The selection is the exception and is full white whatever it carries:
      // it is not a hover, it is where the dial will land and where the unroll
      // leaves from. A pending day takes no light at all — its ink already is
      // the highlight, and white over a chosen colour would hide the choice.
      const white = carries
        ? 0
        : i === selected
          ? 1
          : mark.count > 0
            ? 0
            : LIT_HOVER * lift ** FALLOFF.light;
      if (white > 0.004) {
        ctx.globalAlpha = white;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (i === today) {
        const pip = face.at(...radial(YEAR.TODAY_RING, angle));
        ctx.beginPath();
        ctx.arc(pip.x, pip.y, YEAR.TODAY_PIP * face.u, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
      }
    }
  }, [box.width, box.height, days, marks, selected, today, pending, at, amount]);

  useMotionValueEvent(at, "change", paint);
  useMotionValueEvent(amount, "change", paint);

  /* The canvas is an external system: written to, not rendered. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    paint();
  }, [box.width, box.height, paint]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

/** A point on the face, as the pair `faceToPanel` takes. Saves minting a
 *  `{x, y}` per mark per frame in a loop that runs 365 times. */
function radial(r: number, deg: number): [number, number] {
  const p = polar(r, deg);
  return [p.x, p.y];
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
