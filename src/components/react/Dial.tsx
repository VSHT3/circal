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
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { DIAL, VIEW_SIZE, minutesAtPoint } from "@/lib/dial";
import { clipToDay, colorOf, type Calendar, type Occurrence } from "@/lib/events";
import { cue, type Cue } from "@/lib/feedback";
import { ambientLevel, type Place } from "@/lib/sun";
import {
  MINUTES_PER_DAY,
  addDays,
  dayKey,
  daysBetween,
  formatTime,
  snap,
  startOfDay,
} from "@/lib/time";
import { INTRO_SWEEP_MS } from "@/lib/motion";
import type { Settings } from "@/lib/store";
import type { Task } from "@/lib/tasks";
import { THEME_PALETTES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useElementSize, useHotkeys } from "./hooks";
import Face, { GHOST_ALPHA, SLOT_ALPHA, type FaceGhost, type Grip } from "./Face";
import CenterPanel from "./CenterPanel";
import MoonPanel from "./MoonPanel";

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
  /**
   * The grabbed record's own start before the drag moved anything. The
   * shell needs it for a task: the id names the task, but a task may carry
   * several plans, and this is which one is being held. An event's preview
   * never reads it.
   */
  from: number;
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
  dailyNote: ReactNode;
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
   * Free time received from a link, as absolute spans — the receiver's side
   * of "share my free time". Clipping each one to this face is this
   * component's question, exactly as it is for `pending`.
   */
  slots: { start: number; end: number }[] | null;
  /**
   * A click (a press that never moved) landing inside one of those slots:
   * the booking tap, this face's spelling. The strip's is a hit path on the
   * outline; here the ring already owns the press, so the answer lives in
   * `onRingUp`'s zero-sweep branch — a drawn sweep keeps meaning exactly
   * what was drawn, over a slot or not.
   */
  onBookSlot: (slot: { start: number; end: number }) => void;
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
  onCreate: (startMin: number, endMin: number, on: Date) => void;
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
  /** Tick the task under the pointer off, or back on — a task has one
   *  deadline and is finished once, so there is no scope to ask about. */
  onToggleDone: (occ: Occurrence) => void;
  /**
   * The task a sidebar row has picked up, or `null`. While set, the dial
   * listens on the window — the press happened in the sidebar, so no press
   * ever reaches this SVG — and draws a ghost of the task's estimate under
   * the pointer: slide it, or drag past its own end to sweep a different
   * length (TASKS.md §7). The shell owns clearing it, on release or Escape.
   */
  dragTask: Task | null;
  /** The release over the face: commit these minutes of the shown day as a
   *  plan. The shell writes it with `scheduleTask`'s own toast and cue. */
  onDropTask: (id: string, startMin: number, endMin: number) => void;
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
  /**
   * The app arriving, once per install. Handed straight to `<Face>`, which
   * owns the whole of it: every element there is delayed by the time it
   * stands for, and only the face knows what minute anything is. The dial's
   * one contribution is the interior, which has no minute of its own and so
   * arrives once the day is round it.
   */
  intro: boolean;
  /** The rim's once-a-day sweep, handed straight to `<Face>`. The shell owns
   *  when it fires (see `App.toggleDone`); the dial adds nothing. */
  shimmer: number | null;
}

/** Drag granularity. Matches what a fifteen-minute arc can actually show. */
const STEP = 15;

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
 * lets a drag run the whole revolution — and past it, into the next day.
 */
interface Draw {
  /** Where the press landed, snapped, in minutes since the anchor day's
   *  midnight. */
  from: number;
  /** Ring position the pointer was last seen at, snapped. */
  at: number;
  /**
   * Signed minutes swept since the grab: clockwise positive. Unbounded — a
   * drag through midnight keeps sweeping, and the day underneath steps with
   * it, so a range is as many days long as the pointer made it.
   */
  sweep: number;
  /**
   * The day the grab happened on — the axis `from` and `sweep` are measured
   * against, fixed for the life of the gesture. The view may step away from
   * it mid-drag; the release still commits what was drawn against this day.
   */
  origin: Date;
}

/** The drawn range as absolute instants: the anchor day's midnight plus the
 *  minutes swept, elapsed arithmetic like every other drag delta here — which
 *  is also what makes a sweep across a spring-forward land an hour early on
 *  the wall clock, exactly as an arc dragged the same distance does. */
function drawnOccurrence(draw: Draw): { start: number; end: number } {
  const base = startOfDay(draw.origin).getTime();
  const { start, end } = resolveDraw(draw);
  return { start: base + start * 60_000, end: base + end * 60_000 };
}

/** The drawn range in minutes since the *displayed* midnight — the readout's
 *  units, and out of range whenever the sweep has crossed midnight, which is
 *  the fact the readout is for. `atMinutes` normalises both directions. */
function drawnSpan(draw: Draw, day: Date): { start: number; end: number } {
  const base = startOfDay(day).getTime();
  const { start, end } = drawnOccurrence(draw);
  return { start: (start - base) / 60_000, end: (end - base) / 60_000 };
}

/**
 * How many days the view belongs from the anchor day. Zero for as long as
 * the whole range fits one face — up to a full revolution, wrapping the top
 * when it crosses midnight — because ring positions are day-independent, so
 * the past you drew can stay drawn. `dayFollow`'s own rule, one gesture over:
 * the view switches *then* rather than earlier.
 *
 * Past a revolution the range covers the whole anchor day and no face can
 * show it; the view follows the leading edge — the last instant covered
 * (`end` is exclusive, `dayCount`'s own rule) forward, the first backward —
 * counted in real midnights rather than elapsed minutes, so a spring-forward
 * night still steps at midnight and not an hour after it.
 */
function drawFollow(draw: Draw): number {
  if (Math.abs(draw.sweep) <= MINUTES_PER_DAY) return 0;
  const { start, end } = drawnOccurrence(draw);
  const edge = draw.sweep > 0 ? end - 1 : start;
  return daysBetween(startOfDay(draw.origin), startOfDay(new Date(edge)));
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
  return {
    id: event.id,
    start: event.start + start * 60_000,
    end: event.end + end * 60_000,
    from: event.start,
  };
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
  opacity = 1,
): FaceGhost | null {
  const clipped = clipToDay(span, day);
  return clipped && { ...clipped, color, opacity };
}

export default function Dial({
  day,
  now,
  occurrences,
  calendars,
  settings,
  dailyNote,
  zonePlace,
  pending,
  slots,
  onBookSlot,
  ambient,
  covered,
  onOpen,
  onCreate,
  onAdjust,
  onDelete,
  onDuplicate,
  onToggleDone,
  dragTask,
  onDropTask,
  onPreview,
  onStepDay,
  intro,
  shimmer,
}: DialProps) {
  const {
    clock,
    place,
    daylight,
    moonlight,
    secondZone,
    theme,
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
    moon,
    moonAt,
    tickSound,
    tickHaptics,
  } = settings;
  // Only the fitted diameter affects the dial, not spare space beside it.
  const [stageRef, width, height] = useElementSize<HTMLDivElement>(true);
  /** Every gesture's capture target, and the frame its coordinates are read
   *  in. See `capture`. */
  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const listId = useId();
  const [cursor, setCursor] = useState<string | null>(null);
  const [listFocused, setListFocused] = useState(false);
  const dateKey = dayKey(day);
  const [cursorDay, setCursorDay] = useState(dateKey);
  if (cursorDay !== dateKey) {
    setCursorDay(dateKey);
    setCursor(null);
  }
  // Keep identity across edits and ticks; a removed occurrence falls back to the first.
  const cursorIndex = Math.max(
    0,
    occurrences.findIndex((occ) => occ.key === cursor),
  );
  const cursorOccurrence = occurrences[cursorIndex];
  const active = listFocused && !covered ? (cursorOccurrence?.key ?? null) : hovered;
  const [draw, setDraw] = useState<Draw | null>(null);
  const [adjust, setAdjust] = useState<Adjust | null>(null);
  /** The dragged task's ghost, in minutes of this day — `null` while the
   *  pointer is off the face. The gesture itself lives in the effect below;
   *  this is only what the face draws of it. */
  const [drop, setDrop] = useState<{ start: number; end: number } | null>(null);
  /**
   * Days the view has moved on the draw gesture's account, kept in a ref
   * rather than the gesture state: two pointermoves can arrive inside one
   * render, each running against the same stale closure, and a counter in
   * state would let both issue the same step. A ref is shared across
   * closures and read synchronously, so the difference asked for is always
   * measured against what has actually been asked for so far.
   */
  const drawShift = useRef(0);

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
      cancelDraw();
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
    if (draw || adjust || !active) return;
    const occ = occurrences.find((o) => o.key === active);
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
    () => (pending && !pending.allDay ? clipGhost(pending, day, pending.color) : null),
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
    return clipGhost(draggedOccurrence(adjust), day, colorOf(event, calendars));
  }, [adjust, day, calendars]);

  /**
   * The range being drawn, on this face. While the view is still on the
   * anchor day and the range fits one revolution, it is drawn *whole* —
   * `angleAt` is linear and `arcPath` takes raw degrees, so an end past 1440
   * simply wraps the top: a drag through midnight keeps its head on screen,
   * rather than losing the past to a clip at the rim. A backward wrap is the
   * same arc named from the other end, normalised so `start` stays on the
   * face. Only once the view has stepped away (or the range outgrew a face)
   * is clipping the absolute instants the honest drawing — at which point
   * `GhostArc`'s own closed-ring and `clipToDay`'s 0…1440 branches take over.
   */
  const drawing = useMemo<FaceGhost | null>(() => {
    if (!draw || draw.sweep === 0) return null;
    const color = THEME_PALETTES[theme].ghost;
    const wholeOnFace =
      Math.abs(draw.sweep) <= MINUTES_PER_DAY &&
      startOfDay(day).getTime() === startOfDay(draw.origin).getTime();
    if (wholeOnFace) {
      let { start, end } = resolveDraw(draw);
      if (start < 0) {
        start += MINUTES_PER_DAY;
        end += MINUTES_PER_DAY;
      }
      return { start, end, color, opacity: GHOST_ALPHA };
    }
    return clipGhost(drawnOccurrence(draw), day, color, GHOST_ALPHA);
  }, [draw, day, theme]);

  /**
   * The task drag, carried on window listeners: the press happened on a
   * sidebar row, so no pointer event ever targets this SVG — the window is
   * the only place the rest of the gesture can be heard. The mechanic is
   * one move: the ghost rides under the pointer, at the estimate's length,
   * in both directions — an earlier draft anchored the start and swept the
   * end once the pointer passed it, and moving a task clockwise grew it
   * instead of carrying it. Length is chosen after it lands, with the arc's
   * own grips, like any other arc. `held` is a closure local, not state:
   * the effect's lifetime *is* the drag's, and two pointermoves can arrive
   * inside one render.
   */
  useEffect(() => {
    if (!dragTask) return;
    const length = Math.max(STEP, dragTask.estimate ?? settings.defaultDuration);
    let held: { start: number; end: number } | null = null;

    /** The pointer as a minute of this face, or `null` off the annulus —
     *  from the numerals ring in to a lane past the innermost, so the
     *  interior and the corners refuse the drop the same way. */
    const read = (e: PointerEvent): number | null => {
      const ctm = svgRef.current?.getScreenCTM();
      if (!ctm) return null;
      const { x, y } = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      const radius = Math.hypot(x - DIAL.C, y - DIAL.C);
      if (radius < DIAL.LANE - 3 * DIAL.LANE_STEP || radius > DIAL.C) return null;
      return snap(minutesAtPoint(x, y, clock), STEP);
    };

    const move = (e: PointerEvent) => {
      const m = read(e);
      if (m === null) {
        if (held) {
          held = null;
          setDrop(null);
        }
        return;
      }
      // The start takes the quarter under the pointer, nudged back from
      // midnight so the estimate still fits the day.
      const start = Math.min(m, MINUTES_PER_DAY - STEP);
      if (held && start === held.start) return;
      held = { start, end: Math.min(start + length, MINUTES_PER_DAY) };
      setDrop(held);
      cue("step", { sound: tickSound, haptics: tickHaptics });
    };

    const up = () => {
      const landed = held;
      held = null;
      setDrop(null);
      // Released off the face: the drag just ends, nothing written — the
      // shell hears the same pointerup and puts the row down.
      if (landed) onDropTask(dragTask.id, landed.start, landed.end);
    };
    const cancel = () => {
      held = null;
      setDrop(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setDrop(null);
    };
  }, [dragTask, clock, settings.defaultDuration, onDropTask, tickSound, tickHaptics]);

  /** The carried task, where it is about to land. Unlike the ring's draw
   *  there is a colour to show — the task's own — so the drop looks like
   *  the arc it becomes. */
  const dropping = useMemo<FaceGhost | null>(
    () =>
      dragTask && drop
        ? { ...drop, color: colorOf(dragTask, calendars), opacity: GHOST_ALPHA }
        : null,
    [dragTask, drop, calendars],
  );

  /** The pointer wins while it is down: the range being drawn *is* the draft
   *  about to open, and drawing both would double the same fact. */
  const about = drawing ?? copying ?? dropping ?? drafted;

  /** Received free time, on this day's face. Memoised because it repaints the
   *  SVG, and the spans only change when a link arrives or is dismissed. */
  const slotGhosts = useMemo<FaceGhost[] | null>(() => {
    if (!slots || slots.length === 0) return null;
    const color = THEME_PALETTES[theme].ghost;
    const clipped = slots.flatMap((span) => {
      const arc = clipToDay(span, day);
      return arc && arc.end > arc.start ? [{ ...arc, color, opacity: SLOT_ALPHA }] : [];
    });
    return clipped.length > 0 ? clipped : null;
  }, [slots, day, theme]);

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
    drawShift.current = 0;
    setDraw({ from: m, at: m, sweep: 0, origin: day });
    detent();
  }

  function onRingMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!draw) return;
    const at = minutesAt(e);
    // Pointermove fires far more often than the ghost changes shape. Bailing
    // on an unchanged step is what makes the clicks countable, and it saves
    // the re-render the drag would otherwise do per event.
    if (at === null || at === draw.at) return;
    // The sweep is unbounded, the day is not a wall: a drag through midnight
    // keeps sweeping and `drawFollow` steps the view with it. Nothing is
    // clamped, so nothing is banked — the pointer turning back unwinds the
    // sweep directly, and the view steps back across midnight with it.
    const next = { ...draw, at, sweep: draw.sweep + wrapDelta(draw.at, at) };
    // Wanted position against the anchor day, issued as a difference through
    // the `drawShift` ref — never measured against the `day` prop, which two
    // pointermoves can outrun before React has committed the last step.
    const step = drawFollow(next) - drawShift.current;
    drawShift.current += step;
    setDraw(next);
    if (step !== 0) onStepDay(step);
    detent();
  }

  function onRingUp() {
    if (!draw) return;
    const { start, end } = resolveDraw(draw);
    setDraw(null);
    // The release: the range stops being something you are drawing and starts
    // being a draft in a modal, and the knock-and-tick is that handover.
    say("opened");
    if (end - start < STEP) {
      // A press that never moved, landing inside a received free slot, books
      // the whole slot — the outline says "book over me", and a tap is how
      // every face answers it. Clipped against the *anchor* day, as the
      // ghost is: for a click the two are the same day, and the anchor is
      // the one the press was actually read on.
      const tapped = slots?.find((span) => {
        const arc = clipToDay(span, draw.origin);
        return arc && draw.from >= arc.start && draw.from < arc.end;
      });
      if (tapped) {
        onBookSlot(tapped);
        return;
      }
      // Otherwise it named a minute and no length, so it takes the one every
      // other route takes — ⌘N's and quick-add's. It was its own constant
      // here, which made the dial the one surface with a private opinion
      // about how long an event is.
      const length = settings.defaultDuration;
      const from = Math.min(draw.from, MINUTES_PER_DAY - length);
      onCreate(from, from + length, draw.origin);
    } else {
      onCreate(start, end, draw.origin);
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

  /** The draw's own answer to the same question: a sweep that carried the
   *  view into tomorrow leaves tomorrow where it found it. */
  function cancelDraw() {
    if (!draw) return;
    if (drawShift.current !== 0) onStepDay(-drawShift.current);
    setDraw(null);
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
    cancelDraw();
    cancelAdjust();
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    if (covered || draw || adjust || e.altKey || e.metaKey || e.ctrlKey) return;
    let next = cursorIndex;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next++;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next--;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = occurrences.length - 1;
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (cursorOccurrence) onOpen(cursorOccurrence);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    setHovered(null);
    setCursor(occurrences[Math.max(0, Math.min(occurrences.length - 1, next))]?.key ?? null);
  }

  /* ------------------------------- render ------------------------------- */

  return (
    <div
      ref={stageRef}
      data-export-face="day"
      data-export-name={dayKey(day)}
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
        theme={settings.theme}
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
        joinAdjacent={settings.joinAdjacent}
        inheritMarks={inheritMarks}
        hovered={active}
        dragging={dragging}
        ghost={about}
        slots={slotGhosts}
        gesturing={draw !== null || adjust !== null}
        intro={intro}
        shimmer={shimmer}
        onHover={setHovered}
        onGrab={onArcDown}
        onTick={onToggleDone}
        onRingDown={onRingDown}
        onPointerMove={onGestureMove}
        onPointerUp={onGestureUp}
        onPointerCancel={onGestureCancel}
      />

      <ul
        role="listbox"
        tabIndex={covered || occurrences.length === 0 ? -1 : 0}
        aria-label={`Events for ${day.toLocaleDateString(undefined, { dateStyle: "full" })}. Arrows browse, Home and End jump, Enter opens`}
        aria-activedescendant={cursorOccurrence ? `${listId}-${cursorIndex}` : undefined}
        className="sr-only"
        onFocus={() => {
          setHovered(null);
          setListFocused(true);
        }}
        onBlur={() => setListFocused(false)}
        onKeyDown={onListKeyDown}
      >
        {occurrences.map((occ, i) => (
          <li key={occ.key} id={`${listId}-${i}`} role="option" aria-selected={i === cursorIndex}>
            {occ.event.title},{" "}
            {occ.event.allDay
              ? "All day"
              : occ.startMin === occ.endMin
                ? `Due ${formatTime(occ.start, clock)}`
                : `${formatTime(occ.start, clock)} to ${formatTime(occ.end, clock)}`}
            {occ.task ? (occ.task.done ? ", completed task" : ", task") : ""}
          </li>
        ))}
      </ul>

      {/* A static wrapper, so an absolutely-positioned interior still resolves
          against the stage and costs no layout — it exists to hold the one
          thing on this instrument the face cannot delay for itself. The
          interior arrives once the day is round it: it is the answer, and an
          answer before the question is a clock with a ring drawn round it
          afterwards. */}
      <div
        data-export-readout
        className={intro ? "intro-in" : undefined}
        style={
          intro ? { animationDelay: `${INTRO_SWEEP_MS}ms`, animationDuration: "620ms" } : undefined
        }
      >
        <CenterPanel
          day={day}
          now={now}
          occurrences={occurrences}
          calendars={calendars}
          u={u}
          settings={settings}
          ambient={ambient}
          dailyNote={dailyNote}
          moon={
            moon && moonAt !== "sidebar" ? (
              <MoonPanel day={day} theme={theme} compact u={moonAt === "center" ? u : 1.3} />
            ) : null
          }
          drag={
            draw && draw.sweep !== 0 ? drawnSpan(draw, day) : adjust ? dragSpan(adjust, day) : null
          }
          hovered={active}
          onHover={setHovered}
          onOpen={onOpen}
          onToggleDone={onToggleDone}
        />
      </div>
    </div>
  );
}
