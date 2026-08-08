/* ------------------------------------------------------------------ *
 * The instrument.
 *
 * One SVG, drawn outside-in: elapsed-day ring → ticks → hour numerals →
 * event arcs → now-hand, with the readout and agenda pinned over the middle
 * as HTML (see `CenterPanel`). The viewBox is fixed at 1000×1000 and scaled
 * to fit, so nothing here ever reads a pixel size except the overlay.
 * ------------------------------------------------------------------ */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import {
  ARC_LABEL_SIZE,
  DIAL,
  VIEW_BOX,
  VIEW_SIZE,
  angleAt,
  arcLabel,
  arcPath,
  capInset,
  minutesAtPoint,
  polar,
  seamTrim,
} from "@/lib/dial";
import { colorOf, inkOn, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import { cue, type Cue } from "@/lib/feedback";
import { ambientLevel, solarLight, sunTimes, type Place } from "@/lib/sun";
import {
  MINUTES_PER_DAY,
  addDays,
  clamp,
  daysBetween,
  formatOffset,
  isSameDay,
  minutesOfDay,
  snap,
  startOfDay,
  zoneCity,
  zoneOffset,
  type Clock,
} from "@/lib/time";
import type { ArcLabelMode, Settings } from "@/lib/store";
import { EASE, MODE_MS, MOOD_MS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useElementSize, useHotkeys } from "./hooks";
import CenterPanel from "./CenterPanel";

/**
 * A drag in flight, as the event it will commit. The shell folds it into the
 * day's agenda for as long as it lasts, which is what makes a drag a preview
 * of its own result: lanes repack around the arc, an event dragged into the
 * day is clipped to it, and the readout beside it reads the same as it will
 * once the pointer is let go.
 */
export interface DragPreview {
  id: string;
  /** Epoch ms, `end` exclusive — `CalEvent`'s own units. */
  start: number;
  end: number;
}

export interface DialProps {
  day: Date;
  now: Date;
  occurrences: Occurrence[];
  calendars: Calendar[];
  /**
   * The whole settings object rather than one prop per field. The dial reads
   * fourteen of them and forwarded every one through this interface, `App.tsx`
   * and its own destructure — three places to touch for a single switch.
   */
  settings: Settings;
  /**
   * Where the second zone is, for its own band on its own rim — derived by the
   * shell from `settings.secondZone`, so it is not a setting itself. Its two
   * halves switch independently of yours: two places, two cycles.
   */
  zonePlace: Place | null;
  /**
   * The event the open editor is about to create, or `null`. The ghost that
   * outlives the drag: drawn where the arc will be, in the colour the editor
   * currently carries, so the range does not vanish the moment the modal
   * arrives and the picture does not change again on save.
   *
   * Instants rather than minutes, because a draft can sit on another day
   * entirely once its date row has been edited — clipping it to this face is
   * this component's question and nobody else's.
   */
  pending: { start: number; end: number; allDay: boolean; color: string } | null;
  /**
   * Ambient: the chrome is gone and the face is the whole window, so the dial
   * stops being a surface you work on and becomes one you glance at from
   * across a room. It changes what is drawn, never how it is drawn — four
   * numerals instead of twelve, no names along the arcs, the centre reading
   * at a distance, and the whole face riding the lightcycle's own brightness.
   * Every gesture still works.
   */
  ambient: boolean;
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
  /**
   * The drag in flight, per fifteen-minute step, and `null` the moment it ends.
   * The dial does not draw from it: it hands it up so that the agenda it is
   * handed back already has it in.
   */
  onPreview: (preview: DragPreview | null) => void;
  /**
   * Move the view by whole days. The dial asks for this itself while a drag
   * carries an event off the day on screen: an arc you are still holding has
   * to stay drawn, and the day it has landed on is the one to be looking at.
   */
  onStepDay: (delta: number) => void;
}

/** Minutes a bare click on the ring turns into. */
const CLICK_DURATION = 60;
/** Drag granularity. Matches what a fifteen-minute arc can actually show. */
const STEP = 15;
/**
 * The deeper notch. Every fourth `STEP` lands on a whole hour and sounds
 * different, so a drag can be counted by ear: four clicks and a knock is an
 * hour, which is the affordance a physical dial has and the reason it can be
 * turned without being watched.
 */
const HOUR = 60;
/** How translucent a range still under the pointer is. It has no colour to
 *  show yet, so it is the one thing on the face drawn in plain white. */
const GHOST_ALPHA = 0.45;
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

/**
 * White at `level` alpha, pre-composited against the black canvas. Opaque, so
 * overlapping strokes replace rather than accumulate.
 */
function grey(level: number): string {
  const v = Math.round(clamp(level, 0, 1) * 255);
  return `rgb(${v},${v},${v})`;
}

/** The beats, as the CSS shorthand the inline styles here reach for. */
const MOOD = `${MOOD_MS}ms var(--ease)`;
const MODE = `${MODE_MS}ms var(--ease)`;

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

/**
 * A drag-to-create in progress: where it was grabbed, where the pointer was
 * last seen, and how far round the face it has swept since.
 *
 * The sweep is *accumulated* per pointer event, exactly as an arc's drag is,
 * and for the same reason: two ring positions do not say which way round the
 * circle the pointer went, so a range measured from the grab can never be
 * longer than twelve hours — past that, `wrapDelta` takes the short way and
 * the range turns inside out under the pointer. Summing short hops instead
 * lets a drag run the whole revolution.
 */
interface Draw {
  /** Where the press landed, snapped. */
  from: number;
  /** Ring position the pointer was last seen at, snapped. */
  at: number;
  /** Signed minutes swept since the grab: clockwise positive. */
  sweep: number;
}

/** The two ends of a drag-to-create, in the order the day has them. */
function resolveDraw({ from, sweep }: Draw): { start: number; end: number } {
  return { start: sweep >= 0 ? from : from + sweep, end: sweep >= 0 ? from + sweep : from };
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
  /**
   * Whether the pointer has crossed a step since the grab — which is not the
   * same question as whether the delta changed.
   *
   * A grip held against the minimum duration reports a delta of zero however
   * far the pointer runs (see `clampDelta`), and a release with no delta used
   * to be read as a click and open the editor. So: dragging an event that
   * could not get any shorter opened it instead, which is the one thing a
   * drag must never do.
   */
  moved: boolean;
  /**
   * How many days the *view* has moved on this gesture's account, so that
   * abandoning the gesture can give them back. Nothing is measured from it:
   * the arcs come from the day's own agenda, with the drag folded in.
   */
  shift: number;
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

/** The two deltas the grip applies: an end each for a resize, both for a move. */
function deltas({ grip, delta }: Adjust): { start: number; end: number } {
  return { start: grip === "end" ? 0 : delta, end: grip === "start" ? 0 : delta };
}

/**
 * The instant the grip is sitting on: the end being dragged, or the start of an
 * event being moved whole. This is what the detent is measured against, because
 * a notch is a position on the ring and not a distance travelled — an event
 * whose edge sits at 9:07 crosses no hour marks, and saying so is honest.
 *
 * It runs outside the day when a drag has crossed midnight, which the hour test
 * survives: 1440 and −60 are both on the hour.
 */
function gripMinute({ occ, grip, delta }: Adjust): number {
  return (grip === "end" ? occ.endMin : occ.startMin) + delta;
}

/**
 * The event as the release will commit it. The deltas apply to the event's own
 * instants, which is why a recurring event moves as a series.
 */
function draggedEvent(adjust: Adjust): DragPreview {
  const { event } = adjust.occ;
  const { start, end } = deltas(adjust);
  return { id: event.id, start: event.start + start * 60_000, end: event.end + end * 60_000 };
}

/**
 * Where the drag has put *this* occurrence, as instants. The day on screen and
 * the readout are measured against these rather than against the visible ends,
 * which are the day's clipping of them and not the event's own times.
 */
function draggedOccurrence(adjust: Adjust): { start: number; end: number } {
  const { start, end } = deltas(adjust);
  return {
    start: adjust.occ.start.getTime() + start * 60_000,
    end: adjust.occ.end.getTime() + end * 60_000,
  };
}

/**
 * How far the view has to move for the arc being dragged to still be drawn:
 * nothing at all while the event overlaps the day on screen, otherwise the
 * distance to the day its start has landed on.
 *
 * Which is the rule that makes a drag through midnight switch the day, and
 * makes it switch *then* rather than earlier: while the event straddles, its
 * head genuinely belongs to the day on screen and the clipped arc says so.
 */
function dayFollow(adjust: Adjust, day: Date): number {
  const { start, end } = draggedOccurrence(adjust);
  const from = startOfDay(day);
  if (start < addDays(from, 1).getTime() && end > from.getTime()) return 0;
  return daysBetween(from, new Date(start));
}

/** The dragged occurrence in minutes since the displayed midnight — the
 *  readout's units, and out of range whenever the event spans midnight. */
function dragSpan(adjust: Adjust, day: Date): { start: number; end: number } {
  const base = startOfDay(day).getTime();
  const { start, end } = draggedOccurrence(adjust);
  return { start: (start - base) / 60_000, end: (end - base) / 60_000 };
}

export default function Dial({
  day,
  now,
  occurrences,
  calendars,
  settings,
  zonePlace,
  pending,
  ambient,
  onOpen,
  onCreate,
  onAdjust,
  onPreview,
  onStepDay,
}: DialProps) {
  const {
    clock,
    place,
    daylight,
    moonlight,
    secondZone,
    showZoneName,
    showZoneOffset,
    zoneDaylight,
    zoneMoonlight,
    arcLabels,
    ambientDim,
    ambientDaylight,
    ambientMoonlight,
    ambientZoneRing,
    ambientArcLabels,
    totals,
    totalsAt,
    tickSound,
    tickHaptics,
  } = settings;
  const [stageRef, width, height] = useElementSize<HTMLDivElement>();
  /** Every gesture's capture target, and the frame its coordinates are read
   *  in. See `capture`. */
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [draw, setDraw] = useState<Draw | null>(null);
  const [adjust, setAdjust] = useState<Adjust | null>(null);

  const u = Math.min(width, height) / VIEW_SIZE;
  const today = isSameDay(day, now);
  const nowMin = minutesOfDay(now);

  /**
   * The face's own brightness. Full while the sun is up where you are, down
   * to a little over half in the middle of the night — a desk clock at full
   * white in a dark room is a lamp, and the one thing this mode must not be.
   *
   * One opacity on the whole instrument rather than a second set of colours:
   * over true black, opacity *is* luminance, and it costs a composite rather
   * than a repaint of nine hundred paths. Recomputed once a minute, and
   * transitioned over a second so no step of it is ever a step.
   */
  const level = ambient && ambientDim ? ambientLevel(now, place) : 1;

  /** Calendars nobody here may edit: a subscription is a mirror. */
  const feedIds = useMemo(
    () => new Set(calendars.filter((c) => c.feed).map((c) => c.id)),
    [calendars],
  );

  /** How much of this day is spent: all of a past day, none of a future one. */
  const elapsed = today ? nowMin : startOfDay(day) < startOfDay(now) ? MINUTES_PER_DAY : 0;

  /**
   * A band is drawn only while it has a half left to draw. Which halves is a
   * question the two faces answer separately: on the working face the band
   * shares the rim with a day's arcs and dropping one half is a legibility
   * trade, and on a face that is nothing but the rim it is the picture. Only
   * the place is shared, because a person is somewhere and that is not a
   * property of a mode.
   *
   * The second zone goes whole: its numerals and its band are one reference,
   * and half of one is not a reference.
   */
  const zoneRing = ambient ? ambientZoneRing : true;
  const bandDay = ambient ? ambientDaylight : daylight;
  const bandNight = ambient ? ambientMoonlight : moonlight;
  const band = place && (bandDay || bandNight) ? place : null;
  const zoneBand = zonePlace && (zoneDaylight || zoneMoonlight) && zoneRing ? zonePlace : null;

  /**
   * Escape abandons a gesture in flight. A drag is the one thing in the app
   * you can start by accident and cannot otherwise stop — letting go always
   * committed it, either as an editor full of a range you did not mean or as
   * an event moved to a time you did not choose.
   *
   * The pointer stays captured; both handlers already bail on no gesture, so
   * the release that follows does nothing.
   */
  useHotkeys({
    escape: () => {
      setDraw(null);
      cancelAdjust();
    },
  });

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

  /**
   * The event about to exist: the range under the pointer while a drag is live,
   * else the draft in the open editor, clipped to this face. One notion rather
   * than two, so the arc does not vanish at the moment the modal arrives —
   * white and translucent while it is being drawn, its own colour once it has
   * one to show.
   *
   * `null` for an all-day draft, which gets no arc for the same reason a saved
   * all-day event gets none: a whole turn says nothing the readout's `All day`
   * does not say better. A draft that does not reach this day draws nothing
   * either, and one whose middle covers it draws the closed ring.
   */
  const drafted = useMemo(() => {
    if (!pending || pending.allDay) return null;
    const from = startOfDay(day);
    const to = addDays(from, 1);
    if (pending.end <= from.getTime() || pending.start >= to.getTime()) return null;
    // `minutesOfDay` at each end rather than elapsed milliseconds: a day is not
    // always 1440 minutes long, and an arc has to sit at the time it prints.
    return {
      start: pending.start <= from.getTime() ? 0 : minutesOfDay(new Date(pending.start)),
      end: pending.end >= to.getTime() ? MINUTES_PER_DAY : minutesOfDay(new Date(pending.end)),
      color: pending.color,
      opacity: 1,
    };
  }, [pending, day]);

  const ghost = draw ? resolveDraw(draw) : null;
  /** The pointer wins while it is down: the range being drawn *is* the draft
   *  about to open, and drawing both would double the same fact. */
  const about = ghost ? { ...ghost, color: "#ffffff", opacity: GHOST_ALPHA } : drafted;

  /**
   * The event a drag has hold of, for the arc's own sake: it is drawn thicker,
   * and it is never dimmed for being in the past. Matched by event rather than
   * by occurrence key, because the drag moves it and the key it had at the
   * grab belongs to the instants it has left behind.
   */
  const dragging = adjust?.occ.event.id ?? null;

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

  /**
   * The dial itself draws no preview. `onPreview` hands the drag to the shell,
   * the shell folds it into `dayAgenda`, and the arcs come back already at the
   * dragged times — clipped to the day, repacked into lanes around whatever
   * they now overlap, and identical to the state the release will leave.
   */
  useEffect(() => {
    // A view switch can take the dial away mid-gesture (⌘Y, ⌘L and `t` are one
    // key each) and the release that would clear the preview never arrives.
    return () => onPreview(null);
  }, [onPreview]);

  /* ------------------------------ pointer ------------------------------ */

  /**
   * The pointer, as a minute on the face. Read through the root <svg> rather
   * than through the event's own target, because a gesture in flight is
   * captured *by the root* — so the target is the root, and an outermost <svg>
   * has no `ownerSVGElement` to ask.
   */
  function minutesAt(e: { clientX: number; clientY: number }): number | null {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return snap(minutesAtPoint(x, y, clock), STEP);
  }

  /**
   * Every gesture is captured by the root <svg>, never by the shape it started
   * on: the day can change under a drag, and the arc being dragged is
   * unmounted when it does — which releases a capture held by its own path and
   * drops the rest of the gesture on the floor.
   */
  function capture(e: ReactPointerEvent<SVGElement>) {
    svgRef.current?.setPointerCapture(e.pointerId);
  }

  /** Anything the dial says, in whichever channels the user left on. */
  function say(kind: Cue) {
    cue(kind, { sound: tickSound, haptics: tickHaptics });
  }

  /**
   * A detent, at the minute the grip landed on — including the one a drag
   * starts on, because the grab is a detent too and it is the user gesture
   * that lets the audio context start at all.
   *
   * Every fourth one is a whole hour and takes the deeper notch, which is what
   * makes a drag countable without looking at the face.
   *
   * `whole` is the heavier of the two cues — all of an event moving rather
   * than one end of it — and it is accented the same way, because the notch
   * belongs to the ring and not to what is being dragged over it.
   */
  function detent(minute: number, whole = false) {
    const hour = minute % HOUR === 0;
    if (whole) say(hour ? "slideHour" : "slide");
    else say(hour ? "stepHour" : "step");
  }

  function onRingDown(e: ReactPointerEvent<SVGCircleElement>) {
    if (e.button !== 0) return;
    const m = minutesAt(e);
    if (m === null) return;
    capture(e);
    setDraw({ from: m, at: m, sweep: 0 });
    detent(m);
  }

  function onRingMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!draw) return;
    const at = minutesAt(e);
    // Pointermove fires far more often than the ghost changes shape. Bailing
    // on an unchanged step is what makes the clicks countable, and it saves
    // the re-render the drag would otherwise do per event.
    if (at === null || at === draw.at) return;
    // The sweep is clamped, the pointer is not: a range that has run to
    // midnight stops there and starts following back the instant the pointer
    // turns, rather than unwinding however far it ran past the end of the day.
    const sweep = clamp(
      draw.sweep + wrapDelta(draw.at, at),
      -draw.from,
      MINUTES_PER_DAY - draw.from,
    );
    const moved = sweep !== draw.sweep;
    setDraw({ ...draw, at, sweep });
    if (moved) detent(draw.from + sweep);
  }

  function onRingUp() {
    if (!draw) return;
    const { start, end } = resolveDraw(draw);
    setDraw(null);
    // The release: the range stops being something you are drawing and starts
    // being a draft in a modal, and the knock-and-tick is that handover.
    say("opened");
    if (end - start < STEP) {
      const from = Math.min(draw.from, MINUTES_PER_DAY - CLICK_DURATION);
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
    capture(e);
    const next: Adjust = { occ, grip, at, delta: 0, moved: false, shift: 0 };
    setAdjust(next);
    // Nothing is going to move on somebody else's event, so nothing clicks.
    if (grip !== "none") detent(gripMinute(next), grip === "whole");
  }

  function onArcMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!adjust) return;
    const at = minutesAt(e);
    if (at === null || at === adjust.at) return;
    // Accumulated per event rather than measured from the grab, so the drag
    // survives passing the twelve-hour mark. Clamped rather than let run:
    // a delta that overshot the minimum duration would have to be unwound
    // before the arc started following the pointer back.
    const delta = clampDelta(adjust, adjust.delta + wrapDelta(adjust.at, at));
    if (delta === adjust.delta) {
      // The pointer crossed a step and the grip did not follow: it is against
      // the minimum duration. Still a drag — it is only the arc that is out
      // of room — so the release must not fall through to opening the editor.
      setAdjust({ ...adjust, at, moved: true });
      return;
    }
    const next = { ...adjust, at, delta, moved: true };
    const step = dayFollow(next, day);
    setAdjust({ ...next, shift: adjust.shift + step });
    if (step !== 0) onStepDay(step);
    onPreview(draggedEvent(next));
    detent(gripMinute(next), adjust.grip === "whole");
  }

  function onArcUp() {
    if (!adjust) return;
    const { occ, grip, delta, moved } = adjust;
    const { start, end } = deltas(adjust);
    setAdjust(null);
    onPreview(null);
    // A press that never crossed a step is a click, and a click opens the
    // event — as does any press on a read-only arc, which is the whole
    // implementation of those: they open, they never move.
    if (!moved || grip === "none") {
      onOpen(occ);
      return;
    }
    // Moved, but the grip was pinned the whole way: nothing to write, and a
    // no-op write would still cost an undo step.
    if (delta !== 0) onAdjust(occ, start, end);
  }

  /**
   * Abandoning a drag gives the day back too: the view followed the event
   * through midnight on the gesture's account, and the gesture ends up having
   * made nothing happen.
   */
  function cancelAdjust() {
    if (!adjust) return;
    if (adjust.shift !== 0) onStepDay(-adjust.shift);
    onPreview(null);
    setAdjust(null);
  }

  /**
   * One gesture surface: the root <svg> holds the capture, so every move and
   * release after the press arrives here whatever the press started on, and
   * the shapes below only have to say which gesture it was.
   */
  function onGestureMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (draw) onRingMove(e);
    else if (adjust) onArcMove(e);
  }

  function onGestureUp() {
    if (draw) onRingUp();
    else if (adjust) onArcUp();
  }

  function onGestureCancel() {
    setDraw(null);
    cancelAdjust();
  }

  /* ------------------------------- render ------------------------------- */

  return (
    <div
      ref={stageRef}
      // The drift is a few pixels over five minutes, so that a face left on a
      // desk all evening never burns its numerals into the panel. Imperceptible
      // by design, and off under `prefers-reduced-motion` with everything else.
      className={cn("relative h-full w-full", ambient && "ambient-drift")}
      style={{ opacity: level, transition: "opacity 1200ms linear" }}
    >
      <svg
        ref={svgRef}
        viewBox={VIEW_BOX}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full touch-none select-none"
        role="presentation"
        onPointerMove={onGestureMove}
        onPointerUp={onGestureUp}
        onPointerCancel={onGestureCancel}
      >
        <defs>
          <radialGradient id="dial-glow">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.05" />
            <stop offset="52%" stopColor="#fff" stopOpacity="0.014" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx={DIAL.C} cy={DIAL.C} r={DIAL.TRACK} fill="url(#dial-glow)" />

        <AnimatePresence initial={false}>
          {band && (
            <Fade key="band">
              <SunBand
                day={day}
                clock={clock}
                place={band}
                daylight={bandDay}
                moonlight={bandNight}
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
                place={zoneBand}
                daylight={zoneDaylight}
                moonlight={zoneMoonlight}
                radius={DIAL.ZONE_BAND}
              />
            </Fade>
          )}
          {secondZone && zoneRing && (
            <Fade key="zone-ring">
              <ZoneRing
                now={now}
                clock={clock}
                zone={secondZone}
                showName={showZoneName}
                showOffset={showZoneOffset}
              />
            </Fade>
          )}
        </AnimatePresence>

        <Ticks clock={clock} />
        <HourLabels clock={clock} quartersOnly={ambient} />

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
        />

        {occurrences.map((occ) => (
          <EventArc
            key={occ.key}
            occ={occ}
            clock={clock}
            // Its own mode in ambient, defaulting to off: 11px mono is
            // interaction-distance type, and noise on the one surface that has
            // to stay a shape when it is read from across a room.
            labels={ambient ? ambientArcLabels : arcLabels}
            color={colorOf(occ.event, calendars)}
            dimmed={today && statusOf(occ, now) === "past"}
            hovered={hovered === occ.key}
            // Somebody else's calendar: it opens, it never moves.
            locked={feedIds.has(occ.event.calendarId)}
            dragging={dragging === occ.event.id}
            gap={gaps.get(occ.key) ?? NO_NEIGHBOUR}
            onHover={setHovered}
            onGrab={onArcDown}
          />
        ))}

        {about && about.end > about.start && (
          <GhostArc
            clock={clock}
            start={about.start}
            end={about.end}
            color={about.color}
            opacity={about.opacity}
          />
        )}

        {today && (
          // Keyed on the face: relabelling is a 180° jump, and a hand sweeping
          // half the dial while the numerals under it teleport is two events.
          <NowHand
            key={clock}
            minutes={nowMin}
            clock={clock}
            dimmed={draw !== null || adjust !== null}
          />
        )}
      </svg>

      <CenterPanel
        day={day}
        now={now}
        occurrences={occurrences}
        calendars={calendars}
        u={u}
        clock={clock}
        ambient={ambient}
        totals={totals}
        totalsAt={totalsAt}
        drag={ghost && ghost.end > ghost.start ? ghost : adjust ? dragSpan(adjust, day) : null}
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
  const maskId = useId().replace(/[^a-zA-Z0-9-]/g, "");
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
 */
function EventArc({
  occ,
  clock,
  labels,
  color,
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
  onHover: (key: string | null) => void;
  onGrab: (occ: Occurrence, grip: Grip, e: ReactPointerEvent<SVGPathElement>) => void;
}) {
  // Before the early return, so the hook order does not depend on the event: an
  // all-day occurrence draws nothing, but it still owns this component.
  const r = useEasedRadius(DIAL.LANE - occ.lane * DIAL.LANE_STEP);
  // `<textPath>` takes a reference, not a path, so the label's own path needs
  // an id. Not `occ.key`: a feed's occurrence carries its UID, and a UID is
  // any text at all — including the `#` that would break the reference.
  const labelId = `arc-label-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
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

  // A label lives *inside* the stroke, so it costs no radius and reads the
  // same on every lane. It is mounted whenever the sweep can hold one and
  // hidden by opacity, because in `hover` mode it arrives at the same instant
  // the stroke grows by 3 — and text popping in on a growing arc reads as a
  // wobble where the crossfade should be.
  //
  // `off` is the same bargain one step further out: ambient has its own mode
  // and switching into it would otherwise blink every name on the face out at
  // once. Off is now a state of the label rather than its absence.
  const label = dot ? null : arcLabel(r, paintFrom, paintTo, occ.event.title);
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
    <g onPointerEnter={() => onHover(occ.key)} onPointerLeave={() => onHover(null)}>
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
      {label && (
        <>
          <defs>
            <path id={labelId} d={label.d} />
          </defs>
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
            opacity={labelShown ? 1 : 0}
            aria-hidden={!labelShown}
            pointerEvents="none"
            style={{ transition: `opacity ${MOOD}` }}
          >
            <textPath href={`#${labelId}`} startOffset="50%" textAnchor="middle">
              {label.text}
            </textPath>
          </text>
        </>
      )}
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
}: {
  clock: Clock;
  start: number;
  end: number;
  color: string;
  opacity: number;
}) {
  const stroke = {
    fill: "none",
    stroke: color,
    strokeOpacity: opacity,
    strokeWidth: DIAL.ARC_WIDTH,
    pointerEvents: "none",
  } as const;

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
  const head = polar(DIAL.TRACK, deg);
  const inner = polar(DIAL.HAND_INNER, deg);
  return (
    <g pointerEvents="none" opacity={dimmed ? 0.22 : 1} style={{ transition: `opacity ${MOOD}` }}>
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
