/* ------------------------------------------------------------------ *
 * The shell. Owns the view state (which day, which view, sidebar, which
 * overlay is up) and nothing else — events live in the store, the clock lives
 * in `useNow`, geometry lives in `lib/dial`.
 *
 * The day and the view are also mirrored into the URL, which makes a day
 * linkable and a reload land where you left it. That is the only place view
 * state is persisted, and deliberately so: it belongs to the tab, not to you.
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Clock } from "@/lib/time";
import { dayAgenda, type CalEvent, type Occurrence } from "@/lib/events";
import { draftEvent, store, useStore } from "@/lib/store";
import { exportBackup, exportIcs, importFile } from "@/lib/backup";
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
import { useHotkeys, useNow } from "./hooks";
import type { EditorTarget, ShellActions, ViewMode } from "./types";
import CommandPalette from "./CommandPalette";
import Dial from "./Dial";
import EventEditor from "./EventEditor";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import Toast from "./Toast";
import TopBar from "./TopBar";
import YearView from "./YearView";

/* ---------------------------------- url ----------------------------------- */

interface ViewLocation {
  day: Date;
  view: ViewMode;
}

function readLocation(): ViewLocation {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("d");
  // A malformed `?d=` is a typo in a shared link, not a reason to show a dial
  // labelled "Invalid Date".
  const parsed = key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? fromDayKey(key) : null;
  return {
    day: parsed && !Number.isNaN(parsed.getTime()) ? parsed : startOfDay(new Date()),
    view: params.get("v") === "year" ? "year" : "day",
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
  if (view === "year") params.set("v", "year");
  const url = `${window.location.pathname}?${params}`;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export default function App() {
  const { events, calendars, feeds, settings } = useStore();
  const now = useNow();

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

  const go = useCallback((next: Partial<ViewLocation>, mode: "push" | "replace" = "push") => {
    // Derived and written outside the state updater: an updater has to be
    // pure, and StrictMode runs it twice.
    const merged = { ...current.current, ...next };
    current.current = merged;
    writeLocation(merged, mode);
    setLocation(merged);
  }, []);

  // Back/forward. The listener is the external system; the state follows it.
  useEffect(() => {
    const onPopState = () => {
      const restored = readLocation();
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
      go(
        {
          day:
            from.view === "year"
              ? new Date(from.day.getFullYear() + delta, from.day.getMonth(), from.day.getDate())
              : addDays(from.day, delta),
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

  const commit = useCallback(
    (draft: Omit<CalEvent, "id">) => {
      if (editor?.id) store.update(editor.id, draft);
      else store.create(draft);
      setEditor(null);
    },
    [editor],
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

        <main className="relative min-w-0 flex-1">
          {view === "day" ? (
            <div className="absolute inset-0 p-2">
              <Dial
                day={day}
                now={now}
                occurrences={agenda.all}
                calendars={calendars}
                place={settings.place}
                daylight={settings.daylight}
                moonlight={settings.moonlight}
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
            </div>
          ) : (
            <YearView
              year={day.getFullYear()}
              today={now}
              selected={day}
              events={visible}
              calendars={calendars}
              onSelectDay={(next) => actions.goDay(next)}
            />
          )}
        </main>
      </div>

      {editor && (
        <EventEditor
          target={editor}
          clock={settings.clock}
          calendars={calendars}
          onSave={commit}
          onDelete={() => {
            if (editor.id) store.remove(editor.id);
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
        tickSound={settings.tickSound}
        tickHaptics={settings.tickHaptics}
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
