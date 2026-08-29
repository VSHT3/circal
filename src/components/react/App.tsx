/* ------------------------------------------------------------------ *
 * The shell. Owns the view state (which day, which view, sidebar, which
 * overlay is up) and nothing else — events live in the store, the clock lives
 * in `useNow`, geometry lives in `lib/dial`.
 *
 * The day and the view are also mirrored into the URL, which makes a day
 * linkable and a reload land where you left it. That is the only place view
 * state is persisted, and deliberately so: it belongs to the tab, not to you.
 * ------------------------------------------------------------------ */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Clock } from "@/lib/time";
import {
  NEVER,
  REMIND_INHERIT,
  clashesWith,
  colorOf,
  dayAgenda,
  dayCleared,
  freeGaps,
  freeSlots,
  instantKey,
  planEvents,
  repeats,
  type CalEvent,
  type Occurrence,
} from "@/lib/events";
import { readEstimate, type Task } from "@/lib/tasks";
import {
  defaultCalendarId,
  dismissBackupNudge,
  draftEvent,
  duplicateOf,
  introSeen,
  setIntroSeen,
  store,
  useLastBackup,
  useStore,
} from "@/lib/store";
import {
  backupDue,
  exportBackup,
  exportEventIcs,
  exportIcs,
  importFile,
  importIcs,
} from "@/lib/backup";
import { THEME_PALETTES } from "@/lib/theme";
import { cue } from "@/lib/feedback";
import { placeForZone } from "@/lib/places";
import { refreshFeed } from "@/lib/feeds";
import { notify } from "@/lib/notify";
import { startCloud, useCloud } from "@/lib/cloudLink";
import { startMirror, useMirror } from "@/lib/mirrorLink";
import { defaultStart } from "@/lib/quickadd";
import {
  MINUTES_PER_DAY,
  addDays,
  atMinutes,
  dayKey,
  daysBetween,
  formatRelativeDay,
  formatTime,
  formatTimeShort,
  fromDayKey,
  isSameDay,
  localZone,
  minutesOfDay,
  startOfDay,
  weekOffset,
} from "@/lib/time";
import { placeName, travelNotice } from "@/lib/travel";
import {
  decodeShare,
  decodeSlots,
  encodeShare,
  encodeSlots,
  shareFragment,
  shareToken,
  slotsFragment,
  slotsToken,
  type SlotSpan,
} from "@/lib/share";
import { LIFE_META_H, lifeDot, lifeStage, type LifeRun } from "@/lib/life";
import { weekFaceCentre, weekStage, weekZoomScale } from "@/lib/week";
import { EASE, INTRO_MS, MODE_MS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  useElementSize,
  useFeedRefresh,
  useHotkeys,
  useIdle,
  useIdleAfter,
  useNoDragSelection,
  useNow,
  useOnInput,
  useReminders,
  useTitleCountdown,
  useTypingSound,
  useWakeLock,
} from "./hooks";
import { ErrorBoundary } from "./ErrorBoundary";
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
import { BackupNudge } from "./BackupNudge";
import { SlotsNotice } from "./SlotsNotice";
import { ReplyNotice } from "./ReplyNotice";
import { TravelPrompt } from "./TravelPrompt";
import CommandPalette from "./CommandPalette";
import Dial, { type DragPreview } from "./Dial";
import LifeView from "./LifeView";
import Sidebar, { SIDEBAR_W } from "./Sidebar";
import { ScopeDialog } from "./ScopePrompt";
import Toast from "./Toast";
import TopBar from "./TopBar";
import YearView from "./YearView";
import WeekView from "./WeekView";
import { PANEL } from "./transitions";

/**
 * The macOS shell drops a `.ics` file's text into `__circalImportIcs` when the
 * Dock hands the app a calendar to open (see `mac/main.swift`). It is the
 * settings panel's Import path exactly — same new calendar, same toast, same
 * undo step — so a drop and a menu import cannot come to mean two different
 * things.
 *
 * `__circalReady` is the shell's, called once the moment the import global is
 * registered: a drop on a cold launch is queued shell-side until this fires,
 * because a finished navigation is earlier than a mounted island.
 */
declare global {
  interface Window {
    __circalImportIcs?: (text: string) => void;
    __circalReady?: () => void;
  }
}

// Behind their overlays rather than a view key, so `lazy` is safe to reach
// for without touching the transition geometry `LifeView` / `YearView` /
// `WeekView` hand each other mid-flight (see AUDIT.md Tier 1). Declared at
// module scope: `lazy`'s factory must stay referentially stable across
// renders, or React resuspends the panel on every re-render of `Shell`.
const EventEditor = lazy(() => import("./EventEditor"));
const TaskEditor = lazy(() => import("./TaskEditor"));
const Settings = lazy(() => import("./Settings"));

/* --------------------------------- measures -------------------------------- */

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
 * How long the rings-closed sweep stays mounted: `.face-shimmer`'s 1400ms,
 * plus slack for a frame the animation has not been started on yet.
 */
const SHIMMER_MS = 1800;

/**
 * The zone this browser is in, read once on load.
 *
 * Once, because the question it answers is "has the device moved *since the
 * last launch*" — `settings.deviceZone` is the other half of that comparison,
 * and a value re-read every minute would turn a laptop woken in another city
 * into a prompt arriving over whatever the user was doing at the time.
 * Constructing an `Intl.DateTimeFormat` is not cheap either, and the island is
 * `client:only`, so module scope here is the browser.
 */
const DEVICE_ZONE = localZone();

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

/**
 * The shared event on the URL, or `null` when there is not one — read off the
 * fragment, which is where `share.ts` puts it and why nothing about a shared
 * event ever reaches the server.
 *
 * It asks the store rather than a prop, and that is load-bearing for the same
 * reason the travel notice does it: `store.snapshot()` reads through to
 * storage, while the hook's value is the empty snapshot until the first
 * `subscribe` a commit later — so a receiver's own default calendar is not in
 * any prop yet at the moment this is resolved.
 */
function receiveShare() {
  const token = shareToken(window.location.hash);
  if (!token) return null;
  const stored = store.snapshot();
  return decodeShare(token, defaultCalendarId(stored.calendars, stored.settings.defaultCalendar));
}

/**
 * The other payload a link can carry: somebody's free time, read off its own
 * fragment. Nothing about it touches the store — the slots are shown, never
 * written, so unlike `receiveShare` it has no calendar to resolve.
 */
function receiveSlots() {
  const token = slotsToken(window.location.hash);
  if (!token) return null;
  return decodeSlots(token);
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
 * An event's own instants as an `Occurrence`, so a verb typed in the palette
 * commits through the seam a drag on the arc already uses: `adjustOccurrence`
 * takes one of these, and with it come the scope question, the preview and the
 * notice, none of which a second write path would inherit.
 *
 * The seed rather than the occurrence on screen, because the palette ranks
 * events and its rows already speak of one by its own start — and the scope
 * question then means what it always means, measured from the series' head.
 */
function seedOccurrence(event: CalEvent): Occurrence {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const nextMidnight = addDays(startOfDay(start), 1);
  return {
    key: `${event.id}@${instantKey(start)}`,
    event,
    start,
    end,
    startMin: minutesOfDay(start),
    // As in `occurrencesOn`: an event ending exactly at midnight ends this day
    // at 1440, not the next one at 0.
    endMin: end >= nextMidnight ? MINUTES_PER_DAY : minutesOfDay(end),
    continuesBefore: false,
    continuesAfter: end > nextMidnight,
    dayIndex: 1,
    dayCount: daysBetween(start, new Date(Math.max(event.start, event.end - 1))) + 1,
    done: false,
    lane: 0,
  };
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

/**
 * The island. `Shell` below is the app; this is the one thing above it, and it
 * has to be a wrapper rather than something inside `Shell` because a boundary
 * cannot catch a throw from its own render.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}

function Shell() {
  const { events, tasks, calendars, feeds, settings } = useStore();
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
  /** The backup clock and both links' state, for the main-screen nudge. */
  const lastBackup = useLastBackup();
  const mirrorStatus = useMirror();
  const cloudStatus = useCloud();

  /**
   * A shared event, taken off the URL once, during the first render.
   *
   * Seeded state rather than an effect, because a link's payload is state this
   * app is *starting from* — exactly what the URL's own `?d=` already is. An
   * effect would render the wrong day first and correct it a frame later, and
   * it would be a `setState` inside an effect, which this repo does not do.
   */
  const [received] = useState(receiveShare);
  const [receivedSlots] = useState(receiveSlots);
  /**
   * The received free time, until it is hidden. Session state only: the
   * fragment is consumed on the first location write, so a reload starts
   * clean and a bookmarked link re-offers the overlay, never data.
   */
  const [slots, setSlots] = useState<SlotSpan[] | null>(() =>
    receivedSlots?.ok ? receivedSlots.slots : null,
  );
  /**
   * A booked slot's saved event, until its reply is dismissed — the other
   * half of the exchange. Session state for the overlay's own reason: the
   * reply is a hand-over, not data, and the event itself is already safe in
   * the store.
   */
  const [reply, setReply] = useState<CalEvent | null>(null);
  const [location, setLocation] = useState<ViewLocation>(() => {
    // The event lands on the day it names, whatever view the link asked for:
    // an editor over a face that cannot show what is being edited is a form.
    if (received?.ok) return { day: startOfDay(new Date(received.draft.start)), view: "day" };
    // Free time lands on the *week*: the payload is a stretch of days and the
    // strip is the one face that reads all of them at a glance — where the
    // event above needs the single day its editor is about.
    if (receivedSlots?.ok) {
      return { day: startOfDay(new Date(receivedSlots.slots[0].start)), view: "week" };
    }
    return readLocation();
  });
  const { day, view } = location;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * The editor opens on a received event rather than the app writing it: an
   * unmodified copy that lands with only a toast as evidence is worse than one
   * the receiver is shown first, which is ⌘P's own argument for duplicating
   * through the editor. Nothing is committed until Save, so Escape leaves no
   * orphan and the receiver picks the calendar.
   */
  const [editor, setEditor] = useState<EditorTarget | null>(() =>
    received?.ok ? { id: null, draft: received.draft } : null,
  );
  /** The task card's target: an id to edit, or `null` for a new draft — the
   *  calendar card's own shape, resolved from the store every render. */
  const [taskEditor, setTaskEditor] = useState<{ id: string | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The query lighting the life grid and the year ring — the same field,
   * one face over. Held here rather than in the palette because the thread
   * outlives it: ⌘P closes and the answer stays lit, so it can be read at
   * the size either face draws it.
   */
  const [search, setSearch] = useState("");
  // Opening the palette starts a fresh search, so the box and the field always
  // say the same thing. Adjusted during render rather than in an effect, as
  // everywhere else in this repo that new props must reset local state.
  const [searchSeeded, setSearchSeeded] = useState(paletteOpen);
  if (searchSeeded !== paletteOpen) {
    setSearchSeeded(paletteOpen);
    if (paletteOpen) setSearch("");
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

  /**
   * The run of days being drawn on the life grid, for the reason `preview`
   * lives here: Escape peels the panel, the drawer, the lit grid and then
   * ambient in that order, and a gesture in flight belongs at the front of
   * that list. The shell can only put it there if it can see one.
   */
  const [lifeRun, setLifeRun] = useState<LifeRun | null>(null);

  /**
   * The task a sidebar row has picked up, by id, for the reason `preview`
   * and `lifeRun` live here: `Sidebar` starts the gesture, `Dial` or the
   * week strip finishes it, and only the shell can see all three. Escape
   * clears it first of everything — a drag is the one thing here you can
   * start by accident.
   */
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const draggedTask = useMemo(
    () => (dragTaskId ? (tasks.find((t) => t.id === dragTaskId) ?? null) : null),
    [dragTaskId, tasks],
  );

  /** The drag ends with the pointer, wherever it is: the drop targets hear
   *  the same release first (element handlers run before window listeners),
   *  so clearing here never eats a commit. The cursor says "carrying" for
   *  the whole of it — the ghost only exists over the face. */
  useEffect(() => {
    if (!dragTaskId) return;
    const drop = () => setDragTaskId(null);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
    document.documentElement.style.cursor = "grabbing";
    return () => {
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
      document.documentElement.style.cursor = "";
    };
  }, [dragTaskId]);

  /**
   * The app introducing itself, once per install: `Dial` sweeps one revolution
   * and the face arrives in day order behind it.
   *
   * Resolved here rather than in the instrument, because "has this browser
   * ever seen it" is a fact about the browser and not about the dial. Held as
   * a boolean the shell puts back down after `INTRO_MS`, or leaving the day
   * view and coming back would play it again — the dial is unmounted and
   * remounted by every one of ⌘Y, ⌘L and ⌘E.
   *
   * Only on the day view: a deep link into ⌘L is somebody who has been sent a
   * URL, and the sweep belongs to the face it is about. Deliberately still
   * *unseen* in that case, so the next plain load gets it.
   */
  const [intro, setIntro] = useState(
    () => !reducedMotion && location.view === "day" && !introSeen(),
  );
  useEffect(() => {
    if (!intro) return;
    // Started is seen. A reload halfway through an animation is not a request
    // to watch it again, and marking it only on completion would replay the
    // whole thing for anybody who opens the app and immediately switches view.
    setIntroSeen(true);
    const done = setTimeout(() => setIntro(false), INTRO_MS + 120);
    return () => clearTimeout(done);
  }, [intro]);

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

  /**
   * `visible` with every plan's synthetic event beside it, for the two views
   * that count events over a span instead of asking `dayAgenda` about a day.
   * Planned time is time spent, so a day you worked on something lights in
   * the year ring and the life grid; a bare deadline colours nothing.
   */
  const spanned = useMemo(() => {
    const plans = planEvents(tasks);
    return plans.length === 0 ? visible : [...visible, ...plans];
  }, [visible, tasks]);

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

  const agenda = useMemo(
    () => dayAgenda(previewed, calendars, day, tasks),
    [previewed, calendars, day, tasks],
  );
  const defaultCalendar = defaultCalendarId(calendars, settings.defaultCalendar);
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
        settings.weekStart,
      ),
    [settings.birth, settings.lifeExpectancy, stageWidth, stageHeight, settings.weekStart],
  );

  /** The week grid, resolved against the same box and for the same reason:
   *  the dial has to know which face it is shrinking onto before the grid
   *  that draws that face exists. */
  const weekBox = useMemo(
    () =>
      weekStage(day, stageWidth - 2 * PANEL_PAD, stageHeight - 2 * PANEL_PAD, settings.weekStart),
    [day, stageWidth, stageHeight, settings.weekStart],
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
    const centre = weekFaceCentre(layout, weekOffset(day, settings.weekStart));
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
  }, [weekBox, day, originPoint, stageWidth, stageHeight, settings.weekStart]);

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
   * The same change, by value, for the panel that is *arriving*. `initial` and
   * `active` are resolved during render — the hooks lint rejects reading a ref
   * there, and rightly: the value they need is one a re-render has to
   * reproduce exactly, or motion restarts the arrival every time the shell
   * renders for any other reason. Written by the flow's own two writers.
   */
  const [cameFrom, setCameFrom] = useState<ViewMode>(view);
  const arrival: ViewFlow = { from: cameFrom, to: view, day, face };

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
    // A jump to where you already are is not a jump. `t` is the one that makes
    // this reachable — it keeps the view, so on today it names the location
    // already on screen — and pushing there would bury the back button under
    // entries for a page that never changed, on top of handing every panel a
    // fresh `Date` for the same midnight.
    if (
      merged.view === current.current.view &&
      merged.day.getTime() === current.current.day.getTime()
    )
      return;
    flow.current = {
      from: current.current.view,
      to: merged.view,
      day: merged.day,
      face: faceFrame.current,
    };
    setCameFrom(current.current.view);
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
      setCameFrom(current.current.view);
      current.current = restored;
      setLocation(restored);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  /**
   * The URL, stamped — and the consumed fragment, gone with it.
   *
   * `writeLocation` builds the URL out of the day and the view and nothing
   * else, so writing the location this render resolved to is also what drops a
   * share fragment; `history` is not touched here directly, which is how every
   * other location write in this file works. `replace`, because receiving a
   * link is not a jump — and because the fragment MUST NOT survive: a reload
   * would re-offer the same event and a bookmarked link would become a second
   * copy of it every time it was opened.
   *
   * The notice for a payload this build cannot read lives here for the reason
   * every notice does — it is an external system — and it is said once,
   * quietly, and nothing else happens. Silence would be indistinguishable from
   * a broken app, and a dialog would be chrome demanding an answer to somebody
   * else's mistake.
   */
  useEffect(() => {
    // `current.current`, not `readLocation()`: a received event resolved to its
    // own day, and the URL has not been told yet.
    writeLocation(current.current, "replace");
    if (received && !received.ok) {
      notify(
        received.reason === "version"
          ? "That link was made by a newer circal"
          : "That shared event could not be read",
        "error",
      );
    }
    if (receivedSlots && !receivedSlots.ok) {
      notify(
        receivedSlots.reason === "version"
          ? "That link was made by a newer circal"
          : "That shared link could not be read",
        "error",
      );
    }
  }, [received, receivedSlots]);

  // Subscriptions are a mirror, so they are pulled on arrival, on a timer and
  // whenever the tab comes back — see `useFeedRefresh`.
  useFeedRefresh();

  // The file mirror: its own external store, like `mirrorLink`'s sibling
  // `notify` — started once for this tab, torn down with it, and otherwise
  // driving `Settings`' Mirror section entirely on its own.
  useEffect(() => startMirror(), []);

  // The cloud copy, the same way and for the same reasons — and it returns a
  // no-op teardown where no project is configured, so an unconfigured build
  // fetches nothing and subscribes to nothing.
  useEffect(() => startCloud(), []);

  // The greyscale chrome wears. One external system, one effect: the
  // attribute drives every CSS token in `global.css`, and the meta colour
  // keeps the browser's own chrome (PWA bar, tab strip) on the same ground.
  // Canvases read `THEME_PALETTES[settings.theme]` at their own draw sites.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_PALETTES[settings.theme].void);
  }, [settings.theme]);

  // The Dock's calendar drop, routed through the one import the settings panel
  // already runs. The name it lands under is `fromIcs`'s own, so a filename
  // never reaches here — the shell has none to give once the file is text.
  useEffect(() => {
    window.__circalImportIcs = (text: string) => importIcs(text, "");
    // Tell the shell the global is live, so a `.ics` dropped during a cold
    // launch flushes now rather than being guessed ready by a navigation that
    // finished before this effect ran.
    window.__circalReady?.();
    return () => {
      delete window.__circalImportIcs;
    };
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
   * The travel question, or `null` when there is nothing to ask: a first run,
   * a device that has not moved, or a browser holding no events of the user's
   * own. `events` rather than `visible` — a subscription's occurrences already
   * carry real zones from their feeds and are not part of this at all.
   */
  const travel = useMemo(
    () => travelNotice(settings.deviceZone, DEVICE_ZONE, events.length > 0),
    [settings.deviceZone, events.length],
  );

  /**
   * Every case that is *not* a question still records the zone, silently. A
   * first run has no "before" to compare against; a browser with no events has
   * nothing an answer could apply to. Leaving either unrecorded means the
   * prompt arrives later — after the first event is written, about a journey
   * that has nothing to do with it.
   *
   * It asks the store rather than trusting this render's `settings`, and that
   * is load-bearing: the store hydrates lazily at its first `subscribe`, so
   * the first commit's props are `EMPTY` — no events and no remembered zone —
   * and an effect closing over those would read a genuine journey as a first
   * run and write the question away before it could be asked. Measured by
   * driving it: the stored zone was overwritten on load, every time.
   */
  useEffect(() => {
    const stored = store.snapshot();
    if (stored.settings.deviceZone === DEVICE_ZONE) return;
    if (travelNotice(stored.settings.deviceZone, DEVICE_ZONE, stored.events.length > 0)) return;
    store.setDeviceZone(DEVICE_ZONE);
  }, [settings.deviceZone, events.length]);

  /**
   * One answer, one commit, one undo step — which is the whole safety net
   * here: both answers rewrite events, and a person answering this at an
   * airport has to be able to change their mind. The notice says which way it
   * went and how much it touched, because "move" changes instants the user
   * cannot see the old value of.
   */
  const answerTravel = useCallback(
    (move: boolean) => {
      if (!travel) return;
      const place = placeName(move ? travel.to : travel.from);
      const count = move
        ? store.moveEventsToZone(travel.from, travel.to)
        : store.keepEventsInZone(travel.from, travel.to);
      const events = `${count} event${count === 1 ? "" : "s"}`;
      notify(move ? `Moved ${events} to ${place} time` : `${events} keep ${place} time`);
    },
    [travel],
  );

  /**
   * The mode arriving on its own, and leaving the same way.
   *
   * Armed only on the dial, with nothing open: a timer that swapped the view
   * out from under a grid would lose the year you were reading, and one that
   * fired over a half-finished event would be a data loss dressed as a
   * screensaver. Both conditions read as "there is nothing here to interrupt".
   */
  // The travel notice counts: it covers the stage and owns the screen until
  // it is answered, so ← must not step the day behind it and ⌘Z must not undo
  // into a calendar the user has not decided about yet.
  const busy =
    paletteOpen ||
    settingsOpen ||
    editor !== null ||
    ask !== null ||
    calendarEditor !== null ||
    taskEditor !== null ||
    travel !== null;
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
  /**
   * The booking's reply, first in the queue for the top edge: it exists
   * because of something the user just did, where the other two lines arrived
   * on their own. On every view — a receiver who books and then wanders to
   * the year ring is still owed the hand-over.
   */
  const showReply = reply !== null && !shaded && !inAmbient;
  /**
   * The received free time's own line, only where its ghosts are drawn — the
   * dial and the strip; the year ring and the life grid draw no slot, and a
   * notice about arcs a view cannot show is an accusation of a bug. It takes
   * the top edge whole while it stands: two notices side by side is a status
   * bar, so the backup nudge waits its turn below.
   */
  const showSlots =
    slots !== null && !shaded && !inAmbient && !showReply && (view === "day" || view === "week");
  /**
   * Whether the backup nudge is on screen. On every view, not the dial alone:
   * this is the one message in the app that must not be missable — it is the
   * whole feature — and a person who lives on the week strip or the year ring
   * would never meet it if it were day-only. It sits at the top edge, above
   * where any view puts its own readout (the dial's and the ring's are centred,
   * the strip's is under its faces, the grid's meta strip is a caption row it
   * clears), so it collides with none of them. Never while a modal, the
   * palette, the editor, the drawer or ambient is up (`shaded`, `inAmbient`),
   * so it never arrives over something that owns the screen. Silent while
   * *either* link is live: a rolling copy is already being written on every
   * change, and nagging for a backup somebody is continuously taking is the
   * app not knowing what it does. The cloud copy earns that for the same
   * reason the file does — it is the same document, one transport over.
   */
  const showNudge =
    settings.backupNudge &&
    !shaded &&
    !inAmbient &&
    !showSlots &&
    !showReply &&
    mirrorStatus.state !== "live" &&
    cloudStatus.state !== "live" &&
    backupDue(lastBackup, settings.backupInterval, now.getTime());
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

  /**
   * The one plan write, whatever gesture asked: the Schedule verb, the drag's
   * release on the dial, and a drop on a strip face all land here, so the
   * commit, the cue and the toast cannot drift apart. The toast is the
   * receipt — in drawer mode the column covers the face, so where the plan
   * landed is not otherwise on screen.
   */
  const planAt = useCallback(
    (id: string, on: Date, startMin: number, endMin: number) => {
      // The store's answer, not this render's props: a drop from a stale
      // closure must not plan what another tab just deleted or ticked.
      const target = store.snapshot().tasks.find((t) => t.id === id);
      if (!target || target.done) return;
      const start = atMinutes(on, startMin);
      store.planTask(id, { start: start.getTime(), end: atMinutes(on, endMin).getTime() });
      cue("created", channels);
      notify(
        `Planned “${target.title || "Untitled"}” ${formatRelativeDay(on)} ${formatTimeShort(start, settings.clock)}`,
      );
    },
    [channels, settings.clock],
  );

  /** The dial's drop: the ghost's minutes, on the day the face shows. */
  const dropTask = useCallback(
    (id: string, startMin: number, endMin: number) => planAt(id, day, startMin, endMin),
    [planAt, day],
  );

  /**
   * A drop on a week-strip face: the next free quarter hour inside waking
   * hours on that day (TASKS.md §7) — the strip names a day, never a minute,
   * so the shell picks one the way auto-schedule will. Today's gaps are read
   * from now on, and a day with no gap that fits falls back to the Schedule
   * verb's own `defaultStart`.
   */
  const dropTaskOnDay = useCallback(
    (id: string, on: Date) => {
      const snap = store.snapshot();
      const target = snap.tasks.find((t) => t.id === id);
      if (!target || target.done) return;
      const length = target.estimate ?? settings.defaultDuration;
      const all = [...snap.events, ...Object.values(snap.feeds).flat()];
      const agenda = dayAgenda(all, snap.calendars, on, snap.tasks);
      const floor = isSameDay(on, now) ? minutesOfDay(now) : 0;
      for (const gap of freeGaps(agenda.all, length, settings.wakingFrom, settings.wakingTo)) {
        const startMin = Math.ceil(Math.max(gap.start, floor) / 15) * 15;
        if (startMin + length <= gap.end) {
          planAt(id, on, startMin, startMin + length);
          return;
        }
      }
      const startMin = defaultStart(on, length);
      planAt(id, on, startMin, startMin + length);
    },
    [planAt, now, settings.defaultDuration, settings.wakingFrom, settings.wakingTo],
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
   * A tapped slot from a received link, as a draft covering exactly that gap.
   *
   * Through the editor rather than written, for ⌘P-duplicate's own reason:
   * nothing is committed until Save, Escape leaves no orphan, and the
   * receiver picks the title and the calendar. The instants are the slot's
   * own rather than re-derived from minutes — a slot is an absolute span two
   * people are meant to share (`share.ts`'s rule for the payload), and it
   * already sits inside one local day. `booking` is what makes the save mint
   * the reply.
   */
  const bookSlot = useCallback(
    (span: SlotSpan) => {
      setAmbient("off");
      setEditor({
        id: null,
        booking: true,
        draft: {
          ...draftEvent(startOfDay(new Date(span.start)), 0, 60, defaultCalendar),
          start: span.start,
          end: span.end,
        },
      });
    },
    [defaultCalendar],
  );

  /**
   * One event onto the clipboard, as a link that carries the whole of it.
   *
   * The link is minted against this page's own origin and path, so a self-
   * hosted copy hands out its own address rather than somebody else's, and
   * the payload goes in the fragment — never the query string, which would
   * send the sender's event to the one server this app has (see `share.ts`).
   *
   * The notice is the disclosure as well as the confirmation, and that is
   * deliberate: this is an encoding, not encryption, so anyone holding the
   * link holds the event. The moment it exists is the only moment a reader is
   * actually asking what it is, which is why the sentence is here rather than
   * a permanent caption in a card of twenty rows nobody re-reads.
   */
  const shareEvent = useCallback((draft: Omit<CalEvent, "id">) => {
    const encoded = encodeShare(draft);
    if (!encoded.ok) {
      notify("Too long to share as a link. Export it as .ics instead", "error");
      return;
    }
    const link = `${window.location.origin}${window.location.pathname}${shareFragment(encoded.token)}`;
    // The clipboard needs a user gesture and a secure context; the press has
    // the gesture, and WebKit withholds the API outright in places. A refusal
    // is reported rather than swallowed — a share that copied nothing is a
    // link the sender believes they have sent.
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        notify("Could not reach the clipboard. Nothing was copied", "error");
        return;
      }
      notify("Link copied. Anyone with the link can add this event");
    })();
  }, []);

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
        live.color === next.color &&
        live.calendarId === next.calendarId
      ) {
        return open;
      }
      const { start, end, allDay, color, calendarId } = next;
      return { ...open, live: { start, end, allDay, color, calendarId } };
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
    const { start, end, allDay } = mark;
    return { start, end, allDay, color: colorOf(mark, calendars) };
  }, [editor, calendars]);

  /** The same draft as the year ring wants it: the two days it runs between,
   *  inclusive. `end` is exclusive, so the last day is measured from `end - 1`
   *  — the same reason `dayCount` is. */
  const pendingDays = useMemo(
    () =>
      pending && {
        from: startOfDay(new Date(pending.start)),
        // `Math.max` against a degenerate span, where `end - 1` would name
        // the day before its own start.
        to: startOfDay(new Date(Math.max(pending.start, pending.end - 1))),
        color: pending.color,
      },
    [pending],
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
      switch (effectiveScope(scope, occ.event.start, at)) {
        case "all":
          store.update(occ.event.id, {
            start: moved(occ.event.start, startDeltaMin),
            end: moved(occ.event.end, endDeltaMin),
          });
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
      // The notice is judged by the occurrence that was under the pointer,
      // and only when its new span no longer touches the viewed day: the
      // toast exists for an arc that leaves this face without the view having
      // followed it — a multi-day clipped occurrence, whose visible ends are
      // not the event's instants, so the dial could not step the day. An edit
      // whose arc still covers the viewed day says nothing: resizing day two
      // of a two-day event is not a move, and a toast per drag reads as a
      // fault. `addDays`, not 1440 minutes — a day is not always 1440 minutes.
      const dayStart = startOfDay(day);
      const left =
        start >= addDays(dayStart, 1).getTime() || Math.max(end, start + 1) <= dayStart.getTime();
      if (left) {
        notify(`Moved to ${formatRelativeDay(new Date(start))}`);
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
   * The rim's once-a-day sweep, and the days that have already had theirs.
   * A serial so the face can re-key the element; nulled after the animation
   * has run so the SVG does not hold an invisible circle for the rest of the
   * session. `SHIMMER_MS` = the 1400ms `.face-shimmer` runs, plus slack —
   * clearing mid-flight unmounts the sweep, the intro's own lesson.
   *
   * Declared above the `actions` memo because `tickTask` below is one of its
   * fields' dependencies — `commitAdjust`'s own TDZ reasoning.
   */
  const [shimmer, setShimmer] = useState<number | null>(null);
  const ringsClosed = useRef(new Set<string>());
  useEffect(() => {
    if (shimmer === null) return;
    const timer = window.setTimeout(() => setShimmer(null), SHIMMER_MS);
    return () => window.clearTimeout(timer);
  }, [shimmer]);

  /**
   * A task ticked off, from the interior, the editor or the sidebar list.
   *
   * No `EditScope` question, and that is not an oversight: a task has one
   * deadline and is finished once — nothing to ask, nothing to split.
   *
   * Rings closed rides on it — the one animation this app fires uninvited,
   * budgeted at exactly one: ticking the day's last open pip sweeps a dash of
   * light once round the track (see `.face-shimmer`). The *when* is shell
   * policy, which is why the gate is here and not in the dial: never on an
   * untick, never under reduced motion, and at most once per day — `on` is
   * the day the tick was about, the occurrence's for a tick on the face and
   * the due day for one from the list. The once-a-day guard is a session
   * ref, not storage — it exists against tick-untick-tick, not against
   * tomorrow, and a reload asking for it again costs nothing anyone is
   * counting.
   */
  const tickTask = useCallback(
    (id: string, ticking: boolean, on: Date) => {
      store.toggleTaskDone(id);
      if (!ticking || reducedMotion) return;
      const key = dayKey(on);
      if (ringsClosed.current.has(key)) return;
      // Asked of the store's own post-commit answer rather than this render's
      // props: the snapshot already carries the tick.
      const snap = store.snapshot();
      const visible = [...snap.events, ...Object.values(snap.feeds).flat()];
      if (!dayCleared(dayAgenda(visible, snap.calendars, on, snap.tasks).all)) return;
      ringsClosed.current.add(key);
      setShimmer(Date.now());
    },
    [reducedMotion],
  );

  const actions: ShellActions = useMemo(
    () => ({
      // Today keeps the view it was asked in. It is the middle of the `‹ Today
      // ›` group and its two neighbours step the picture without leaving it, so
      // a button between them that jumps to the dial is the odd one out — and
      // in the week that jump is a zoom onto a face you were already looking
      // at. This names *when*, not *what*: `goDay` is the one that names a day
      // in order to go and look at it.
      goToday: () => go({ day: startOfDay(new Date()) }),
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
      /**
       * ⌘P's own duplicate, and it opens the editor rather than writing.
       *
       * The palette has no gesture to say *when*, so an unmodified copy would
       * land exactly on top of its original and the only evidence of it would
       * be a toast. The drag has the opposite problem and gets the opposite
       * answer: it named a time, so it writes and says so. Nothing is
       * committed here until Save, so an Escape leaves no orphan behind.
       */
      duplicateEvent: (event: CalEvent) => {
        setPaletteOpen(false);
        setAmbient("off");
        setEditor({ id: null, draft: duplicateOf(event) });
      },
      duplicateDay: (from: Date) => {
        setPaletteOpen(false);
        const count = store.duplicateDay(from, day);
        const events = `${count} event${count === 1 ? "" : "s"}`;
        notify(
          count === 0
            ? "Nothing to copy from that day"
            : `Copied ${events} from ${formatRelativeDay(from)}`,
        );
      },
      newEvent: () => {
        // The hour a draft opens on is `defaultStart`'s answer, shared with
        // quick-add: two ways of adding an event must not disagree about when.
        // Its length is the setting, for the same reason — one number, both
        // routes, and `DEFAULT_DURATION` is only what that setting starts at.
        const length = settings.defaultDuration;
        const start = defaultStart(day, length);
        openDraft(start, start + length, day);
      },
      newTask: () => {
        setPaletteOpen(false);
        setAmbient("off");
        // A blank draft due today at ⌘N's own hour, seeded inside the card —
        // the calendar editor's shape, not the event editor's.
        setTaskEditor({ id: null });
      },
      editTask: (id: string) => {
        setPaletteOpen(false);
        setAmbient("off");
        setTaskEditor({ id });
      },
      toggleTask: (id: string) => {
        // The store's answer, not this render's props: a tick from a stale
        // closure must not untick what another tab just ticked.
        const target = store.snapshot().tasks.find((t) => t.id === id);
        if (!target) return;
        tickTask(id, !target.done, new Date(target.due));
      },
      scheduleTask: (id: string) => {
        setPaletteOpen(false);
        const target = store.snapshot().tasks.find((t) => t.id === id);
        if (!target || target.done) return;
        // The next quarter hour on the selected day, at the estimate's length
        // — `defaultStart` is ⌘N's and quick-add's shared rule, and a task
        // that could not be sized takes the same default an event does.
        const length = target.estimate ?? settings.defaultDuration;
        const startMin = defaultStart(day, length);
        planAt(id, day, startMin, startMin + length);
      },
      dragTask: (id: string) => setDragTaskId(id),
      newEventAt: (startMin: number, endMin: number) => openDraft(startMin, endMin, day),
      quickAdd: (spec) => {
        /**
         * Asked *before* the write, so the new event is not in the list it is
         * being compared against — and deliberately not asked at all for an
         * all-day line, which covers the revolution and would name everything
         * on the day.
         *
         * This is the only create path with no review step: a drag shows the
         * arc land beside its neighbours, and the editor shows the day behind
         * it. A typed line shows neither until `go` has already committed it,
         * so the toast is the one place an overlap can still be mentioned.
         */
        const clashes = spec.allDay
          ? []
          : clashesWith(
              dayAgenda(visible, calendars, spec.day, tasks).timed,
              spec.startMin,
              spec.endMin,
            );
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
        // One name and a count, never a list: the first clash is the one the
        // reader can act on, and `and 2 others` is the guests row's own way of
        // saying a cap did not hide anything.
        const first = clashes[0];
        const rest = clashes.length - 1;
        const over = !first
          ? ""
          : ` over “${first.event.title || "Untitled"}”${
              rest > 0 ? ` and ${rest} other${rest === 1 ? "" : "s"}` : ""
            }`;
        notify(`Added “${spec.title}”${over}`);
      },
      /**
       * A verb typed in ⌘P, applied. The palette resolved which event and
       * where it lands; `adjustOccurrence` is then the same seam a drag on the
       * arc commits through, with the shift typed rather than dragged. It
       * carries everything that path already decided: a one-off is written now,
       * a repeating one asks its scope in the same card, the preview holds the
       * new position while the question is up, and an event that has left the
       * viewed day says so.
       *
       * A subscription is refused here as well as in the parser, for the
       * reason `calendarRemoval` mirrors the store's own rule: the surface that
       * offers a verb and the code that performs it must not disagree about
       * what may be written.
       */
      quickEdit: (edit) => {
        const event = visible.find((e) => e.id === edit.target.id);
        if (!event || feedIds.has(event.calendarId)) return;
        setPaletteOpen(false);
        adjustOccurrence(seedOccurrence(event), edit.startDeltaMin, edit.endDeltaMin);
      },
      undo: () => notify(store.undo() ? "Undone" : "Nothing to undo"),
      redo: () => notify(store.redo() ? "Redone" : "Nothing to redo"),
      exportIcs: () => void exportIcs(store.snapshot()),
      exportBackup: () => void exportBackup(store.snapshot()),
      importFile,
      refreshFeeds: () => {
        const subscriptions = calendars.filter((c) => c.feed);
        if (subscriptions.length === 0) return;
        notify(`Refreshing ${subscriptions.length} subscriptions…`);
        void Promise.all(subscriptions.map(refreshFeed));
      },
      /**
       * The next seven days' free time onto the clipboard, as a link.
       *
       * The gaps and never the events — `freeSlots` reads the exact list the
       * dial draws, so the link cannot claim an hour the sender's own face
       * shows as booked, and nothing about *what* books an hour survives the
       * construction. Seven days from now rather than "this week": a link is
       * minted to schedule something ahead, and Monday-to-Sunday shared on a
       * Friday is four dead days. The notice carries the same disclosure the
       * event share does — an encoding, not encryption.
       */
      shareFreeSlots: () => {
        setPaletteOpen(false);
        const spans = freeSlots(
          visible,
          calendars,
          new Date(),
          7,
          { from: settings.wakingFrom, to: settings.wakingTo },
          tasks,
        );
        const encoded = encodeSlots(spans);
        if (!encoded.ok) {
          // An empty answer is an answer, not a failure — a fully booked week
          // is news worth a sentence, never a red one.
          if (encoded.reason === "empty") notify("No free time to share in the next 7 days");
          else notify("A week of free time did not fit in a link", "error");
          return;
        }
        const link = `${window.location.origin}${window.location.pathname}${slotsFragment(encoded.token)}`;
        void (async () => {
          try {
            await navigator.clipboard.writeText(link);
          } catch {
            notify("Could not reach the clipboard. Nothing was copied", "error");
            return;
          }
          notify("Link copied. Anyone with the link can see when you're free");
        })();
      },
      /**
       * The intro again, on request. It takes the panels down and goes to the
       * day view first, because the sweep is the dial's and a modal over it is
       * a modal over the one thing being shown.
       *
       * It does not un-see it afterwards: the flag says "this browser has met
       * the app", which stays true whatever you replay.
       */
      replayIntro: () => {
        setPaletteOpen(false);
        setSettingsOpen(false);
        setAmbient("off");
        go({ view: "day" });
        setIntro(true);
      },
      toggleAmbient: () => enterAmbient(inAmbient ? "off" : "manual"),
    }),
    [
      day,
      go,
      openDraft,
      adjustOccurrence,
      tickTask,
      planAt,
      tasks,
      defaultCalendar,
      settings.defaultDuration,
      settings.clock,
      settings.wakingFrom,
      settings.wakingTo,
      feedIds,
      calendars,
      visible,
      inAmbient,
      enterAmbient,
      channels,
    ],
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
      // A task being carried is the very front of the queue, before even the
      // panels: TASKS.md §7 — a drag is the one thing here you can start by
      // accident, and abandoning it must never also close what is open.
      if (dragTaskId) {
        setDragTaskId(null);
        return;
      }
      // One key, one thing: a press that closed a panel has done its work,
      // and taking the mode down with it would be two. A lit life grid is the
      // next layer down — nothing is over it, so Escape is free to clear it.
      const panelled = busy;
      setPaletteOpen(false);
      setSettingsOpen(false);
      setEditor(null);
      if (panelled) return;
      // A gesture in flight is the front of the queue, and it has to be: a
      // run drawn across a *lit* grid is the natural way to use this view, so
      // an Escape that abandoned the drag and cleared the thread in one press
      // would be the two-things-per-key bug above, on the one surface where
      // both are live at once. The dial's own drag abandons itself, inside
      // `Dial` — it has nothing else on the shell's list to be confused with.
      if (lifeRun) {
        setLifeRun(null);
        return;
      }
      // The drawer is the next layer down: it covers the face and it is the
      // only thing on screen, so Escape belongs to it before it belongs to a
      // lit grid or to ambient. In `push` mode it is not covering anything
      // and Escape is not its key.
      if (sidebarMode === "drawer" && sidebarOpen) {
        setSidebarOpen(false);
        return;
      }
      if (search) {
        setSearch("");
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
      //
      // ⌘W is bound *as well*, and costs nothing to bind: a browser never
      // delivers it, so this line is dead on the web and correct in the macOS
      // shell (`mac/main.swift`), where no menu item claims the chord and the
      // keydown reaches the page. The chip stays ⌘E, because that is the one
      // spelling true on every platform.
      "mod+e": () => actions.setView("week"),
      "mod+w": () => actions.setView("week"),
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

  // A press on a face is a gesture, never the start of a selection. Document
  // wide, for the reason above it: nothing in the app has to know about it.
  useNoDragSelection();

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
    tasks,
    lead: settings.remindLead,
    clock: settings.clock,
    onOpen: useCallback(
      (event: CalEvent) => {
        go({ day: startOfDay(new Date(event.start)), view: "day" });
        actions.openEvent(event);
      },
      [go, actions],
    ),
    onOpenTask: useCallback(
      (task: Task) => {
        go({ day: startOfDay(new Date(task.due)), view: "day" });
        actions.editTask(task.id);
      },
      [go, actions],
    ),
  });

  /**
   * The document title as the reminder that survives a backgrounded tab —
   * push needs a server and this needs none. Same tick, same event pool as
   * `useReminders` above; see `useTitleCountdown` for why it carries no
   * switch of its own and why a visible tab does not get one.
   */
  useTitleCountdown(visible, calendars, tasks, now);

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
   * `EventEditor` is conditionally mounted — {@link editor} is `null` until
   * ⌘N or an arc is pressed — so unlike `Settings` (always in the tree,
   * hence already warmed the moment `Shell` first commits) nothing starts
   * its chunk download until the user asks to open it. That is the one
   * first-open latency this split can introduce, so it is warmed here
   * instead, once the shell is idle rather than competing with the dial's
   * own first paint. `requestIdleCallback` is absent in Safari; `setTimeout`
   * is the fallback every polyfill for it uses.
   */
  useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => void import("./EventEditor"));
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(() => void import("./EventEditor"), 1);
    return () => clearTimeout(id);
  }, []);

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
        const created = store.create(draft);
        // A booking is only half done at the save: the sender is owed the
        // reply, and this is what offers it. The event *as saved*, not the
        // slot — the receiver may have trimmed the gap in the editor, and the
        // reply must say what was actually booked.
        if (editor.booking) setReply(created);
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
   * The event editor's Convert verb: the draft on screen rebuilt as a task,
   * one commit through `store.convertEvent` (a series takes its overrides
   * with it — Convert answers "what is this", not "which occurrence"). The
   * task card opens on the new record, which is what the old Type switch's
   * continuity was: the thing being edited changed kind, not hands.
   */
  const convertToTask = useCallback(
    (draft: Omit<CalEvent, "id">) => {
      if (!editor?.id) return;
      // The occurrence the card was opened from, not the series' seed: a
      // weekly review converted from next Tuesday's arc is due next Tuesday.
      const at = editor.occurrenceStart ?? draft.start;
      const created = store.convertEvent(editor.id, {
        title: draft.title.trim() || "New task",
        notes: draft.notes,
        calendarId: draft.calendarId,
        icon: draft.icon,
        color: draft.color,
        due: draft.allDay ? startOfDay(new Date(at)).getTime() : at,
        dueAllDay: draft.allDay,
        // The span is real information about the work, so it seeds the
        // estimate; an all-day event has no span to read one off.
        estimate: draft.allDay ? null : readEstimate((draft.end - draft.start) / 60_000),
        priority: 0,
        plans: [],
        done: false,
      });
      setEditor(null);
      if (created) setTaskEditor({ id: created.id });
    },
    [editor],
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
      notify(`Deleted “${occ.event.title || "Untitled"}”`);
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

  /**
   * ⌘-drag off an arc. Written on release with no question and no editor: the
   * gesture named the new time, which is the whole of what a duplicate needs
   * to be told, and a modal after a drag that already said it is a second
   * answer to the same question.
   *
   * No `EditScope` either, and that is not an omission. The three scopes exist
   * because an edit to a repeating event has to say which occurrences it
   * reaches; a duplicate reaches none of them — the original is untouched —
   * so the copy is the whole event, rule and all, shifted by what the drag
   * measured. Exactly what a plain drag on the same arc already does to the
   * original under `"all"`.
   */
  const duplicateOccurrence = useCallback(
    (occ: Occurrence, deltaMin: number) => {
      if (feedIds.has(occ.event.calendarId)) return;
      store.create(duplicateOf(occ.event, deltaMin * 60_000));
      cue("created", channels);
      notify(`Duplicated “${occ.event.title || "Untitled"}”`);
    },
    [feedIds, channels],
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

  /** A tick from the face or the day's card: only a task's occurrence has one.
   *  Routed through `tickTask`, so a tick from here and one from the sidebar
   *  list cannot disagree about the rings-closed gate. */
  const toggleDone = useCallback(
    (occ: Occurrence) => {
      if (!occ.task) return;
      tickTask(occ.task.id, !occ.done, occ.start);
    },
    [tickTask],
  );

  /**
   * The task card's subject, resolved from the store rather than copied into
   * the state that opened it — the calendar card's own rule: an edit landing
   * from another tab updates the card under you, and a task deleted out from
   * under it takes the card with it.
   */
  const editedTask = taskEditor?.id ? (tasks.find((t) => t.id === taskEditor.id) ?? null) : null;
  const taskCardOpen = taskEditor !== null && (!taskEditor.id || !!editedTask);

  const saveTask = useCallback(
    (draft: Omit<Task, "id" | "updatedAt">) => {
      if (editedTask) store.updateTask(editedTask.id, draft);
      else {
        store.addTask(draft);
        // Only for a new task: the cue is for the moment something starts to
        // exist, the event editor's own rule.
        cue("created", channels);
      }
      setTaskEditor(null);
    },
    [editedTask, channels],
  );

  const deleteTask = useCallback(() => {
    if (!editedTask) return;
    store.removeTask(editedTask.id);
    setTaskEditor(null);
    cue("deleted", channels);
    notify(`Deleted “${editedTask.title || "Untitled"}”`);
  }, [editedTask, channels]);

  /**
   * The task card's Convert verb, the other direction: one commit through
   * `store.convertTask`, the event editor opening on the new record. A timed
   * deadline becomes an event at that instant, the estimate its length; a
   * day-only deadline becomes an all-day event on that day. The plans do not
   * travel — an event has no list for them, and one ⌘Z is the way back.
   */
  const convertToEvent = useCallback(
    (draft: Omit<Task, "id" | "updatedAt">) => {
      if (!editedTask) return;
      const dueDay = startOfDay(new Date(draft.due));
      const length = (draft.estimate ?? settings.defaultDuration) * 60_000;
      const created = store.convertTask(editedTask.id, {
        title: draft.title.trim() || "New event",
        calendarId: draft.calendarId,
        start: draft.dueAllDay ? dueDay.getTime() : draft.due,
        end: draft.dueAllDay ? addDays(dueDay, 1).getTime() : draft.due + length,
        allDay: draft.dueAllDay,
        tzid: "",
        location: "",
        url: "",
        notes: draft.notes,
        ...NEVER,
        seriesId: "",
        seriesKey: "",
        color: draft.color,
        icon: draft.icon,
        free: false,
        remindLead: REMIND_INHERIT,
        organizer: null,
        attendees: [],
        attendeeCount: 0,
        updatedAt: 0,
      });
      setTaskEditor(null);
      if (created) {
        const { id, ...body } = created;
        setEditor({ id, draft: body });
      }
    },
    [editedTask, settings.defaultDuration],
  );

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
    (name: string, color: string, icon: string, remindLead: number) => {
      if (editedCalendar)
        store.updateCalendar(editedCalendar.id, { name, color, icon, remindLead });
      else store.addCalendar(name, color, icon, remindLead);
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
        ? `Removed “${editedCalendar.name}”. ${gone.moved} event${gone.moved === 1 ? "" : "s"} moved to ${gone.into?.name}`
        : `Removed “${editedCalendar.name}”`,
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
        <TopBar
          day={day}
          view={view}
          sidebarOpen={sidebarOpen}
          onStep={step}
          weekStart={settings.weekStart}
          actions={actions}
        />
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
          tasks={tasks}
          clock={settings.clock}
          moon={settings.moon}
          theme={settings.theme}
          weekStart={settings.weekStart}
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
              // Only `exit` is a label: see `PANEL`. The other two are
              // resolved here, so the panel that is leaving carries the answer
              // it had before the flow moved rather than re-deriving the
              // arriving panel's — and the objects below outrank the table's
              // own `initial`/`active`, so passing it whole costs nothing and
              // is what gives `exit` something to resolve against.
              variants={reducedMotion ? undefined : PANEL}
              initial={reducedMotion ? false : PANEL.initial(arrival)}
              animate={reducedMotion ? undefined : PANEL.active(arrival)}
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
                  slots={slots}
                  onBookSlot={bookSlot}
                  onOpen={openOccurrence}
                  onCreate={(startMin, endMin, on) => openDraft(startMin, endMin, on)}
                  onAdjust={adjustOccurrence}
                  onDelete={deleteOccurrence}
                  onDuplicate={duplicateOccurrence}
                  onToggleDone={toggleDone}
                  dragTask={draggedTask}
                  onDropTask={dropTask}
                  onPreview={setPreview}
                  onStepDay={step}
                  ambient={inAmbient}
                  covered={shaded}
                  intro={intro}
                  shimmer={shimmer}
                />
              )}
              {view === "week" && (
                <WeekView
                  stage={weekBox}
                  now={now}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  tasks={tasks}
                  settings={settings}
                  onSelectDay={(next) => actions.goDay(next)}
                  onOpenEvent={openOccurrence}
                  pending={pendingDays}
                  slots={slots}
                  onBookSlot={bookSlot}
                  // The strip's own span drag, handed to the same function the
                  // ring and the grid use: which face drew the run is not
                  // something the editor can tell, and must not be.
                  onCreateSpan={(from, days) => openDraft(0, days * MINUTES_PER_DAY, from)}
                  dragging={dragTaskId !== null}
                  onDropTask={(on) => dragTaskId && dropTaskOnDay(dragTaskId, on)}
                />
              )}
              {view === "year" && (
                <YearView
                  year={day.getFullYear()}
                  today={now}
                  selected={day}
                  events={spanned}
                  calendars={calendars}
                  settings={settings}
                  stage={stage}
                  flow={flow}
                  pending={pendingDays}
                  search={search}
                  onClearSearch={() => setSearch("")}
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
                  settings={settings}
                  now={now}
                  selected={day}
                  events={spanned}
                  calendars={calendars}
                  search={search}
                  pending={pendingDays}
                  onClearSearch={() => setSearch("")}
                  draw={lifeRun}
                  onDraw={setLifeRun}
                  onSelectDay={(next) => actions.goDay(next)}
                  // The same run of whole days the ring hands over, through the
                  // same function: which face drew it is not something the
                  // editor can tell, and must not be.
                  onCreateSpan={(from, days) => openDraft(0, days * MINUTES_PER_DAY, from)}
                />
              )}
            </motion.div>
          </AnimatePresence>
          {/* Over the stage, outside the panel transform so the zoom does not
              carry it. Its own presence, so it animates away when a backup
              clears it or a modal opens over it. */}
          <AnimatePresence>
            {showReply && reply && (
              <ReplyNotice
                key="reply"
                onCopy={() => shareEvent(reply)}
                onIcs={() => void exportEventIcs(reply)}
                onDismiss={() => setReply(null)}
              />
            )}
            {showSlots && slots && (
              <SlotsNotice key="slots" slots={slots} onDismiss={() => setSlots(null)} />
            )}
            {showNudge && (
              <BackupNudge
                key="nudge"
                onBackup={() => void exportBackup(store.snapshot())}
                onDismiss={dismissBackupNudge}
              />
            )}
          </AnimatePresence>
          {/* Over the same stage, and over everything on it: until this is
              answered the face is drawing hours on a clock the events were not
              written on, so it is the screen rather than a notice beside one.
              Inside `main` for the reason the nudge is — the panel transform
              must not carry it — and it never coexists with the nudge, which
              `shaded` already suppresses. */}
          {travel && (
            <TravelPrompt
              notice={travel}
              now={now}
              clock={settings.clock}
              onMove={() => answerTravel(true)}
              onKeep={() => answerTravel(false)}
            />
          )}
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
        <Suspense fallback={null}>
          <EventEditor
            target={editor}
            settings={settings}
            calendars={calendars}
            onSave={saveEvent}
            onDelete={deleteEvent}
            onShare={shareEvent}
            onDraftChange={trackDraft}
            onConvert={convertToTask}
            onClose={() => setEditor(null)}
          />
        </Suspense>
      )}

      {taskCardOpen && (
        <Suspense fallback={null}>
          <TaskEditor
            target={editedTask}
            seedDue={atMinutes(day, defaultStart(day, 0)).getTime()}
            calendars={calendars}
            defaultCalendar={defaultCalendar}
            clock={settings.clock}
            onSave={saveTask}
            onDelete={deleteTask}
            onConvert={convertToEvent}
            onClose={() => setTaskEditor(null)}
          />
        </Suspense>
      )}

      <Suspense fallback={null}>
        <Settings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={settings}
          events={events}
          calendars={calendars}
          actions={actions}
        />
      </Suspense>

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
        tasks={tasks}
        settings={settings}
        actions={actions}
        onSearch={setSearch}
      />

      {calendarCardOpen && (
        <CalendarEditor
          target={editedCalendar}
          removal={calendarRemoval}
          remind={settings.remind}
          remindLead={settings.remindLead}
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
