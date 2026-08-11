/* ------------------------------------------------------------------ *
 * The instrument.
 *
 * A `<Face>` with every ring switched on, the readout and agenda pinned over
 * its middle as HTML (see `CenterPanel`), and the gestures that make it a
 * surface you work on rather than one you read. The drawing lives in
 * `Face.tsx`; what is here is what a *day* can be edited into — drawing a
 * range on the ring, moving and resizing an arc, and the two keys that belong
 * to whatever the pointer is over.
 * ------------------------------------------------------------------ */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { VIEW_SIZE, minutesAtPoint } from "@/lib/dial";
import { colorOf, type Calendar, type Occurrence } from "@/lib/events";
import { cue, type Cue } from "@/lib/feedback";
import { ambientLevel, type Place } from "@/lib/sun";
import {
  MINUTES_PER_DAY,
  addDays,
  clamp,
  daysBetween,
  minutesOfDay,
  snap,
  startOfDay,
} from "@/lib/time";
import type { Settings } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useElementSize, useHotkeys } from "./hooks";
import Face, { type FaceGhost, type Grip } from "./Face";
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
  pending: { start: number; end: number; allDay: boolean; task: boolean; color: string } | null;
  /**
   * Ambient: the chrome is gone and the face is the whole window, so the dial
   * stops being a surface you work on and becomes one you glance at from
   * across a room. It changes what is drawn, never how it is drawn — four
   * numerals instead of twelve, no names along the arcs, the centre reading
   * at a distance, and the whole face riding the lightcycle's own brightness.
   * Every gesture still works.
   */
  ambient: boolean;
  /**
   * Something is on top of the face — an editor, the palette, settings, a
   * scope question. The dial keeps its gestures (nothing can reach them
   * anyway) but gives up its shortcuts: the editor has a ⌘⌫ of its own, and
   * two handlers on one press delete two different events.
   */
  covered: boolean;
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
   * ⌘⌫ over an arc. The dial owns the hover, so it owns the key — the same
   * reason Escape's gesture-abandon lives here rather than in the shell. It
   * never fires for a subscription's occurrence: that arc opens, it does not
   * change.
   */
  onDelete: (occ: Occurrence) => void;
  /**
   * ⌘ held through a drag on an arc's body: the original stays where it is and
   * a copy lands where the pointer let go. One delta, because a duplicate is a
   * move of a copy and never a resize of one — ⌘ on an end grip is ignored.
   *
   * It asks no scope question and opens no editor: the gesture already named
   * the new time, which is the whole difference between this and ⌘P's own
   * `Duplicate` row.
   */
  onDuplicate: (occ: Occurrence, deltaMin: number) => void;
  /** Tick the task under the pointer off, or back on. Straight through to the
   *  store — a task has one occurrence's worth of state and no scope to ask
   *  about, because ticking Monday off has never meant ticking every Monday. */
  onToggleDone: (occ: Occurrence) => void;
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
/** How translucent a range still under the pointer is. It has no colour to
 *  show yet, so it is the one thing on the face drawn in plain white. */
const GHOST_ALPHA = 0.45;

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
  /**
   * ⌘ was held at the grab: the original stays put and the drag is carrying a
   * copy. Fixed at the press rather than read per move, because a modifier
   * let go halfway through a gesture would turn a duplicate into a move of
   * the thing you were copying — which is the one outcome nothing undoes in
   * one step.
   *
   * Only ever true for `grip === "whole"`: a duplicate is a move of a copy.
   */
  copy: boolean;
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

/**
 * A pair of instants as an arc on this day.
 *
 * `null` when it does not reach the day at all; `minutesOfDay` at each end
 * rather than elapsed milliseconds, because a day is not always 1440 minutes
 * long and an arc has to sit at the time it prints; and 0…1440 for a span
 * whose middle covers the day, which is the closed ring.
 */
function clipGhost(
  span: { start: number; end: number },
  day: Date,
  color: string,
  task: boolean,
  opacity = 1,
): FaceGhost | null {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  if (span.end < from.getTime() || span.start >= to.getTime()) return null;
  return {
    start: span.start <= from.getTime() ? 0 : minutesOfDay(new Date(span.start)),
    end: span.end >= to.getTime() ? MINUTES_PER_DAY : minutesOfDay(new Date(span.end)),
    color,
    opacity,
    task,
  };
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
  covered,
  onOpen,
  onCreate,
  onAdjust,
  onDelete,
  onDuplicate,
  onToggleDone,
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
    inheritMarks,
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
  const zoneOn = ambient ? ambientZoneRing : true;
  const bandDay = ambient ? ambientDaylight : daylight;
  const bandNight = ambient ? ambientMoonlight : moonlight;
  const band =
    place && (bandDay || bandNight) ? { place, daylight: bandDay, moonlight: bandNight } : null;
  const zoneBand =
    zonePlace && (zoneDaylight || zoneMoonlight) && zoneOn
      ? { place: zonePlace, daylight: zoneDaylight, moonlight: zoneMoonlight }
      : null;
  const zoneRing =
    secondZone && zoneOn
      ? { zone: secondZone, showName: showZoneName, showOffset: showZoneOffset }
      : null;

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
   * ⌘⌫ deletes the arc under the pointer — the editor's own Delete shortcut,
   * one layer out, so the key means one thing wherever an event is in front of
   * you. The dial owns the hover, so it owns the press; what a delete means to
   * a *repeating* event is the shell's question, so the occurrence goes up
   * rather than the store being written to from here.
   *
   * ⌦ answers to the same handler: a full-size keyboard has both, and on one
   * of them the key labelled Delete is the one this is not.
   */
  const deleteHovered = () => {
    // Never mid-gesture: the drag in flight is about to write to this same arc,
    // and a press that both deletes and commits is neither.
    if (draw || adjust || !hovered) return;
    const occ = occurrences.find((o) => o.key === hovered);
    // Somebody else's calendar: that arc opens, it does not change.
    if (!occ || calendars.some((c) => c.id === occ.event.calendarId && c.feed)) return;
    setHovered(null);
    onDelete(occ);
  };
  useHotkeys({ "mod+backspace": deleteHovered, "mod+delete": deleteHovered }, !covered);

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
  const drafted = useMemo<FaceGhost | null>(
    () =>
      pending && !pending.allDay ? clipGhost(pending, day, pending.color, pending.task) : null,
    [pending, day],
  );

  /**
   * The copy a ⌘-drag is carrying. It is the same ghost channel the draft
   * uses, in the event's own colour, because it is the same fact: an event
   * that does not exist yet, drawn where it is about to. The original is not
   * previewed at all — `onArcMove` withholds `onPreview` while copying, so
   * the arc under the pointer stays exactly where it was.
   */
  const copying = useMemo<FaceGhost | null>(() => {
    if (!adjust?.copy) return null;
    const { event } = adjust.occ;
    return clipGhost(draggedOccurrence(adjust), day, colorOf(event, calendars), event.task);
  }, [adjust, day, calendars]);

  const ghost = draw ? resolveDraw(draw) : null;
  /** The pointer wins while it is down: the range being drawn *is* the draft
   *  about to open, and drawing both would double the same fact. A drag never
   *  draws a task — a gesture with a length in it is asking for a span. */
  const about = ghost
    ? { ...ghost, color: "#ffffff", opacity: GHOST_ALPHA, task: false }
    : (copying ?? drafted);

  /**
   * The event a drag has hold of, for the arc's own sake: it is drawn thicker,
   * and it is never dimmed for being in the past. Matched by event rather than
   * by occurrence key, because the drag moves it and the key it had at the
   * grab belongs to the instants it has left behind.
   */
  const dragging = adjust?.occ.event.id ?? null;

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
   * A detent, at every fifteen-minute step the grip lands on — including the
   * one a drag starts on, because the grab is a detent too and it is the user
   * gesture that lets the audio context start at all.
   *
   * One click, and the hour is not accented. The centre of the face is
   * printing the span in words for the whole of the gesture, so counting
   * hours by ear answers a question already answered — on a channel that
   * fires fifteen times a second, where a second signal is noise.
   *
   * `whole` is the heavier of the two cues — all of an event moving rather
   * than one end of it — and that is the only thing this chooses between.
   */
  function detent(whole = false) {
    say(whole ? "slide" : "step");
  }

  function onRingDown(e: ReactPointerEvent<SVGCircleElement>) {
    if (e.button !== 0) return;
    const m = minutesAt(e);
    if (m === null) return;
    capture(e);
    setDraw({ from: m, at: m, sweep: 0 });
    detent();
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
    if (moved) detent();
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
    // ⌘ on the body carries a copy off it. Only the body: a duplicate is a
    // move of a copy, so an end grip is a resize whatever is held down.
    const copy = grip === "whole" && (e.metaKey || e.ctrlKey);
    const next: Adjust = { occ, grip, at, delta: 0, moved: false, shift: 0, copy };
    setAdjust(next);
    // Nothing is going to move on somebody else's event, so nothing clicks.
    if (grip !== "none") detent(grip === "whole");
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
    // A copy leaves the original alone, so there is nothing to preview: the
    // arc under the pointer must stay where it is, and the thing that moves
    // is `copying`'s ghost.
    if (!next.copy) onPreview(draggedEvent(next));
    detent(adjust.grip === "whole");
  }

  function onArcUp() {
    if (!adjust) return;
    const { occ, grip, delta, moved, copy } = adjust;
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
    if (delta === 0) return;
    if (copy) onDuplicate(occ, delta);
    else onAdjust(occ, start, end);
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
      <Face
        svgRef={svgRef}
        day={day}
        now={now}
        occurrences={occurrences}
        calendars={calendars}
        clock={clock}
        glow
        ticks
        // Ambient keeps the four the face is navigated by: twelve 19-unit
        // numerals is interaction-distance type, and from a chair it reads
        // as a grey fringe rather than as a scale.
        numerals={ambient ? "quarters" : "all"}
        elapsed
        hand
        band={band}
        zoneBand={zoneBand}
        zoneRing={zoneRing}
        // Its own mode in ambient, defaulting to off: 11px mono is
        // interaction-distance type, and noise on the one surface that has
        // to stay a shape when it is read from across a room.
        arcLabels={ambient ? ambientArcLabels : arcLabels}
        inheritMarks={inheritMarks}
        hovered={hovered}
        dragging={dragging}
        ghost={about}
        gesturing={draw !== null || adjust !== null}
        onHover={setHovered}
        onGrab={onArcDown}
        onRingDown={onRingDown}
        onPointerMove={onGestureMove}
        onPointerUp={onGestureUp}
        onPointerCancel={onGestureCancel}
      />

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
        onToggleDone={onToggleDone}
      />
    </div>
  );
}
