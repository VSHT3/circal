/* ------------------------------------------------------------------ *
 * The instrument.
 *
 * One SVG, drawn outside-in: elapsed-day ring → ticks → hour numerals →
 * event arcs → now-hand, with the readout and agenda pinned over the middle
 * as HTML (see `CenterPanel`). The viewBox is fixed at 1000×1000 and scaled
 * to fit, so nothing here ever reads a pixel size except the overlay.
 * ------------------------------------------------------------------ */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  DIAL,
  TURN,
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

/** Radius of the lane an occurrence's arc is drawn on. */
function laneRadius(occ: Occurrence, clock: Clock): number {
  if (clock === "24h") return DIAL.LANE - occ.lane * DIAL.LANE_STEP;
  const base = occ.startMin < TURN["12h"] ? DIAL.LANE_AM : DIAL.LANE_PM;
  return base - occ.lane * DIAL.LANE_STEP_12;
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
  /** Which band the pointer went down in — the whole drag stays in that half. */
  const dragBand = useRef(false);

  const u = Math.min(width, height) / VIEW_SIZE;
  const today = isSameDay(day, now);
  const nowMin = minutesOfDay(now);

  /** How much of this day is spent: all of a past day, none of a future one. */
  const elapsed = today ? nowMin : startOfDay(day) < startOfDay(now) ? MINUTES_PER_DAY : 0;

  /**
   * SVG has no conic gradient, so the elapsed ring is drawn as a chain of
   * short arcs whose opacity ramps towards the present. Fifteen minutes each,
   * overlapping slightly so the joins do not show. On the twelve-hour face it
   * tracks the current half-day, since that is one turn of this dial.
   */
  const elapsedSegments = useMemo(() => {
    const turn = TURN[clock];
    // A full past day is a whole turn of either face; today is the progress
    // through the current turn.
    const spent = elapsed === MINUTES_PER_DAY ? turn : elapsed % turn;
    if (spent <= 0) return [];
    const from = angleAt(elapsed - spent, clock);
    const to = from + (spent / turn) * 360;
    const count = clamp(Math.round(spent / STEP), 2, 96);
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
    // On the twelve-hour face the angle is ambiguous, so the radius picks the
    // half: press inside the morning band, drag a morning event.
    dragBand.current = Math.hypot(point.x - DIAL.C, point.y - DIAL.C) >= DIAL.BAND_SPLIT;
    const m = snap(minutesAtPoint(point.x, point.y, clock, dragBand.current), STEP);
    setDrag({ from: m, to: m });
  }

  function onRingMove(e: ReactPointerEvent<SVGCircleElement>) {
    if (!drag) return;
    const point = pointIn(e);
    if (!point) return;
    setDrag({ ...drag, to: snap(minutesAtPoint(point.x, point.y, clock, dragBand.current), STEP) });
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
        {clock === "12h" && <BandGuides />}

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
  const hours = clock === "24h" ? 24 : 12;
  const ticks = [];
  for (let i = 0; i < hours * 2; i += 1) {
    const minutes = i * 30;
    const deg = angleAt(minutes, clock);
    const cardinal = deg % 90 === 0;
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
  const hours = clock === "24h" ? 24 : 12;
  return (
    <g pointerEvents="none" textAnchor="middle">
      {Array.from({ length: hours }, (_, h) => {
        const { x, y } = polar(DIAL.LABELS, angleAt(h * 60, clock));
        // Quarter-turn hours are the anchors you actually navigate by.
        const major = h % (hours / 4) === 0;
        const display = h % 12 === 0 ? 12 : h % 12;

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
              {display}
            </text>
          );
        }

        return (
          <g key={h}>
            <text
              x={x}
              y={clock === "24h" ? y - 4 : y}
              dominantBaseline="central"
              className="fill-ink"
              fontSize={30}
              fontWeight={600}
              letterSpacing="-0.02em"
            >
              {display}
            </text>
            {/* Only the 24-hour face can say which half of the day a numeral
                belongs to; on the 12-hour face that is the band's job. */}
            {clock === "24h" && (
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

/**
 * The two rings the twelve-hour face splits the day across. Without them an
 * empty morning band is invisible and the face looks like it lost an event.
 */
function BandGuides() {
  return (
    <g pointerEvents="none">
      {(["AM", "PM"] as const).map((band) => {
        const r = band === "AM" ? DIAL.LANE_AM : DIAL.LANE_PM;
        const mark = polar(r, 270);
        return (
          <g key={band}>
            <circle
              cx={DIAL.C}
              cy={DIAL.C}
              r={r}
              fill="none"
              stroke="#fff"
              strokeOpacity={0.08}
              strokeWidth={1}
              strokeDasharray="1 9"
            />
            <circle cx={mark.x} cy={mark.y} r={13} className="fill-void" />
            <text
              x={mark.x}
              y={mark.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-ink-4 font-mono"
              fontSize={12}
              fontWeight={500}
              letterSpacing="0.08em"
            >
              {band}
            </text>
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

  const r = laneRadius(occ, clock);
  const width = clock === "24h" ? DIAL.ARC_WIDTH : DIAL.ARC_WIDTH - 2;
  const inset = capInset(r);
  const from = angleAt(occ.startMin, clock);
  const to = from + ((occ.endMin - occ.startMin) / TURN[clock]) * 360;
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

/** The range being dragged, drawn on the band that range belongs to. */
function GhostArc({ clock, start, end }: { clock: Clock; start: number; end: number }) {
  const r = clock === "24h" ? DIAL.LANE : start < TURN["12h"] ? DIAL.LANE_AM : DIAL.LANE_PM;
  const inset = capInset(r);
  const from = angleAt(start, clock) + inset;
  const to = Math.max(from, angleAt(start, clock) + ((end - start) / TURN[clock]) * 360 - inset);
  return (
    <path
      d={arcPath(r, from, to)}
      fill="none"
      stroke="#fff"
      strokeOpacity={0.45}
      strokeWidth={clock === "24h" ? DIAL.ARC_WIDTH : DIAL.ARC_WIDTH - 2}
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
