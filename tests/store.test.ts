import { describe, expect, it, vi } from "vitest";
import { at, ms, event, MemoryStorage } from "./helpers";
import type { Repeat } from "@/lib/events";
import { DEFAULT_SETTINGS, LIFE_EXPECTANCY_RANGE } from "@/lib/store";
import { dayKey } from "@/lib/time";
import type * as StoreModule from "@/lib/store";
import type * as NotifyModule from "@/lib/notify";

const KEY = "circal.v1";

/** What `freshStore()` hands back to a test: the store API, the storage it
 *  was built against, and the notify module to spy on. */
interface StoreHandle {
  store: typeof StoreModule.store;
  draftEvent: typeof StoreModule.draftEvent;
  hostLabel: typeof StoreModule.hostLabel;
  newId: typeof StoreModule.newId;
  subscribe: typeof StoreModule.subscribe;
  storage: MemoryStorage;
  notify: typeof NotifyModule;
}

/**
 * The store keeps module-level mutable state (`snapshot`, `lastRaw`, `past`,
 * `future`) and only ever reads `localStorage` lazily, so the one way to get
 * a clean instance per test is: install a fresh storage, drop the module
 * cache, and re-import. `storage` defaults to a new `MemoryStorage`, or takes
 * one already written to — that's what a "simulated reload" is: the same
 * disk, a new module.
 *
 * The dynamic imports are load-bearing, not a convenience: `vi.resetModules`
 * only forces a re-evaluation on the *next* import, so a static import above
 * would keep resolving to the first module instance for the whole file.
 */
async function freshStore(storage: MemoryStorage = new MemoryStorage()): Promise<StoreHandle> {
  globalThis.localStorage = storage;
  vi.resetModules();
  const store = await import("@/lib/store");
  const notify = await import("@/lib/notify");
  return { ...store, storage, notify };
}

/** Built fresh per call, not shared: many tests move or re-title the result,
 *  and a shared literal would let one test's mutation leak into another's. */
const draft = (s: StoreHandle, startMin = 60, endMin = 120, repeat: Repeat = "never") =>
  s.draftEvent(at("2026-03-08"), startMin, endMin, "personal", repeat);

/**
 * `subscribe` installs a `storage` listener, so it needs a `window`. This is
 * the whole of the DOM this suite wants — jsdom would be a dependency and a
 * second environment for one `addEventListener`.
 *
 * Returns a `fire(key)` that plays another tab's write back at the listener.
 */
function withWindow<T>(body: (fire: (key: string) => void) => T): T {
  const handlers = new Set<(e: StorageEvent) => void>();
  vi.stubGlobal("window", {
    addEventListener: (_t: string, fn: (e: StorageEvent) => void) => handlers.add(fn),
    removeEventListener: (_t: string, fn: (e: StorageEvent) => void) => handlers.delete(fn),
  });
  try {
    return body((key) => {
      for (const fn of handlers) fn({ key } as StorageEvent);
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

/* ------------------------------ create ------------------------------ */

describe("create", () => {
  it("returns the event with an id, appended and persisted, not just held in memory", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    expect(created.id).toBeTruthy();
    expect(s.store.snapshot().events).toContainEqual(created);

    const persisted = JSON.parse(s.storage.getItem(KEY)!);
    expect(persisted.events).toContainEqual(created);
  });

  it("survives a simulated reload — same storage, a fresh module", async () => {
    const s1 = await freshStore();
    const created = s1.store.create(draft(s1));
    const s2 = await freshStore(s1.storage);
    expect(s2.store.snapshot().events).toContainEqual(created);
  });

  it("two creates yield two distinct ids", async () => {
    const s = await freshStore();
    const a = s.store.create(draft(s, 60, 120));
    const b = s.store.create(draft(s, 180, 240));
    expect(a.id).not.toBe(b.id);
  });
});

/* ------------------------------ update ------------------------------ */

describe("update", () => {
  it("patches only the named event; every other event is the same object, untouched", async () => {
    const s = await freshStore();
    const a = s.store.create({ ...draft(s, 60, 120), title: "A" });
    const b = s.store.create({ ...draft(s, 180, 240), title: "B" });
    s.store.update(a.id, { title: "A2" });
    const snap = s.store.snapshot();
    expect(snap.events.find((e) => e.id === a.id)?.title).toBe("A2");
    // Not just equal — the untouched event is literally the same reference,
    // proof that update() maps rather than rebuilds the array's contents.
    expect(snap.events.find((e) => e.id === b.id)).toBe(b);
  });

  it("patching a field to undefined actually sets it undefined, not a no-op", async () => {
    const s = await freshStore();
    const created = s.store.create({ ...draft(s), title: "has a title" });
    s.store.update(created.id, { title: undefined });
    expect(s.store.snapshot().events[0].title).toBeUndefined();
  });

  it("patching an id that does not exist is a no-op, not a crash", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    expect(() => s.store.update("does-not-exist", { title: "nope" })).not.toThrow();
    expect(s.store.snapshot().events).toEqual([created]);
  });
});

/* -------------------------- moving events --------------------------- */

describe("moving an event (update with new start/end)", () => {
  it("persists moved instants and preserves duration when both ends shift together", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s, 9 * 60, 10 * 60));
    const duration = created.end - created.start;
    const newStart = ms("2026-03-08 14:00");
    s.store.update(created.id, { start: newStart, end: newStart + duration });
    const moved = s.store.snapshot().events[0];
    expect(moved.start).toBeSameInstantAs(newStart);
    expect(moved.end).toBeSameInstantAs(newStart + duration);
    expect(moved.end - moved.start).toBe(duration);
  });

  // The store has no idea what a "series" is beyond the plain fields on the
  // event — dragging an arc just calls update() like any other move, and a
  // shallow recurrence has no per-occurrence exceptions to update instead.
  it("moving a recurring event moves the whole series — no per-occurrence override", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s, 9 * 60, 10 * 60, "weekly"));
    const newStart = ms("2026-03-08 16:00");
    const newEnd = ms("2026-03-08 17:00");
    s.store.update(created.id, { start: newStart, end: newEnd });
    const snap = s.store.snapshot();
    expect(snap.events).toHaveLength(1);
    const moved = snap.events[0];
    expect(moved.start).toBeSameInstantAs(newStart);
    expect(moved.end).toBeSameInstantAs(newEnd);
    expect(moved.repeat).toBe("weekly");
    expect(moved.seriesId).toBe(""); // this event IS the series, not an override of it
  });

  it("moving across a day boundary lands the event on the new day's key", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s, 23 * 60, 23 * 60 + 30));
    const newStart = ms("2026-03-09 01:00");
    const newEnd = ms("2026-03-09 01:30");
    s.store.update(created.id, { start: newStart, end: newEnd });
    const moved = s.store.snapshot().events[0];
    expect(moved.start).toBeSameInstantAs(newStart);
    expect(dayKey(new Date(moved.start))).toBe("2026-03-09");
  });

  // Europe/Berlin: 2026-03-29 is the spring-forward day. The store's job is
  // to persist whatever instant it is handed, not to reinterpret it — moving
  // an arc onto this day must not quietly round or shift the ms value.
  it("moving across a DST boundary stores exactly the instants written, unnormalised", async () => {
    const s = await freshStore();
    const created = s.store.create(s.draftEvent(at("2026-03-01"), 9 * 60, 10 * 60, "personal"));
    const newStart = ms("2026-03-29 09:00");
    const newEnd = ms("2026-03-29 10:00");
    s.store.update(created.id, { start: newStart, end: newEnd });
    const moved = s.store.snapshot().events[0];
    expect(moved.start).toBe(newStart);
    expect(moved.end).toBe(newEnd);
  });
});

/* ------------------------------ remove ------------------------------ */

describe("remove", () => {
  it("removes exactly one event and persists the removal", async () => {
    const s = await freshStore();
    const a = s.store.create(draft(s, 60, 120));
    const b = s.store.create(draft(s, 180, 240));
    s.store.remove(a.id);
    expect(s.store.snapshot().events.map((e) => e.id)).toEqual([b.id]);
    const persisted = JSON.parse(s.storage.getItem(KEY)!);
    expect(persisted.events.map((e: { id: string }) => e.id)).toEqual([b.id]);
  });

  it("removing a non-existent id is a no-op", async () => {
    const s = await freshStore();
    const a = s.store.create(draft(s));
    s.store.remove("does-not-exist");
    expect(s.store.snapshot().events).toEqual([a]);
  });

  it("removing the last event leaves an empty array, not a reseed", async () => {
    const s = await freshStore();
    const a = s.store.create(draft(s));
    s.store.remove(a.id);
    expect(s.store.snapshot().events).toEqual([]);
  });
});

describe("removeCalendar", () => {
  it("removes the calendar, all its own events, and its cached feed entry", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    s.store.setFeedEvents(cal.id, [event({ title: "cached feed event" })]);
    const owned = s.store.create({ ...draft(s), calendarId: cal.id });
    expect(s.store.snapshot().feeds[cal.id]).toBeDefined(); // sanity: it was cached

    s.store.removeCalendar(cal.id);
    const snap = s.store.snapshot();
    expect(snap.calendars.some((c) => c.id === cal.id)).toBe(false);
    expect(snap.events.some((e) => e.id === owned.id)).toBe(false);
    expect(snap.feeds[cal.id]).toBeUndefined();
  });
});

describe("addCalendarWithEvents", () => {
  it("adds calendar and events in one undoable step, stamping each calendarId", async () => {
    const s = await freshStore();
    const imported = event({ title: "imported", calendarId: "wrong-on-purpose" });
    const cal = s.store.addCalendarWithEvents("Imported", [imported]);

    const snap = s.store.snapshot();
    expect(snap.calendars.some((c) => c.id === cal.id)).toBe(true);
    const stamped = snap.events.find((e) => e.id === imported.id);
    expect(stamped?.calendarId).toBe(cal.id);

    expect(s.store.undo()).toBe(true);
    const undone = s.store.snapshot();
    expect(undone.calendars.some((c) => c.id === cal.id)).toBe(false);
    expect(undone.events.some((e) => e.id === imported.id)).toBe(false);
  });
});

/* ------------------------------ undo/redo ----------------------------- */

describe("undo / redo", () => {
  it("create -> undo -> gone; redo -> back", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().events).toEqual([]);
    expect(s.store.redo()).toBe(true);
    expect(s.store.snapshot().events).toEqual([created]);
  });

  it("update -> undo -> reverted; redo -> reapplied", async () => {
    const s = await freshStore();
    const created = s.store.create({ ...draft(s), title: "before" });
    s.store.update(created.id, { title: "after" });
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().events[0].title).toBe("before");
    expect(s.store.redo()).toBe(true);
    expect(s.store.snapshot().events[0].title).toBe("after");
  });

  it("remove -> undo -> restored; redo -> removed again", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    s.store.remove(created.id);
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().events).toEqual([created]);
    expect(s.store.redo()).toBe(true);
    expect(s.store.snapshot().events).toEqual([]);
  });

  it("caps undo depth at 60 — the oldest change survives 61 undos", async () => {
    const s = await freshStore();
    const titles = Array.from({ length: 61 }, (_, i) => `e${i}`);
    for (const title of titles) s.store.create({ ...draft(s), title });
    expect(s.store.snapshot().events).toHaveLength(61);

    let undone = 0;
    for (let i = 0; i < 61; i++) {
      if (s.store.undo()) undone++;
    }
    // The 61st push shifted the pre-first-create state out of history, so
    // only 60 undos succeed, and the very first create can never be undone.
    expect(undone).toBe(60);
    expect(s.store.snapshot().events).toHaveLength(1);
    expect(s.store.snapshot().events[0].title).toBe("e0");
    expect(s.store.undo()).toBe(false);
  });

  it("a new change after an undo clears the redo future", async () => {
    const s = await freshStore();
    const first = s.store.create({ ...draft(s), title: "first" });
    s.store.create({ ...draft(s), title: "second" });
    expect(s.store.undo()).toBe(true); // "second" undone, redo would bring it back
    s.store.create({ ...draft(s), title: "third" }); // a new branch of history
    expect(s.store.redo()).toBe(false);
    expect(
      s.store
        .snapshot()
        .events.map((e) => e.title)
        .sort(),
    ).toEqual(["first", "third"]);
    expect(s.store.snapshot().events.some((e) => e.id === first.id)).toBe(true);
  });

  it("undo() and redo() return false when there is nothing to do", async () => {
    const s = await freshStore();
    expect(s.store.undo()).toBe(false);
    expect(s.store.redo()).toBe(false);
    s.store.create(draft(s));
    expect(s.store.redo()).toBe(false); // nothing to redo without a prior undo
  });

  /* A settings change is not an undo step, so undoing past one must not take
   * the setting with it. The history holds whole snapshots, so the recorded
   * one still carries the *old* settings — restoring it wholesale silently
   * flipped a switch the user changed after the change they were undoing. */
  it("does not revert a setting changed after the step being undone", async () => {
    const s = await freshStore();
    const created = s.store.create({ ...draft(s), title: "meeting" });
    s.store.setClock("24h");
    s.store.setToggle("totals", true);

    expect(s.store.undo()).toBe(true);

    expect(s.store.snapshot().events.some((e) => e.id === created.id)).toBe(false);
    expect(s.store.snapshot().settings.clock).toBe("24h");
    expect(s.store.snapshot().settings.totals).toBe(true);
  });

  it("does not re-apply the setting on redo either", async () => {
    const s = await freshStore();
    s.store.create({ ...draft(s), title: "meeting" });
    s.store.setClock("24h");
    s.store.undo();
    s.store.setClock("12h");

    expect(s.store.redo()).toBe(true);
    expect(s.store.snapshot().settings.clock).toBe("12h");
  });

  /* `restore` is the exception: it replaces settings *as part of* an undoable
   * change, so its step owns them and undoing it must put them back. */
  it("puts settings back when undoing a restore, which does own them", async () => {
    const s = await freshStore();
    s.store.setClock("12h");
    s.store.restore({
      events: [],
      calendars: [{ id: "imported", name: "Imported", color: "#8ecbff", visible: true }],
      settings: { ...DEFAULT_SETTINGS, clock: "24h" },
    });
    expect(s.store.snapshot().settings.clock).toBe("24h");

    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().settings.clock).toBe("12h");
  });
});

const SETTINGS_ACTIONS: { name: string; act: (s: StoreHandle) => void }[] = [
  { name: "setClock", act: (s) => s.store.setClock("24h") },
  { name: "setToggle", act: (s) => s.store.setToggle("moonlight", false) },
  { name: "setSecondZone", act: (s) => s.store.setSecondZone("Europe/Paris") },
  {
    name: "setPlace",
    act: (s) => s.store.setPlace({ lat: 48.85, lon: 2.35, label: "Paris", zone: "Europe/Paris" }),
  },
  { name: "setLife", act: (s) => s.store.setLife("2000-01-01", 90) },
  { name: "toggleCalendar", act: (s) => s.store.toggleCalendar("personal") },
  { name: "addFeed", act: (s) => void s.store.addFeed("https://example.com/feed.ics", "Feed") },
  {
    name: "setFeedEvents",
    act: (s) => {
      const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
      s.store.setFeedEvents(cal.id, []);
    },
  },
  {
    name: "setFeedError",
    act: (s) => {
      const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
      s.store.setFeedError(cal.id, "boom");
    },
  },
];

describe("settings changes and feed pulls are not undoable", () => {
  it.each(SETTINGS_ACTIONS)(
    "$name: undo() reaches past it to the change before it",
    async ({ act }) => {
      const s = await freshStore();
      const created = s.store.create(draft(s));
      act(s);
      expect.soft(s.store.undo()).toBe(true);
      expect.soft(s.store.snapshot().events.find((e) => e.id === created.id)).toBeUndefined();
    },
  );
});

/* -------------------------------- fresh() ------------------------------- */

describe("fresh() — every action derives from storage, never the in-memory snapshot", () => {
  // The documented bug this exists to prevent: another tab writes between
  // this tab's last read and this tab's next action. If an action derived
  // from the in-memory snapshot instead of re-reading storage, the other
  // tab's event would be silently overwritten on the next write.
  it("survives another tab's write when this tab creates without re-reading first", async () => {
    const s = await freshStore();
    s.store.create({ ...draft(s), title: "A" }); // this tab, synced to storage

    // Another tab writes directly to storage, bypassing this tab entirely.
    const otherTabBlob = JSON.parse(s.storage.getItem(KEY)!);
    otherTabBlob.events.push(event({ title: "B" }));
    s.storage.setItem(KEY, JSON.stringify(otherTabBlob));

    // This tab now acts, unaware of B, on what it believes is the latest state.
    s.store.create({ ...draft(s), title: "C" });

    const titles = s.store
      .snapshot()
      .events.map((e) => e.title)
      .sort();
    expect(titles).toEqual(["A", "B", "C"]);
  });

  it("re-parses only when the raw string actually changed", async () => {
    const s = await freshStore();
    const first = s.store.snapshot();
    const second = s.store.snapshot();
    expect(second).toBe(first); // no write happened in between — same object

    s.store.create(draft(s));
    const third = s.store.snapshot();
    expect(third).not.toBe(first); // storage changed — a new snapshot was parsed in
  });
});

/* ---------------------------- parsing & sane() --------------------------- */

describe("sane() via setLife", () => {
  it.each([
    {
      name: "malformed birth (unpadded month/day) is dropped to empty",
      birth: "2000-1-1",
      life: 80,
      wantBirth: "",
      wantLife: 80,
    },
    {
      name: "life below range clamps to the minimum",
      birth: "2000-01-01",
      life: 0,
      wantBirth: "2000-01-01",
      wantLife: LIFE_EXPECTANCY_RANGE.min,
    },
    {
      name: "life above range clamps to the maximum",
      birth: "2000-01-01",
      life: 999,
      wantBirth: "2000-01-01",
      wantLife: LIFE_EXPECTANCY_RANGE.max,
    },
    {
      name: "NaN life falls back to the default",
      birth: "2000-01-01",
      life: NaN,
      wantBirth: "2000-01-01",
      wantLife: DEFAULT_SETTINGS.lifeExpectancy,
    },
    {
      name: "Infinity life falls back to the default",
      birth: "2000-01-01",
      life: Infinity,
      wantBirth: "2000-01-01",
      wantLife: DEFAULT_SETTINGS.lifeExpectancy,
    },
    {
      name: "a fractional life rounds",
      birth: "2000-01-01",
      life: 45.6,
      wantBirth: "2000-01-01",
      wantLife: 46,
    },
  ])("$name", async ({ birth, life, wantBirth, wantLife }) => {
    const s = await freshStore();
    s.store.setLife(birth, life);
    const settings = s.store.snapshot().settings;
    expect.soft(settings.birth).toBe(wantBirth);
    expect.soft(settings.lifeExpectancy).toBe(wantLife);
  });
});

describe("sane() via parsing a stored blob", () => {
  it("a malformed stored birth is dropped to empty, the same as the setLife path", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { birth: "not-a-date", lifeExpectancy: 40 },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.birth).toBe("");
    expect(s.store.snapshot().settings.lifeExpectancy).toBe(40);
  });

  it("a place with no zone field is dropped to null", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { place: { lat: 1, lon: 2, label: "X" } },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.place).toBeNull();
  });

  it("a place with a zone field survives", async () => {
    const storage = new MemoryStorage();
    const place = { lat: 48.85, lon: 2.35, label: "Paris", zone: "Europe/Paris" };
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: { place } }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.place).toEqual(place);
  });

  it.each([
    { name: "a mode the panel cannot show", stored: "sometimes", want: "always" },
    { name: "a non-string", stored: 3, want: "always" },
    { name: "a mode it can", stored: "hover", want: "hover" },
  ])("arcLabels: $name → $want", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { arcLabels: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.arcLabels).toBe(want);
  });

  // A blob written before the labels existed. Absent is not wrong, and the
  // default is on: an unlabelled arc is not something anybody chose.
  it("a blob with no arcLabels key gets the default", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.arcLabels).toBe("always");
  });
});

describe("migrateSettings", () => {
  it.each([
    {
      name: "night: false migrates to moonlight: false, key dropped",
      night: false,
      moonlight: false,
    },
    { name: "night: true migrates to moonlight: true, key dropped", night: true, moonlight: true },
  ])("$name", async ({ night, moonlight }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: { night } }),
    );
    const s = await freshStore(storage);
    const settings = s.store.snapshot().settings;
    expect.soft(settings.moonlight).toBe(moonlight);
    expect.soft(settings).not.toHaveProperty("night");
  });
});

describe("a stale schema", () => {
  it("resets settings to defaults but keeps events", async () => {
    const storage = new MemoryStorage();
    const kept = event({ title: "keep me" });
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 1, // SCHEMA is 2 — this blob is stale
        events: [kept],
        calendars: [{ id: "personal", name: "Personal", color: "#fff", visible: true }],
        feeds: {},
        settings: { clock: "24h", birth: "1990-05-05" },
      }),
    );
    const s = await freshStore(storage);
    const snap = s.store.snapshot();
    expect(snap.settings).toEqual(DEFAULT_SETTINGS);
    expect(snap.events.map((e) => e.title)).toEqual(["keep me"]);
  });
});

describe("a corrupted blob", () => {
  it("does not throw and does not lose the app — it starts clean", async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, "{not valid json");
    const s = await freshStore(storage);
    expect(() => s.store.snapshot()).not.toThrow();
    const snap = s.store.snapshot();
    expect(snap.events).toEqual([]);
    expect(snap.calendars.length).toBeGreaterThan(0);
  });
});

describe("hydrateEvents", () => {
  it("fills recurrence fields an old blob lacks, not leaving them undefined", async () => {
    const storage = new MemoryStorage();
    const old = {
      id: "old1",
      title: "Old",
      calendarId: "personal",
      start: ms("2026-03-08 09:00"),
      end: ms("2026-03-08 10:00"),
      allDay: false,
      location: "",
      url: "",
      notes: "",
      seriesId: "",
      seriesKey: "",
      color: "",
      // no repeat/interval/until/wkst/by*/exdates/rdates at all
    };
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [old], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    const hydrated = s.store.snapshot().events[0];
    expect(hydrated.interval).toBe(1);
    expect(hydrated.until).toBe(0);
    expect(hydrated.wkst).toBe(1);
    expect(hydrated.byMonth).toEqual([]);
    expect(hydrated.byDay).toEqual([]);
    expect(hydrated.exdates).toEqual([]);
    expect(hydrated.rdates).toEqual([]);
    expect(hydrated.seriesId).toBe(""); // already a string — untouched, not re-defaulted wrong
  });
});

describe("seed()", () => {
  it("an empty-but-present blob does not re-seed", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().events).toEqual([]);
  });

  // `seed()` runs only inside `load()`, and `load()` runs only from the first
  // `subscribe()` — never from `fresh()`, which every `store.*` action goes
  // through. So an action fired before anything has subscribed sees an
  // *unseeded* empty store. That never bites the real app (every screen calls
  // `useStore()` long before a user can act), and `subscribe` is exported
  // precisely so the hydration path can be exercised without a React tree.
  it("the action API alone never seeds, because nothing has subscribed yet", async () => {
    const s = await freshStore();
    expect(s.store.snapshot().events).toEqual([]);
  });

  it("seeds on the first subscribe against empty storage", async () => {
    const s = await freshStore();
    withWindow(() => s.subscribe(() => {}));
    expect(s.store.snapshot().events.length).toBeGreaterThan(0);
  });

  it("anchors the seed on today's local midnight", async () => {
    const s = await freshStore();
    withWindow(() => s.subscribe(() => {}));

    const today = dayKey(new Date());
    // Every seeded event belongs to today — the shape (a morning gap, a
    // stacked afternoon, a late call) is only legible if it is *this* day.
    for (const e of s.store.snapshot().events) {
      expect.soft(dayKey(new Date(e.start)), `"${e.title}" is not on today`).toBe(today);
    }
  });

  it("does not seed over a stored blob", async () => {
    const s1 = await freshStore();
    withWindow(() => s1.subscribe(() => {}));
    const seeded = s1.store.snapshot().events.length;

    s1.store.remove(s1.store.snapshot().events[0].id);
    const s2 = await freshStore(s1.storage);
    withWindow(() => s2.subscribe(() => {}));

    expect(s2.store.snapshot().events).toHaveLength(seeded - 1);
  });
});

/* -------------------------------- quota -------------------------------- */

describe("a write that fails", () => {
  it("keeps the in-memory snapshot; a failed write notifies with an error", async () => {
    const s = await freshStore();
    const spy = vi.spyOn(s.notify, "notify");
    s.storage.quota = 0; // every setItem throws from here on
    const created = s.store.create(draft(s));
    expect(s.store.snapshot().events).toContainEqual(created); // in-memory still works
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/not saved/i);
    expect(spy.mock.calls[0][1]).toBe("error");
  });
});

/* -------------------------------- misc --------------------------------- */

describe("draftEvent", () => {
  it.each([
    { name: "1439 minutes stays timed, not all-day", endMin: 1439, wantAllDay: false },
    {
      name: "exactly 1440 minutes becomes all-day, snapped to the two midnights",
      endMin: 1440,
      wantAllDay: true,
    },
    {
      name: "1441 minutes is still all-day, end clamped to the next midnight",
      endMin: 1441,
      wantAllDay: true,
    },
  ])("$name", async ({ endMin, wantAllDay }) => {
    const s = await freshStore();
    const dayStart = at("2026-03-08").getTime();
    const drafted = s.draftEvent(at("2026-03-08"), 0, endMin, "personal");
    expect.soft(drafted.allDay).toBe(wantAllDay);
    if (wantAllDay) {
      expect.soft(drafted.start).toBe(dayStart);
      expect.soft(drafted.end).toBe(dayStart + 1440 * 60_000); // clamped, never endMin's own value
    } else {
      expect.soft(drafted.start).toBe(dayStart);
      expect.soft(drafted.end).toBe(dayStart + endMin * 60_000);
    }
  });
});

describe("newId", () => {
  it("returns distinct values across rapid calls", async () => {
    const s = await freshStore();
    const ids = Array.from({ length: 200 }, () => s.newId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("hostLabel", () => {
  it.each([
    { name: "strips a leading www.", url: "https://www.example.com/feed.ics", want: "example.com" },
    { name: "leaves a host with no www. alone", url: "https://example.org/x", want: "example.org" },
    {
      name: "falls back to Subscription on an unparseable URL",
      url: "not a url",
      want: "Subscription",
    },
    {
      name: "strips only the leading www., not an inner one",
      url: "http://www.www.example.com",
      want: "www.example.com",
    },
  ])("$name", async ({ url, want }) => {
    const s = await freshStore();
    expect.soft(s.hostLabel(url)).toBe(want);
  });
});
