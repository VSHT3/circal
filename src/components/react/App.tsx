/* ------------------------------------------------------------------ *
 * The shell. Owns the view state (which day, which view, sidebar, which
 * overlay is up) and nothing else — events live in the store, the clock lives
 * in `useNow`, geometry lives in `lib/dial`.
 *
 * The day and the view are also mirrored into the URL, which makes a day
 * linkable and a reload land where you left it. That is the only place view
 * state is persisted, and deliberately so: it belongs to the tab, not to you.
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Clock } from "@/lib/time";
import {
  NEVER,
  colorOf,
  dayAgenda,
  instantKey,
  repeats,
  type CalEvent,
  type Occurrence,
} from "@/lib/events";
import { draftEvent, store, taskDraft, useStore } from "@/lib/store";
import { exportBackup, exportIcs, importFile } from "@/lib/backup";
import { cue } from "@/lib/feedback";
import { placeForZone } from "@/lib/places";
import { refreshFeed, refreshStaleFeeds } from "@/lib/feeds";
import { notify } from "@/lib/notify";
import { DEFAULT_DURATION, defaultStart } from "@/lib/quickadd";
import {
  MINUTES_PER_DAY,
  addDays,
  dayKey,
  formatRelativeDay,
  formatTime,
  fromDayKey,
  isSameDay,
  mondayOffset,
  startOfDay,
} from "@/lib/time";
import { LIFE_META_H, lifeDot, lifeStage } from "@/lib/life";
import { weekFaceCentre, weekStage, weekZoomScale } from "@/lib/week";
import { EASE, MODE_MS, UNROLL_IN_MS, UNROLL_OUT_MS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  useElementSize,
  useHotkeys,
  useIdle,
  useIdleAfter,
  useNow,
  useOnInput,
  useReminders,
  useTypingSound,
  useWakeLock,
} from "./hooks";
import type {
  AmbientMode,
  EditScope,
  EditorTarget,
  ShellActions,
  ViewFlow,
  ViewMode,
  ZoomFrame,
} from "./types";
import CalendarEditor from "./CalendarEditor";
import CommandPalette from "./CommandPalette";
import Dial, { type DragPreview } from "./Dial";
import EventEditor from "./EventEditor";
import LifeView from "./LifeView";
import Settings from "./Settings";
import Sidebar, { SIDEBAR_W } from "./Sidebar";
import { ScopeDialog } from "./ScopePrompt";
import Toast from "./Toast";
import TopBar from "./TopBar";
import YearView from "./YearView";
import WeekView from "./WeekView";

/* ------------------------------- transitions ------------------------------- */

/**
 * The padding of a view panel, as a number. It is `p-2` in the class list and
 * 8 here because the zoom needs a *point*: the life grid's geometry is resolved
 * against the panel's content box, and the transform origin is measured from
 * the panel's border box.
 */
const PANEL_PAD = 8;

/**
 * The top bar's height, as a number. It is `h-12` in `TopBar`'s own class list
 * and 48 here because ambient animates the bar away, and a height cannot be
 * transitioned from a utility class to nothing.
 */
const TOP_BAR_H = 48;

/**
 * How long ambient ignores input after arriving on its own. Withdrawing the
 * chrome moves the layout under a parked cursor, and the browser reports that
 * as a pointer that moved — so the mode would arrive and leave in one frame.
 */
const AUTO_AMBIENT_GRACE_MS = 500;

/**
 * Day ⇄ life is the one pair that *zooms*, because it is the one pair where
 * the same thing is drawn at two scales: the dial *is* the dot it lands on.
 */
function zoomsOut(flow: ViewFlow): boolean {
  return flow.from === "day" && flow.to === "life";
}

function zoomsIn(flow: ViewFlow): boolean {
  return flow.from === "life" && flow.to === "day";
}

/**
 * Year ⇄ life *unrolls*, on a stricter identity still: a year in day order
 * round a circle is a row of the life grid rolled up. `YearView` draws both
 * halves on its own canvas and holds its unmount open with `usePresence`, so
 * all the shell has to do here is keep the panels out of the way — no fade
 * over the top of a transition that is already showing you the whole thing.
 *
 * Day ⇄ year is neither, and crossfades: a day is not a magnified year and it
 * is not a rolled-up one either.
 */
function unrollsOut(flow: ViewFlow): boolean {
  return flow.from === "year" && flow.to === "life";
}

function unrollsIn(flow: ViewFlow): boolean {
  return flow.from === "life" && flow.to === "year";
}

/**
 * Day ⇄ week zooms too, and on the same identity: the grid's face for the day
 * you are on *is* the dial, a few times smaller. Crossfading it would be the
 * one transition in the app that throws away a geometric relationship it has.
 *
 * It is a separate pair from the life zoom because the distance is different by
 * two orders of magnitude — 1 → ~0.4 rather than 1 → 0.008 — so it takes one
 * eased tween where `ZOOM_STEPS`' geometric ladder would read as a stutter.
 * Week ⇄ year and week ⇄ life are crossfades: a week is not a magnified year
 * and a row of the life grid is not seven dials.
 */
function stepsOut(flow: ViewFlow): boolean {
  return flow.from === "day" && flow.to === "week";
}

function stepsIn(flow: ViewFlow): boolean {
  return flow.from === "week" && flow.to === "day";
}

/**
 * The dial's scale, from full to the size of one dot, in five geometric steps.
 *
 * Interpolating scale linearly is what makes most "zoom" animations feel
 * wrong: apparent size is linear in scale, so the thing hangs at full size and
 * then vanishes in the last few frames. Equal *ratios* between keyframes give
 * a constant rate of zoom — every step is a third of what came before — and
 * the uneven `times` spend the last stretch of the duration on the smallest
 * step, which is the settle.
 */
const ZOOM_STEPS = [1, 0.3, 0.09, 0.027, 0.008] as const;
const ZOOM_OUT_TIMES = [0, 0.34, 0.58, 0.79, 1] as const;
const ZOOM_IN_TIMES = [0, 0.21, 0.42, 0.66, 1] as const;
/** Long, and deliberately so: it is a change of scale of two orders of
 *  magnitude, and at half a second that reads as a glitch rather than as a
 *  move. Both halves are timed against the life view's wave. */
const ZOOM_OUT = { duration: 0.85, ease: "linear" as const, times: [...ZOOM_OUT_TIMES] };
const ZOOM_IN = { duration: 0.8, delay: 0.3, ease: "linear" as const, times: [...ZOOM_IN_TIMES] };

/**
 * The week's step, which is a zoom of about three times rather than of two
 * orders of magnitude — so one eased tween, not a ladder. The dial holds full
 * opacity for most of the way and gives up only at the end, over the face it
 * has landed on: it is the same day at two sizes, and the handover should read
 * as one shape settling rather than as two pictures crossing.
 */
const STEP_MS = 0.52;
const STEP_OUT = {
  duration: STEP_MS,
  ease: EASE,
  opacity: { duration: STEP_MS, times: [0, 0.72, 1], ease: "linear" as const },
};
const STEP_IN = {
  duration: STEP_MS,
  ease: EASE,
  opacity: { duration: STEP_MS, times: [0, 0.3, 1], ease: "linear" as const },
};

/**
 * What a panel does when it arrives and when it leaves. Both are dynamic
 * variants, so they are resolved against `flow.current` at the moment the
 * animation starts rather than at the render that scheduled it — for `exit`
 * that is the whole point, since by then the panel's own props are frozen.
 */
const PANEL = {
  initial: (flow: RefObject<ViewFlow>) => {
    if (zoomsIn(flow.current)) return { opacity: 0, scale: ZOOM_STEPS[ZOOM_STEPS.length - 1] };
    if (stepsIn(flow.current)) {
      // Already the size and in the place of the face it is growing out of,
      // so the first frame of the dial *is* the last frame of that face.
      const { scale, dx, dy } = flow.current.face;
      return { opacity: 0, scale, x: dx, y: dy };
    }
    // The ring arrives already drawn, on the canvas, exactly over the dots it
    // is lifting off. Fading it up would dim the one frame that has to match.
    if (unrollsIn(flow.current)) return { opacity: 1, scale: 1 };
    return { opacity: 0, scale: 1 };
  },
  active: (flow: RefObject<ViewFlow>) => {
    if (zoomsIn(flow.current)) {
      // The dial grows out of the dot it left from, fading up early so it is
      // a dial arriving rather than a dot inflating.
      return {
        opacity: [0, 1, 1, 1, 1],
        scale: [...ZOOM_STEPS].reverse(),
        transition: ZOOM_IN,
      };
    }
    if (stepsIn(flow.current)) {
      return { opacity: [0, 1, 1], scale: 1, x: 0, y: 0, transition: STEP_IN };
    }
    if (unrollsIn(flow.current)) return { opacity: 1, scale: 1, transition: { duration: 0 } };
    return {
      opacity: 1,
      scale: 1,
      // Arriving over a dial that is collapsing: wait for it, or the two
      // fades cross in the middle and both look like ghosts.
      //
      // Arriving under an unrolling ring costs more waiting still. The ring
      // is the same greys the grid is, so against thirty thousand dots the
      // whole movement is invisible — it has to happen on black, and the grid
      // comes up as the days settle onto it.
      //
      // The week is the exception, and waits for nothing: the dial is landing
      // *on* one of its faces, so that face has to already be there.
      transition: {
        duration: stepsOut(flow.current) ? STEP_MS : 0.45,
        delay: unrollsOut(flow.current) ? 0.44 : zoomsOut(flow.current) ? 0.18 : 0,
        ease: EASE,
      },
    };
  },
  exit: (flow: RefObject<ViewFlow>) => {
    if (zoomsOut(flow.current)) {
      // Held opaque until it is genuinely small: a dial that fades while it
      // is still large looks like it is being switched off, not moved.
      return {
        opacity: [1, 1, 0.9, 0.5, 0],
        scale: [...ZOOM_STEPS],
        pointerEvents: "none" as const,
        transition: ZOOM_OUT,
      };
    }
    if (stepsOut(flow.current)) {
      // Scaled and translated rather than scaled about a `transform-origin`,
      // because the origin on this panel belongs to the life zoom — see
      // `originPoint`, which is what corrects `dx`/`dy` for it.
      const { scale, dx, dy } = flow.current.face;
      return {
        opacity: [1, 1, 0],
        scale,
        x: dx,
        y: dy,
        pointerEvents: "none" as const,
        transition: STEP_OUT,
      };
    }
    if (unrollsOut(flow.current)) {
      // Neither fades nor shrinks: the canvas inside is drawing the whole
      // transition, and a fade over it would only take contrast off it.
      // `usePresence` in `YearView` is what actually holds the unmount.
      return {
        opacity: 1,
        scale: 1,
        pointerEvents: "none" as const,
        transition: { duration: UNROLL_OUT_MS / 1000 },
      };
    }
    // The week leaving under a dial that is growing out of one of its faces
    // keeps its scale: shrinking by 3% would drag that face out from under
    // the shape claiming to be it. Everything else settles back as it goes.
    return {
      opacity: 0,
      scale: stepsIn(flow.current) ? 1 : 0.97,
      pointerEvents: "none" as const,
      // Leaving under a ring rolling up: gone by the time the row it lifted
      // off would be missed, and not before.
      transition: {
        duration: unrollsIn(flow.current)
          ? UNROLL_IN_MS / 1600
          : stepsIn(flow.current)
            ? STEP_MS
            : 0.3,
        ease: EASE,
      },
    };
  },
} as const;

/* ---------------------------------- url ----------------------------------- */

interface ViewLocation {
  day: Date;
  view: ViewMode;
}

/** The views that are named in the URL — `day` is the one that is not. */
const VIEWS = ["week", "year", "life"] as const;

function readLocation(): ViewLocation {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("d");
  // A malformed `?d=` is a typo in a shared link, not a reason to show a dial
  // labelled "Invalid Date".
  const parsed = key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? fromDayKey(key) : null;
  return {
    day: parsed && !Number.isNaN(parsed.getTime()) ? parsed : startOfDay(new Date()),
    view: VIEWS.find((v) => v === params.get("v")) ?? "day",
  };
}

/**
 * `push` for a deliberate jump, `replace` for stepping. Holding ← would
 * otherwise bury the previous page under a hundred history entries, and the
 * back button would stop being a way out of the app.
 */
function writeLocation({ day, view }: ViewLocation, mode: "push" | "replace") {
  const params = new URLSearchParams();
  params.set("d", dayKey(day));
  if (view !== "day") params.set("v", view);
  const url = `${window.location.pathname}?${params}`;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

/* --------------------------------- editing --------------------------------- */

/**
 * The scope an edit actually lands on. Cutting a series at its own first
 * occurrence would leave a head that generates nothing, so "this and all
 * future" means "the whole series" there — and the whole series is the answer
 * that keeps it one event rather than two, one of them dead.
 */
function effectiveScope(scope: EditScope, seedMs: number, at: number): EditScope {
  return scope === "future" && at <= seedMs ? "all" : scope;
}

/**
 * A draft's instants moved off the series' seed and onto the occurrence being
 * edited. The editor hands back the *series'* instants, sitting on its seed's
 * own day, so without this, changing Tuesday's time writes onto whichever day
 * the series happens to start on. A draft whose date the user changed by hand
 * is left where they put it: they named an absolute day, and moving it again
 * would be answering a question nobody asked.
 */
function onOccurrence(draft: Omit<CalEvent, "id">, seedMs: number, at: number) {
  const seedDay = startOfDay(new Date(seedMs)).getTime();
  const keptDate = startOfDay(new Date(draft.start)).getTime() === seedDay;
  const shift = keptDate ? startOfDay(new Date(at)).getTime() - seedDay : 0;
  return { start: draft.start + shift, end: draft.end + shift };
}

/**
 * A gesture that has landed on a repeating event and is waiting to be told
 * what it meant. Nothing has been written by the time it appears: a move holds
 * its new position on `preview` alone, and a delete has touched nothing at
 * all, so cancelling either is a matter of dropping this.
 *
 * One union and one card rather than a state each, because the question is the
 * same question — two copies of it would be two vocabularies for one press,
 * which is the mistake `ScopeChoices` exists to prevent.
 */
type ScopeAsk =
  | {
      kind: "move";
      occ: Occurrence;
      /** The dial's own deltas: an end each for a resize, both for a move. */
      startDeltaMin: number;
      endDeltaMin: number;
    }
  | { kind: "delete"; occ: Occurrence };

/** Where the pending gesture leaves its occurrence, in the app's clock — the
 *  line the scope card prints, because the card covers the readout that would
 *  otherwise be saying it. A delete moves nothing, so it prints where the
 *  occurrence already is. */
function askSpan(ask: ScopeAsk, clock: Clock): string {
  const { occ } = ask;
  const shift = ask.kind === "move" ? ask : { startDeltaMin: 0, endDeltaMin: 0 };
  const start = new Date(occ.start.getTime() + shift.startDeltaMin * 60_000);
  const end = new Date(occ.end.getTime() + shift.endDeltaMin * 60_000);
  const day = isSameDay(start, occ.start) ? "" : `${formatRelativeDay(start)} · `;
  return `${day}${formatTime(start, clock)} – ${formatTime(end, clock)}`;
}

export default function App() {
  const { events, calendars, feeds, settings } = useStore();
  /**
   * Ambient: the chrome withdraws and the dial becomes the window. View state
   * and deliberately not a setting — a mode that survives a reload, with no
   * chrome on screen to say how to leave it, is a trap rather than a feature.
   *
   * Three values rather than a boolean, because how it arrived decides how it
   * leaves. Asked for, it stays until it is dismissed: the pointer is how you
   * use the dial, and a mode that fell over at a mouse movement could not be
   * dragged on. Arrived on its own, it is a screensaver and leaves like one,
   * at the first sign of anybody being there.
   */
  const [ambient, setAmbient] = useState<AmbientMode>("off");
  const inAmbient = ambient !== "off";
  /**
   * One tick a minute, for the whole tree.
   *
   * Nothing in circal prints a second: `splitTime` is `HH:MM`, `untilText` and
   * `formatDuration` round to the minute, and the hand is `minutesOfDay`. A
   * one-second clock therefore woke Dial, Sidebar, CenterPanel, YearView and
   * LifeView 3,600 times an hour to redraw pixels that were already right.
   *
   * Nothing lands late either, because `useNow` aligns to its own period: a
   * 60,000ms tick fires at `:00` of each minute, which is exactly the instant
   * every one of those strings changes. The single number finer than this is
   * the life view's percentage, and it carries its own clock in the leaf that
   * prints it.
   */
  const now = useNow(60_000);
  const reducedMotion = useReducedMotion();

  const [location, setLocation] = useState<ViewLocation>(() => readLocation());
  const { day, view } = location;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The query lighting the life grid. Held here rather than in the palette
   * because the thread outlives it: ⌘P closes and the field stays lit, so the
   * answer can be read at the size it is drawn.
   */
  const [lifeSearch, setLifeSearch] = useState("");
  // Opening the palette starts a fresh search, so the box and the field always
  // say the same thing. Adjusted during render rather than in an effect, as
  // everywhere else in this repo that new props must reset local state.
  const [searchSeeded, setSearchSeeded] = useState(paletteOpen);
  if (searchSeeded !== paletteOpen) {
    setSearchSeeded(paletteOpen);
    if (paletteOpen) setLifeSearch("");
  }
  /** The pointer, parked. An arrow over a desk clock is the one piece of
   *  chrome the mode cannot remove by not rendering it. */
  const cursorIdle = useIdle(inAmbient, 2000);
  useWakeLock(inAmbient);

  /**
   * The arc the dial has hold of, at where the drag has it. Held here rather
   * than in the dial because the day's agenda is what has to know: fold it in
   * and a drag becomes a preview of its own result — lanes repack around it,
   * an event dragged into the day is clipped to it, and the sidebar and the
   * readout say what the release is about to make true.
   *
   * Never written to the store. A gesture in flight is not data, and the
   * dial clears it on release, on Escape, and on being unmounted.
   */
  const [preview, setPreview] = useState<DragPreview | null>(null);

  /** A move or a delete on a repeating event, waiting on its scope. */
  const [ask, setAsk] = useState<ScopeAsk | null>(null);

  /** The calendar card's target: an id to edit, or `null` for a new one. The
   *  calendar itself is resolved from the store every render, so one edited in
   *  another tab simply updates under the card. */
  const [calendarEditor, setCalendarEditor] = useState<{ id: string | null } | null>(null);

  /**
   * Everything the dial draws: what you wrote plus what you subscribed to.
   * A feed's events are merged only for reading — every mutation still goes
   * through `store.events`, which is why they are two lists in the snapshot.
   */
  const visible = useMemo(
    () => (Object.keys(feeds).length === 0 ? events : [...events, ...Object.values(feeds).flat()]),
    [events, feeds],
  );

  /** `visible`, with the dragged event where the drag has it. */
  const previewed = useMemo(
    () =>
      preview
        ? visible.map((e) =>
            e.id === preview.id ? { ...e, start: preview.start, end: preview.end } : e,
          )
        : visible,
    [visible, preview],
  );

  const agenda = useMemo(() => dayAgenda(previewed, calendars, day), [previewed, calendars, day]);
  const defaultCalendar = calendars.find((c) => !c.feed)?.id ?? "personal";
  const feedIds = useMemo(
    () => new Set(calendars.filter((c) => c.feed).map((c) => c.id)),
    [calendars],
  );

  /**
   * The second zone's coordinates, for its own band. `null` when the zone has
   * no place behind it — the picker offers every zone the browser knows, and
   * a handful of those (`UTC`, and aliases like `Asia/Calcutta`) are not in
   * the coordinate table.
   */
  const zonePlace = useMemo(
    () => (settings.secondZone ? placeForZone(settings.secondZone) : null),
    [settings.secondZone],
  );

  /**
   * The stage: the box a view panel gets, and the life grid resolved against
   * it. Both live here rather than in `LifeView` because the zoom needs a day's
   * dot in screen coordinates *while the grid is not mounted yet* — the dial
   * has to know where it is going before the thing it is going to exists.
   */
  const [stageRef, stageWidth, stageHeight] = useElementSize<HTMLElement>();
  const stage = useMemo(
    () =>
      lifeStage(
        settings.birth,
        settings.lifeExpectancy,
        stageWidth - 2 * PANEL_PAD,
        stageHeight - 2 * PANEL_PAD,
      ),
    [settings.birth, settings.lifeExpectancy, stageWidth, stageHeight],
  );

  /** The week grid, resolved against the same box and for the same reason:
   *  the dial has to know which face it is shrinking onto before the grid
   *  that draws that face exists. */
  const weekBox = useMemo(
    () => weekStage(day, stageWidth - 2 * PANEL_PAD, stageHeight - 2 * PANEL_PAD),
    [day, stageWidth, stageHeight],
  );

  /**
   * Whether the sidebar can afford to push, measured rather than guessed at
   * with a breakpoint.
   *
   * The dial is height-bound on any stage wider than it is tall, so taking
   * 260px off the width there costs the instrument *nothing* — the face does
   * not even shrink. The moment the stage would become width-bound, every
   * pixel the column takes comes straight out of the face, and that is the
   * condition. It is not "is this a phone": a tablet in portrait is 1024px
   * wide and still cannot afford it, and a half-screen desktop window flips
   * over at exactly the point where it starts to hurt.
   *
   * Measured on the *row* rather than on `main`, which is already the pushed
   * width — asking `main` would shrink the stage, flip the answer to drawer,
   * un-shrink it, and oscillate. Nobody sees the pre-measurement frame,
   * because the sidebar starts closed.
   */
  const [rowRef, rowWidth, rowHeight] = useElementSize<HTMLDivElement>();
  const sidebarMode = rowWidth > 0 && rowWidth - SIDEBAR_W < rowHeight ? "drawer" : "push";

  /**
   * Where the zoom meets the grid: the selected day's dot, in the panel's own
   * coordinates. That is the day you were looking at on the dial on the way
   * out, and the day you just clicked on the way back — so the dial always
   * lands on, and leaves from, the day it is actually showing.
   */
  const originPoint = stage ? lifeDot(stage.layout, stage.span, day) : null;
  const origin = originPoint
    ? `${PANEL_PAD + originPoint.x}px ${PANEL_PAD + LIFE_META_H + originPoint.y}px`
    : "center";

  /**
   * Where the zoom meets the week: the same day's face, as a transform of the
   * whole panel.
   *
   * The panel already carries a `transform-origin` — the life dot — and the
   * dial has to land on its face whatever that origin happens to be, so the
   * translation is solved for rather than assumed. Under `scale(s)` about an
   * origin `o`, a point `c` lands at `o + (c - o) * s`; putting the panel's
   * own centre on the face's centre `f` therefore needs `t = f - o - (c - o) * s`.
   * One panel, one origin, two zooms that both land exactly.
   */
  const face = useMemo<ZoomFrame>(() => {
    if (!weekBox) return { scale: 1, dx: 0, dy: 0 };
    const { layout, box } = weekBox;
    const centre = weekFaceCentre(layout, mondayOffset(day));
    // Border-box coordinates throughout: `transform-origin` resolves against
    // the padded box, and the panel's padding is what `PANEL_PAD` names.
    const scale = weekZoomScale(layout, box.width, box.height);
    const f = { x: PANEL_PAD + centre.x, y: PANEL_PAD + centre.y };
    const o = originPoint
      ? { x: PANEL_PAD + originPoint.x, y: PANEL_PAD + LIFE_META_H + originPoint.y }
      : { x: stageWidth / 2, y: stageHeight / 2 };
    const c = { x: stageWidth / 2, y: stageHeight / 2 };
    return {
      scale,
      dx: f.x - o.x - (c.x - o.x) * scale,
      dy: f.y - o.y - (c.y - o.y) * scale,
    };
  }, [weekBox, day, originPoint, stageWidth, stageHeight]);

  /**
   * The location as of *now*, not as of the render this callback was made in.
   *
   * `goDay` and `openEvent` fire back to back from the palette, and with the
   * values closed over at render time the second call would merge against the
   * pre-jump day and push it straight back on top of the first.
   *
   * Kept in step by its only two writers — `go` and the popstate handler —
   * rather than assigned during render, which the hooks lint rejects.
   */
  const current = useRef(location);

  /**
   * The view change in progress. A ref, because the two halves of the zoom are
   * driven by elements that are *leaving* — the panel's `exit` variant and the
   * life view's `usePresence` — and a leaving element's props are frozen at its
   * last render, which is one render too early to know what is arriving.
   */
  const flow = useRef<ViewFlow>({ from: view, to: view, day, face });

  /**
   * The face frame, kept on the flow ref because the element that applies it
   * is the one leaving. Written from an effect rather than during render —
   * the same bargain `channels` makes — and carried across every wholesale
   * reassignment of `flow.current` below, which is why it also lives in a ref
   * of its own.
   */
  const faceFrame = useRef(face);
  useEffect(() => {
    faceFrame.current = face;
    flow.current.face = face;
  }, [face]);

  const go = useCallback((next: Partial<ViewLocation>, mode: "push" | "replace" = "push") => {
    // Derived and written outside the state updater: an updater has to be
    // pure, and StrictMode runs it twice.
    const merged = { ...current.current, ...next };
    flow.current = {
      from: current.current.view,
      to: merged.view,
      day: merged.day,
      face: faceFrame.current,
    };
    current.current = merged;
    writeLocation(merged, mode);
    setLocation(merged);
  }, []);

  // Back/forward. The listener is the external system; the state follows it.
  useEffect(() => {
    const onPopState = () => {
      const restored = readLocation();
      flow.current = {
        from: current.current.view,
        to: restored.view,
        day: restored.day,
        face: faceFrame.current,
      };
      current.current = restored;
      setLocation(restored);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    // The URL starts bare, so stamp the day we resolved to — otherwise the
    // first ← would push a second entry for a page that never had one.
    writeLocation(readLocation(), "replace");
    // Subscriptions are a mirror: pulled once on launch, then left alone.
    // Read through `store.snapshot()`, because this closure was made on the
    // first render, before `useSyncExternalStore` hydrated the real one.
    void refreshStaleFeeds(store.snapshot().calendars);
  }, []);

  /**
   * Ambient, and the fullscreen it does not take on its own.
   *
   * `f` withdraws the chrome; `⇧f` does that and asks for the screen as well,
   * because hijacking the whole display from a bare keypress surprises people
   * and the mode is worth having either way. Only the day view has an
   * instrument to show, so entering from a grid brings the dial with it.
   */
  const enterAmbient = useCallback(
    (mode: AmbientMode, fullscreen = false) => {
      if (mode !== "off" && current.current.view !== "day") go({ view: "day" });
      setAmbient(mode);
      if (!fullscreen) return;
      const root = document.documentElement;
      // Both are rejected rather than thrown outside a user gesture, and
      // neither exists in every browser that renders the rest of this.
      if (mode !== "off") void root.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    },
    [go],
  );

  /**
   * Leaving fullscreen leaves ambient. Escape inside fullscreen is taken by
   * the browser before the page ever sees the keydown, so without this the
   * first press appears to do nothing and the mode needs two to exit.
   */
  useEffect(() => {
    if (!inAmbient) return;
    const onChange = () => {
      if (!document.fullscreenElement) setAmbient("off");
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [inAmbient]);

  /**
   * The mode arriving on its own, and leaving the same way.
   *
   * Armed only on the dial, with nothing open: a timer that swapped the view
   * out from under a grid would lose the year you were reading, and one that
   * fired over a half-finished event would be a data loss dressed as a
   * screensaver. Both conditions read as "there is nothing here to interrupt".
   */
  const busy =
    paletteOpen || settingsOpen || editor !== null || ask !== null || calendarEditor !== null;
  /**
   * `busy` plus the one panel that has no state on it but does cover the
   * face. The two questions are not the same: ← under an open editor would
   * step the day out from under unsaved work, which is why `busy` gates the
   * hotkeys, while an open drawer only means the instrument is not reachable
   * — which is what the ambient timer and the dial's own ⌘⌫ ask about.
   */
  const shaded = busy || (sidebarMode === "drawer" && sidebarOpen);
  useIdleAfter(
    inAmbient || shaded || view !== "day" ? 0 : settings.ambientAfter * 60_000,
    useCallback(() => setAmbient("auto"), []),
  );
  useOnInput(
    ambient === "auto",
    useCallback(() => setAmbient("off"), []),
    AUTO_AMBIENT_GRACE_MS,
  );

  /** The sound channels, as every cue in the shell wants them. */
  const channels = useMemo(
    () => ({ sound: settings.tickSound, haptics: settings.tickHaptics }),
    [settings.tickSound, settings.tickHaptics],
  );

  const openDraft = useCallback(
    (startMin: number, endMin: number, on: Date) => {
      setPaletteOpen(false);
      // A modal over the desk clock is neither: the editor is a working
      // surface and it wants the chrome it was designed beside.
      setAmbient("off");
      setEditor({ id: null, draft: draftEvent(on, startMin, endMin, defaultCalendar) });
    },
    [defaultCalendar],
  );

  /**
   * The open editor's draft, kept on the target so the face behind the modal can
   * draw the event that does not exist yet — the range you dragged stays lit and
   * answers the swatch you are picking.
   *
   * Returning the same target when nothing the faces care about moved is what
   * makes this affordable: React bails out of an identical state value, so
   * typing a title costs no render at all, let alone a canvas repaint.
   */
  const trackDraft = useCallback((next: Omit<CalEvent, "id">) => {
    setEditor((open) => {
      if (!open) return open;
      const live = open.live ?? open.draft;
      if (
        live.start === next.start &&
        live.end === next.end &&
        live.allDay === next.allDay &&
        live.task === next.task &&
        live.color === next.color &&
        live.calendarId === next.calendarId
      ) {
        return open;
      }
      const { start, end, allDay, task, color, calendarId } = next;
      return { ...open, live: { start, end, allDay, task, color, calendarId } };
    });
  }, []);

  /**
   * The event about to exist, resolved once for whichever face is behind the
   * modal — the dial takes it in instants, the year ring in days.
   *
   * `null` for an existing event: it already has an arc and marks of its own,
   * and a preview over them would draw the same event twice. Memoised because
   * the ring repaints on it, and a fresh object every render would repaint that
   * canvas on every clock tick.
   */
  const pending = useMemo(() => {
    if (!editor || editor.id !== null) return null;
    const mark = editor.live ?? editor.draft;
    const { start, end, allDay, task } = mark;
    return { start, end, allDay, task, color: colorOf(mark, calendars) };
  }, [editor, calendars]);

  /** The same draft as the year ring wants it: the two days it runs between,
   *  inclusive. `end` is exclusive, so the last day is measured from `end - 1`
   *  — the same reason `dayCount` is. */
  const pendingDays = useMemo(
    () =>
      pending && {
        from: startOfDay(new Date(pending.start)),
        // A task is one day, and `end - 1` on a zero-width instant would name
        // the day before it.
        to: startOfDay(new Date(Math.max(pending.start, pending.end - 1))),
        color: pending.color,
      },
    [pending],
  );

  const actions: ShellActions = useMemo(
    () => ({
      goToday: () => go({ day: startOfDay(new Date()), view: "day" }),
      // Naming a day means you want to look at it: the year grid is never the
      // answer to "go to Dec 25", and one call is one history entry.
      goDay: (next: Date) => go({ day: startOfDay(next), view: "day" }),
      setView: (next: ViewMode) => go({ view: next }),
      toggleSidebar: () => setSidebarOpen((open) => !open),
      openPalette: () => setPaletteOpen(true),
      openSettings: () => {
        setPaletteOpen(false);
        setSettingsOpen(true);
      },
      setClock: (clock: Clock) => store.setClock(clock),
      toggleCalendar: (id: string) => store.toggleCalendar(id),
      newCalendar: () => {
        setPaletteOpen(false);
        setAmbient("off");
        setCalendarEditor({ id: null });
      },
      editCalendar: (id: string) => {
        setPaletteOpen(false);
        setAmbient("off");
        setCalendarEditor({ id });
      },
      openEvent: (event: CalEvent) => {
        const { id, ...draft } = event;
        setPaletteOpen(false);
        setAmbient("off");
        setEditor({ id, draft, readOnly: feedIds.has(event.calendarId) });
      },
      newEvent: () => {
        // The hour a draft opens on is `defaultStart`'s answer, shared with
        // quick-add: two ways of adding an event must not disagree about when.
        const start = defaultStart(day, DEFAULT_DURATION);
        openDraft(start, start + DEFAULT_DURATION, day);
      },
      newTask: () => {
        setPaletteOpen(false);
        setAmbient("off");
        // The same hour ⌘N opens on, with no width. `defaultStart` is asked
        // for a duration of zero because a task has none, which on today is
        // the next quarter hour and on any other day is nine o'clock.
        setEditor({
          id: null,
          draft: taskDraft(day, defaultStart(day, 0), defaultCalendar),
        });
      },
      newEventAt: (startMin: number, endMin: number) => openDraft(startMin, endMin, day),
      quickAdd: (spec) => {
        store.create({
          ...draftEvent(spec.day, spec.startMin, spec.endMin, defaultCalendar),
          title: spec.title,
          // `null` for the lines that named no rule, which is most of them.
          ...spec.repeat,
        });
        setPaletteOpen(false);
        // Land on the day it went to. An event created off-screen is a claim
        // rather than a result, and the dial is what makes it a result — which
        // is also the only review this gesture gets.
        go({ day: spec.day, view: "day" });
        cue("created", channels);
        notify(`Added “${spec.title}” — ⌘Z to undo`);
      },
      undo: () => notify(store.undo() ? "Undone" : "Nothing to undo"),
      redo: () => notify(store.redo() ? "Redone" : "Nothing to redo"),
      exportIcs: () => exportIcs(store.snapshot()),
      exportBackup: () => exportBackup(store.snapshot()),
      importFile,
      refreshFeeds: () => {
        const subscriptions = calendars.filter((c) => c.feed);
        if (subscriptions.length === 0) return;
        notify(`Refreshing ${subscriptions.length} subscriptions…`);
        void Promise.all(subscriptions.map(refreshFeed));
      },
      toggleAmbient: () => enterAmbient(inAmbient ? "off" : "manual"),
    }),
    [day, go, openDraft, defaultCalendar, feedIds, calendars, inAmbient, enterAmbient, channels],
  );

  const step = useCallback(
    (delta: number) => {
      const from = current.current;
      // Stepping replaces rather than pushes: a held arrow key must not fill
      // the history stack with days you scrolled past.
      //
      // One screenful each time: a day on the dial, a week on its seven faces,
      // a year in the two grid views. The unit is whatever the view draws, so
      // a step always moves the picture by exactly the picture — in the week a
      // step of a day would shuffle the same seven faces along by one, which is
      // a different week only in the sense that it is not the one you asked
      // for.
      go(
        {
          day:
            from.view === "day"
              ? addDays(from.day, delta)
              : from.view === "week"
                ? addDays(from.day, delta * 7)
                : new Date(from.day.getFullYear() + delta, from.day.getMonth(), from.day.getDate()),
        },
        "replace",
      );
    },
    [go],
  );

  // Escape belongs to whatever is on top, so it is the one shortcut a panel
  // does not switch off.
  useHotkeys({
    escape: () => {
      // One key, one thing: a press that closed a panel has done its work,
      // and taking the mode down with it would be two. A lit life grid is the
      // next layer down — nothing is over it, so Escape is free to clear it.
      const panelled = busy;
      setPaletteOpen(false);
      setSettingsOpen(false);
      setEditor(null);
      if (panelled) return;
      // The drawer is the next layer down: it covers the face and it is the
      // only thing on screen, so Escape belongs to it before it belongs to a
      // lit grid or to ambient. In `push` mode it is not covering anything
      // and Escape is not its key.
      if (sidebarMode === "drawer" && sidebarOpen) {
        setSidebarOpen(false);
        return;
      }
      if (lifeSearch) {
        setLifeSearch("");
        return;
      }
      if (inAmbient) enterAmbient("off", true);
    },
  });

  // The rest are the shell's, and the shell is behind the panel: ← stepping
  // the day under an open editor is the same bug as ⌘Z undoing behind one.
  // A panel that wants one of these keeps it for itself — the palette closes
  // on its own ⌘P, since the copy here is off while it is up.
  useHotkeys(
    {
      "mod+p": () => setPaletteOpen((open) => !open),
      "mod+n": actions.newEvent,
      "mod+shift+n": actions.newTask,
      "mod+y": () => actions.setView("year"),
      "mod+d": () => actions.setView("day"),
      // ⌘E rather than the obvious ⌘W: Chrome, Safari and Firefox all close
      // the tab on ⌘W and none of them deliver the keydown, so a page cannot
      // take it. ⌘E is the same class as ⌘D, ⌘Y, ⌘L and ⌘P — a menu
      // equivalent, which this app already overrides four times over — and the
      // segment in the top bar prints the chip, so the mnemonic is not what
      // anybody finds it by.
      "mod+e": () => actions.setView("week"),
      "mod+b": actions.toggleSidebar,
      "mod+l": () => actions.setView("life"),
      "mod+,": actions.openSettings,
      "mod+z": actions.undo,
      "mod+shift+z": actions.redo,
      arrowleft: () => step(-1),
      arrowright: () => step(1),
      t: actions.goToday,
      f: () => enterAmbient(inAmbient ? "off" : "manual"),
      "shift+f": () => enterAmbient(inAmbient ? "off" : "manual", true),
    },
    !busy,
  );

  // Every field in the app, on the same switch as the dial's clicks: one
  // setting called Sound, because a user who turned the dial quiet did not
  // ask for a keyboard.
  useTypingSound(settings.tickSound);

  /**
   * The one thing in circal that speaks first. Driven off the same minute
   * tick everything else is — a reminder is a claim about a minute, and a
   * finer clock would only make the same claim more often.
   *
   * Clicking one lands on the event: the day first, then the editor, in that
   * order, because opening an editor over a day three weeks from the one it
   * belongs to is an answer with no context behind it.
   */
  useReminders({
    enabled: settings.remind,
    now,
    events: visible,
    calendars,
    lead: settings.remindLead,
    clock: settings.clock,
    onOpen: useCallback(
      (event: CalEvent) => {
        go({ day: startOfDay(new Date(event.start)), view: "day" });
        actions.openEvent(event);
      },
      [go, actions],
    ),
  });

  /**
   * A panel arriving says so, from wherever it was opened — ⌘P, the top bar,
   * or the palette handing over to settings. One effect per panel rather than a
   * cue at each call site, because there are four call sites and they would
   * drift; audio is an external system, which is what an effect is for.
   *
   * The channels come from a ref so that flipping Sound while a panel is open
   * does not re-announce it: a new object would run the effect again.
   */
  const channelsRef = useRef(channels);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  useEffect(() => {
    if (paletteOpen) cue("opened", channelsRef.current);
  }, [paletteOpen]);
  useEffect(() => {
    if (settingsOpen) cue("opened", channelsRef.current);
  }, [settingsOpen]);

  /**
   * A save, with the scope the editor asked for — one occurrence, this one and
   * everything after it, or the series entire. Only a repeating event is ever
   * asked; everything else arrives as `"all"`, which is the only thing it can
   * mean when there is one occurrence to write to.
   */
  const saveEvent = useCallback(
    (draft: Omit<CalEvent, "id">, scope: EditScope) => {
      if (!editor) return;
      if (!editor.id) {
        store.create(draft);
        // Only for a new event. Saving an edit changes something that already
        // existed; this cue is for the one moment something starts to.
        cue("created", channels);
        setEditor(null);
        return;
      }
      const at = editor.occurrenceStart ?? editor.draft.start;
      const seedMs = editor.draft.start;
      switch (effectiveScope(scope, seedMs, at)) {
        case "all":
          store.update(editor.id, draft);
          break;
        // RECURRENCE-ID's job: the edit becomes its own event rather than a
        // change to the series, and `NEVER` strips whatever recurrence fields
        // the draft still carries from the series it was seeded from — an
        // override is one occurrence, never a second series running alongside
        // the first.
        case "one":
          store.create({
            ...draft,
            ...NEVER,
            ...onOccurrence(draft, seedMs, at),
            seriesId: editor.id,
            seriesKey: instantKey(at),
          });
          cue("created", channels);
          break;
        // Two series, which is what "from here on" is: the old one stops the
        // instant before this occurrence and this one seeds a new rule.
        case "future":
          store.splitSeries(editor.id, at, { ...draft, ...onOccurrence(draft, seedMs, at) });
          cue("created", channels);
          break;
      }
      setEditor(null);
    },
    [editor, channels],
  );

  /**
   * A delete, with the same three scopes. "Only this one" writes an EXDATE and
   * removes nothing: the series still exists, it simply no longer lands there.
   */
  const deleteEvent = useCallback(
    (scope: EditScope) => {
      if (editor?.id) {
        const at = editor.occurrenceStart ?? editor.draft.start;
        const seedMs = editor.draft.start;
        switch (effectiveScope(scope, seedMs, at)) {
          case "all":
            store.remove(editor.id);
            break;
          case "one":
            store.update(editor.id, { exdates: [...editor.draft.exdates, instantKey(at)] });
            break;
          case "future":
            store.truncateSeries(editor.id, at);
            break;
        }
        // Falling, hollow, and two taps: the one cue that reports something
        // being taken away rather than put somewhere.
        cue("deleted", channels);
      }
      setEditor(null);
    },
    [editor, channels],
  );

  const openOccurrence = useCallback(
    (occ: Occurrence) => {
      const { id, ...draft } = occ.event;
      setPaletteOpen(false);
      setAmbient("off");
      setEditor({
        id,
        draft,
        readOnly: feedIds.has(occ.event.calendarId),
        occurrenceStart: occ.start.getTime(),
      });
    },
    [feedIds],
  );

  /**
   * An arc dragged on the dial, applied. The deltas are minutes. `"all"` puts
   * them on the event's own instants, so the seed moves and every occurrence
   * follows it; the other two measure from the occurrence that was actually
   * under the pointer, and leave the rest of the series where it was.
   *
   * An event dragged past midnight leaves the day, and the view has usually
   * followed it there already: the dial asks for the step itself as the drag
   * carries the arc through. The notice is for the case where it could not —
   * a multi-day event's clipped occurrence, whose visible ends are not the
   * event's own instants — because an arc that leaves the face without a word
   * reads as a deletion.
   */
  const commitAdjust = useCallback(
    (occ: Occurrence, startDeltaMin: number, endDeltaMin: number, scope: EditScope) => {
      const { id: _id, ...body } = occ.event;
      const at = occ.start.getTime();
      const moved = (ms: number, minutes: number) => ms + minutes * 60_000;
      const start = moved(at, startDeltaMin);
      const end = moved(occ.end.getTime(), endDeltaMin);
      // What the write actually landed on, which is what the notice is about:
      // the series' own seed for a whole-series move, this occurrence for the
      // two that only touch one.
      let landed = start;
      switch (effectiveScope(scope, occ.event.start, at)) {
        case "all":
          landed = moved(occ.event.start, startDeltaMin);
          store.update(occ.event.id, { start: landed, end: moved(occ.event.end, endDeltaMin) });
          break;
        case "one":
          store.create({
            ...body,
            ...NEVER,
            start,
            end,
            seriesId: occ.event.id,
            seriesKey: instantKey(at),
          });
          break;
        case "future":
          store.splitSeries(occ.event.id, at, { ...body, start, end });
          break;
      }
      if (!isSameDay(new Date(landed), day)) {
        notify(`Moved to ${formatRelativeDay(new Date(landed))} — ⌘Z to undo`);
      }
    },
    [day],
  );

  /**
   * The dial's release. A one-off is written there and then — the gesture said
   * everything it had to say. A repeating event is asked what the drag meant,
   * the same three ways the editor asks.
   */
  const adjustOccurrence = useCallback(
    (occ: Occurrence, startDeltaMin: number, endDeltaMin: number) => {
      if (!repeats(occ.event)) {
        commitAdjust(occ, startDeltaMin, endDeltaMin, "all");
        return;
      }
      setAsk({ kind: "move", occ, startDeltaMin, endDeltaMin });
      // The dial drops its preview the moment the pointer lifts. Re-arming it
      // here is what keeps the arc where the drag left it while the question
      // is up: springing back to the old position and then jumping again on
      // the answer reads as the gesture having failed.
      setPreview({
        id: occ.event.id,
        start: occ.event.start + startDeltaMin * 60_000,
        end: occ.event.end + endDeltaMin * 60_000,
      });
    },
    [commitAdjust],
  );

  /**
   * A delete, applied. The same three scopes the editor's Delete has, because
   * it is the same delete: "only this one" writes an EXDATE and removes
   * nothing — the series still exists, it simply no longer lands there.
   *
   * It always says so. The editor's Delete is two deliberate presses inside a
   * modal; this one can be a single keystroke over an arc, and a destructive
   * key with no receipt is a key nobody presses twice.
   */
  const removeOccurrence = useCallback(
    (occ: Occurrence, scope: EditScope) => {
      const at = occ.start.getTime();
      switch (effectiveScope(scope, occ.event.start, at)) {
        case "all":
          store.remove(occ.event.id);
          break;
        case "one":
          store.update(occ.event.id, { exdates: [...occ.event.exdates, instantKey(at)] });
          break;
        case "future":
          store.truncateSeries(occ.event.id, at);
          break;
      }
      cue("deleted", channels);
      notify(`Deleted “${occ.event.title || "Untitled"}” — ⌘Z to undo`);
    },
    [channels],
  );

  /** ⌘⌫ over an arc. A one-off goes; a repeating one is asked what the press
   *  meant, in the same card a drag gets. */
  const deleteOccurrence = useCallback(
    (occ: Occurrence) => {
      if (feedIds.has(occ.event.calendarId)) return;
      if (repeats(occ.event)) {
        setAsk({ kind: "delete", occ });
        return;
      }
      removeOccurrence(occ, "all");
    },
    [feedIds, removeOccurrence],
  );

  const answerAsk = useCallback(
    (scope: EditScope) => {
      if (!ask) return;
      setAsk(null);
      setPreview(null);
      if (ask.kind === "delete") {
        removeOccurrence(ask.occ, scope);
        return;
      }
      commitAdjust(ask.occ, ask.startDeltaMin, ask.endDeltaMin, scope);
    },
    [ask, commitAdjust, removeOccurrence],
  );

  /** Nothing was written while the question was up, so abandoning is just
   *  dropping the preview — and the arc is back where it started. */
  const cancelAsk = useCallback(() => {
    setAsk(null);
    setPreview(null);
  }, []);

  /**
   * A task ticked off, from the interior or from the editor.
   *
   * No `EditScope` question, and that is not an oversight: a repeating task's
   * ticks are per occurrence by construction (`doneKeys` holds the instants),
   * so "this one" is the only answer the gesture could have. Nothing to ask,
   * nothing to split.
   */
  const toggleDone = useCallback((occ: Occurrence) => {
    store.toggleDone(occ.event.id, occ.start);
  }, []);

  /**
   * The calendar card's subject, resolved from the store rather than copied
   * into the state that opened it: a rename landing from another tab updates
   * the card under you, and a calendar deleted out from under it takes the
   * card with it — `open` is false the moment the id resolves to nothing.
   */
  const editedCalendar = calendarEditor?.id
    ? (calendars.find((c) => c.id === calendarEditor.id) ?? null)
    : null;
  const calendarCardOpen = calendarEditor !== null && (!calendarEditor.id || !!editedCalendar);

  /** What deleting that calendar would cost, or `null` when it may not go.
   *  The rule is the store's — the last calendar that is not a feed stays —
   *  and it is mirrored here so the verb can be disabled rather than fail. */
  const calendarRemoval = useMemo(() => {
    if (!editedCalendar) return null;
    const into = calendars.find((c) => c.id !== editedCalendar.id && !c.feed);
    if (!editedCalendar.feed && !into) return null;
    const holds = events.filter((e) => e.calendarId === editedCalendar.id).length;
    if (holds > 0 && !into) return null;
    return { holds, into: into?.name ?? "" };
  }, [editedCalendar, calendars, events]);

  const saveCalendar = useCallback(
    (name: string, color: string, icon: string) => {
      if (editedCalendar) store.updateCalendar(editedCalendar.id, { name, color, icon });
      else store.addCalendar(name, color, icon);
      setCalendarEditor(null);
    },
    [editedCalendar],
  );

  /**
   * The card's Delete. The events are not deleted with it — `removeCalendar`
   * moves them to the calendar that is left — so the notice says where they
   * went: a colour disappearing off the face otherwise reads as a day's work
   * having gone with it.
   */
  const removeEditedCalendar = useCallback(() => {
    if (!editedCalendar) return;
    const gone = store.removeCalendar(editedCalendar.id);
    setCalendarEditor(null);
    if (!gone) return;
    cue("deleted", channels);
    notify(
      gone.moved > 0
        ? `Removed “${editedCalendar.name}” — ${gone.moved} event${gone.moved === 1 ? "" : "s"} moved to ${gone.into?.name} · ⌘Z to undo`
        : `Removed “${editedCalendar.name}” — ⌘Z to undo`,
    );
  }, [editedCalendar, channels]);

  return (
    <div
      className={cn(
        "relative flex h-dvh w-dvw flex-col overflow-hidden bg-void",
        inAmbient && cursorIdle && "cursor-none",
      )}
    >
      {/* The chrome does not vanish, it withdraws — and it leaves on the same
          beat the dial takes to grow into the space, because two curves would
          read as two events rather than as one movement. */}
      <motion.div
        className="shrink-0 overflow-hidden"
        initial={false}
        animate={{ height: inAmbient ? 0 : TOP_BAR_H, opacity: inAmbient ? 0 : 1 }}
        transition={reducedMotion ? { duration: 0 } : { duration: MODE_MS / 1000, ease: EASE }}
      >
        <TopBar day={day} view={view} sidebarOpen={sidebarOpen} onStep={step} actions={actions} />
      </motion.div>

      {/* `relative`, because the drawer and its scrim are absolute inside this
          row rather than over the whole app: the top bar stays above them, so
          the button that opened the drawer is still the button that closes
          it, and it needs no close verb of its own. */}
      <div ref={rowRef} className="relative flex min-h-0 flex-1">
        <Sidebar
          open={sidebarOpen && !inAmbient}
          mode={sidebarMode}
          day={day}
          now={now}
          events={visible}
          calendars={calendars}
          moonPhase={settings.moonPhase}
          actions={actions}
        />

        {/* One view at a time, and never abruptly. Day ⇄ life is a zoom: the
            dial collapses onto the dot of the day it is showing while the life
            grid's wave leaves that same dot, and back the other way. Everything
            else is a crossfade. `initial={false}` so a reload lands on its view
            without either.

            `transformOrigin` is a style rather than a variant because it must
            be right on the *frozen* render of a panel that is leaving — and it
            is, since it depends only on the selected day and the box.

            The exiting panel gives up its pointer events at once: for the best
            part of a second it is still on top of the incoming one, and a click
            landing on the view you just left is a bug you cannot see. */}
        <main ref={stageRef} className="relative min-w-0 flex-1">
          <AnimatePresence initial={false}>
            <motion.div
              key={view}
              className="absolute inset-0 p-2"
              style={{ transformOrigin: origin }}
              custom={flow}
              variants={reducedMotion ? undefined : PANEL}
              initial="initial"
              animate="active"
              exit="exit"
            >
              {view === "day" && (
                <Dial
                  day={day}
                  now={now}
                  occurrences={agenda.all}
                  calendars={calendars}
                  settings={settings}
                  zonePlace={zonePlace}
                  pending={pending}
                  onOpen={openOccurrence}
                  onCreate={(startMin, endMin) => openDraft(startMin, endMin, day)}
                  onAdjust={adjustOccurrence}
                  onDelete={deleteOccurrence}
                  onToggleDone={toggleDone}
                  onPreview={setPreview}
                  onStepDay={step}
                  ambient={inAmbient}
                  covered={shaded}
                />
              )}
              {view === "week" && (
                <WeekView
                  stage={weekBox}
                  now={now}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  settings={settings}
                  onSelectDay={(next) => actions.goDay(next)}
                  onOpenEvent={openOccurrence}
                />
              )}
              {view === "year" && (
                <YearView
                  year={day.getFullYear()}
                  today={now}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  settings={settings}
                  stage={stage}
                  flow={flow}
                  pending={pendingDays}
                  onSelectDay={(next) => actions.goDay(next)}
                  // A run of whole days, in the minutes `draftEvent` decides
                  // all-day by: the ring gesture and this one hand over to the
                  // same function, and the editor cannot tell which drew it.
                  onCreateSpan={(from, days) => openDraft(0, days * MINUTES_PER_DAY, from)}
                />
              )}
              {view === "life" && (
                <LifeView
                  stage={stage}
                  flow={flow}
                  birth={settings.birth}
                  expectancy={settings.lifeExpectancy}
                  now={now}
                  milestones={settings.milestones}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  search={lifeSearch}
                  onClearSearch={() => setLifeSearch("")}
                  onSelectDay={(next) => actions.goDay(next)}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* The way out, said once. A mode with no chrome on screen has to
          answer "how do I leave" itself, and it has to stop saying it — a
          permanent caption is chrome by another name. Remounted on every
          entry, so it plays again the next time and never during. */}
      {inAmbient && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center"
          initial={{ opacity: 0 }}
          animate={reducedMotion ? { opacity: 0 } : { opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3.4, times: [0, 0.1, 0.62, 1], ease: "linear" }}
        >
          <span className="label text-ink-3">Esc to exit</span>
        </motion.div>
      )}

      {editor && (
        <EventEditor
          target={editor}
          clock={settings.clock}
          calendars={calendars}
          onSave={saveEvent}
          onDelete={deleteEvent}
          onDraftChange={trackDraft}
          onClose={() => setEditor(null)}
        />
      )}

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        calendars={calendars}
        actions={actions}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        day={day}
        now={now}
        view={view}
        sidebarOpen={sidebarOpen}
        ambient={inAmbient}
        events={visible}
        calendars={calendars}
        occurrences={agenda.all}
        clock={settings.clock}
        inheritMarks={settings.inheritMarks}
        actions={actions}
        onSearchLife={setLifeSearch}
      />

      {calendarCardOpen && (
        <CalendarEditor
          target={editedCalendar}
          removal={calendarRemoval}
          onSave={saveCalendar}
          onDelete={removeEditedCalendar}
          onClose={() => setCalendarEditor(null)}
        />
      )}

      {/* A move or a delete on a repeating arc, waiting to be told what it
          meant. Its own card rather than the editor's footer: the gesture is
          finished and there is no panel on screen to ask inside. */}
      {ask && (
        <ScopeDialog
          title={ask.occ.event.title || "Untitled"}
          detail={askSpan(ask, settings.clock)}
          heading={ask.kind === "delete" ? "Delete" : "Apply this change to"}
          danger={ask.kind === "delete"}
          onPick={answerAsk}
          onCancel={cancelAsk}
        />
      )}

      <Toast />
    </div>
  );
}
