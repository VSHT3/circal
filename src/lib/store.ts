/* ------------------------------------------------------------------ *
 * The store. One module-level object, a listener set and localStorage.
 *
 * There is no server: circal is a local instrument. That makes an external
 * store read through `useSyncExternalStore` the right shape — every panel
 * (dial, agenda, sidebar, palette) reads the same snapshot without threading
 * a dozen props through the shell, and a second tab picks up writes via the
 * `storage` event.
 *
 * Two properties this file is responsible for, both learned the hard way:
 *
 * 1. A write that fails must *say so*. `localStorage` throws on quota and in
 *    private mode, and the app looked identical either way — the UI showed the
 *    event saved while the disk did not have it.
 * 2. A second tab must not overwrite this one. Every action re-reads the blob
 *    before deriving from it (`fresh()`), so two tabs racing lose an *edit* at
 *    worst, never the other tab's events.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { startOfDay, type Clock } from "./time";
import { notify } from "./notify";
import { PALETTE, type CalEvent, type Calendar, type Repeat } from "./events";
import type { PickedPlace } from "./places";

const KEY = "circal.v1";

/**
 * Bumped when a stored field changes meaning rather than shape. `clock: "24h"`
 * used to name the noon-at-top AM/PM face; it now names the 0–23 face, so a
 * blob written before this bump would silently show the wrong dial. Events
 * survive the bump — only settings reset.
 *
 * Still 2: `secondZone`, `place` and `feeds` are new *fields*, and a blob
 * without them merges the defaults in. Nothing already stored changed meaning,
 * so there is no reason to throw away anyone's dial preference.
 */
const SCHEMA = 2;

export interface Settings {
  /** Which face the dial wears — see `lib/dial.ts`. */
  clock: Clock;
  /** IANA zone for the dial's second ring. `""` = the ring is off. */
  secondZone: string;
  /** Whether that ring is captioned with the city, the offset, both, neither. */
  showZoneName: boolean;
  showZoneOffset: boolean;
  /** The second zone's own band, on its own rim, with its own two halves. */
  zoneDaylight: boolean;
  zoneMoonlight: boolean;
  /** Where the sun is computed for, chosen by city. `null` = no lightcycle. */
  place: PickedPlace | null;
  /** The two halves of your band, each its own switch. */
  daylight: boolean;
  /** The hours the sun is down, in violet. */
  moonlight: boolean;
}

export interface Snapshot {
  schema: number;
  /** The user's own events. These are what export writes and import merges. */
  events: CalEvent[];
  calendars: Calendar[];
  /**
   * Events pulled from subscribed feeds, keyed by their calendar's id. Kept
   * apart from `events` so a refresh can replace a feed wholesale, and so
   * nobody's Google calendar ends up inside a circal backup.
   */
  feeds: Record<string, CalEvent[]>;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  clock: "12h",
  secondZone: "",
  showZoneName: true,
  showZoneOffset: true,
  // Off: the captions describe a ring that is already there, but a band is
  // another ring, and chrome does not get to appear unasked.
  zoneDaylight: false,
  zoneMoonlight: false,
  place: null,
  // Both on, because the band *is* the track: with one half off the ring
  // simply stops at dusk (or at dawn), and an incomplete ring reads as a
  // rendering fault rather than as a choice.
  daylight: true,
  moonlight: true,
};

const DEFAULT_CALENDARS: Calendar[] = [
  { id: "personal", name: "Personal", color: PALETTE[0], visible: true },
  { id: "work", name: "Work", color: PALETTE[3], visible: true },
  { id: "family", name: "Family", color: PALETTE[5], visible: true },
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
    color: "",
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
  feeds: {},
  settings: DEFAULT_SETTINGS,
};

/**
 * `night` split into the pair `daylight` / `moonlight`. A blob still carrying
 * the old key keeps the choice it names — the dark half — and loses the key.
 */
function migrateSettings(stored: Partial<Settings> & { night?: boolean }): Partial<Settings> {
  const { night, ...rest } = stored;
  return night === undefined ? rest : { moonlight: night, ...rest };
}

function parse(raw: string): Snapshot {
  const parsed: Partial<Snapshot> = JSON.parse(raw);
  // A stale schema means the stored values no longer mean what they say.
  const settings =
    parsed.schema === SCHEMA
      ? { ...DEFAULT_SETTINGS, ...migrateSettings(parsed.settings ?? {}) }
      : DEFAULT_SETTINGS;
  return {
    schema: SCHEMA,
    events: Array.isArray(parsed.events) ? parsed.events : [],
    calendars: parsed.calendars?.length ? parsed.calendars : DEFAULT_CALENDARS,
    feeds: parsed.feeds ?? {},
    // A place is chosen by city now. One written as bare coordinates cannot be
    // shown in the picker, and a band the settings panel says is off is worse
    // than no band — drop it and let it be re-picked.
    settings: settings.place?.zone ? settings : { ...settings, place: null },
  };
}

function load(): Snapshot {
  if (typeof localStorage === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    lastRaw = raw;
    if (!raw) return { ...EMPTY, events: seed() };
    return parse(raw);
  } catch {
    // A corrupted blob must not brick the app; start clean rather than throw.
    return EMPTY;
  }
}

let snapshot: Snapshot = EMPTY;
/** The blob as this tab last saw it. A different string means someone else wrote. */
let lastRaw: string | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

/** Undo is in-memory and session-scoped: a reload starts fresh. */
const UNDO_DEPTH = 60;
let past: Snapshot[] = [];
let future: Snapshot[] = [];

function emit() {
  for (const listener of listeners) listener();
}

/**
 * The snapshot, re-read if another tab has written since we last looked.
 *
 * Every action derives its next state from this rather than from the module's
 * `snapshot`, which closes the window between another tab's write and the
 * `storage` event that tells us about it. Without it, two tabs editing in the
 * same second silently drop one tab's event.
 */
function fresh(): Snapshot {
  if (typeof localStorage === "undefined") return snapshot;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== lastRaw) {
      snapshot = raw ? parse(raw) : EMPTY;
      lastRaw = raw;
    }
  } catch {
    // Unreadable storage is the same situation as no storage: keep going on
    // what is in memory.
  }
  return snapshot;
}

function write(next: Snapshot) {
  snapshot = next;
  try {
    const raw = JSON.stringify(next);
    localStorage.setItem(KEY, raw);
    lastRaw = raw;
  } catch {
    // Private mode, or the quota is full. The session keeps working on the
    // in-memory snapshot, but nothing here will survive the reload — and that
    // is exactly the failure the user has to hear about, because the UI is
    // otherwise indistinguishable from a successful save.
    notify("Not saved — this browser is refusing to store data", "error");
  }
  emit();
}

/** `record: false` for changes not worth an undo step (settings, feed pulls). */
function commit(next: Snapshot, record = true) {
  if (record) {
    past.push(snapshot);
    if (past.length > UNDO_DEPTH) past.shift();
    future = [];
  }
  write(next);
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
    // Undoing onto a base another tab has moved on from would resurrect the
    // events it just deleted. Ours is the stale history; drop it.
    past = [];
    future = [];
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

/**
 * A holding name for a subscription until its ICS says what it is called.
 * Exported because the settings panel names a feed the same way when adding
 * it, and `setFeedEvents` recognises that name as "still a placeholder".
 */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Subscription";
  }
}

/* --------------------------------- actions -------------------------------- */

export const store = {
  /**
   * The current state, outside React. For the two callers that act on the
   * whole store rather than render it — export, and the launch-time feed pull
   * — where a value captured in a mount effect's closure would be the
   * pre-hydration snapshot.
   */
  snapshot(): Snapshot {
    return fresh();
  },

  create(event: Omit<CalEvent, "id">): CalEvent {
    const base = fresh();
    const created: CalEvent = { ...event, id: newId() };
    commit({ ...base, events: [...base.events, created] });
    return created;
  },

  update(id: string, patch: Partial<CalEvent>) {
    const base = fresh();
    commit({
      ...base,
      events: base.events.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  },

  remove(id: string) {
    const base = fresh();
    commit({ ...base, events: base.events.filter((e) => e.id !== id) });
  },

  toggleCalendar(id: string) {
    const base = fresh();
    commit(
      {
        ...base,
        calendars: base.calendars.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)),
      },
      false,
    );
  },

  /* ------------------------------- settings ------------------------------- */

  setClock(clock: Clock) {
    const base = fresh();
    commit({ ...base, settings: { ...base.settings, clock } }, false);
  },

  /** `""` turns the second ring off. */
  setSecondZone(secondZone: string) {
    const base = fresh();
    commit({ ...base, settings: { ...base.settings, secondZone } }, false);
  },

  setPlace(place: PickedPlace | null) {
    const base = fresh();
    commit({ ...base, settings: { ...base.settings, place } }, false);
  },

  /** The six independent dial annotations, each its own switch. */
  setDialToggle(
    key:
      | "showZoneName"
      | "showZoneOffset"
      | "zoneDaylight"
      | "zoneMoonlight"
      | "daylight"
      | "moonlight",
    on: boolean,
  ) {
    const base = fresh();
    commit({ ...base, settings: { ...base.settings, [key]: on } }, false);
  },

  /* ----------------------------- subscriptions ---------------------------- */

  /** Starts empty; `lib/feeds.ts` pulls it and fills `Snapshot.feeds`. */
  addFeed(url: string, name: string): Calendar {
    const base = fresh();
    const calendar: Calendar = {
      id: newId(),
      name,
      color: PALETTE[(base.calendars.length * 3) % PALETTE.length],
      visible: true,
      feed: { url, fetchedAt: 0, error: "" },
    };
    commit({ ...base, calendars: [...base.calendars, calendar] }, false);
    return calendar;
  },

  removeCalendar(id: string) {
    const base = fresh();
    const { [id]: _dropped, ...feeds } = base.feeds;
    commit({
      ...base,
      calendars: base.calendars.filter((c) => c.id !== id),
      // The user's own events are never orphaned by removing a feed, and a
      // feed's events live only in `feeds`, so this is the whole cleanup.
      events: base.events.filter((e) => e.calendarId !== id),
      feeds,
    });
  },

  /**
   * Replaces the feed's cached events wholesale — a pull is not a merge.
   * `name` renames the calendar only when it is still the host placeholder the
   * user was given before the feed said what it was actually called.
   */
  setFeedEvents(id: string, events: CalEvent[], name?: string) {
    const base = fresh();
    const target = base.calendars.find((c) => c.id === id);
    if (!target) return;
    const rename = name && target.feed && target.name === hostLabel(target.feed.url);
    commit(
      {
        ...base,
        calendars: base.calendars.map((c) =>
          c.id === id && c.feed
            ? {
                ...c,
                name: rename ? name : c.name,
                feed: { ...c.feed, fetchedAt: Date.now(), error: "" },
              }
            : c,
        ),
        feeds: { ...base.feeds, [id]: events },
      },
      false,
    );
  },

  setFeedError(id: string, error: string) {
    const base = fresh();
    commit(
      {
        ...base,
        calendars: base.calendars.map((c) =>
          c.id === id && c.feed ? { ...c, feed: { ...c.feed, error } } : c,
        ),
      },
      false,
    );
  },

  /* -------------------------------- import -------------------------------- */

  /** Adds a calendar and its events in one undoable step. */
  addCalendarWithEvents(name: string, events: Omit<CalEvent, "id" | "calendarId">[]): Calendar {
    const base = fresh();
    const calendar: Calendar = {
      id: newId(),
      name,
      color: PALETTE[(base.calendars.length * 3) % PALETTE.length],
      visible: true,
    };
    commit({
      ...base,
      calendars: [...base.calendars, calendar],
      events: [
        ...base.events,
        ...events.map((e) => ({ ...e, id: newId(), calendarId: calendar.id })),
      ],
    });
    return calendar;
  },

  /** Whole-store restore from a backup. One undo step, so a misfire is not fatal. */
  restore(next: Pick<Snapshot, "events" | "calendars" | "settings">) {
    const base = fresh();
    commit({
      schema: SCHEMA,
      events: next.events,
      calendars: next.calendars,
      // Feeds are a live mirror, not part of a backup; keep whatever is cached.
      feeds: base.feeds,
      settings: { ...DEFAULT_SETTINGS, ...next.settings },
    });
  },

  /* --------------------------------- undo --------------------------------- */

  undo(): boolean {
    const previous = past.pop();
    if (!previous) return false;
    future.push(snapshot);
    write(previous);
    return true;
  },

  redo(): boolean {
    const next = future.pop();
    if (!next) return false;
    past.push(snapshot);
    write(next);
    return true;
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
    color: "",
  };
}
