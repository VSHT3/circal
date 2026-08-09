/* ------------------------------------------------------------------ *
 * The face: one day, as a revolution.
 *
 * Drawn outside-in — lightcycle band or elapsed-day ring → ticks → hour
 * numerals → event arcs → now-hand. The viewBox is fixed at 1000×1000 and
 * scaled to fit, so nothing here ever reads a pixel size.
 *
 * Every ring outside the arcs is opt-in and off by default: a bare <Face> is
 * the track and one day's arcs, which is the whole of the instrument at a
 * count where numerals would be a fringe. `Dial.tsx` switches all of them on.
 * The alternative to this split is a second copy of the arc-drawing code the
 * first time anything draws more than one day at a time, and this repo has no
 * duplicated conventions in it yet.
 *
 * The face knows nothing about how a day is *edited*. It reports a press on an
 * arc and a press on the ring; what those mean — a drag, a resize, a click
 * that opens the editor — belongs to whoever passed the handlers in, and a
 * face given no handlers has no hit targets at all.
 * ------------------------------------------------------------------ */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import {
  ARC_LABEL_SIZE,
  DIAL,
  VIEW_BOX,
  angleAt,
  arcLabel,
  arcPath,
  capInset,
  polar,
  seamTrim,
} from "@/lib/dial";
import { colorOf, inkOn, markOf, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import { MarkGlyph } from "@/components/react/ui/icons";
import { solarLight, sunTimes, type Place } from "@/lib/sun";
import {
  MINUTES_PER_DAY,
  clamp,
  formatOffset,
  isSameDay,
  minutesOfDay,
  startOfDay,
  zoneCity,
  zoneOffset,
  type Clock,
} from "@/lib/time";
import type { ArcLabelMode } from "@/lib/store";
import { EASE, MODE_MS, MOOD_MS } from "@/lib/motion";

/**
 * What a press on an arc took hold of: one of its two ends, all of it, or —
 * on a subscribed calendar's event — nothing that can be moved.
 */
export type Grip = "start" | "end" | "whole" | "none";

/** One place's lightcycle, as the two halves it is drawn in. */
export interface FaceBand {
  place: Place;
  daylight: boolean;
  moonlight: boolean;
}

/** The event about to exist, in minutes since this day's midnight. */
export interface FaceGhost {
  start: number;
  end: number;
  color: string;
  opacity: number;
  /** A draft that is a moment rather than a span. */
  task: boolean;
}

/**
 * Declared here rather than in `types.ts` for the reason `DialProps` and
 * `CenterPanelProps` are: that file holds the *panel* contracts, and this is
 * the instrument they are arranged around.
 */
export interface FaceProps {
  day: Date;
  now: Date;
  /** The day's agenda, already clipped and packed into lanes. An all-day
   *  occurrence draws nothing and may be left in. */
  occurrences: Occurrence[];
  calendars: Calendar[];
  clock: Clock;

  /* --- What this face carries besides its arcs. Every one off by default. --- */

  /** The soft disc behind the track. */
  glow?: boolean;
  /** Half-hour marks on the rim. */
  ticks?: boolean;
  /** The hours: all twenty-four, the four the face is navigated by, or none.
   *  `quarters` fades the other eight rather than unmounting them, so a mode
   *  change recedes; `none` is the reduced face and mounts nothing. */
  numerals?: "all" | "quarters" | "none";
  /** The ramp of light around the rim, up to the present. Drawn only where
   *  `band` has no half to draw — the two share the track, and a second ring
   *  beside it reads as one line accidentally doubled. */
  elapsed?: boolean;
  /** The now-hand. On today only, whatever this says. */
  hand?: boolean;
  /** Your own lightcycle, on the track. */
  band?: FaceBand | null;
  /** The second zone's lightcycle, on its own rim outside the track: a
   *  different place, so it does get a rim of its own. */
  zoneBand?: FaceBand | null;
  /** The second zone's four numerals and their caption. */
  zoneRing?: { zone: string; showName: boolean; showOffset: boolean } | null;

  /* ------------------------------- the arcs ------------------------------- */

  /** When an arc prints its name along itself. See `arcLabel`. */
  arcLabels?: ArcLabelMode;
  /** Whether an event with no mark of its own takes its calendar's. */
  inheritMarks?: boolean;
  hovered?: string | null;
  /** The event a drag has hold of, by event id: drawn thicker, and never
   *  dimmed for being in the past. */
  dragging?: string | null;
  ghost?: FaceGhost | null;
  /** A gesture is in flight, so the now-hand recedes: it marks a time nobody
   *  is reading, and at full white it competes with the range being drawn. */
  gesturing?: boolean;

  /* ----------------------------- the gestures ----------------------------- */

  /** The capture target and the frame every gesture's coordinates are read in.
   *  Held by the caller, because the caller is what reads them. */
  svgRef?: Ref<SVGSVGElement>;
  onHover?: (key: string | null) => void;
  onGrab?: (occ: Occurrence, grip: Grip, e: ReactPointerEvent<SVGPathElement>) => void;
  /** A press on the drag annulus. The annulus exists only when this does. */
  onRingDown?: (e: ReactPointerEvent<SVGCircleElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp?: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerCancel?: (e: ReactPointerEvent<SVGSVGElement>) => void;
}

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
 * The ambient hand's minute step. Longer than a pointer's beat, because it is
 * covering a quarter of a degree rather than 27 units and a move that short
 * has to be slow to read as a move at all — under about a third of a second
 * it is the snap it replaced with extra steps.
 */
const HAND_MS = 420;
/** An arc with nothing beside it on its lane: no seam to cut. Hoisted so it is
 *  one object rather than one per arc per render. */
const NO_NEIGHBOUR = { before: Infinity, after: Infinity } as const;

/** The beats, as the CSS shorthand the inline styles here reach for. */
const MOOD = `${MOOD_MS}ms var(--ease)`;
const MODE = `${MODE_MS}ms var(--ease)`;

/**
 * White at `level` alpha, pre-composited against the black canvas. Opaque, so
 * overlapping strokes replace rather than accumulate.
 */
function grey(level: number): string {
  const v = Math.round(clamp(level, 0, 1) * 255);
  return `rgb(${v},${v},${v})`;
}

/** An id safe to put behind a `#` in a `url(…)` or an `href`. */
function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
}

/**
 * A group that arrives and leaves by fading, for the pieces of the face a
 * mode or a switch adds and removes. Mounted through `AnimatePresence`, so
 * nothing is kept on the canvas for the sake of the transition — the nodes
 * exist while it runs and not a frame longer.
 */
function Fade({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.g
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : MODE_MS / 1000, ease: EASE }}
    >
      {children}
    </motion.g>
  );
}

export default function Face({
  day,
  now,
  occurrences,
  calendars,
  clock,
  glow = false,
  ticks = false,
  numerals = "none",
  elapsed = false,
  hand = false,
  band = null,
  zoneBand = null,
  zoneRing = null,
  arcLabels = "off",
  inheritMarks = false,
  hovered = null,
  dragging = null,
  ghost = null,
  gesturing = false,
  svgRef,
  onHover,
  onGrab,
  onRingDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: FaceProps) {
  const glowId = useSvgId("face-glow");
  const today = isSameDay(day, now);
  const nowMin = minutesOfDay(now);

  /** How much of this day is spent: all of a past day, none of a future one. */
  const spent = today ? nowMin : startOfDay(day) < startOfDay(now) ? MINUTES_PER_DAY : 0;

  /** Calendars nobody here may edit: a subscription is a mirror. */
  const feedIds = useMemo(
    () => new Set(calendars.filter((c) => c.feed).map((c) => c.id)),
    [calendars],
  );

  /** Whether the band has taken the track. Depended on as a boolean rather
   *  than as the spec: a caller resolving that spec inline hands down a new
   *  object every render, and the ring below would rebuild 180 paths on every
   *  frame of a drag for a fact that changed on neither. */
  const banded = band !== null;

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
    if (!elapsed || banded || spent <= 0) return [];
    const from = angleAt(0, clock);
    const to = from + (spent / MINUTES_PER_DAY) * 360;
    const count = clamp(Math.round(spent / 8), 2, 180);
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
  }, [elapsed, banded, spent, clock]);

  /**
   * Each arc's clearance from its neighbours on the same lane, in minutes.
   *
   * `packLanes` puts two events that merely touch on one ring, which is right —
   * they do not overlap — but their round caps then land on the same instant
   * and weld into one bent line (see `seamTrim`). The gap is measured here,
   * once per agenda, because it is a fact about the pair rather than about
   * either arc: only the lane they share decides whether they can touch at all.
   */
  const gaps = useMemo(() => {
    const timed = occurrences.filter((o) => !o.event.allDay);
    return new Map(
      timed.map((occ) => {
        let before = Infinity;
        let after = Infinity;
        for (const other of timed) {
          if (other === occ || other.lane !== occ.lane) continue;
          if (other.endMin <= occ.startMin) before = Math.min(before, occ.startMin - other.endMin);
          if (other.startMin >= occ.endMin) after = Math.min(after, other.startMin - occ.endMin);
        }
        return [occ.key, { before, after }] as const;
      }),
    );
  }, [occurrences]);

  return (
    <svg
      ref={svgRef}
      viewBox={VIEW_BOX}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full touch-none select-none"
      role="presentation"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {glow && (
        <>
          <defs>
            <radialGradient id={glowId}>
              <stop offset="0%" stopColor="#fff" stopOpacity="0.05" />
              <stop offset="52%" stopColor="#fff" stopOpacity="0.014" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx={DIAL.C} cy={DIAL.C} r={DIAL.TRACK} fill={`url(#${glowId})`} />
        </>
      )}

      <AnimatePresence initial={false}>
        {band && (
          <Fade key="band">
            <SunBand
              day={day}
              clock={clock}
              place={band.place}
              daylight={band.daylight}
              moonlight={band.moonlight}
              radius={DIAL.TRACK}
            />
          </Fade>
        )}
        {/* The trail and the band share the track, so one leaving is the
            other arriving — and switched between by a mode or a switch, a
            cut on the rim reads as the dial redrawing itself. */}
        {elapsedSegments.length > 0 && (
          <Fade key="elapsed">
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
          </Fade>
        )}
        {zoneBand && (
          <Fade key="zone-band">
            <SunBand
              day={day}
              clock={clock}
              place={zoneBand.place}
              daylight={zoneBand.daylight}
              moonlight={zoneBand.moonlight}
              radius={DIAL.ZONE_BAND}
            />
          </Fade>
        )}
        {zoneRing && (
          <Fade key="zone-ring">
            <ZoneRing
              now={now}
              clock={clock}
              zone={zoneRing.zone}
              showName={zoneRing.showName}
              showOffset={zoneRing.showOffset}
            />
          </Fade>
        )}
      </AnimatePresence>

      {ticks && <Ticks clock={clock} />}
      {numerals !== "none" && <HourLabels clock={clock} quartersOnly={numerals === "quarters"} />}

      {/* Drag target. An annulus, so the agenda in the middle stays clickable
          and the corners of the window do not create events. */}
      {onRingDown && (
        <circle
          cx={DIAL.C}
          cy={DIAL.C}
          r={(DIAL.TRACK + DIAL.DRAG_INNER) / 2}
          fill="none"
          stroke="transparent"
          strokeWidth={DIAL.TRACK - DIAL.DRAG_INNER}
          className="[pointer-events:stroke] cursor-crosshair"
          onPointerDown={onRingDown}
        />
      )}

      {occurrences.map((occ) => (
        <EventArc
          key={occ.key}
          occ={occ}
          clock={clock}
          labels={arcLabels}
          color={colorOf(occ.event, calendars)}
          mark={markOf(occ.event, calendars, inheritMarks)}
          dimmed={today && statusOf(occ, now) === "past"}
          hovered={hovered === occ.key}
          // Somebody else's calendar: it opens, it never moves.
          locked={feedIds.has(occ.event.calendarId)}
          dragging={dragging === occ.event.id}
          gap={gaps.get(occ.key) ?? NO_NEIGHBOUR}
          onHover={onHover}
          onGrab={onGrab}
        />
      ))}

      {ghost && (ghost.task || ghost.end > ghost.start) && (
        <GhostArc
          clock={clock}
          start={ghost.start}
          end={ghost.end}
          color={ghost.color}
          opacity={ghost.opacity}
          task={ghost.task}
        />
      )}

      {hand && today && (
        // Keyed on the face: relabelling is a 180° jump, and a hand sweeping
        // half the dial while the numerals under it teleport is two events.
        <NowHand key={clock} minutes={nowMin} clock={clock} dimmed={gesturing} />
      )}
    </svg>
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
  const reducedMotion = useReducedMotion();
  const halves = useMemo(() => {
    const sun = sunTimes(day, place);

    // Five minutes a segment. At this radius that is an eight-unit chord, and
    // the step between neighbouring shades stops being something you can see.
    const COUNT = 288;
    const step = MINUTES_PER_DAY / COUNT;

    const lit: { d: string; stroke: string }[][] = [[], []];
    const has: boolean[][] = [Array(COUNT).fill(false), Array(COUNT).fill(false)];
    for (let i = 0; i < COUNT; i += 1) {
      const value = solarLight(sun, (i + 0.5) * step);
      if (Math.abs(value) <= 0.004) continue;
      const from = angleAt(i * step, clock);
      // Overlap the neighbour: an exact butt-to-butt join leaves an
      // antialiasing seam, which is the same artefact one shade darker.
      const to = angleAt((i + 1) * step, clock) + 0.3;
      // Both pre-composited against black. Warm but desaturated for day, and a
      // dim violet for night — saturated colour on this canvas belongs to
      // events, and neither band may compete with an arc.
      const [r, g, b] = value > 0 ? [255, 198, 124] : [150, 132, 255];
      const k = Math.abs(value);
      const half = value > 0 ? 0 : 1;
      has[half][i] = true;
      lit[half].push({
        d: arcPath(radius, from, to),
        stroke: `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`,
      });
    }

    /**
     * The arc a half's mask sweeps: where that half *begins*, and how far it
     * runs from there.
     *
     * Not the whole revolution from midnight. Night starts at dusk and ends at
     * dawn the other side of midnight, so a mask that began at midnight began
     * in the middle of it — the band grew out of its own centre in two pieces,
     * which is not how a night arrives.
     *
     * Each half is one contiguous run: `solarLight` is positive from dawn to
     * dusk and negative the rest of the way round. The run's start is the lit
     * slot whose predecessor is dark, and its length is however far forward
     * the last lit slot is. Polar day and polar night fill every slot and get
     * the whole turn.
     */
    const sweeps = has.map((slots) => {
      const start = slots.findIndex((on, i) => on && !slots[(i - 1 + COUNT) % COUNT]);
      if (start < 0) return { from: angleAt(0, clock), degrees: 360 };
      let span = COUNT;
      while (span > 0 && !slots[(start + span - 1) % COUNT]) span -= 1;
      return { from: angleAt(start * step, clock), degrees: (span / COUNT) * 360 };
    });

    return lit.map((segments, half) => ({ segments, ...sweeps[half] }));
  }, [day, clock, place, radius]);

  // Each half is masked by a stroke of its own that draws itself along the
  // face, from that half's own first minute and in the direction the day runs.
  // A band is a thing that happens *over* a day, so it arrives over one —
  // appearing whole was the one piece of the rim that still just turned up.
  //
  // One animated element per half rather than 144: `pathLength` normalises
  // the mask's own arc to 1, so a single number sweeps it. `motion` handles
  // the dash arithmetic behind that prop.
  //
  // A half that is the same either side of a mode change never animates,
  // because nothing about it changed — the curve is computed for the whole
  // day whatever the switches say, so the half that stays keeps the exact
  // shape it had beside the other.
  const maskId = useSvgId("band-mask");
  return (
    <g pointerEvents="none" shapeRendering="geometricPrecision">
      <defs>
        {[daylight, moonlight].map((on, half) => (
          <mask key={half} id={`${maskId}-${half}`} maskUnits="userSpaceOnUse">
            <motion.path
              d={arcPath(radius, halves[half].from, halves[half].from + halves[half].degrees)}
              fill="none"
              stroke="#fff"
              // Wider than the band, so the mask's own antialiased edges never
              // shave the stroke it is revealing.
              strokeWidth={DIAL.TRACK_WIDTH + 4}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: on ? 1 : 0 }}
              transition={{ duration: reducedMotion ? 0 : MODE_MS / 1000, ease: EASE }}
            />
          </mask>
        ))}
      </defs>
      {[daylight, moonlight].map((_, half) => (
        <g key={half} mask={`url(#${maskId}-${half})`}>
          {halves[half].segments.map((segment, i) => (
            <path
              key={i}
              d={segment.d}
              fill="none"
              stroke={segment.stroke}
              strokeWidth={DIAL.TRACK_WIDTH}
              // Butt everywhere: the band fades to black at both ends rather
              // than stopping, so a round cap would only add a bead where
              // there is nothing left to round off.
              strokeLinecap="butt"
            />
          ))}
        </g>
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

/**
 * The hours, on the ring just inside the ticks.
 *
 * `quartersOnly` keeps the four the face is navigated by and drops the eight
 * between them: twelve 19-unit numerals is interaction-distance type, and from
 * a chair it reads as a grey fringe rather than as a scale. The ticks are
 * still there, so nothing about the geometry is lost — only the labelling of
 * hours nobody is squinting at.
 *
 * Dropped by opacity rather than by unmounting, so the eight recede instead of
 * blinking out. Eight `<text>` nodes at zero alpha is what a fade costs here,
 * and they are the same eight that are mounted the rest of the time.
 */
function HourLabels({ clock, quartersOnly = false }: { clock: Clock; quartersOnly?: boolean }) {
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
              opacity={quartersOnly ? 0 : 1}
              aria-hidden={quartersOnly}
              style={{ transition: `opacity ${MODE}` }}
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
 * A lane's radius, eased rather than stepped.
 *
 * Lanes repack live while an arc is dragged past another, so an event that has
 * to give up the outer ring moves 27 units inwards between one pointer event
 * and the next — and a shape that teleports reads as a redraw rather than as
 * something making room. The drag's own angular steps stay instant: those are
 * the fifteen-minute detents, and they are meant to be felt.
 *
 * The eased value is React state, not a motion value on the attribute, because
 * the whole path is rebuilt from the radius — `capInset` has to follow it, or
 * an arc mid-move lies about its length.
 */
function useEasedRadius(target: number): number {
  const reducedMotion = useReducedMotion();
  const [eased, setEased] = useState(target);
  const at = useRef(target);

  useEffect(() => {
    if (reducedMotion || at.current === target) return;
    const run = animate(at.current, target, {
      duration: MOOD_MS / 1000,
      ease: EASE,
      onUpdate: (r) => {
        at.current = r;
        setEased(r);
      },
    });
    return () => run.stop();
  }, [target, reducedMotion]);

  return reducedMotion ? target : eased;
}

/**
 * The now-hand's angle, eased rather than stepped.
 *
 * Same shape as `useEasedRadius` and for the same reason: the geometry is
 * rebuilt from the value, so it has to be a number this render rather than a
 * motion value on an attribute.
 *
 * On both faces, not only in ambient. A quarter of a degree is two pixels at
 * a working size and thirty times that filling a window, but a clock whose
 * hand steps is a clock that redraws — the difference is only how obvious it
 * is. Switching the face is the one jump left, and it is a jump on purpose:
 * `NowHand` is keyed on the clock, so the 180° relabel remounts it rather
 * than sweeping a hand across a dial that teleported around it.
 */
function useEasedAngle(target: number): number {
  const reducedMotion = useReducedMotion();
  const [eased, setEased] = useState(target);
  const at = useRef(target);

  useEffect(() => {
    if (reducedMotion || at.current === target) return;
    const run = animate(at.current, target, {
      duration: HAND_MS / 1000,
      ease: EASE,
      onUpdate: (a) => {
        at.current = a;
        setEased(a);
      },
    });
    return () => run.stop();
  }, [target, reducedMotion]);

  return reducedMotion ? target : eased;
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
 *
 * `onGrab` and `onHover` are both optional, and a face given neither draws no
 * hit strokes at all — which is the whole of a read-only face.
 */
function EventArc({
  occ,
  clock,
  labels,
  color,
  mark,
  dimmed,
  hovered,
  locked,
  dragging,
  gap,
  onHover,
  onGrab,
}: {
  occ: Occurrence;
  clock: Clock;
  /** When this arc prints its name along itself. See `arcLabel`. */
  labels: ArcLabelMode;
  color: string;
  /** The event's glyph, already resolved through `markOf` — its own, its
   *  calendar's if inheritance is on, else `""`. Rides before the name when
   *  the sweep can hold both. */
  mark: string;
  dimmed: boolean;
  hovered: boolean;
  /** From a subscription: draggable by nobody. */
  locked: boolean;
  /** Held by a drag: thicker, and never dimmed for being in the past. Where the
   *  drag has *put* it is already in `occ` — see `onPreview` in `DialProps`. */
  dragging: boolean;
  /** Minutes of clear air before and after, to the nearest arc on this lane.
   *  `Infinity` when there is none — see `seamTrim`. */
  gap: { before: number; after: number };
  onHover?: (key: string | null) => void;
  onGrab?: (occ: Occurrence, grip: Grip, e: ReactPointerEvent<SVGPathElement>) => void;
}) {
  // Before the early return, so the hook order does not depend on the event: an
  // all-day occurrence draws nothing, but it still owns this component.
  const r = useEasedRadius(DIAL.LANE - occ.lane * DIAL.LANE_STEP);
  // `<textPath>` takes a reference, not a path, so the label's own path needs
  // an id. Not `occ.key`: a feed's occurrence carries its UID, and a UID is
  // any text at all — including the `#` that would break the reference.
  const labelId = useSvgId("arc-label");
  if (occ.event.allDay) return null;

  const width = DIAL.ARC_WIDTH;
  const inset = capInset(r);
  const from = angleAt(occ.startMin, clock);
  const to = angleAt(occ.endMin, clock);
  // Sub-cap-length events collapse to their own round cap: a dot on the ring
  // at the right minute, rather than an arc that lies about its duration.
  const dot = to - from <= inset * 2;
  // A whole revolution closes instead: the inset that keeps a short arc honest
  // would leave a notch at midnight once the two ends meet.
  const closed = to - from >= 360;
  // Half a seam off each end that has a neighbour hard against it, so two
  // back-to-back events are two lozenges rather than one dented line. Not on a
  // dot: it is already shorter than the event it stands for.
  //
  // The two spans are the *paint's* ends and the *centre line's*: a round cap
  // puts half a stroke back past `head` and `tail`, which is exactly what
  // `inset` took off, so what an event actually covers is its own span less
  // whatever a neighbour's seam claimed.
  const paintFrom = closed || dot ? from : from + seamTrim(r, gap.before);
  const paintTo = closed || dot ? to : to - seamTrim(r, gap.after);
  const head = closed ? from : paintFrom + inset;
  const tail = closed ? to : paintTo - inset;
  const d = dot ? arcPath(r, (from + to) / 2, (from + to) / 2 + 0.001) : arcPath(r, head, tail);
  /** Where a task's pip sits: the same point the dot path is centred on. */
  const taskPoint = polar(r, (from + to) / 2);

  // A label lives *inside* the stroke, so it costs no radius and reads the
  // same on every lane. It is mounted whenever the sweep can hold one and
  // hidden by opacity, because in `hover` mode it arrives at the same instant
  // the stroke grows by 3 — and text popping in on a growing arc reads as a
  // wobble where the crossfade should be.
  //
  // `off` is the same bargain one step further out: ambient has its own mode
  // and switching into it would otherwise blink every name on the face out at
  // once. Off is now a state of the label rather than its absence.
  const label = dot ? null : arcLabel(r, paintFrom, paintTo, occ.event.title, mark);
  const labelShown = labels === "always" || (labels === "hover" && (hovered || dragging));

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
    <g
      onPointerEnter={onHover && (() => onHover(occ.key))}
      onPointerLeave={onHover && (() => onHover(null))}
    >
      {occ.event.task ? (
        // A task is a notch in the rim, and its two states are the face's own
        // vocabulary: ink is light, so an open one is a filled pip and a done
        // one is that pip emptied out — the favicon's two shapes, at 14 units.
        // Not a tick: at this size a glyph is a smudge, and the pip already
        // has a state to be in.
        <circle
          cx={taskPoint.x}
          cy={taskPoint.y}
          r={(hovered || dragging ? width + 3 : width) / 2 - (occ.done ? 1.6 : 0)}
          fill={occ.done ? "none" : color}
          stroke={occ.done ? color : "none"}
          strokeWidth={3.2}
          opacity={occ.done ? 0.7 : dimmed && !hovered && !dragging ? 0.42 : 1}
          pointerEvents="none"
          style={{ transition: `r ${MOOD}, opacity ${MOOD}` }}
        />
      ) : (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={hovered || dragging ? width + 3 : width}
          strokeLinecap="round"
          opacity={dimmed && !hovered && !dragging ? 0.42 : 1}
          pointerEvents="none"
          style={{ transition: `stroke-width ${MOOD}, opacity ${MOOD}` }}
        />
      )}
      {label && (
        <g
          // One opacity for the name and the glyph before it: they are one
          // label, and fading them separately would read as two.
          opacity={labelShown ? 1 : 0}
          aria-hidden={!labelShown}
          pointerEvents="none"
          style={{ transition: `opacity ${MOOD}` }}
        >
          <defs>
            <path id={labelId} d={label.d} />
          </defs>
          {label.mark && (
            <g
              transform={`translate(${label.mark.x} ${label.mark.y}) rotate(${label.mark.rotate})`}
            >
              <MarkGlyph icon={mark} color={inkOn(color)} size={label.mark.size} />
            </g>
          )}
          <text
            className="font-mono"
            fill={inkOn(color)}
            fontSize={ARC_LABEL_SIZE}
            fontWeight={600}
            letterSpacing="0.01em"
            dominantBaseline="central"
            // Full alpha even on a past arc. The ink is the *absence* of
            // light, so dimming it with the body would take both towards the
            // black behind them and the label would vanish at 1.5:1; left
            // alone it softens from about 10:1 to 4.8:1 as the arc under it
            // recedes, which is the hierarchy the dimming was asking for.
          >
            <textPath
              href={`#${labelId}`}
              startOffset={`${label.startOffset}%`}
              textAnchor="middle"
            >
              {label.text}
            </textPath>
          </text>
        </g>
      )}
      {/* The ends are listed after the body, so where they overlap it they
          win the hit test — a stacking order, not a subtraction. */}
      {onGrab &&
        zones.map((zone) => (
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
          />
        ))}
    </g>
  );
}

/**
 * The event about to exist, on the outermost lane: the range under the pointer,
 * or the draft in the open editor once the pointer has let go.
 *
 * White and translucent while it is being drawn — there is no colour to show
 * yet — and the draft's own colour, opaque, once the editor has one. The shape
 * is identical either way, which is what stops the release and the save from
 * each looking like the drawing having been thrown away.
 *
 * A whole revolution is a closed ring rather than an arc: the cap inset that
 * makes a short arc tell the truth about its length leaves a gap at midnight
 * once the two ends meet, and a circle drawn with a notch in it reads as a
 * rendering fault rather than as a day.
 */
function GhostArc({
  clock,
  start,
  end,
  color,
  opacity,
  task,
}: {
  clock: Clock;
  start: number;
  end: number;
  color: string;
  opacity: number;
  /** A draft that is a moment rather than a span. */
  task: boolean;
}) {
  const stroke = {
    fill: "none",
    stroke: color,
    strokeOpacity: opacity,
    strokeWidth: DIAL.ARC_WIDTH,
    pointerEvents: "none",
  } as const;

  // A task is a moment, so its ghost is the pip it is about to become rather
  // than an arc of no length — without this, flipping the editor's Task switch
  // makes the draft disappear off the face, which reads as the drawing having
  // been thrown away. The one shape a `GhostArc` draws that is not an arc.
  if (task) {
    const at = polar(DIAL.LANE, angleAt(start, clock));
    return (
      <circle
        cx={at.x}
        cy={at.y}
        r={DIAL.ARC_WIDTH / 2}
        fill={color}
        fillOpacity={opacity}
        pointerEvents="none"
      />
    );
  }

  if (end - start >= MINUTES_PER_DAY) {
    return <circle cx={DIAL.C} cy={DIAL.C} r={DIAL.LANE} {...stroke} />;
  }

  const inset = capInset(DIAL.LANE);
  const from = angleAt(start, clock) + inset;
  const to = Math.max(from, angleAt(end, clock) - inset);
  return <path d={arcPath(DIAL.LANE, from, to)} strokeLinecap="round" {...stroke} />;
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
 *
 * The minute step is glided rather than jumped — see `useEasedAngle`.
 */
function NowHand({ minutes, clock, dimmed }: { minutes: number; clock: Clock; dimmed: boolean }) {
  // Eased into new geometry rather than rotated into place. A CSS rotation
  // would be cheaper, but it needs a transform origin, and `transform-box`
  // resolves percentages against a box whose own origin is the cropped
  // viewBox's — 30 units off centre, which is a hand that no longer points at
  // the middle of its own dial. The angle is a number here, so there is
  // nothing to resolve: `polar` puts it where it has always gone.
  const deg = useEasedAngle(angleAt(minutes, clock));
  const gradientId = useSvgId("now-hand");
  const head = polar(DIAL.TRACK, deg);
  const inner = polar(DIAL.HAND_INNER, deg);
  return (
    <g pointerEvents="none" opacity={dimmed ? 0.22 : 1} style={{ transition: `opacity ${MOOD}` }}>
      <defs>
        {/* Along the spoke, not across it: solid at the rim, gone by the
            inner end, so the hand has no hard tail to notice. */}
        <linearGradient
          id={gradientId}
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
        stroke={`url(#${gradientId})`}
        strokeWidth={DIAL.HAND_WIDTH}
        strokeLinecap="round"
      />
      <circle cx={head.x} cy={head.y} r={DIAL.HAND_PIP} fill="#fff" />
    </g>
  );
}
