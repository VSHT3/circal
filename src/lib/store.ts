/* ------------------------------------------------------------------ *
 * The store. One module-level object, a listener set and localStorage.
 *
 * There is no server: circal is a local instrument. That makes an external
 * store read through `useSyncExternalStore` the right shape — every panel
 * (dial, agenda, sidebar, palette) reads the same snapshot without threading
 * a dozen props through the shell, and a second tab picks up writes via the
 * `storage` event.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { startOfDay } from "./time";
import type { Clock } from "./dial";
import type { CalEvent, Calendar, Repeat } from "./events";

const KEY = "circal.v1";

/**
 * Bumped when a stored field changes meaning rather than shape. `clock: "24h"`
 * used to name the noon-at-top AM/PM face; it now names the 0–23 face, so a
 * blob written before this bump would silently show the wrong dial. Events
 * survive the bump — only settings reset.
 */
const SCHEMA = 2;

export interface Settings {
  /** Which face the dial wears — see `lib/dial.ts`. */
  clock: Clock;
}

export interface Snapshot {
  schema: number;
  events: CalEvent[];
  calendars: Calendar[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = { clock: "12h" };

/** The eight calendar colours. Muted enough that two can share the dial. */
export const PALETTE = [
  "#a3d9e4", // cyan
  "#b7c9f2", // periwinkle
  "#c6b6ec", // lilac
  "#eeb0c6", // blush
  "#f0b98d", // amber
  "#e6dd9a", // straw
  "#a8dcb8", // mint
  "#9fb0bd", // slate
] as const;

const DEFAULT_CALENDARS: Calendar[] = [
  { id: "personal", name: "Personal", color: PALETTE[0], visible: true },
  { id: "work", name: "Work", color: PALETTE[2], visible: true },
  { id: "family", name: "Family", color: PALETTE[3], visible: true },
];

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------------------------- seed ---------------------------------- */

/**
 * A first run against an empty dial teaches nothing, so seed one plausible
 * day — anchored on *today* rather than a fixed date, so the shape (a morning
 * gap, a stacked afternoon, a late call) is legible whenever it is opened.
 */
function seed(): CalEvent[] {
  const base = startOfDay(new Date()).getTime();
  const at = (h: number, m = 0) => base + (h * 60 + m) * 60_000;
  const make = (
    title: string,
    calendarId: string,
    start: number,
    end: number,
    extra: Partial<CalEvent> = {},
  ): CalEvent => ({
    id: newId(),
    title,
    calendarId,
    start,
    end,
    allDay: false,
    location: "",
    url: "",
    notes: "",
    repeat: "never",
    ...extra,
  });

  return [
    make("Morning run", "personal", at(7, 15), at(8, 0), { repeat: "daily" }),
    make("Cas", "personal", at(10, 45), at(11, 30), { location: "Kitchen table" }),
    make("Packing", "personal", at(13, 15), at(13, 50)),
    make("Design review", "work", at(14, 0), at(16, 20), { location: "Studio" }),
    make("Sync with Anna", "work", at(14, 15), at(15, 15), { url: "https://meet.example.com/x" }),
    make("Call home", "family", at(21, 10), at(21, 40)),
  ];
}

/* --------------------------------- state ---------------------------------- */

const EMPTY: Snapshot = {
  schema: SCHEMA,
  events: [],
  calendars: DEFAULT_CALENDARS,
  settings: DEFAULT_SETTINGS,
};

function load(): Snapshot {
  if (typeof localStorage === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, events: seed() };
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    return {
      schema: SCHEMA,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      calendars: parsed.calendars?.length ? parsed.calendars : DEFAULT_CALENDARS,
      // A stale schema means the stored values no longer mean what they say.
      settings:
        parsed.schema === SCHEMA ? { ...DEFAULT_SETTINGS, ...parsed.settings } : DEFAULT_SETTINGS,
    };
  } catch {
    // A corrupted blob must not brick the app; start clean rather than throw.
    return EMPTY;
  }
}

let snapshot: Snapshot = EMPTY;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function commit(next: Snapshot) {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private-mode / quota. The session still works, it just will not persist.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  // First subscriber pulls localStorage in. Doing it at module scope would run
  // during SSR bundling and during hydration, before the client has committed —
  // this keeps the first render deterministic.
  if (!hydrated) {
    hydrated = true;
    snapshot = load();
  }
  listeners.add(listener);

  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    snapshot = load();
    emit();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStore(): Snapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
}

/* --------------------------------- actions -------------------------------- */

export const store = {
  create(event: Omit<CalEvent, "id">): CalEvent {
    const created: CalEvent = { ...event, id: newId() };
    commit({ ...snapshot, events: [...snapshot.events, created] });
    return created;
  },

  update(id: string, patch: Partial<CalEvent>) {
    commit({
      ...snapshot,
      events: snapshot.events.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  },

  remove(id: string) {
    commit({ ...snapshot, events: snapshot.events.filter((e) => e.id !== id) });
  },

  toggleCalendar(id: string) {
    commit({
      ...snapshot,
      calendars: snapshot.calendars.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
    });
  },

  recolorCalendar(id: string, color: string) {
    commit({
      ...snapshot,
      calendars: snapshot.calendars.map((c) => (c.id === id ? { ...c, color } : c)),
    });
  },

  setClock(clock: Clock) {
    commit({ ...snapshot, settings: { ...snapshot.settings, clock } });
  },
};

/** A blank event on `day`, used by ⌘N and by drag-to-create on the dial. */
export function draftEvent(
  day: Date,
  startMin: number,
  endMin: number,
  calendarId: string,
  repeat: Repeat = "never",
): Omit<CalEvent, "id"> {
  const base = startOfDay(day).getTime();
  return {
    title: "",
    calendarId,
    start: base + startMin * 60_000,
    end: base + endMin * 60_000,
    allDay: false,
    location: "",
    url: "",
    notes: "",
    repeat,
  };
}
