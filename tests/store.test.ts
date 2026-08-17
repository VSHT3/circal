import { describe, expect, it, vi } from "vitest";
import { at, calendar, ms, event, MemoryStorage } from "./helpers";
import {
  instantKey,
  PALETTE,
  REMIND_INHERIT,
  REMIND_SILENT,
  type CalEvent,
  type Repeat,
} from "@/lib/events";
import { DEFAULT_SETTINGS, LIFE_EXPECTANCY_RANGE, duplicateOf } from "@/lib/store";
import { MINUTES_PER_DAY, addDays, addMonths, dayKey, daysBetween, startOfDay } from "@/lib/time";
import type * as StoreModule from "@/lib/store";
import type * as NotifyModule from "@/lib/notify";

const KEY = "circal.v1";

/** What `freshStore()` hands back to a test: the store API, the storage it
 *  was built against, and the notify module to spy on. */
interface StoreHandle {
  store: typeof StoreModule.store;
  defaultCalendarId: typeof StoreModule.defaultCalendarId;
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

/* --------------------------- editing a series --------------------------- */

/** A weekly series seeded on Sunday 8 March 2026 at 01:00, and the instants of
 *  the three occurrences after it. */
const WEEKLY = {
  seed: ms("2026-03-08 01:00"),
  second: ms("2026-03-15 01:00"),
  third: ms("2026-03-22 01:00"),
  fourth: ms("2026-03-29 01:00"),
};

/** An override of `series` on `at`, the way the editor's "only this one" writes
 *  one: its own event, pointing back at the occurrence it replaces. */
function override(s: StoreHandle, series: CalEvent, at: number): CalEvent {
  return s.store.create({
    ...draft(s),
    title: `override ${instantKey(at)}`,
    seriesId: series.id,
    seriesKey: instantKey(at),
  });
}

/** The series' own body, ready to be handed back as the tail of a split. */
function body(series: CalEvent): Omit<CalEvent, "id"> {
  const { id: _id, ...rest } = series;
  return rest;
}

describe("remove — a series takes its overrides with it", () => {
  it("deletes the event and every override that detached from it, and nothing else", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    override(s, series, WEEKLY.second);
    const unrelated = s.store.create(draft(s, 300, 360));

    s.store.remove(series.id);
    expect(s.store.snapshot().events.map((e) => e.id)).toEqual([unrelated.id]);
  });
});

describe("splitSeries", () => {
  it("bounds the original at the instant before the cut and seeds a new series there", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    const tail = s.store.splitSeries(series.id, WEEKLY.third, {
      ...body(series),
      start: WEEKLY.third + 60 * 60_000,
      end: WEEKLY.third + 120 * 60_000,
    });

    const head = s.store.snapshot().events.find((e) => e.id === series.id);
    expect.soft(head?.until).toBe(WEEKLY.third - 1);
    expect.soft(tail?.start).toBe(WEEKLY.third + 60 * 60_000);
    // A tail is a series, not an override: it repeats, and it points at nothing.
    expect.soft(tail?.repeat).toBe("weekly");
    expect.soft(tail?.seriesId).toBe("");
    expect(tail?.seriesKey).toBe("");
  });

  it("is one undoable step — the state between the two writes is a series with no future", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    s.store.splitSeries(series.id, WEEKLY.third, body(series));

    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().events).toEqual([series]);
  });

  it("re-points an override past the cut at the new series and leaves an earlier one alone", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    const before = override(s, series, WEEKLY.second);
    const after = override(s, series, WEEKLY.fourth);

    const tail = s.store.splitSeries(series.id, WEEKLY.third, body(series));
    const events = s.store.snapshot().events;
    const seriesOf = (id: string) => events.find((e) => e.id === id)?.seriesId;
    expect.soft(seriesOf(before.id)).toBe(series.id);
    expect(seriesOf(after.id)).toBe(tail?.id);
  });

  it("carries the exclusions past the cut onto the tail, so a skipped day stays skipped", async () => {
    const s = await freshStore();
    const series = s.store.create({
      ...draft(s, 60, 120, "weekly"),
      exdates: [instantKey(WEEKLY.second), instantKey(WEEKLY.fourth)],
    });
    const tail = s.store.splitSeries(series.id, WEEKLY.third, body(series));

    const head = s.store.snapshot().events.find((e) => e.id === series.id);
    expect.soft(head?.exdates).toEqual([instantKey(WEEKLY.second)]);
    expect(tail?.exdates).toEqual([instantKey(WEEKLY.fourth)]);
  });

  it("writes nothing for an id that is not there", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    expect(s.store.splitSeries("does-not-exist", WEEKLY.third, body(series))).toBeNull();
    expect(s.store.snapshot().events).toEqual([series]);
  });
});

describe("truncateSeries", () => {
  it("stops the series at the cut and takes the overrides past it with it", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    const before = override(s, series, WEEKLY.second);
    override(s, series, WEEKLY.fourth);

    s.store.truncateSeries(series.id, WEEKLY.third);
    const events = s.store.snapshot().events;
    expect.soft(events.find((e) => e.id === series.id)?.until).toBe(WEEKLY.third - 1);
    expect(events.map((e) => e.id)).toEqual([series.id, before.id]);
  });

  it("writes nothing for an id that is not there", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    s.store.truncateSeries("does-not-exist", WEEKLY.third);
    expect(s.store.snapshot().events).toEqual([series]);
  });
});

describe("addCalendar", () => {
  it("appends a named calendar in the colour and mark it was given, visible, undoable", async () => {
    const s = await freshStore();
    const before = s.store.snapshot().calendars.length;
    const cal = s.store.addCalendar("Studio", "#ff9fb4", "paint-brush");

    const snap = s.store.snapshot();
    expect.soft(snap.calendars.length).toBe(before + 1);
    expect.soft(snap.calendars.at(-1)).toEqual({
      id: cal.id,
      name: "Studio",
      color: "#ff9fb4",
      icon: "paint-brush",
      visible: true,
    });

    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().calendars.some((c) => c.id === cal.id)).toBe(false);
  });

  it("walks the palette when no colour is named, and takes no mark", async () => {
    const s = await freshStore();
    const cal = s.store.addCalendar("Studio");
    expect.soft(PALETTE).toContain(cal.color);
    expect.soft(cal.icon).toBe("");
  });
});

describe("updateCalendar", () => {
  it("renames and recolours, and leaves the rest of the calendar alone", async () => {
    const s = await freshStore();
    const before = s.store.snapshot().calendars[0];
    s.store.updateCalendar(before.id, { name: "Renamed", color: "#8bf0b8" });

    const after = s.store.snapshot().calendars[0];
    expect.soft(after).toEqual({ ...before, name: "Renamed", color: "#8bf0b8" });
  });

  it("survives a feed pull that would otherwise rename it", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", s.hostLabel("https://example.com"));
    s.store.updateCalendar(cal.id, { name: "Mine" });
    s.store.setFeedEvents(cal.id, [], "What the host calls it");
    expect(s.store.snapshot().calendars.find((c) => c.id === cal.id)?.name).toBe("Mine");
  });

  it("writes nothing for an id that is not there", async () => {
    const s = await freshStore();
    const before = s.store.snapshot().calendars;
    s.store.updateCalendar("does-not-exist", { name: "Renamed" });
    expect(s.store.snapshot().calendars).toEqual(before);
  });
});

describe("removeCalendar", () => {
  it("drops the calendar and its cached feed entry", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    s.store.setFeedEvents(cal.id, [event({ title: "cached feed event" })]);
    expect(s.store.snapshot().feeds[cal.id]).toBeDefined(); // sanity: it was cached

    s.store.removeCalendar(cal.id);
    const snap = s.store.snapshot();
    expect.soft(snap.calendars.some((c) => c.id === cal.id)).toBe(false);
    expect.soft(snap.feeds[cal.id]).toBeUndefined();
  });

  // The whole point of the rewrite: a calendar is a label, and deleting a
  // label is not a way to ask for a year of appointments to be deleted too.
  it("moves its own events to the first calendar left, and says how many", async () => {
    const s = await freshStore();
    const [first, second] = s.store.snapshot().calendars;
    const kept = s.store.create({ ...draft(s), calendarId: second.id });
    const other = s.store.create({ ...draft(s), calendarId: first.id });

    const gone = s.store.removeCalendar(second.id);
    expect.soft(gone).toEqual({ into: expect.objectContaining({ id: first.id }), moved: 1 });

    const snap = s.store.snapshot();
    expect.soft(snap.events.find((e) => e.id === kept.id)?.calendarId).toBe(first.id);
    expect.soft(snap.events.find((e) => e.id === other.id)?.calendarId).toBe(first.id);
  });

  it("refuses to remove the last calendar that is not a feed", async () => {
    const s = await freshStore();
    const locals = s.store.snapshot().calendars.filter((c) => !c.feed);
    for (const c of locals.slice(0, -1)) s.store.removeCalendar(c.id);

    const last = s.store.snapshot().calendars.filter((c) => !c.feed);
    expect.soft(last.length).toBe(1);
    expect.soft(s.store.removeCalendar(last[0].id)).toBeNull();
    expect.soft(s.store.snapshot().calendars.some((c) => c.id === last[0].id)).toBe(true);
  });

  it("still removes a subscription when it is the only calendar left", async () => {
    const s = await freshStore();
    const locals = s.store.snapshot().calendars.filter((c) => !c.feed);
    const feed = s.store.addFeed("https://example.com/feed.ics", "Feed");
    // Every local one but the last, then the last — which is refused — leaves
    // one local and one feed, and the feed must still be removable.
    for (const c of locals.slice(0, -1)) s.store.removeCalendar(c.id);
    expect(s.store.removeCalendar(feed.id)).not.toBeNull();
    expect(s.store.snapshot().calendars.some((c) => c.id === feed.id)).toBe(false);
  });

  it("returns null for an id that is not there", async () => {
    const s = await freshStore();
    const before = s.store.snapshot().calendars;
    expect.soft(s.store.removeCalendar("does-not-exist")).toBeNull();
    expect.soft(s.store.snapshot().calendars).toEqual(before);
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
      calendars: [{ id: "imported", name: "Imported", color: "#8ecbff", icon: "", visible: true }],
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
  { name: "setDeviceZone", act: (s) => s.store.setDeviceZone("Europe/Paris") },
  {
    name: "setPlace",
    act: (s) => s.store.setPlace({ lat: 48.85, lon: 2.35, label: "Paris", zone: "Europe/Paris" }),
  },
  { name: "setLife", act: (s) => s.store.setLife("2000-01-01", 90) },
  { name: "setWeekStart", act: (s) => s.store.setWeekStart(0) },
  { name: "setWaking", act: (s) => s.store.setWaking(7 * 60, 21 * 60) },
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

/* -------------------------------- travel -------------------------------- */

describe("the travel answers", () => {
  /** A floating 09:00 event, and a browser that thinks it is still in Berlin. */
  async function travelled(): Promise<{ s: StoreHandle; created: CalEvent }> {
    const s = await freshStore();
    s.store.setDeviceZone("Europe/Berlin");
    const created = s.store.create({
      ...draft(s),
      start: ms("2026-07-15 09:00"),
      end: ms("2026-07-15 10:00"),
    });
    return { s, created };
  }

  it("setDeviceZone records the zone and asks nothing of the events — the silent first run", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    s.store.setDeviceZone("Europe/Berlin");
    expect.soft(s.store.snapshot().settings.deviceZone).toBe("Europe/Berlin");
    expect.soft(s.store.snapshot().events.find((e) => e.id === created.id)).toEqual(created);
  });

  it("moveEventsToZone shifts the events and moves the remembered zone in one commit", async () => {
    const { s, created } = await travelled();
    expect.soft(s.store.moveEventsToZone("Europe/Berlin", "America/New_York")).toBe(1);
    const moved = s.store.snapshot().events.find((e) => e.id === created.id)!;
    expect.soft(moved.start - created.start).toBe(6 * 3_600_000);
    expect.soft(moved.tzid).toBe("");
    expect.soft(s.store.snapshot().settings.deviceZone).toBe("America/New_York");
  });

  it("keepEventsInZone stamps the events, touching no instant, and moves the zone too", async () => {
    const { s, created } = await travelled();
    expect.soft(s.store.keepEventsInZone("Europe/Berlin", "America/New_York")).toBe(1);
    const kept = s.store.snapshot().events.find((e) => e.id === created.id)!;
    expect.soft(kept.start).toBe(created.start);
    expect.soft(kept.tzid).toBe("Europe/Berlin");
    expect.soft(s.store.snapshot().settings.deviceZone).toBe("America/New_York");
  });

  it.each([
    {
      name: "move",
      act: (s: StoreHandle) => s.store.moveEventsToZone("Europe/Berlin", "America/New_York"),
    },
    {
      name: "keep",
      act: (s: StoreHandle) => s.store.keepEventsInZone("Europe/Berlin", "America/New_York"),
    },
  ])(
    "$name is one undo step: it restores every instant and leaves the zone recorded",
    async ({ act }) => {
      const { s, created } = await travelled();
      act(s);
      expect.soft(s.store.undo()).toBe(true);
      expect.soft(s.store.snapshot().events.find((e) => e.id === created.id)).toEqual(created);
      // Deliberately *not* wound back: the question has been answered, and a
      // stored zone rolled back with the events would ask it again.
      expect.soft(s.store.snapshot().settings.deviceZone).toBe("America/New_York");
      // One step, so a second undo reaches past the answer to the creation.
      expect.soft(s.store.undo()).toBe(true);
      expect.soft(s.store.snapshot().events).toHaveLength(0);
    },
  );

  it("keepEventsInZone records the zone it stamped with, so the Clear has a scope", async () => {
    const { s } = await travelled();
    s.store.keepEventsInZone("Europe/Berlin", "America/New_York");
    expect(s.store.snapshot().settings.stampedZones).toEqual(["Europe/Berlin"]);
  });

  it("keepEventsInZone records nothing when nothing took a stamp", async () => {
    const s = await freshStore();
    s.store.setDeviceZone("Europe/Berlin");
    // An all-day event is re-anchored rather than stamped, so this answer
    // leaves no stamp — and must leave no zone behind for the row to count.
    s.store.create({
      ...draft(s),
      allDay: true,
      start: at("2026-10-05").getTime(),
      end: at("2026-10-06").getTime(),
    });
    s.store.keepEventsInZone("Europe/Berlin", "America/New_York");
    expect(s.store.snapshot().settings.stampedZones).toEqual([]);
  });

  it("clearEventZones takes the recorded stamps off in one undoable step, and says how many", async () => {
    const { s, created } = await travelled();
    s.store.keepEventsInZone("Europe/Berlin", "America/New_York");
    expect.soft(s.store.clearEventZones()).toBe(1);
    expect.soft(s.store.snapshot().events.find((e) => e.id === created.id)?.tzid).toBe("");
    // The zones go with them: nothing carries them, and a list left behind is
    // a row offering to clear nothing.
    expect.soft(s.store.snapshot().settings.stampedZones).toEqual([]);
    expect.soft(s.store.undo()).toBe(true);
    expect
      .soft(s.store.snapshot().events.find((e) => e.id === created.id)?.tzid)
      .toBe("Europe/Berlin");
    // This one action owns its settings, so the undo brings back the list that
    // names those stamps — without it they would be unclearable.
    expect.soft(s.store.snapshot().settings.stampedZones).toEqual(["Europe/Berlin"]);
  });

  it("clearEventZones leaves an imported event's own zone alone", async () => {
    const { s } = await travelled();
    // What an .ics import lands in this same list: a weekly 09:00 New York
    // standup whose zone came out of the file, not out of an answer here.
    const imported = s.store.create({ ...draft(s), tzid: "America/Chicago", repeat: "weekly" });
    s.store.keepEventsInZone("Europe/Berlin", "America/New_York");
    expect.soft(s.store.clearEventZones()).toBe(1);
    expect
      .soft(s.store.snapshot().events.find((e) => e.id === imported.id)?.tzid)
      .toBe("America/Chicago");
  });

  it("clearEventZones with nothing recorded writes no undo step at all", async () => {
    const { s, created } = await travelled();
    // A zone on an event, and no answer that put it there: not this row's.
    s.store.update(created.id, { tzid: "America/Chicago" });
    expect.soft(s.store.clearEventZones()).toBe(0);
    expect
      .soft(s.store.snapshot().events.find((e) => e.id === created.id)?.tzid)
      .toBe("America/Chicago");
    // The step undo reaches is that update, not a commit this made.
    expect.soft(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().events.find((e) => e.id === created.id)?.tzid).toBe("");
  });
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

  it.each([
    { name: "a zone Intl cannot resolve", stored: "Mars/Olympus_Mons", want: "" },
    { name: "a non-string", stored: 7, want: "" },
    { name: "a zone it can", stored: "Europe/Berlin", want: "Europe/Berlin" },
  ])("deviceZone: $name → '$want'", async ({ stored, want }) => {
    // A remembered zone nothing resolves would have the travel notice naming
    // a place that does not exist, or asking about a move nobody made; `""`
    // is read as a first run, which is silent.
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { deviceZone: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.deviceZone).toBe(want);
  });

  it.each([
    { name: "the garbage among them", stored: ["Europe/Berlin", "Mars/Olympus_Mons", 7] },
    { name: "the duplicates among them", stored: ["Europe/Berlin", "Europe/Berlin"] },
  ])("stampedZones: drops $name", async ({ stored }) => {
    // A garbage entry here scopes the Clear to nothing while the row still
    // counts against it — a verb offered that does nothing.
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { stampedZones: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.stampedZones).toEqual(["Europe/Berlin"]);
  });

  it("stampedZones: anything that is not a list becomes one", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { stampedZones: "Europe/Berlin" },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.stampedZones).toEqual([]);
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

  // The one ambient setting that can act on its own. A delay off the list is
  // a timer the panel cannot show, and a mode arriving on a schedule nothing
  // on screen names is worse than one that never arrives.
  it.each([
    { name: "a delay the panel cannot offer", stored: 7, want: 0 },
    { name: "a non-number", stored: "5", want: 0 },
    { name: "a delay it can", stored: 10, want: 10 },
  ])("ambientAfter: $name → $want", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { ambientAfter: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.ambientAfter).toBe(want);
  });

  // The backup nudge's interval, pinned the same way: an interval off the list
  // is a nudge on a schedule nothing on screen names.
  it.each([
    { name: "an interval the panel cannot offer", stored: 45, want: 30 },
    { name: "a non-number", stored: "30", want: 30 },
    { name: "an interval it can", stored: 14, want: 14 },
  ])("backupInterval: $name → $want", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { backupInterval: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.backupInterval).toBe(want);
  });

  // A blob written before the mode existed: the timer stays off, and the face
  // keeps the defaults rather than inheriting the working face's.
  it("a blob with no ambient keys gets the defaults, timer included", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: {} }),
    );
    const { settings } = (await freshStore(storage)).store.snapshot();
    expect(settings.ambientAfter).toBe(0);
    expect(settings.ambientDim).toBe(true);
    expect(settings.ambientDaylight).toBe(true);
    expect(settings.ambientMoonlight).toBe(true);
    expect(settings.ambientZoneRing).toBe(false);
    expect(settings.ambientArcLabels).toBe("off");
  });

  it.each([
    {
      name: "an illegal weekday falls back to the default",
      stored: 3,
      want: DEFAULT_SETTINGS.weekStart,
    },
    { name: "a legal, non-default weekday is kept", stored: 0, want: 0 },
  ])("weekStart: $name", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { weekStart: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.weekStart).toBe(want);
  });

  // Both revert together rather than one clamping onto the other: an
  // inverted or zero-width window is a day with no free time in it.
  it.each([
    {
      name: "an inverted waking window reverts both fields to the defaults",
      wakingFrom: 600,
      wakingTo: 300,
    },
    {
      name: "a zero-width waking window reverts both fields to the defaults",
      wakingFrom: 480,
      wakingTo: 480,
    },
  ])("$name", async ({ wakingFrom, wakingTo }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { wakingFrom, wakingTo },
      }),
    );
    const s = await freshStore(storage);
    const settings = s.store.snapshot().settings;
    expect.soft(settings.wakingFrom).toBe(DEFAULT_SETTINGS.wakingFrom);
    expect.soft(settings.wakingTo).toBe(DEFAULT_SETTINGS.wakingTo);
  });

  it("clamps an out-of-range waking window into the day rather than rejecting it", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { wakingFrom: -120, wakingTo: 2000 },
      }),
    );
    const s = await freshStore(storage);
    const settings = s.store.snapshot().settings;
    expect.soft(settings.wakingFrom).toBe(0);
    expect.soft(settings.wakingTo).toBe(MINUTES_PER_DAY);
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

  it("says so, because an empty dial is what a first run looks like", async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, "{not valid json");
    const s = await freshStore(storage);
    const spy = vi.spyOn(s.notify, "notify");
    // Hydration is lazy, at the first subscribe: nothing has been read yet.
    withWindow(() => s.subscribe(() => {}));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("could not be read"), "error");
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
    // already a string — untouched, not re-defaulted wrong
    expect.soft(hydrated.seriesId).toBe("");
    expect.soft(hydrated.tzid).toBe("");
    // The blob predates busy/free entirely, and every event in one was busy:
    // an absent boolean must not reach `freeGaps` as `undefined`.
    expect.soft(hydrated.free).toBe(false);
    expect.soft(hydrated.task).toBe(false);
    // The same blob predates per-event reminder leads, and an absent one must
    // reach `leadOf` as the inheriting state rather than as `undefined`,
    // which is none of the three and would silently stop matching any of
    // them.
    expect.soft(hydrated.remindLead).toBe(REMIND_INHERIT);
  });

  // The fast path returns the stored event untouched when every field is
  // already the right shape, so a field left out of that question is a field a
  // stored blob never gains — and a free event would come back booked.
  it("keeps a stored free event free across a reload", async () => {
    const storage = new MemoryStorage();
    const held = event({ title: "Hold", start: "2026-03-08 09:00", free: true });
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [held], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().events[0].free).toBe(true);
  });

  // The same fast path, and the state it costs most: an event the user
  // silenced would come back inheriting — which is to say speaking again —
  // if `remindLead` were left out of the shape question.
  it("keeps a stored silent event silent across a reload", async () => {
    const storage = new MemoryStorage();
    const quiet = event({
      title: "Standup",
      start: "2026-03-08 09:00",
      remindLead: REMIND_SILENT,
    });
    const own = event({ title: "Dentist", start: "2026-03-08 11:00", remindLead: 60 });
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [quiet, own], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect.soft(s.store.snapshot().events[0].remindLead).toBe(REMIND_SILENT);
    expect.soft(s.store.snapshot().events[1].remindLead).toBe(60);
  });

  // A stored value that is not one of the three states is a hand-edited or
  // corrupt blob, and `readRemindLead` is the one thing that decides: it
  // comes back inheriting rather than as a negative lead that `dueReminders`
  // would read as a reminder *after* the event started.
  it("reads a nonsense stored lead as inheriting", async () => {
    const storage = new MemoryStorage();
    const broken = { ...event({ start: "2026-03-08 09:00" }), remindLead: -99 };
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [broken], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().events[0].remindLead).toBe(REMIND_INHERIT);
  });
});

describe("hydrateCalendars", () => {
  it("fills the mark an old blob lacks, so a stored calendar is never undefined", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        // Written before marks existed: colour and nothing else.
        calendars: [{ id: "personal", name: "Personal", color: "#a3d9e4", visible: true }],
        feeds: {},
        settings: {},
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().calendars[0].icon).toBe("");
  });

  it("leaves a stored mark alone, unknown names included", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [
          { id: "a", name: "A", color: "#a3d9e4", icon: "barbell", visible: true },
          // A name this build does not carry renders as the dot; dropping it
          // here would lose the mark on a round trip through an older build.
          { id: "b", name: "B", color: "#a3d9e4", icon: "unicorn", visible: true },
          { id: "c", name: "C", color: "#a3d9e4", icon: "🎸", visible: true },
        ],
        feeds: {},
        settings: {},
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().calendars.map((c) => c.icon)).toEqual(["barbell", "unicorn", "🎸"]);
  });

  it("falls back to the seeded calendars when the blob has none", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().calendars.length).toBeGreaterThan(0);
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
    // Every event of the demo *day* belongs to today — the shape (a morning
    // gap, a stacked afternoon, a late call) is only legible if it is *this*
    // day. The trip is the one that is deliberately not on it.
    for (const e of s.store.snapshot().events) {
      if (e.allDay) continue;
      expect.soft(dayKey(new Date(e.start)), `"${e.title}" is not on today`).toBe(today);
    }
  });

  it("bounds the repeating run at a month, every other day", async () => {
    const s = await freshStore();
    withWindow(() => s.subscribe(() => {}));

    const run = s.store.snapshot().events.find((e) => e.repeat !== "never");
    // An unbounded daily rule gave every day of the year a mark, which is a
    // year ring with no empty day left in it for the magnifier to light.
    expect(run?.interval).toBe(2);
    expect(run?.until).toBe(addMonths(startOfDay(new Date()), 1).getTime());
  });

  it("puts the all-day trip a week from tomorrow", async () => {
    const s = await freshStore();
    withWindow(() => s.subscribe(() => {}));

    const trip = s.store.snapshot().events.find((e) => e.allDay);
    const tomorrow = addDays(startOfDay(new Date()), 1);
    expect(trip?.start).toBe(tomorrow.getTime());
    // `end` is exclusive, so seven days is the midnight after the seventh —
    // and it is built with `addDays`, never `7 × 1440` minutes, or a spring
    // forward inside the week lands it an hour short and drops the last day.
    expect(trip?.end).toBe(addDays(tomorrow, 7).getTime());
    expect(daysBetween(new Date(trip!.start), new Date(trip!.end - 1))).toBe(6);
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

/* ---------------------------- feed payloads ----------------------------- */

/** Feed keys, in insertion order. */
const feedKeys = (s: StoreHandle) =>
  Array.from({ length: s.storage.length }, (_, i) => s.storage.key(i)!).filter((k) =>
    k.startsWith("circal.feed."),
  );

/** ~100k characters each, so a couple of dozen overrun the 2M budget without
 *  a test having to build two megabytes of plausible calendar. */
const PAD = "x".repeat(100_000);
const fat = (title: string, start: number, over: Partial<CalEvent> = {}) =>
  event({ title, start, end: start + 3_600_000, notes: PAD, ...over });

describe("feed payloads live outside the blob", () => {
  it("a pull writes its own key and leaves nothing in circal.v1", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    s.store.setFeedEvents(cal.id, [event({ title: "theirs" })]);

    const blob = JSON.parse(s.storage.getItem(KEY)!);
    expect(blob.feeds).toBeUndefined();
    expect(feedKeys(s)).toEqual([`circal.feed.${cal.id}`]);
    expect(JSON.parse(s.storage.raw(`circal.feed.${cal.id}`)!)).toHaveLength(1);
  });

  it("survives a reload — the mirror comes back from its own key", async () => {
    const first = await freshStore();
    const cal = first.store.addFeed("https://example.com/feed.ics", "Feed");
    first.store.setFeedEvents(cal.id, [event({ title: "theirs" })]);

    const s = await freshStore(first.storage);
    expect(s.store.snapshot().feeds[cal.id]).toHaveLength(1);
  });

  it("removing the calendar removes the key, not just the entry", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    s.store.setFeedEvents(cal.id, [event({ title: "theirs" })]);
    s.store.removeCalendar(cal.id);
    expect(feedKeys(s)).toEqual([]);
  });

  it("a payload whose calendar is gone is swept on the next load", async () => {
    const s = await freshStore();
    s.store.create(draft(s));
    // What another tab removing the subscription leaves behind.
    s.storage.setItem("circal.feed.never-existed", JSON.stringify([event()]));

    const reloaded = await freshStore(s.storage);
    reloaded.store.snapshot();
    expect(feedKeys(reloaded)).toEqual([]);
  });

  it("a restore that drops a subscription drops its megabytes with it", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    s.store.setFeedEvents(cal.id, [event({ title: "theirs" })]);

    s.store.restore({ events: [], calendars: [], settings: DEFAULT_SETTINGS });
    expect(feedKeys(s)).toEqual([]);
    expect(s.store.snapshot().feeds).toEqual({});
  });

  it("a blob written with feeds inline is migrated out and the field dropped", async () => {
    const storage = new MemoryStorage();
    const sub = {
      id: "sub",
      name: "Sub",
      color: "#fff",
      visible: true,
      feed: { url: "https://example.com/f.ics", fetchedAt: 1, error: "" },
    };
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [sub],
        feeds: { sub: [event({ title: "was inline" })] },
        settings: {},
      }),
    );
    const s = await freshStore(storage);

    expect(s.store.snapshot().feeds.sub).toHaveLength(1);
    expect(JSON.parse(s.storage.raw("circal.feed.sub")!)).toHaveLength(1);
    // Rewritten immediately, or the next launch moves the same bytes again.
    expect(JSON.parse(s.storage.raw(KEY)!).feeds).toBeUndefined();
  });
});

describe("the feed budget", () => {
  it("trims an oversized feed, keeps what is nearest, and says what is missing", async () => {
    const s = await freshStore();
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    const now = Date.now();
    const dated = Array.from({ length: 30 }, (_, i) => fat(`day ${i}`, now + i * 86_400_000));
    // Far future, but a rule is bytes that describe years — never the first
    // thing to drop.
    const series = fat("weekly", now + 3650 * 86_400_000, { repeat: "weekly", interval: 1 });
    s.store.setFeedEvents(cal.id, [...dated, series]);

    const cached = s.store.snapshot().feeds[cal.id];
    const titles = cached.map((e) => e.title);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.length).toBeLessThan(31);
    expect(titles).toContain("weekly");
    expect(titles).toContain("day 0");
    expect(titles).not.toContain("day 29");
    // The feed's own order, minus what was dropped.
    expect(titles).toEqual(
      [...dated, series].map((e) => e.title).filter((t) => titles.includes(t)),
    );

    const error = s.store.snapshot().calendars.find((c) => c.id === cal.id)!.feed!.error;
    expect(error).toBe(`${cached.length}/31 cached`);
    expect(s.storage.raw(`circal.feed.${cal.id}`)!.length).toBeLessThanOrEqual(2_000_000);
  });

  it("is shared between subscriptions — four feeds get a quarter each", async () => {
    const s = await freshStore();
    const cals = [1, 2, 3, 4].map((n) => s.store.addFeed(`https://example.com/${n}.ics`, `F${n}`));
    const now = Date.now();
    s.store.setFeedEvents(
      cals[0].id,
      Array.from({ length: 30 }, (_, i) => fat(`day ${i}`, now + i * 86_400_000)),
    );
    expect(s.storage.raw(`circal.feed.${cals[0].id}`)!.length).toBeLessThanOrEqual(500_000);
  });

  it("a feed too big for the disk does not stop your own events saving", async () => {
    const s = await freshStore();
    const spy = vi.spyOn(s.notify, "notify");
    const cal = s.store.addFeed("https://example.com/feed.ics", "Feed");
    // Big enough for the blob, nowhere near enough for one padded event.
    s.storage.quota = 50_000;
    s.store.setFeedEvents(cal.id, [fat("huge", Date.now())]);

    expect(feedKeys(s)).toEqual([]);
    expect(s.store.snapshot().calendars.find((c) => c.id === cal.id)!.feed!.error).toMatch(
      /no room/i,
    );
    // The subscription's failure is the subscription's, said on its own line.
    expect(spy).not.toHaveBeenCalled();

    const created = s.store.create(draft(s));
    expect(JSON.parse(s.storage.getItem(KEY)!).events).toContainEqual(created);
  });
});

/* -------------------------------- misc --------------------------------- */

describe("the defaults a new event starts from", () => {
  it.each([
    { name: "a length under the editor's own minimum clamps up", set: 1, want: 5 },
    { name: "a length past a day clamps down", set: 5000, want: 1440 },
    { name: "a fraction rounds", set: 42.6, want: 43 },
    { name: "zero is not a length", set: 0, want: 60 },
    { name: "a number that is not one falls back", set: Number.NaN, want: 60 },
  ])("$name", async ({ set, want }) => {
    const s = await freshStore();
    s.store.setDefaultDuration(set);
    expect(s.store.snapshot().settings.defaultDuration).toBe(want);
  });

  it("keeps a calendar id that no longer exists rather than rewriting the preference", async () => {
    const s = await freshStore();
    s.store.setDefaultCalendar("work");
    s.store.removeCalendar("work");
    // The setting is what the user said; `defaultCalendarId` is what the app
    // does about it today. Rewriting the first would lose the second's reason.
    expect(s.store.snapshot().settings.defaultCalendar).toBe("work");
  });
});

describe("defaultCalendarId", () => {
  const own = (id: string) => calendar({ id, name: id });
  const feed = (id: string) => ({
    ...calendar({ id, name: id }),
    feed: { url: "https://x/y.ics", fetchedAt: 0, error: "" },
  });

  it.each([
    { name: "the named calendar, when it is still there", list: [own("a"), own("b")], want: "b" },
    {
      name: "the first one when nothing is named",
      list: [own("a"), own("b")],
      named: "",
      want: "a",
    },
    {
      name: "the first one when the named calendar has been deleted",
      list: [own("a")],
      want: "a",
    },
    {
      name: "never a subscription, even when it is named",
      list: [feed("b"), own("c")],
      want: "c",
    },
    {
      name: "never a subscription when it is merely first",
      list: [feed("z"), own("c")],
      named: "",
      want: "c",
    },
  ])("$name", async ({ list, named = "b", want }) => {
    const s = await freshStore();
    expect(s.defaultCalendarId(list, named)).toBe(want);
  });
});

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

  // A drag across the year ring: whole revolutions, as many all-day days as it
  // covered. The dial can only ever hand over exactly one — its sweep is
  // clamped to the day — so everything past 1440 arrives from that gesture.
  it.each([
    { name: "two days", days: 2 },
    { name: "seven days", days: 7 },
    { name: "a whole ordinary year", days: 365 },
  ])("$name of ring drag becomes that many all-day days", async ({ days }) => {
    const s = await freshStore();
    const dayStart = at("2026-03-08").getTime();
    const drafted = s.draftEvent(at("2026-03-08"), 0, days * 1440, "personal");
    expect.soft(drafted.allDay).toBe(true);
    expect.soft(drafted.start).toBe(dayStart);
    // `end` is exclusive, so a two-day event ends at the third midnight.
    expect.soft(drafted.end).toBe(dayStart + days * 1440 * 60_000);
  });

  // A span that crosses a DST boundary is still whole days: the instants are
  // built from minutes off local midnight, so the event is 23 or 25 hours of
  // elapsed time and nobody downstream cares — `dayAgenda` clips by day.
  it("a span across a spring-forward keeps both ends on a local midnight", async () => {
    const s = await freshStore();
    const drafted = s.draftEvent(at("2026-03-28"), 0, 3 * 1440, "personal");
    expect.soft(new Date(drafted.start).getHours()).toBe(0);
    expect.soft(new Date(drafted.end).getHours()).toBe(0);
    expect.soft(dayKey(new Date(drafted.end))).toBe("2026-03-31");
  });

  it("mints a floating event — a draft has no zone until a feed gives it one", async () => {
    const s = await freshStore();
    expect(s.draftEvent(at("2026-03-08"), 0, 60, "personal").tzid).toBe("");
  });
});

/* ------------------------------ duplicateOf ------------------------------ */

describe("duplicateOf", () => {
  const HOUR = 3_600_000;

  it("copies everything the user wrote, the rule included", () => {
    const source = event({
      title: "Standup",
      start: "2026-03-08 09:00",
      end: "2026-03-08 09:30",
      repeat: "weekly",
      interval: 2,
      location: "Room 2",
      notes: "bring the thing",
      color: "#8bf0b8",
      icon: "barbell",
    });
    const copy = duplicateOf(source);
    expect.soft(copy).not.toHaveProperty("id");
    expect.soft(copy.title).toBe("Standup");
    // The whole event, not the occurrence you had hold of: a duplicate of a
    // fortnightly standup is a fortnightly standup.
    expect.soft(copy.repeat).toBe("weekly");
    expect.soft(copy.interval).toBe(2);
    expect.soft(copy.location).toBe("Room 2");
    expect.soft(copy.notes).toBe("bring the thing");
    expect.soft(copy.color).toBe("#8bf0b8");
    expect.soft(copy.icon).toBe("barbell");
  });

  it("carries the zone — a copy of a New York standup is a New York standup", () => {
    const source = event({ title: "Standup", start: "2026-03-08 09:00", tzid: "America/New_York" });
    expect(duplicateOf(source).tzid).toBe("America/New_York");
  });

  it("detaches a copy of an override — two events cannot claim one occurrence", () => {
    const copy = duplicateOf(
      event({ start: "2026-03-08 09:00", seriesId: "parent", seriesKey: "2026-03-08T09:00:00" }),
    );
    expect.soft(copy.seriesId).toBe("");
    expect.soft(copy.seriesKey).toBe("");
  });

  it("arrives unticked — a duplicate carrying its original's ticks is a lie", () => {
    const copy = duplicateOf(
      event({ start: "2026-03-08 09:00", task: true, doneKeys: ["2026-03-08T09:00:00"] }),
    );
    expect.soft(copy.task).toBe(true);
    expect.soft(copy.doneKeys).toEqual([]);
  });

  // Part of "the whole event": a ⌘-drag on a placeholder gives back a
  // placeholder, not an hour that now books the day.
  it("carries busy/free across", () => {
    expect.soft(duplicateOf(event({ start: "2026-03-08 09:00", free: true })).free).toBe(true);
    expect.soft(duplicateOf(event({ start: "2026-03-08 09:00" })).free).toBe(false);
  });

  // The same argument for the reminder: a ⌘-drag on the standup you silenced
  // gives back a silent standup, and one you gave an hour's warning keeps the
  // hour. Both states, because carrying only the number would let silence
  // come back as inheritance.
  it("carries the reminder lead across, silence included", () => {
    const silent = duplicateOf(event({ start: "2026-03-08 09:00", remindLead: REMIND_SILENT }));
    expect.soft(silent.remindLead).toBe(REMIND_SILENT);
    expect
      .soft(duplicateOf(event({ start: "2026-03-08 09:00", remindLead: 60 })).remindLead)
      .toBe(60);
    expect.soft(duplicateOf(event({ start: "2026-03-08 09:00" })).remindLead).toBe(REMIND_INHERIT);
  });

  it("shifts both instants by the drag, keeping the duration", () => {
    const source = event({ start: "2026-03-08 09:00", end: "2026-03-08 10:00" });
    const copy = duplicateOf(source, 2 * HOUR);
    expect.soft(copy.start).toBeSameInstantAs("2026-03-08 11:00");
    expect.soft(copy.end).toBeSameInstantAs("2026-03-08 12:00");
  });

  it("moves the bound with the series, and leaves an unbounded one unbounded", () => {
    const bounded = event({
      start: "2026-03-08 09:00",
      repeat: "weekly",
      until: ms("2026-04-05 09:00"),
    });
    // `until` bounds a *start*, so a series shifted an hour later and handed
    // its old bound loses its last occurrence.
    expect.soft(duplicateOf(bounded, HOUR).until).toBeSameInstantAs("2026-04-05 10:00");
    expect.soft(duplicateOf(event({ repeat: "weekly" }), HOUR).until).toBe(0);
  });

  it("carries the exclusions across the shift rather than beside it", () => {
    const source = event({
      start: "2026-03-08 09:00",
      end: "2026-03-08 10:00",
      repeat: "weekly",
      exdates: ["2026-03-15T09:00:00"],
      rdates: ["2026-04-01T09:00:00"],
    });
    // Left alone, the copy fires on every day the original skipped.
    const copy = duplicateOf(source, HOUR);
    expect.soft(copy.exdates).toEqual(["2026-03-15T10:00:00"]);
    expect.soft(copy.rdates).toEqual(["2026-04-01T10:00:00"]);
  });

  it("keeps a day-form key a day, and moves it when the shift crosses midnight", () => {
    const source = event({
      start: "2026-03-08 23:00",
      end: "2026-03-08 23:30",
      repeat: "daily",
      exdates: ["2026-03-15"],
    });
    expect.soft(duplicateOf(source, HOUR).exdates).toEqual(["2026-03-16"]);
    expect.soft(duplicateOf(source, -HOUR).exdates).toEqual(["2026-03-15"]);
  });

  it("leaves the lists exactly as they were when nothing moved", () => {
    const source = event({
      start: "2026-03-08 09:00",
      repeat: "weekly",
      exdates: ["2026-03-15T09:00:00", "2026-03-22"],
      rdates: ["2026-04-01T09:00:00"],
    });
    const copy = duplicateOf(source);
    expect.soft(copy.exdates).toEqual(source.exdates);
    expect.soft(copy.rdates).toEqual(source.rdates);
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
