/* ------------------------------------------------------------------ *
 * The instrument.
 *
 * One SVG, drawn outside-in: elapsed-day ring → ticks → hour numerals →
 * event arcs → now-hand, with the readout and agenda pinned over the middle
 * as HTML (see `CenterPanel`). The viewBox is fixed at 1000×1000 and scaled
 * to fit, so nothing here ever reads a pixel size except the overlay.
 * ------------------------------------------------------------------ */

import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DIAL,
  VIEW_BOX,
  VIEW_SIZE,
  angleAt,
  arcPath,
  capInset,
  minutesAtPoint,
  polar,
  type Clock,
} from "@/lib/dial";
import { colorOf, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import { MINUTES_PER_DAY, clamp, isSameDay, minutesOfDay, snap, startOfDay } from "@/lib/time";
import { useElementSize } from "./hooks";
import CenterPanel from "./CenterPanel";

export interface DialProps {
  day: Date;
  now: Date;
  clock: Clock;
  occurrences: Occurrence[];
  calendars: Calendar[];
  onOpen: (occ: Occurrence) => void;
  onCreate: (startMin: number, endMin: number) => void;
}

/** Minutes a bare click on the ring turns into. */
const CLICK_DURATION = 60;
/** Drag granularity. Matches what a fifteen-minute arc can actually show. */
const STEP = 15;

/**
 * Two ring positions do not say which way round the circle the user dragged.
 * Take the shorter sweep: anything over twelve hours was a counter-clockwise
 * drag, not a twenty-hour event.
 */
function resolveDrag(from: number, to: number): { start: number; end: number } {
  const forward = (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const span = forward <= MINUTES_PER_DAY / 2 ? forward : forward - MINUTES_PER_DAY;
  const start = span >= 0 ? from : from + span;
  const end = span >= 0 ? from + span : from;
  return { start: clamp(start, 0, MINUTES_PER_DAY - STEP), end: clamp(end, STEP, MINUTES_PER_DAY) };
}

export default function Dial({
  day,
  now,
  clock,
  occurrences,
  calendars,
  onOpen,
  onCreate,
}: DialProps) {
  const [stageRef, width, height] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const u = Math.min(width, height) / VIEW_SIZE;
  const today = isSameDay(day, now);
  const nowMin = minutesOfDay(now);

  /** How much of this day is spent: all of a past day, none of a future one. */
  const elapsed = today ? nowMin : startOfDay(day) < startOfDay(now) ? MINUTES_PER_DAY : 0;

  /**
   * SVG has no conic gradient, so the elapsed ring is drawn as a chain of
   * short arcs whose opacity ramps towards the present. Fifteen minutes each,
   * overlapping slightly so the joins do not show.
   */
  const elapsedSegments = useMemo(() => {
    if (elapsed <= 0) return [];
    const from = angleAt(0, clock);
    const to = from + (elapsed / MINUTES_PER_DAY) * 360;
    const count = clamp(Math.round(elapsed / STEP), 2, 96);
    return Array.from({ length: count }, (_, i) => {
      const a = from + ((to - from) * i) / count;
      const b = from + ((to - from) * (i + 1)) / count + 0.35;
      return {
        d: arcPath(DIAL.TRACK, a, Math.min(b, to)),
        // Eased, not linear: a straight ramp reads as a uniformly grey ring,
        // where the day should stay nearly dark until it approaches now.
        opacity: 0.045 + 0.6 * ((i + 0.7) / count) ** 1.7,
      };
    });
  }, [elapsed, clock]);

  const ghost = drag ? resolveDrag(drag.from, drag.to) : null;

  /* ------------------------------ pointer ------------------------------ */

  // The handler lives on a <circle>, so `ownerSVGElement` is always the root
  // <svg>; the guard is only there because the DOM types allow null.
  function pointIn(e: ReactPointerEvent<SVGCircleElement>): { x: number; y: number } | null {
    const ctm = e.currentTarget.ownerSVGElement?.getScreenCTM();
    if (!ctm) return null;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  }

  function onRingDown(e: ReactPointerEvent<SVGCircleElement>) {
    if (e.button !== 0) return;
    const point = pointIn(e);
    if (!point) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const m = snap(minutesAtPoint(point.x, point.y, clock), STEP);
    setDrag({ from: m, to: m });
  }

  function onRingMove(e: ReactPointerEvent<SVGCircleElement>) {
    if (!drag) return;
    const point = pointIn(e);
    if (!point) return;
    setDrag({ ...drag, to: snap(minutesAtPoint(point.x, point.y, clock), STEP) });
  }

  function onRingUp() {
    if (!drag) return;
    const { start, end } = resolveDrag(drag.from, drag.to);
    setDrag(null);
    if (end - start < STEP) {
      const from = Math.min(drag.from, MINUTES_PER_DAY - CLICK_DURATION);
      onCreate(from, from + CLICK_DURATION);
    } else {
      onCreate(start, end);
    }
  }

  /* ------------------------------- render ------------------------------- */

  return (
    <div ref={stageRef} className="relative h-full w-full">
      <svg
        viewBox={VIEW_BOX}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full touch-none select-none"
        role="presentation"
      >
        <defs>
          <radialGradient id="dial-glow">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.05" />
            <stop offset="52%" stopColor="#fff" stopOpacity="0.014" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={DIAL.C} cy={DIAL.C} r={DIAL.TRACK} fill="url(#dial-glow)" />

        {elapsedSegments.map((segment, i) => (
          <path
            key={i}
            d={segment.d}
            fill="none"
            stroke="#fff"
            strokeOpacity={segment.opacity}
            strokeWidth={DIAL.TRACK_WIDTH}
            strokeLinecap="round"
          />
        ))}

        <Ticks clock={clock} />
        <HourLabels clock={clock} />

        {/* Drag target. An annulus, so the agenda in the middle stays clickable
            and the corners of the window do not create events. */}
        <circle
          cx={DIAL.C}
          cy={DIAL.C}
          r={(DIAL.TRACK + DIAL.DRAG_INNER) / 2}
          fill="none"
          stroke="transparent"
          strokeWidth={DIAL.TRACK - DIAL.DRAG_INNER}
          className="[pointer-events:stroke] cursor-crosshair"
          onPointerDown={onRingDown}
          onPointerMove={onRingMove}
          onPointerUp={onRingUp}
          onPointerCancel={() => setDrag(null)}
        />

        {occurrences.map((occ) => (
          <EventArc
            key={occ.key}
            occ={occ}
            clock={clock}
            color={colorOf(occ.event, calendars)}
            dimmed={today && statusOf(occ, now) === "past"}
            hovered={hovered === occ.key}
            onHover={setHovered}
            onOpen={onOpen}
          />
        ))}

        {ghost && ghost.end > ghost.start && (
          <GhostArc clock={clock} start={ghost.start} end={ghost.end} />
        )}

        {today && <NowHand minutes={nowMin} clock={clock} dimmed={drag !== null} />}
      </svg>

      <CenterPanel
        day={day}
        now={now}
        occurrences={occurrences}
        calendars={calendars}
        u={u}
        drag={ghost && ghost.end > ghost.start ? ghost : null}
        hovered={hovered}
        onHover={setHovered}
        onOpen={onOpen}
      />
    </div>
  );
}

/* -------------------------------- pieces --------------------------------- */

function Ticks({ clock }: { clock: Clock }) {
  // Half-hour resolution: enough texture to read the ring as a scale, sparse
  // enough that the numerals still lead.
  const ticks = [];
  for (let i = 0; i < 48; i += 1) {
    const deg = angleAt(i * 30, clock);
    const cardinal = ((deg % 90) + 90) % 90 === 0;
    const hour = i % 2 === 0;
    const inner = cardinal ? 374 : hour ? DIAL.TICK_INNER : DIAL.TICK_INNER_MINOR;
    const a = polar(inner, deg);
    const b = polar(DIAL.TICK_OUTER, deg);
    ticks.push(
      <line
        key={i}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke="#fff"
        strokeOpacity={cardinal ? 0.6 : hour ? 0.26 : 0.13}
        strokeWidth={cardinal ? 2 : 1}
        strokeLinecap="round"
      />,
    );
  }
  return <g pointerEvents="none">{ticks}</g>;
}

function HourLabels({ clock }: { clock: Clock }) {
  return (
    <g pointerEvents="none" textAnchor="middle">
      {Array.from({ length: 24 }, (_, h) => {
        const { x, y } = polar(DIAL.LABELS, angleAt(h * 60, clock));
        // The quarter-turn hours are the anchors you navigate by. On the
        // AM/PM face they are the two noons and the two sixes; on the
        // 24-hour face, 00 · 06 · 12 · 18.
        const major = h % 6 === 0;
        const twelve = h % 12 === 0 ? 12 : h % 12;

        if (!major) {
          return (
            <text
              key={h}
              x={x}
              y={y}
              dominantBaseline="central"
              className="fill-[#6d6d73]"
              fontSize={19.5}
              fontWeight={450}
            >
              {clock === "12h" ? twelve : h}
            </text>
          );
        }

        return (
          <g key={h}>
            <text
              x={x}
              // The AM/PM face carries a caption under the numeral, so its
              // major label sits high to keep the pair optically centred.
              y={clock === "12h" ? y - 4 : y}
              dominantBaseline="central"
              className="fill-ink"
              fontSize={30}
              fontWeight={600}
              letterSpacing="-0.02em"
            >
              {clock === "12h" ? twelve : `${h}`.padStart(2, "0")}
            </text>
            {clock === "12h" && (
              <text
                x={x}
                y={y + 20}
                dominantBaseline="central"
                className="fill-ink-2 font-mono"
                fontSize={13.5}
                fontWeight={500}
                letterSpacing="0.06em"
              >
                {h < 12 ? "AM" : "PM"}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function EventArc({
  occ,
  clock,
  color,
  dimmed,
  hovered,
  onHover,
  onOpen,
}: {
  occ: Occurrence;
  clock: Clock;
  color: string;
  dimmed: boolean;
  hovered: boolean;
  onHover: (key: string | null) => void;
  onOpen: (occ: Occurrence) => void;
}) {
  if (occ.event.allDay) return null;

  const r = DIAL.LANE - occ.lane * DIAL.LANE_STEP;
  const width = DIAL.ARC_WIDTH;
  const inset = capInset(r);
  const from = angleAt(occ.startMin, clock);
  const to = angleAt(occ.endMin, clock);
  // Sub-cap-length events collapse to their own round cap: a dot on the ring
  // at the right minute, rather than an arc that lies about its duration.
  const dot = to - from <= inset * 2;
  const d = dot
    ? arcPath(r, (from + to) / 2, (from + to) / 2 + 0.001)
    : arcPath(r, from + inset, to - inset);

  return (
    <g
      className="cursor-pointer"
      onPointerEnter={() => onHover(occ.key)}
      onPointerLeave={() => onHover(null)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onOpen(occ)}
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={hovered ? width + 3 : width}
        strokeLinecap="round"
        opacity={dimmed && !hovered ? 0.42 : 1}
        style={{ transition: "stroke-width 140ms var(--ease), opacity 140ms var(--ease)" }}
      />
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={width + 16}
        strokeLinecap="round"
        pointerEvents="stroke"
      />
    </g>
  );
}

/** The range being dragged, on the outermost lane. */
function GhostArc({ clock, start, end }: { clock: Clock; start: number; end: number }) {
  const inset = capInset(DIAL.LANE);
  const from = angleAt(start, clock) + inset;
  const to = Math.max(from, angleAt(end, clock) - inset);
  return (
    <path
      d={arcPath(DIAL.LANE, from, to)}
      fill="none"
      stroke="#fff"
      strokeOpacity={0.45}
      strokeWidth={DIAL.ARC_WIDTH}
      strokeLinecap="round"
      pointerEvents="none"
    />
  );
}

/** `dimmed` while a drag is in progress: the hand marks a time the user is no
 *  longer reading, and at full white it competes with the range being drawn. */
function NowHand({ minutes, clock, dimmed }: { minutes: number; clock: Clock; dimmed: boolean }) {
  const deg = angleAt(minutes, clock);
  const head = polar(DIAL.TRACK, deg);
  const tail = polar(-DIAL.HAND_TAIL, deg);
  return (
    <line
      x1={head.x}
      y1={head.y}
      x2={tail.x}
      y2={tail.y}
      stroke="#fff"
      strokeOpacity={dimmed ? 0.22 : 1}
      strokeWidth={DIAL.HAND_WIDTH}
      strokeLinecap="round"
      pointerEvents="none"
      style={{ transition: "stroke-opacity 140ms var(--ease)" }}
    />
  );
}
