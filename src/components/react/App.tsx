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
import { dayAgenda, type CalEvent, type Occurrence } from "@/lib/events";
import { draftEvent, store, useStore } from "@/lib/store";
import { exportBackup, exportIcs, importFile } from "@/lib/backup";
import { cue } from "@/lib/feedback";
import { placeForZone } from "@/lib/places";
import { refreshFeed, refreshStaleFeeds } from "@/lib/feeds";
import { notify } from "@/lib/notify";
import {
  MINUTES_PER_DAY,
  addDays,
  dayKey,
  formatRelativeDay,
  fromDayKey,
  isSameDay,
  minutesOfDay,
  snap,
  startOfDay,
} from "@/lib/time";
import { LIFE_META_H, lifeDot, lifeStage } from "@/lib/life";
import { useElementSize, useHotkeys, useNow, useTypingSound } from "./hooks";
import type { EditorTarget, ShellActions, ViewFlow, ViewMode } from "./types";
import CommandPalette from "./CommandPalette";
import Dial from "./Dial";
import EventEditor from "./EventEditor";
import LifeView from "./LifeView";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import Toast from "./Toast";
import TopBar from "./TopBar";
import YearView from "./YearView";

/* ------------------------------- transitions ------------------------------- */

/** The app's one curve, for the crossfade between views. */
const PANEL_EASE = [0.32, 0.72, 0, 1] as const;

/**
 * The padding of a view panel, as a number. It is `p-2` in the class list and
 * 8 here because the zoom needs a *point*: the life grid's geometry is resolved
 * against the panel's content box, and the transform origin is measured from
 * the panel's border box.
 */
const PANEL_PAD = 8;

/**
 * Day ⇄ life is the one pair that zooms, because it is the one pair where the
 * same thing is drawn at two scales: the dial *is* the dot it lands on. Every
 * other pair crossfades — a year grid is not a magnified anything.
 */
function zoomsOut(flow: ViewFlow): boolean {
  return flow.from === "day" && flow.to === "life";
}

function zoomsIn(flow: ViewFlow): boolean {
  return flow.from === "life" && flow.to === "day";
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
 * What a panel does when it arrives and when it leaves. Both are dynamic
 * variants, so they are resolved against `flow.current` at the moment the
 * animation starts rather than at the render that scheduled it — for `exit`
 * that is the whole point, since by then the panel's own props are frozen.
 */
const PANEL = {
  initial: (flow: RefObject<ViewFlow>) =>
    zoomsIn(flow.current)
      ? { opacity: 0, scale: ZOOM_STEPS[ZOOM_STEPS.length - 1] }
      : { opacity: 0, scale: 1 },
  active: (flow: RefObject<ViewFlow>) =>
    zoomsIn(flow.current)
      ? {
          // The dial grows out of the dot it left from, fading up early so it
          // is a dial arriving rather than a dot inflating.
          opacity: [0, 1, 1, 1, 1],
          scale: [...ZOOM_STEPS].reverse(),
          transition: ZOOM_IN,
        }
      : {
          opacity: 1,
          scale: 1,
          // Arriving over a dial that is collapsing: wait for it, or the two
          // fades cross in the middle and both look like ghosts.
          transition: {
            duration: 0.4,
            delay: zoomsOut(flow.current) ? 0.18 : 0,
            ease: PANEL_EASE,
          },
        },
  exit: (flow: RefObject<ViewFlow>) =>
    zoomsOut(flow.current)
      ? {
          // Held opaque until it is genuinely small: a dial that fades while
          // it is still large looks like it is being switched off, not moved.
          opacity: [1, 1, 0.9, 0.5, 0],
          scale: [...ZOOM_STEPS],
          pointerEvents: "none" as const,
          transition: ZOOM_OUT,
        }
      : {
          opacity: 0,
          scale: 0.97,
          pointerEvents: "none" as const,
          transition: { duration: 0.3, ease: PANEL_EASE },
        },
} as const;

/* ---------------------------------- url ----------------------------------- */

interface ViewLocation {
  day: Date;
  view: ViewMode;
}

/** The views that are named in the URL — `day` is the one that is not. */
const VIEWS = ["year", "life"] as const;

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

export default function App() {
  const { events, calendars, feeds, settings } = useStore();
  const now = useNow();
  const reducedMotion = useReducedMotion();

  const [location, setLocation] = useState<ViewLocation>(() => readLocation());
  const { day, view } = location;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Everything the dial draws: what you wrote plus what you subscribed to.
   * A feed's events are merged only for reading — every mutation still goes
   * through `store.events`, which is why they are two lists in the snapshot.
   */
  const visible = useMemo(
    () => (Object.keys(feeds).length === 0 ? events : [...events, ...Object.values(feeds).flat()]),
    [events, feeds],
  );

  const agenda = useMemo(() => dayAgenda(visible, calendars, day), [visible, calendars, day]);
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
  const flow = useRef<ViewFlow>({ from: view, to: view, day });

  const go = useCallback((next: Partial<ViewLocation>, mode: "push" | "replace" = "push") => {
    // Derived and written outside the state updater: an updater has to be
    // pure, and StrictMode runs it twice.
    const merged = { ...current.current, ...next };
    flow.current = { from: current.current.view, to: merged.view, day: merged.day };
    current.current = merged;
    writeLocation(merged, mode);
    setLocation(merged);
  }, []);

  // Back/forward. The listener is the external system; the state follows it.
  useEffect(() => {
    const onPopState = () => {
      const restored = readLocation();
      flow.current = { from: current.current.view, to: restored.view, day: restored.day };
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

  const openDraft = useCallback(
    (startMin: number, endMin: number, on: Date) => {
      setPaletteOpen(false);
      setEditor({ id: null, draft: draftEvent(on, startMin, endMin, defaultCalendar) });
    },
    [defaultCalendar],
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
      openEvent: (event: CalEvent) => {
        const { id, ...draft } = event;
        setPaletteOpen(false);
        setEditor({ id, draft, readOnly: feedIds.has(event.calendarId) });
      },
      newEvent: () => {
        // Start at the next quarter hour when looking at today, otherwise at a
        // plausible working hour — a draft that opens at 00:00 is never right.
        const isToday = startOfDay(new Date()).getTime() === day.getTime();
        const start = isToday
          ? Math.min(snap(minutesOfDay(new Date()) + 7.5, 15), MINUTES_PER_DAY - 60)
          : 9 * 60;
        openDraft(start, start + 60, day);
      },
      newEventAt: (startMin: number, endMin: number) => openDraft(startMin, endMin, day),
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
    }),
    [day, go, openDraft, feedIds, calendars],
  );

  const step = useCallback(
    (delta: number) => {
      const from = current.current;
      // Stepping replaces rather than pushes: a held arrow key must not fill
      // the history stack with days you scrolled past.
      //
      // A year in the two grid views, a day on the dial. Both grids draw a
      // year per row or per block, so a step of a day would move the selection
      // by less than it takes to see.
      go(
        {
          day:
            from.view === "day"
              ? addDays(from.day, delta)
              : new Date(from.day.getFullYear() + delta, from.day.getMonth(), from.day.getDate()),
        },
        "replace",
      );
    },
    [go],
  );

  useHotkeys({
    "mod+p": () => setPaletteOpen((open) => !open),
    "mod+n": actions.newEvent,
    "mod+y": () => actions.setView("year"),
    "mod+d": () => actions.setView("day"),
    "mod+b": actions.toggleSidebar,
    "mod+l": () => actions.setView("life"),
    "mod+,": actions.openSettings,
    "mod+z": actions.undo,
    "mod+shift+z": actions.redo,
    arrowleft: () => step(-1),
    arrowright: () => step(1),
    t: actions.goToday,
    escape: () => {
      setPaletteOpen(false);
      setSettingsOpen(false);
      setEditor(null);
    },
  });

  // Every field in the app, on the same switch as the dial's clicks: one
  // setting called Sound, because a user who turned the dial quiet did not
  // ask for a keyboard.
  useTypingSound(settings.tickSound);

  /** The sound channels, as every cue in the shell wants them. */
  const channels = useMemo(
    () => ({ sound: settings.tickSound, haptics: settings.tickHaptics }),
    [settings.tickSound, settings.tickHaptics],
  );

  /**
   * A panel arriving says so, from wherever it was opened — ⌘P, the top bar,
   * or the palette handing over to settings. One effect per panel rather than a
   * cue at each call site, because there are four call sites and they would
   * drift; audio is an external system, which is what an effect is for.
   *
   * The channels come from a ref so that flipping Sound while a panel is open
   * does not re-announce it, and so `actions` need not depend on them.
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

  const commit = useCallback(
    (draft: Omit<CalEvent, "id">) => {
      if (editor?.id) {
        store.update(editor.id, draft);
      } else {
        store.create(draft);
        // Only for a new event. Saving an edit changes something that already
        // existed; this cue is for the one moment something starts to.
        cue("created", channels);
      }
      setEditor(null);
    },
    [editor, channels],
  );

  const openOccurrence = useCallback((occ: Occurrence) => actions.openEvent(occ.event), [actions]);

  /**
   * An arc dragged on the dial. The deltas are minutes and they apply to the
   * event's own instants, so a recurring event moves as a series (the seed
   * moves, every occurrence follows) and one dragged past midnight lands on
   * the next day and leaves this one — which is what dragging it there meant.
   *
   * A notice, because that last case is the one where the arc you just moved
   * is no longer on screen: without a word it reads as a deletion.
   */
  const adjustOccurrence = useCallback(
    (occ: Occurrence, startDeltaMin: number, endDeltaMin: number) => {
      const { event } = occ;
      const start = event.start + startDeltaMin * 60_000;
      const end = event.end + endDeltaMin * 60_000;
      store.update(event.id, { start, end });
      if (!isSameDay(new Date(start), day)) {
        notify(`Moved to ${formatRelativeDay(new Date(start))} — ⌘Z to undo`);
      }
    },
    [day],
  );

  return (
    <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-void">
      <TopBar day={day} view={view} sidebarOpen={sidebarOpen} onStep={step} actions={actions} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          open={sidebarOpen}
          day={day}
          now={now}
          occurrences={agenda.all}
          events={visible}
          calendars={calendars}
          clock={settings.clock}
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
                  place={settings.place}
                  daylight={settings.daylight}
                  moonlight={settings.moonlight}
                  totals={settings.totals}
                  totalsAt={settings.totalsAt}
                  secondZone={settings.secondZone}
                  showZoneName={settings.showZoneName}
                  showZoneOffset={settings.showZoneOffset}
                  zonePlace={zonePlace}
                  zoneDaylight={settings.zoneDaylight}
                  zoneMoonlight={settings.zoneMoonlight}
                  tickSound={settings.tickSound}
                  tickHaptics={settings.tickHaptics}
                  clock={settings.clock}
                  onOpen={openOccurrence}
                  onCreate={(startMin, endMin) => openDraft(startMin, endMin, day)}
                  onAdjust={adjustOccurrence}
                />
              )}
              {view === "year" && (
                <YearView
                  year={day.getFullYear()}
                  today={now}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  onSelectDay={(next) => actions.goDay(next)}
                />
              )}
              {view === "life" && (
                <LifeView
                  stage={stage}
                  flow={flow}
                  birth={settings.birth}
                  expectancy={settings.lifeExpectancy}
                  now={now}
                  selected={day}
                  events={visible}
                  calendars={calendars}
                  onSelectDay={(next) => actions.goDay(next)}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {editor && (
        <EventEditor
          target={editor}
          clock={settings.clock}
          calendars={calendars}
          onSave={commit}
          onDelete={() => {
            if (editor.id) {
              store.remove(editor.id);
              // Falling, hollow, and two taps: the one cue that reports
              // something being taken away rather than put somewhere.
              cue("deleted", channels);
            }
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        clock={settings.clock}
        secondZone={settings.secondZone}
        showZoneName={settings.showZoneName}
        showZoneOffset={settings.showZoneOffset}
        zoneDaylight={settings.zoneDaylight}
        zoneMoonlight={settings.zoneMoonlight}
        place={settings.place}
        daylight={settings.daylight}
        moonlight={settings.moonlight}
        totals={settings.totals}
        totalsAt={settings.totalsAt}
        tickSound={settings.tickSound}
        tickHaptics={settings.tickHaptics}
        birth={settings.birth}
        lifeExpectancy={settings.lifeExpectancy}
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
        events={visible}
        calendars={calendars}
        occurrences={agenda.all}
        clock={settings.clock}
        actions={actions}
      />

      <Toast />
    </div>
  );
}
