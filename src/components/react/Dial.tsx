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
} from "@/lib/dial";
import { colorOf, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import { sunTimes, type Place } from "@/lib/sun";
import {
  MINUTES_PER_DAY,
  clamp,
  formatOffset,
  isSameDay,
  minutesOfDay,
  snap,
  startOfDay,
  zoneCity,
  zoneOffset,
  type Clock,
} from "@/lib/time";
import { useElementSize } from "./hooks";
import CenterPanel from "./CenterPanel";

export interface DialProps {
  day: Date;
  now: Date;
  clock: Clock;
  occurrences: Occurrence[];
  calendars: Calendar[];
  /** Daylight band; `null` leaves the elapsed ring on the track instead. */
  place: Place | null;
  /** Draw the hours the sun is down, in violet, alongside the daylight. */
  night: boolean;
  /** IANA zone for the outer ring; `""` leaves it off. */
  secondZone: string;
  showZoneName: boolean;
  showZoneOffset: boolean;
  onOpen: (occ: Occurrence) => void;
  onCreate: (startMin: number, endMin: number) => void;
}

/** Minutes a bare click on the ring turns into. */
const CLICK_DURATION = 60;
/** Drag granularity. Matches what a fifteen-minute arc can actually show. */
const STEP = 15;

/**
 * White at `level` alpha, pre-composited against the black canvas. Opaque, so
 * overlapping strokes replace rather than accumulate.
 */
function grey(level: number): string {
  const v = Math.round(clamp(level, 0, 1) * 255);
  return `rgb(${v},${v},${v})`;
}

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
  place,
  night,
  secondZone,
  showZoneName,
  showZoneOffset,
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
   * short arcs whose brightness ramps towards the present.
   *
   * The ramp is in the *colour*, not the opacity: on a pure-black canvas an
   * opaque grey is indistinguishable from translucent white, and opaque
   * segments can overlap without their alphas compounding. Translucent ones
   * cannot — every join brightened into a bead, and the trail read as a row
   * of tick marks. Butt caps for the same reason; only the two ends of the
   * whole trail are rounded.
   *
   * The daylight band takes over this same radius when a place is set, so
   * there is nothing to compute here then.
   */
  const elapsedSegments = useMemo(() => {
    if (place || elapsed <= 0) return [];
    const from = angleAt(0, clock);
    const to = from + (elapsed / MINUTES_PER_DAY) * 360;
    const count = clamp(Math.round(elapsed / 8), 2, 180);
    return Array.from({ length: count }, (_, i) => {
      const a = from + ((to - from) * i) / count;
      // Overlap the next segment: an exact butt-to-butt join leaves an
      // antialiasing seam, which is the same artefact one shade darker.
      const b = from + ((to - from) * (i + 1)) / count + 0.4;
      // Eased, not linear: a straight ramp reads as a uniformly grey ring,
      // where the day should stay nearly dark until it approaches now.
      const level = 0.045 + 0.62 * ((i + 0.7) / count) ** 1.7;
      return {
        d: arcPath(DIAL.TRACK, a, Math.min(b, to)),
        stroke: grey(level),
        cap: i === 0 || i === count - 1 ? ("round" as const) : ("butt" as const),
      };
    });
  }, [place, elapsed, clock]);

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

        {place && <SunBand day={day} clock={clock} place={place} night={night} />}
        {secondZone && (
          <ZoneRing
            now={now}
            clock={clock}
            zone={secondZone}
            showName={showZoneName}
            showOffset={showZoneOffset}
          />
        )}

        <g shapeRendering="geometricPrecision">
          {elapsedSegments.map((segment, i) => (
            <path
              key={i}
              d={segment.d}
              fill="none"
              stroke={segment.stroke}
              strokeWidth={DIAL.TRACK_WIDTH}
              strokeLinecap={segment.cap}
            />
          ))}
        </g>

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
        clock={clock}
        drag={ghost && ghost.end > ghost.start ? ghost : null}
        hovered={hovered}
        onHover={setHovered}
        onOpen={onOpen}
      />
    </div>
  );
}

/* -------------------------------- pieces --------------------------------- */

/**
 * The daylight band: where the sun actually is on this day, at this place.
 *
 * The single feature the circle earns that a grid cannot — a rectangular
 * calendar can draw a sunrise line, but only a dial shows the *shape* of the
 * day's light, and that shape visibly turns through the year.
 *
 * It is drawn *on* the track, replacing the elapsed ring rather than sitting
 * outside it. Two rings a few units apart read as one line doubled by
 * mistake, and between "how much of the day is gone" and "where the light
 * is", the light is the one worth the rim.
 *
 * Same construction as the ring it replaces, for the same reason: a chain of
 * *opaque* butt-capped arcs. Translucent segments compound their alpha at
 * every join and the band reads as a row of beads.
 */
function SunBand({
  day,
  clock,
  place,
  night,
}: {
  day: Date;
  clock: Clock;
  place: Place;
  night: boolean;
}) {
  const segments = useMemo(() => {
    const sun = sunTimes(day, place);

    /**
     * Signed light at minute `m`: positive is sun, negative is night, and it
     * passes through zero exactly at the civil-twilight boundary.
     *
     * One continuous function rather than four cases with their own constants,
     * because every discontinuity in here becomes a visible step on the rim —
     * the shoulders used to start at 0.04 and the band began with a hard edge.
     */
    const light = (m: number): number => {
      if (sun.polar === "day") return 0.86;
      const { dawn, sunrise, sunset, dusk } = sun;
      if (sun.polar !== "night" && sunrise !== null && sunset !== null) {
        if (m >= sunrise && m <= sunset) {
          // A sine between the two horizons stands in for solar altitude:
          // wrong by a few percent, right about where the day is brightest.
          const t = (m - sunrise) / (sunset - sunrise);
          return 0.14 + 0.72 * Math.sin(Math.PI * t) ** 0.7;
        }
        // Civil twilight: a shoulder that reaches the horizon at zero, so the
        // warm band and the night band meet without either one starting on a
        // step.
        if (dawn !== null && m >= dawn && m < sunrise) {
          return 0.14 * ((m - dawn) / (sunrise - dawn));
        }
        if (dusk !== null && m > sunset && m <= dusk) {
          return 0.14 * ((dusk - m) / (dusk - sunset));
        }
      }
      if (!night) return 0;
      // Night wraps midnight, so it is measured as the fraction of the way
      // from dusk to the next dawn rather than as a span of this day.
      const from = sun.dusk ?? sun.sunset ?? 0;
      const to = (sun.dawn ?? sun.sunrise ?? MINUTES_PER_DAY) + MINUTES_PER_DAY;
      const at = m < from ? m + MINUTES_PER_DAY : m;
      const u = sun.polar === "night" ? 0.5 : clamp((at - from) / (to - from), 0, 1);
      return -(0.05 + 0.42 * Math.sin(Math.PI * u) ** 0.6);
    };

    // Five minutes a segment. At this radius that is an eight-unit chord, and
    // the step between neighbouring shades stops being something you can see.
    const COUNT = 288;
    const step = MINUTES_PER_DAY / COUNT;

    return Array.from({ length: COUNT }, (_, i) => light((i + 0.5) * step)).flatMap((value, i) => {
      if (Math.abs(value) <= 0.004) return [];
      const from = angleAt(i * step, clock);
      // Overlap the neighbour: an exact butt-to-butt join leaves an
      // antialiasing seam, which is the same artefact one shade darker.
      const to = angleAt((i + 1) * step, clock) + 0.3;
      // Both pre-composited against black. Warm but desaturated for day, and a
      // dim violet for night — saturated colour on this canvas belongs to
      // events, and neither band may compete with an arc.
      const [r, g, b] = value > 0 ? [255, 198, 124] : [150, 132, 255];
      const k = Math.abs(value);
      return [
        {
          d: arcPath(DIAL.TRACK, from, to),
          stroke: `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`,
        },
      ];
    });
  }, [day, clock, place, night]);

  return (
    <g pointerEvents="none" shapeRendering="geometricPrecision">
      {segments.map((segment, i) => (
        <path
          key={i}
          d={segment.d}
          fill="none"
          stroke={segment.stroke}
          strokeWidth={DIAL.TRACK_WIDTH}
          // Butt everywhere: the band now fades to black at both ends rather
          // than stopping, so a round cap would only add a bead where there is
          // nothing left to round off.
          strokeLinecap="butt"
        />
      ))}
    </g>
  );
}

/**
 * A second timezone, as a rotation rather than a second clock.
 *
 * The instant is the same everywhere, so the other zone does not need its own
 * hand — it needs its own *labels*, offset around the same face. Four of them:
 * twenty-four numerals out here would out-shout the dial they annotate.
 *
 * The caption is the city and its offset **from you**, not from UTC. You are
 * the origin of this dial; "GMT+9" makes you do the subtraction yourself, and
 * gets it wrong twice a year when one of the two zones changes and the other
 * does not.
 */
function ZoneRing({
  now,
  clock,
  zone,
  showName,
  showOffset,
}: {
  now: Date;
  clock: Clock;
  zone: string;
  showName: boolean;
  showOffset: boolean;
}) {
  const marks = useMemo(() => {
    // Minutes the zone runs ahead of the viewer. `getTimezoneOffset` is
    // minutes *behind* UTC, hence the addition.
    const delta = zoneOffset(now, zone) + now.getTimezoneOffset();
    const caption = [showName ? zoneCity(zone) : "", showOffset ? formatOffset(delta) : ""]
      .filter(Boolean)
      .join(" ");

    const placed = [0, 6, 12, 18].map((hour) => {
      // The local minute at which the other zone reads `hour`.
      const localMin =
        (((hour * 60 - delta) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      return { hour, ...polar(DIAL.ZONE, angleAt(localMin, clock)) };
    });

    // The caption sits beside a numeral, not beneath it — under it, it landed
    // on the hour label below and ran off the edge of the viewBox at three
    // o'clock. Beside the *topmost* of the four, because that is the one with
    // horizontal room: the marks are 90° apart, so one is always within 45° of
    // the top, and at 45° the caption still ends 60 units inside the crop.
    const anchor = placed.reduce((top, mark) => (mark.y < top.y ? mark : top));
    return { placed, caption, anchor };
  }, [now, zone, clock, showName, showOffset]);

  return (
    <g pointerEvents="none">
      {marks.placed.map((mark) => (
        <text
          key={mark.hour}
          x={mark.x}
          y={mark.y}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-[#55555a] font-mono"
          fontSize={15}
          fontWeight={500}
          letterSpacing="0.04em"
        >
          {`${mark.hour}`.padStart(2, "0")}
        </text>
      ))}
      {marks.caption && (
        <text
          x={marks.anchor.x + 14}
          y={marks.anchor.y}
          textAnchor="start"
          dominantBaseline="central"
          className="fill-ink-4 font-mono"
          fontSize={11}
          fontWeight={500}
          letterSpacing="0.1em"
        >
          {marks.caption}
        </text>
      )}
    </g>
  );
}

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

/**
 * The present, as a spoke on the rim rather than a needle through the middle.
 *
 * It starts as a pip on the track at the exact minute, runs inwards, and is
 * gone before it reaches the readout — a full diameter crosses the digits and
 * the agenda, which is a lot of ink spent on a time the readout already says.
 *
 * `dimmed` while a drag is in progress: the hand marks a time the user is no
 * longer reading, and at full white it competes with the range being drawn.
 */
function NowHand({ minutes, clock, dimmed }: { minutes: number; clock: Clock; dimmed: boolean }) {
  const deg = angleAt(minutes, clock);
  const head = polar(DIAL.TRACK, deg);
  const inner = polar(DIAL.HAND_INNER, deg);
  return (
    <g
      pointerEvents="none"
      opacity={dimmed ? 0.22 : 1}
      style={{ transition: "opacity 140ms var(--ease)" }}
    >
      <defs>
        {/* Along the spoke, not across it: solid at the rim, gone by the
            inner end, so the hand has no hard tail to notice. */}
        <linearGradient
          id="now-hand"
          gradientUnits="userSpaceOnUse"
          x1={head.x}
          y1={head.y}
          x2={inner.x}
          y2={inner.y}
        >
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="42%" stopColor="#fff" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1={head.x}
        y1={head.y}
        x2={inner.x}
        y2={inner.y}
        stroke="url(#now-hand)"
        strokeWidth={DIAL.HAND_WIDTH}
        strokeLinecap="round"
      />
      <circle cx={head.x} cy={head.y} r={DIAL.HAND_PIP} fill="#fff" />
    </g>
  );
}
