/* ------------------------------------------------------------------ *
 * The shell. Owns the four pieces of view state (which day, which view,
 * sidebar, which overlay is up) and nothing else — events live in the store,
 * the clock lives in `useNow`, geometry lives in `lib/dial`.
 * ------------------------------------------------------------------ */

import { useCallback, useMemo, useState } from "react";
import type { Clock } from "@/lib/dial";
import { dayAgenda, type CalEvent, type Occurrence } from "@/lib/events";
import { draftEvent, store, useStore } from "@/lib/store";
import { MINUTES_PER_DAY, addDays, minutesOfDay, snap, startOfDay } from "@/lib/time";
import { useHotkeys, useNow } from "./hooks";
import type { EditorTarget, ShellActions, ViewMode } from "./types";
import CommandPalette from "./CommandPalette";
import Dial from "./Dial";
import EventEditor from "./EventEditor";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import YearView from "./YearView";

export default function App() {
  const { events, calendars, settings } = useStore();
  const now = useNow();

  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState<ViewMode>("day");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const agenda = useMemo(
    () => dayAgenda(events, calendars, day, settings.clock),
    [events, calendars, day, settings.clock],
  );
  const defaultCalendar = calendars[0]?.id ?? "personal";

  const openDraft = useCallback(
    (startMin: number, endMin: number, on: Date) => {
      setPaletteOpen(false);
      setEditor({ id: null, draft: draftEvent(on, startMin, endMin, defaultCalendar) });
    },
    [defaultCalendar],
  );

  const actions: ShellActions = useMemo(
    () => ({
      goToday: () => {
        setDay(startOfDay(new Date()));
        setView("day");
      },
      goDay: (next: Date) => setDay(startOfDay(next)),
      setView: (next: ViewMode) => setView(next),
      toggleSidebar: () => setSidebarOpen((open) => !open),
      openPalette: () => setPaletteOpen(true),
      setClock: (clock: Clock) => store.setClock(clock),
      toggleCalendar: (id: string) => store.toggleCalendar(id),
      openEvent: (event: CalEvent) => {
        const { id, ...draft } = event;
        setPaletteOpen(false);
        setEditor({ id, draft });
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
    }),
    [day, openDraft],
  );

  const step = useCallback(
    (delta: number) => {
      setDay((current) =>
        view === "year"
          ? new Date(current.getFullYear() + delta, current.getMonth(), current.getDate())
          : addDays(current, delta),
      );
    },
    [view],
  );

  useHotkeys({
    "mod+k": () => setPaletteOpen((open) => !open),
    "mod+n": actions.newEvent,
    "mod+y": () => setView("year"),
    "mod+d": () => setView("day"),
    "mod+b": actions.toggleSidebar,
    arrowleft: () => step(-1),
    arrowright: () => step(1),
    t: actions.goToday,
    escape: () => {
      setPaletteOpen(false);
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

  return (
    <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-void">
      <TopBar day={day} view={view} sidebarOpen={sidebarOpen} onStep={step} actions={actions} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          open={sidebarOpen}
          day={day}
          now={now}
          occurrences={agenda.all}
          events={events}
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
                clock={settings.clock}
                onOpen={openOccurrence}
                onCreate={(startMin, endMin) => openDraft(startMin, endMin, day)}
              />
            </div>
          ) : (
            <YearView
              year={day.getFullYear()}
              today={now}
              selected={day}
              events={events}
              calendars={calendars}
              onSelectDay={(next) => {
                setDay(startOfDay(next));
                setView("day");
              }}
            />
          )}
        </main>
      </div>

      {editor && (
        <EventEditor
          target={editor}
          calendars={calendars}
          onSave={commit}
          onDelete={() => {
            if (editor.id) store.remove(editor.id);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        day={day}
        view={view}
        sidebarOpen={sidebarOpen}
        events={events}
        calendars={calendars}
        clock={settings.clock}
        actions={actions}
      />
    </div>
  );
}
