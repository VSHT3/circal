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
import { detent, type Detent } from "@/lib/feedback";
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
  /** Lightcycle band; `null` leaves the elapsed ring on the track instead. */
  place: Place | null;
  /** The two halves of that band: the lit hours, and the dark ones in violet. */
  daylight: boolean;
  moonlight: boolean;
  /** IANA zone for the outer ring; `""` leaves it off. */
  secondZone: string;
  showZoneName: boolean;
  showZoneOffset: boolean;
  /** Where that zone is, for its own band on its own rim. Its two halves
   *  switch independently of yours — two places, two cycles. */
  zonePlace: Place | null;
  zoneDaylight: boolean;
  zoneMoonlight: boolean;
  /** Whether each fifteen-minute step of a drag clicks, and whether it taps. */
  tickSound: boolean;
  tickHaptics: boolean;
  onOpen: (occ: Occurrence) => void;
  onCreate: (startMin: number, endMin: number) => void;
  /**
   * An existing event dragged to a new place on the face. Both deltas are
   * whole `STEP`s of minutes: equal for a move, one of them zero for a
   * resize. Applied to the event's own instants, not to the day — an
   * occurrence dragged past midnight belongs to the next day, which is what
   * dragging it there meant.
   */
  onAdjust: (occ: Occurrence, startDeltaMin: number, endDeltaMin: number) => void;
}

/** Minutes a bare click on the ring turns into. */
const CLICK_DURATION = 60;
/** Drag granularity. Matches what a fifteen-minute arc can actually show. */
const STEP = 15;
/** Width of an arc's invisible hit stroke: the painted arc plus a margin for
 *  the pointer. Also, halved, how far a round cap on one reaches past its own
 *  endpoint — which is what puts a grip outside the body. */
const HIT_WIDTH = DIAL.ARC_WIDTH + 16;
/** How far into an arc each end grip reaches, in user units. Deliberately
 *  mean: an overshooting grip costs whoever wanted to move the event, and on
 *  a short arc it would leave nothing to grab at all. */
const GRIP_REACH = 18;
/** Hit width of a grip. Narrower than the body's, because half of it is the
 *  cap's reach past the tip and that reach is inward too. */
const GRIP_WIDTH = DIAL.ARC_WIDTH + 8;

/**
 * White at `level` alpha, pre-composited against the black canvas. Opaque, so
 * overlapping strokes replace rather than accumulate.
 */
function grey(level: number): string {
  const v = Math.round(clamp(level, 0, 1) * 255);
  return `rgb(${v},${v},${v})`;
}

/**
 * Shortest signed distance from one ring position to another. Two positions
 * do not say which way round the circle the pointer went, so take the short
 * way: anything over twelve hours was a counter-clockwise drag, not a
 * twenty-hour one.
 *
 * A gesture accumulates these per pointer event rather than measuring from
 * where it started, which is what lets a drag pass the twelve-hour mark (and
 * midnight, more than once) without the delta flipping sign underneath it.
 */
function wrapDelta(from: number, to: number): number {
  const forward = (((to - from) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return forward <= MINUTES_PER_DAY / 2 ? forward : forward - MINUTES_PER_DAY;
}

/** The two ends of a drag-to-create, in the order the day has them. */
function resolveDrag(from: number, to: number): { start: number; end: number } {
  const span = wrapDelta(from, to);
  const start = span >= 0 ? from : from + span;
  const end = span >= 0 ? from + span : from;
  return { start: clamp(start, 0, MINUTES_PER_DAY - STEP), end: clamp(end, STEP, MINUTES_PER_DAY) };
}

/**
 * What a press on an arc took hold of: one of its two ends, all of it, or —
 * on a subscribed calendar's event — nothing that can be moved.
 */
type Grip = "start" | "end" | "whole" | "none";

interface Adjust {
  occ: Occurrence;
  grip: Grip;
  /** Ring position the pointer was last seen at, snapped. */
  at: number;
  /** How far the grip has travelled so far. Always a whole `STEP`. */
  delta: number;
}

/**
 * The minimum duration, as a limit on the grip's travel rather than on the
 * result. Clamping the delta is what makes the arc stop dead at fifteen
 * minutes and start following the pointer again the instant it turns back;
 * clamping the *end* instead banks the overshoot and the arc lags by however
 * far the pointer ran on. A step that changes no delta also makes no sound.
 */
function clampDelta({ occ, grip }: Adjust, delta: number): number {
  if (grip === "none") return 0;
  if (grip === "start") return Math.min(delta, occ.endMin - STEP - occ.startMin);
  if (grip === "end") return Math.max(delta, occ.startMin + STEP - occ.endMin);
  return delta;
}

/**
 * Where the arc is being dragged to, in minutes since midnight of the day on
 * screen. Out-of-range values are honest: a move that runs past midnight
 * draws past the top of the face and lands on the next day, which is what
 * dragging it there meant.
 */
function adjusted({ occ, grip, delta }: Adjust): { start: number; end: number } {
  if (grip === "whole") return { start: occ.startMin + delta, end: occ.endMin + delta };
  if (grip === "start") return { start: occ.startMin + delta, end: occ.endMin };
  if (grip === "end") return { start: occ.startMin, end: occ.endMin + delta };
  return { start: occ.startMin, end: occ.endMin };
}

export default function Dial({
  day,
  now,
  clock,
  occurrences,
  calendars,
  place,
  daylight,
  moonlight,
  secondZone,
  showZoneName,
  showZoneOffset,
  zonePlace,
  zoneDaylight,
  zoneMoonlight,
  tickSound,
  tickHaptics,
  onOpen,
  onCreate,
  onAdjust,
}: DialProps) {
  const [stageRef, width, height] = useElementSize<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [adjust, setAdjust] = useState<Adjust | null>(null);

  const u = Math.min(width, height) / VIEW_SIZE;
  const today = isSameDay(day, now);
  const nowMin = minutesOfDay(now);

  /** Calendars nobody here may edit: a subscription is a mirror. */
  const feedIds = useMemo(
    () => new Set(calendars.filter((c) => c.feed).map((c) => c.id)),
    [calendars],
  );

  /** How much of this day is spent: all of a past day, none of a future one. */
  const elapsed = today ? nowMin : startOfDay(day) < startOfDay(now) ? MINUTES_PER_DAY : 0;

  /** A band is drawn only while it has a half left to draw. */
  const band = place && (daylight || moonlight) ? place : null;
  const zoneBand = zonePlace && (zoneDaylight || zoneMoonlight) ? zonePlace : null;

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
   * The lightcycle band takes over this same radius when it is on, so there
   * is nothing to compute here then.
   */
  const elapsedSegments = useMemo(() => {
    if (band || elapsed <= 0) return [];
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
  }, [band, elapsed, clock]);

  const ghost = drag ? resolveDrag(drag.from, drag.to) : null;

  /* ------------------------------ pointer ------------------------------ */

  // The handlers live on a <circle> and on the arcs' <path>s, so
  // `ownerSVGElement` is always the root <svg>; the guard is only there
  // because the DOM types allow null.
  function pointIn(e: ReactPointerEvent<SVGGraphicsElement>): { x: number; y: number } | null {
    const ctm = e.currentTarget.ownerSVGElement?.getScreenCTM();
    if (!ctm) return null;
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  }

  function minutesAt(e: ReactPointerEvent<SVGGraphicsElement>): number | null {
    const point = pointIn(e);
    return point ? snap(minutesAtPoint(point.x, point.y, clock), STEP) : null;
  }

  /** Every fifteen-minute step a drag lands on, including the one it starts
   *  on — the grab is a detent too, and it is the user gesture that lets the
   *  audio context start at all. */
  function step(kind: Detent) {
    detent(kind, { sound: tickSound, haptics: tickHaptics });
  }

  function onRingDown(e: ReactPointerEvent<SVGCircleElement>) {
    if (e.button !== 0) return;
    const m = minutesAt(e);
    if (m === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: m, to: m });
    step("step");
  }

  function onRingMove(e: ReactPointerEvent<SVGCircleElement>) {
    if (!drag) return;
    const to = minutesAt(e);
    // Pointermove fires far more often than the ghost changes shape. Bailing
    // on an unchanged step is what makes the clicks countable, and it saves
    // the re-render the drag would otherwise do per event.
    if (to === null || to === drag.to) return;
    setDrag({ ...drag, to });
    step("step");
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

  /* ------------------------- dragging what exists ------------------------- */

  function onArcDown(occ: Occurrence, grip: Grip, e: ReactPointerEvent<SVGPathElement>) {
    if (e.button !== 0) return;
    const at = minutesAt(e);
    if (at === null) return;
    // The ring under the arc would otherwise start drawing a new event
    // through the one being grabbed.
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAdjust({ occ, grip, at, delta: 0 });
    // Nothing is going to move on somebody else's event, so nothing clicks.
    if (grip !== "none") step(grip === "whole" ? "slide" : "step");
  }

  function onArcMove(e: ReactPointerEvent<SVGPathElement>) {
    if (!adjust) return;
    const at = minutesAt(e);
    if (at === null || at === adjust.at) return;
    // Accumulated per event rather than measured from the grab, so the drag
    // survives passing the twelve-hour mark. Clamped rather than let run:
    // a delta that overshot the minimum duration would have to be unwound
    // before the arc started following the pointer back.
    const delta = clampDelta(adjust, adjust.delta + wrapDelta(adjust.at, at));
    const moved = delta !== adjust.delta;
    setAdjust({ ...adjust, at, delta });
    if (moved) step(adjust.grip === "whole" ? "slide" : "step");
  }

  function onArcUp() {
    if (!adjust) return;
    const { occ, grip, delta } = adjust;
    setAdjust(null);
    // A press that moved nothing is a click, and a click opens the event.
    // That covers a read-only arc, which can never move at all.
    if (delta === 0) {
      onOpen(occ);
      return;
    }
    onAdjust(occ, grip === "end" ? 0 : delta, grip === "start" ? 0 : delta);
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

        {band && (
          <SunBand
            day={day}
            clock={clock}
            place={band}
            daylight={daylight}
            moonlight={moonlight}
            radius={DIAL.TRACK}
          />
        )}
        {zoneBand && (
          <SunBand
            day={day}
            clock={clock}
            place={zoneBand}
            daylight={zoneDaylight}
            moonlight={zoneMoonlight}
            radius={DIAL.ZONE_BAND}
          />
        )}
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
            // Somebody else's calendar: it opens, it never moves.
            locked={feedIds.has(occ.event.calendarId)}
            range={adjust?.occ.key === occ.key ? adjusted(adjust) : null}
            onHover={setHovered}
            onGrab={onArcDown}
            onGrabMove={onArcMove}
            onGrabEnd={onArcUp}
            onGrabCancel={() => setAdjust(null)}
          />
        ))}

        {ghost && ghost.end > ghost.start && (
          <GhostArc clock={clock} start={ghost.start} end={ghost.end} />
        )}

        {today && (
          <NowHand minutes={nowMin} clock={clock} dimmed={drag !== null || adjust !== null} />
        )}
      </svg>

      <CenterPanel
        day={day}
        now={now}
        occurrences={occurrences}
        calendars={calendars}
        u={u}
        clock={clock}
        drag={ghost && ghost.end > ghost.start ? ghost : adjust ? adjusted(adjust) : null}
        hovered={hovered}
        onHover={setHovered}
        onOpen={onOpen}
      />
    </div>
  );
}

/* -------------------------------- pieces --------------------------------- */

/**
 * The lightcycle band: where the sun actually is on this day, at this place.
 *
 * The single feature the circle earns that a grid cannot — a rectangular
 * calendar can draw a sunrise line, but only a dial shows the *shape* of the
 * day's light, and that shape visibly turns through the year.
 *
 * Your own is drawn *on* the track, replacing the elapsed ring rather than
 * sitting outside it. Two rings a few units apart read as one line doubled by
 * mistake, and between "how much of the day is gone" and "where the light
 * is", the light is the one worth the rim. The second zone's gets a rim of
 * its own out at `ZONE_BAND`, beside the numerals it belongs to: it is a
 * different place's day, and the two phases beside each other is the point.
 *
 * Same construction as the ring it replaces, for the same reason: a chain of
 * *opaque* butt-capped arcs. Translucent segments compound their alpha at
 * every join and the band reads as a row of beads.
 */
function SunBand({
  day,
  clock,
  place,
  daylight,
  moonlight,
  radius,
}: {
  day: Date;
  clock: Clock;
  place: Place;
  daylight: boolean;
  moonlight: boolean;
  radius: number;
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
     *
     * It answers for the whole day whatever the two switches say: dropping a
     * half is a filter on the segments below, not a hole punched in the curve,
     * so the half that stays keeps the exact shape it had beside the other.
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
      if (value > 0 ? !daylight : !moonlight) return [];
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
          d: arcPath(radius, from, to),
          stroke: `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`,
        },
      ];
    });
  }, [day, clock, place, daylight, moonlight, radius]);

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

/**
 * One event, as an arc — and as three drag targets.
 *
 * The body moves the whole event; the two ends move one instant each. They
 * are separate hit paths rather than one path plus a hit test, because the
 * cursor has to say which is which *before* the press: on a dial there is no
 * edge to see, so the pointer is the only affordance the ends get.
 *
 * A grip is at most a third of the sweep, so a short event still has a middle
 * to grab, and an event too short to have ends at all (a dot) only moves.
 */
function EventArc({
  occ,
  clock,
  color,
  dimmed,
  hovered,
  locked,
  range,
  onHover,
  onGrab,
  onGrabMove,
  onGrabEnd,
  onGrabCancel,
}: {
  occ: Occurrence;
  clock: Clock;
  color: string;
  dimmed: boolean;
  hovered: boolean;
  /** From a subscription: draggable by nobody. */
  locked: boolean;
  /** Where the drag currently has it, or `null` when it is where it belongs. */
  range: { start: number; end: number } | null;
  onHover: (key: string | null) => void;
  onGrab: (occ: Occurrence, grip: Grip, e: ReactPointerEvent<SVGPathElement>) => void;
  onGrabMove: (e: ReactPointerEvent<SVGPathElement>) => void;
  onGrabEnd: () => void;
  onGrabCancel: () => void;
}) {
  if (occ.event.allDay) return null;

  const r = DIAL.LANE - occ.lane * DIAL.LANE_STEP;
  const width = DIAL.ARC_WIDTH;
  const inset = capInset(r);
  const from = angleAt(range ? range.start : occ.startMin, clock);
  const to = angleAt(range ? range.end : occ.endMin, clock);
  // Sub-cap-length events collapse to their own round cap: a dot on the ring
  // at the right minute, rather than an arc that lies about its duration.
  const dot = to - from <= inset * 2;
  const head = from + inset;
  const tail = to - inset;
  const d = dot ? arcPath(r, (from + to) / 2, (from + to) / 2 + 0.001) : arcPath(r, head, tail);

  /**
   * The grips own the *tips*, the body owns the middle — which is entirely a
   * question of which path's cap overhangs the endpoint.
   *
   * A round cap on a hit stroke reaches half its width past the point it is
   * centred on, so with a round-capped body and butt-capped grips the outermost
   * thing at each end of the arc was the *body*: the pointer said "move" on the
   * cap and "resize" only once you were inside it, which is backwards. So the
   * body is butt-capped, stopping dead at head and tail, and the grips are
   * round-capped, hanging out past the tip the way a handle should.
   *
   * How far they reach *inwards* is measured in user units rather than degrees,
   * because a grip has to feel the same size on the outer lane as on the inner
   * one — and it is deliberately mean. A grip that overshoots is only a nuisance
   * for whoever wanted to move the event, and on a short arc it is the whole
   * arc: hence the quarter-of-the-sweep ceiling, and hence the grip's own hit
   * width narrowing with it, since the cap alone would otherwise reach further
   * in than the ceiling allows.
   */
  const sweepLength = (((tail - head) * Math.PI) / 180) * r;
  const gripReach = Math.min(GRIP_REACH, sweepLength / 4);
  const gripWidth = Math.min(GRIP_WIDTH, gripReach * 2);
  // `0.001` because `arcPath` of a zero sweep draws nothing at all: on a short
  // arc the two caps are the entire handles.
  const gripDeg = Math.max(((gripReach - gripWidth / 2) / r) * (180 / Math.PI), 0.001);

  const zones: { grip: Grip; d: string; width: number; cursor: string }[] =
    locked || dot
      ? [
          {
            grip: locked ? "none" : "whole",
            d,
            width: HIT_WIDTH,
            cursor: locked ? "cursor-pointer" : "cursor-grab",
          },
        ]
      : [
          { grip: "whole", d, width: HIT_WIDTH, cursor: "cursor-grab" },
          {
            grip: "start",
            d: arcPath(r, head, head + gripDeg),
            width: gripWidth,
            cursor: "cursor-ew-resize",
          },
          {
            grip: "end",
            d: arcPath(r, tail - gripDeg, tail),
            width: gripWidth,
            cursor: "cursor-ew-resize",
          },
        ];

  return (
    <g onPointerEnter={() => onHover(occ.key)} onPointerLeave={() => onHover(null)}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={hovered || range ? width + 3 : width}
        strokeLinecap="round"
        opacity={dimmed && !hovered && !range ? 0.42 : 1}
        pointerEvents="none"
        style={{ transition: "stroke-width 140ms var(--ease), opacity 140ms var(--ease)" }}
      />
      {/* The ends are listed after the body, so where they overlap it they
          win the hit test — a stacking order, not a subtraction. */}
      {zones.map((zone) => (
        <path
          key={zone.grip}
          className={zone.cursor}
          d={zone.d}
          fill="none"
          stroke="transparent"
          strokeWidth={zone.width}
          // Butt for the body so it stops at the endpoints, round for the
          // grips so they are what the tip belongs to. Unless the body is all
          // there is — a dot, or somebody else's event — and then it has the
          // whole shape to cover.
          strokeLinecap={zone.grip === "whole" && zones.length > 1 ? "butt" : "round"}
          pointerEvents="stroke"
          onPointerDown={(e) => onGrab(occ, zone.grip, e)}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabEnd}
          onPointerCancel={onGrabCancel}
        />
      ))}
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
