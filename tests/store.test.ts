import { describe, expect, it, vi } from "vitest";
import { at, attendee, calendar, dailyNote, ms, event, plan, task, MemoryStorage } from "./helpers";
import {
  instantKey,
  PALETTE,
  REMIND_INHERIT,
  REMIND_SILENT,
  type CalEvent,
  type Repeat,
} from "@/lib/events";
import {
  DEFAULT_SETTINGS,
  LIFE_EXPECTANCY_RANGE,
  TOTALS_POSITIONS,
  dayCopies,
  duplicateOf,
} from "@/lib/store";
import { readBackup } from "@/lib/backup";
import { mirrorDigest, readMirrorFile, serialiseMirror } from "@/lib/mirror";
import { MINUTES_PER_DAY, addDays, addMonths, dayKey, daysBetween, startOfDay } from "@/lib/time";
import type * as StoreModule from "@/lib/store";
import type * as NotifyModule from "@/lib/notify";
import { compareTaskOrder, taskListTree } from "@/lib/tasks";

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

describe("daily notes", () => {
  it("persists separate local dates and Markdown verbatim across reloads", async () => {
    const s = await freshStore();
    s.store.setDayNote("2026-03-08", "# Sunday\n\n- [ ] Work\n");
    s.store.setDayNote("2026-03-09", "Monday");
    s.store.setDayNote("2026-03-08", "# Sunday\n\n- [x] Work\n");
    const reloaded = await freshStore(s.storage);
    expect(reloaded.store.snapshot().dayNotes.map(({ day, text }) => ({ day, text }))).toEqual([
      { day: "2026-03-08", text: "# Sunday\n\n- [x] Work\n" },
      { day: "2026-03-09", text: "Monday" },
    ]);
    expect(JSON.parse(s.storage.getItem(KEY)!).dayNotes).toEqual(
      reloaded.store.snapshot().dayNotes,
    );
  });

  it("clears with a newer blank record, and undo and redo preserve the clear", async () => {
    const s = await freshStore();
    s.store.setDayNote("2026-03-08", "Before");
    const original = s.store.snapshot().dayNotes[0];
    s.store.setDayNote("2026-03-08", "");
    const cleared = s.store.snapshot().dayNotes[0];
    expect(cleared.text).toBe("");
    expect(cleared.updatedAt).toBeGreaterThan(original.updatedAt);
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().dayNotes[0].text).toBe("Before");
    expect(s.store.snapshot().dayNotes[0].updatedAt).toBeGreaterThan(cleared.updatedAt);
    expect(s.store.redo()).toBe(true);
    expect(s.store.snapshot().dayNotes[0].text).toBe("");
    const reloaded = await freshStore(s.storage);
    expect(reloaded.store.snapshot().dayNotes[0].text).toBe("");
  });

  it("rejects impossible dates and does not create history for unchanged text", async () => {
    const s = await freshStore();
    s.store.setDayNote("2026-02-30", "No");
    s.store.setDayNote("2026-03-08", "");
    expect(s.store.snapshot().dayNotes).toEqual([]);
    expect(s.store.undo()).toBe(false);
    s.store.setDayNote("2026-03-08", "One");
    s.store.setDayNote("2026-03-08", "One");
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().dayNotes).toEqual([]);
    expect(s.store.undo()).toBe(false);
  });

  it("re-reads another tab's notes before unrelated event and note edits", async () => {
    const s = await freshStore();
    s.store.setDayNote("2026-03-08", "Local");
    const foreign = dailyNote({ day: "2026-03-09", text: "Other tab", updatedAt: Date.now() });
    const persisted = JSON.parse(s.storage.getItem(KEY)!);
    s.storage.setItem(
      KEY,
      JSON.stringify({ ...persisted, dayNotes: [...persisted.dayNotes, foreign] }),
    );
    s.store.create(draft(s));
    s.store.setDayNote("2026-03-08", "Local edited");
    expect(s.store.snapshot().dayNotes).toContainEqual(foreign);
    expect(s.store.snapshot().events).toHaveLength(1);
  });

  it("drops stale undo history when another tab changes only a note", async () => {
    const s = await freshStore();
    withWindow((fire) => {
      const stop = s.subscribe(() => {});
      s.store.setDayNote("2026-03-08", "Local");
      const persisted = JSON.parse(s.storage.getItem(KEY)!);
      s.storage.setItem(
        KEY,
        JSON.stringify({ ...persisted, dayNotes: [dailyNote({ text: "Other tab" })] }),
      );
      fire(KEY);
      expect(s.store.undo()).toBe(false);
      expect(s.store.snapshot().dayNotes[0].text).toBe("Other tab");
      stop();
    });
  });

  it("adopts original stamps but restamps restore and buries notes absent from old backups", async () => {
    const s = await freshStore();
    const note = dailyNote({ updatedAt: ms("2026-03-08 09:00") });
    const foreign = { ...s.store.snapshot(), dayNotes: [note] };
    s.store.adopt(foreign);
    expect(s.store.snapshot().dayNotes).toEqual([note]);
    s.store.restore({ ...foreign, dayNotes: [{ ...note, text: "Restored" }] });
    expect(s.store.snapshot().dayNotes[0].updatedAt).toBeGreaterThan(note.updatedAt);
    const old = readBackup({ app: "circal", calendars: [calendar()] });
    if (!old.ok) throw new Error("invalid fixture");
    s.store.restore(old);
    expect(s.store.snapshot().dayNotes).toEqual([]);
    expect(s.store.snapshot().graves.some((grave) => grave.id === note.id)).toBe(true);
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().dayNotes[0].text).toBe("Restored");
  });

  it("preserves explicit moon and note preferences", async () => {
    const s = await freshStore();
    s.store.setToggle("dailyNote", false);
    s.store.setDailyNoteAt("top-left");
    s.store.setToggle("moon", false);
    s.store.setMoonAt("sidebar");
    const reloaded = await freshStore(s.storage);
    expect(reloaded.store.snapshot().settings).toMatchObject({
      dailyNote: false,
      dailyNoteAt: "top-left",
      moon: false,
      moonAt: "sidebar",
    });
  });

  it("hydrates missing note fields and clamps invalid placement", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        settings: { dailyNoteAt: "sidebar" },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().dayNotes).toEqual([]);
    expect(s.store.snapshot().settings).toMatchObject({
      dailyNote: true,
      moon: true,
      moonAt: "bottom-right",
    });
    const settings = s.store.snapshot().settings;
    expect(TOTALS_POSITIONS).toContain(settings.dailyNoteAt);
    expect(settings.dailyNoteAt).not.toBe(settings.moonAt);
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

describe("task lists", () => {
  it("moves and orders tasks atomically without changing their calendar or deadline", async () => {
    const s = await freshStore();
    const source = s.store.addTaskList("Source")!;
    const target = s.store.addTaskList("Target")!;
    const a = s.store.addTask(task({ title: "A", listId: source.id }));
    const b = s.store.addTask(task({ title: "B", listId: target.id }));
    const c = s.store.addTask(task({ title: "C", listId: target.id }));
    const ids = () =>
      s.store
        .snapshot()
        .tasks.filter((t) => t.listId === target.id)
        .sort(compareTaskOrder)
        .map((t) => t.id);
    expect(s.store.moveTask(a.id, target.id, c.id)).toBe(true);
    expect(ids()).toEqual([b.id, a.id, c.id]);
    const moved = s.store.snapshot().tasks.find((t) => t.id === a.id)!;
    expect(moved.calendarId).toBe(a.calendarId);
    expect(moved.due).toBeSameInstantAs(a.due);
    s.store.undo();
    expect(ids()).toEqual([b.id, c.id]);
    expect(s.store.snapshot().tasks.find((t) => t.id === a.id)?.listId).toBe(source.id);
    s.store.redo();
    const reloaded = await freshStore(s.storage);
    expect(
      reloaded.store
        .snapshot()
        .tasks.filter((t) => t.listId === target.id)
        .sort(compareTaskOrder)
        .map((t) => t.id),
    ).toEqual([b.id, a.id, c.id]);
    expect(reloaded.store.moveTask(a.id, "", undefined)).toBe(true);
    expect(reloaded.store.snapshot().tasks.find((t) => t.id === a.id)?.listId).toBe("");
  });

  it("persists list appearance and sibling order and rejects cyclic drag destinations", async () => {
    const s = await freshStore();
    const a = s.store.addTaskList("A", "", PALETTE[2], "briefcase")!;
    const b = s.store.addTaskList("B")!;
    const child = s.store.addTaskList("Child", a.id)!;
    expect(s.store.moveTaskList(b.id, "", a.id)).toBe(true);
    expect(taskListTree(s.store.snapshot().taskLists).map(({ list }) => list.id)).toEqual([
      b.id,
      a.id,
      child.id,
    ]);
    const before = s.storage.getItem(KEY);
    expect(s.store.moveTaskList(a.id, child.id)).toBe(false);
    expect(s.store.moveTaskList(a.id, "", "missing")).toBe(false);
    expect(s.store.moveTaskList(a.id, "", a.id)).toBe(false);
    expect(s.storage.getItem(KEY)).toBe(before);
    expect(s.store.moveTaskList(b.id, a.id, child.id)).toBe(true);
    expect(
      taskListTree(s.store.snapshot().taskLists).map(({ list, depth }) => [list.id, depth]),
    ).toEqual([
      [a.id, 0],
      [b.id, 1],
      [child.id, 1],
    ]);
    s.store.undo();
    const reloaded = await freshStore(s.storage);
    expect(taskListTree(reloaded.store.snapshot().taskLists).map(({ list }) => list.id)).toEqual([
      b.id,
      a.id,
      child.id,
    ]);
    expect(reloaded.store.snapshot().taskLists.find((list) => list.id === a.id)).toMatchObject({
      color: PALETTE[2],
      icon: "briefcase",
    });
  });

  it("deleting a list preserves its tasks and children, and undo restores membership", async () => {
    const s = await freshStore();
    const root = s.store.addTaskList("Work")!;
    const child = s.store.addTaskList("Launch", root.id)!;
    const grandchild = s.store.addTaskList("Design", child.id)!;
    const assigned = s.store.addTask(task({ listId: child.id }));
    const nested = s.store.addTask(task({ listId: grandchild.id }));
    s.store.removeTaskList(child.id);
    expect(s.store.snapshot().taskLists.find((list) => list.id === grandchild.id)?.parentId).toBe(
      root.id,
    );
    expect(s.store.snapshot().tasks.find((t) => t.id === assigned.id)?.listId).toBe(root.id);
    expect(s.store.snapshot().tasks.find((t) => t.id === nested.id)?.listId).toBe(grandchild.id);
    expect(s.store.snapshot().graves.some((grave) => grave.id === child.id)).toBe(true);
    s.store.undo();
    expect(s.store.snapshot().taskLists.find((list) => list.id === grandchild.id)?.parentId).toBe(
      child.id,
    );
    expect(s.store.snapshot().tasks.find((t) => t.id === assigned.id)?.listId).toBe(child.id);
    s.store.redo();
    const reloaded = await freshStore(s.storage);
    expect(reloaded.store.snapshot().tasks.find((t) => t.id === assigned.id)?.listId).toBe(root.id);
    expect(reloaded.store.snapshot().taskLists.map((list) => list.id)).not.toContain(child.id);
  });

  it("refuses cyclic moves and invalid parents without altering persisted state", async () => {
    const s = await freshStore();
    const root = s.store.addTaskList("Work")!;
    const child = s.store.addTaskList("Project", root.id)!;
    const before = s.storage.getItem(KEY);
    expect(s.store.updateTaskList(root.id, { parentId: child.id })).toBe(false);
    expect(s.store.updateTaskList(root.id, { parentId: root.id })).toBe(false);
    expect(s.store.updateTaskList(child.id, { parentId: "missing" })).toBe(false);
    expect(s.store.addTaskList(" ", root.id)).toBeNull();
    expect(s.storage.getItem(KEY)).toBe(before);
  });

  it("uses fresh lists when another tab deletes the task's destination", async () => {
    const s = await freshStore();
    const list = s.store.addTaskList("Work")!;
    const other = await freshStore(s.storage);
    other.store.removeTaskList(list.id);
    const created = s.store.addTask(task({ listId: list.id }));
    expect(created.listId).toBe("");
    expect(s.store.snapshot().taskLists).toEqual([]);
  });

  it("keeps old tasks unlisted when hydrating storage without lists", async () => {
    const storage = new MemoryStorage();
    const { listId: _listId, ...legacy } = task({ id: "old" });
    storage.setItem(KEY, JSON.stringify({ schema: 2, tasks: [legacy], calendars: [calendar()] }));
    const s = await freshStore(storage);
    expect(s.store.snapshot().tasks[0].listId).toBe("");
    expect(s.store.snapshot().taskLists).toEqual([]);
  });
});

/* ------------------------------ tasks ------------------------------ */

describe("task actions", () => {
  const body = (
    over: Partial<Omit<StoreModule.Snapshot["tasks"][number], "id" | "updatedAt">> = {},
  ) => {
    const { id: _id, updatedAt: _at, ...rest } = task({ due: "2026-03-08 18:30" });
    return { ...rest, ...over };
  };

  it("addTask stamps at the line it becomes a record, and persists", async () => {
    const s = await freshStore();
    const created = s.store.addTask(body());
    expect.soft(created.id).toBeTruthy();
    expect.soft(created.updatedAt).toBeGreaterThan(0);
    const persisted = JSON.parse(s.storage.getItem(KEY)!);
    expect.soft(persisted.tasks).toContainEqual(created);
  });

  it("toggleTaskDone flips one task, restamped, and ⌘Z is the way back", async () => {
    const s = await freshStore();
    const created = s.store.addTask(body());
    s.store.toggleTaskDone(created.id);
    expect.soft(s.store.snapshot().tasks[0]?.done).toBe(true);
    expect.soft(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().tasks[0]?.done).toBe(false);
  });

  it("removeTask buries the id in the same commit — a deletion without its grave comes back", async () => {
    const s = await freshStore();
    const created = s.store.addTask(body());
    s.store.removeTask(created.id);
    expect.soft(s.store.snapshot().tasks).toEqual([]);
    expect.soft(s.store.snapshot().graves.map((g) => g.id)).toContain(created.id);
  });

  it("planTask keeps the list in start order and refuses a widthless plan", async () => {
    const s = await freshStore();
    const created = s.store.addTask(body());
    s.store.planTask(created.id, plan("2026-03-10 09:00", "2026-03-10 10:00"));
    s.store.planTask(created.id, plan("2026-03-09 09:00", "2026-03-09 10:00"));
    s.store.planTask(created.id, { start: ms("2026-03-11 09:00"), end: ms("2026-03-11 09:00") });
    expect(s.store.snapshot().tasks[0]?.plans).toEqual([
      plan("2026-03-09 09:00", "2026-03-09 10:00"),
      plan("2026-03-10 09:00", "2026-03-10 10:00"),
    ]);
  });

  it("unplanTask and movePlan address one block by index", async () => {
    const s = await freshStore();
    const created = s.store.addTask(
      body({
        plans: [
          plan("2026-03-09 09:00", "2026-03-09 10:00"),
          plan("2026-03-10 09:00", "2026-03-10 10:00"),
        ],
      }),
    );
    s.store.movePlan(created.id, 0, plan("2026-03-09 11:00", "2026-03-09 12:00"));
    expect
      .soft(s.store.snapshot().tasks[0]?.plans[0])
      .toEqual(plan("2026-03-09 11:00", "2026-03-09 12:00"));
    s.store.unplanTask(created.id, 1);
    expect
      .soft(s.store.snapshot().tasks[0]?.plans)
      .toEqual([plan("2026-03-09 11:00", "2026-03-09 12:00")]);
  });

  it("applyPlans lands a whole run in one commit — one ⌘Z gives it all back", async () => {
    const s = await freshStore();
    const a = s.store.addTask(body({ title: "A" }));
    const b = s.store.addTask(body({ title: "B" }));
    s.store.applyPlans([
      { id: a.id, plan: plan("2026-03-09 09:00", "2026-03-09 10:00") },
      { id: b.id, plan: plan("2026-03-09 10:00", "2026-03-09 11:00") },
      // A placement for an id another tab removed is dropped, not resurrected.
      { id: "gone", plan: plan("2026-03-09 11:00", "2026-03-09 12:00") },
    ]);
    const planned = s.store.snapshot().tasks;
    expect.soft(planned.find((t) => t.id === a.id)?.plans).toHaveLength(1);
    expect.soft(planned.find((t) => t.id === b.id)?.plans).toHaveLength(1);
    expect.soft(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().tasks.every((t) => t.plans.length === 0)).toBe(true);
  });

  it("convertTask rebuilds it as an event in one commit, id buried, one ⌘Z back", async () => {
    const s = await freshStore();
    const created = s.store.addTask(body({ title: "Essay" }));
    const madeEvent = s.store.convertTask(created.id, {
      ...s.draftEvent(at("2026-03-08"), 9 * 60, 10 * 60, "personal"),
      title: "Essay",
    });
    const snap = s.store.snapshot();
    expect.soft(madeEvent?.title).toBe("Essay");
    expect.soft(snap.tasks).toEqual([]);
    expect.soft(snap.events.map((e) => e.id)).toContain(madeEvent!.id);
    expect.soft(snap.graves.map((g) => g.id)).toContain(created.id);
    // One commit: one undo restores the task and takes the event away.
    expect.soft(s.store.undo()).toBe(true);
    const back = s.store.snapshot();
    expect.soft(back.tasks.map((t) => t.title)).toEqual(["Essay"]);
    expect.soft(back.events.find((e) => e.id === madeEvent!.id)).toBeUndefined();
  });

  it("convertEvent takes a series' overrides with it, all buried, one commit", async () => {
    const s = await freshStore();
    const series = s.store.create(draft(s, 60, 120, "weekly"));
    const override = s.store.create({
      ...draft(s, 180, 240),
      seriesId: series.id,
      seriesKey: "2026-03-15T01:00:00",
    });
    const { id: _id, updatedAt: _at, ...taskBody } = task({ title: "Was a series" });
    const made = s.store.convertEvent(series.id, taskBody);
    const snap = s.store.snapshot();
    expect.soft(made?.title).toBe("Was a series");
    expect.soft(snap.events).toEqual([]);
    expect.soft(snap.tasks.map((t) => t.id)).toContain(made!.id);
    // The override is not orphaned — it goes, and both ids are buried.
    expect.soft(snap.graves.map((g) => g.id).sort()).toEqual([series.id, override.id].sort());
    expect.soft(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().events).toHaveLength(2);
    expect.soft(s.store.snapshot().tasks).toEqual([]);
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
    // The stamp is deliberately *not* the one the series was created with: an
    // undo is a compensating edit, so `restamped` dates what it puts back at
    // the moment it runs (`merge.ts`). Asserting the whole record including
    // `updatedAt` passed only while both instants landed in one millisecond,
    // which is a coin toss the full suite loses under load.
    const [restored] = s.store.snapshot().events;
    expect.soft(restored).toEqual({ ...series, updatedAt: expect.any(Number) });
    expect(restored.updatedAt).toBeGreaterThanOrEqual(series.updatedAt);
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
      remindLead: REMIND_INHERIT,
      updatedAt: cal.updatedAt,
    });
    expect.soft(cal.updatedAt).toBeGreaterThan(0);

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
    // The stamp moves with the change, and only the stamp: an edit to a
    // calendar is what a merge compares, so a rename that left it alone would
    // lose to the other machine's older copy.
    expect.soft(after).toEqual({
      ...before,
      name: "Renamed",
      color: "#8bf0b8",
      updatedAt: after.updatedAt,
    });
    expect.soft(after.updatedAt).toBeGreaterThan(0);
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
    // The same event, re-stamped: a redo is a change made now, which is the
    // case below in full.
    const back = s.store.snapshot().events;
    expect(back).toEqual([{ ...created, updatedAt: back[0]?.updatedAt }]);
  });

  /**
   * An undo is a fresh mutation, and the stamps are why. A step carries the
   * events as they were, so putting one back with its old `updatedAt` leaves a
   * record the other machine's copy outranks — the next merge would undo the
   * undo, with nothing on screen to say so. Undoing a *creation* is the same
   * argument from the other side: the id has to be buried, or the other
   * machine writes it straight back.
   */
  it("restamps what an undo changes and buries what it takes away", async () => {
    const s = await freshStore();
    const kept = s.store.create({ ...draft(s, 60, 120), title: "Kept" });
    const created = s.store.create({ ...draft(s, 180, 240), title: "Undone" });
    s.store.update(kept.id, { title: "Edited" });
    const edited = s.store.snapshot().events.find((e) => e.id === kept.id)!;

    // Undo the edit: the record put back is the old title, stamped now.
    expect(s.store.undo()).toBe(true);
    const reverted = s.store.snapshot().events.find((e) => e.id === kept.id)!;
    expect.soft(reverted.title).toBe("Kept");
    expect.soft(reverted.updatedAt).toBeGreaterThanOrEqual(edited.updatedAt);
    // The event the step did not touch keeps the stamp it had — an undo that
    // re-dated the whole document would make this machine win every field of
    // the next merge.
    expect
      .soft(s.store.snapshot().events.find((e) => e.id === created.id)?.updatedAt)
      .toBe(created.updatedAt);

    // Undo the second creation: gone, and graved rather than merely dropped.
    expect(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().events.some((e) => e.id === created.id)).toBe(false);
    expect.soft(s.store.snapshot().graves.map((g) => g.id)).toContain(created.id);
  });

  /* One entry per id, the later instant winning. Every *reader* of a grave
   * list assumes it — `readGraves` on the way in, `pruneGraves` in every
   * merge — and none of the writers held it: `remove` appended, and
   * `restamped` concatenates both sides' lists, so this sequence left two
   * graves for one id. The cloud copy holds the collapsed list, so the two
   * were one document in two shapes and the machine that deleted was told its
   * own deletion was news on every pass. */
  it("holds one grave per id after a delete, an undo and a delete", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    s.store.remove(created.id);
    expect(s.store.undo()).toBe(true);

    const back = s.store.snapshot().events.find((e) => e.id === created.id);
    expect.soft(back).toBeDefined();

    s.store.remove(created.id);
    const graves = s.store.snapshot().graves.filter((g) => g.id === created.id);
    expect.soft(graves).toHaveLength(1);

    // And the persisted blob, not only the snapshot in memory: the mirrored
    // copy is read from what was written.
    const persisted = JSON.parse(s.storage.getItem(KEY)!) as { graves: { id: string }[] };
    expect.soft(persisted.graves.filter((g) => g.id === created.id)).toHaveLength(1);
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
    // Same restamp as the split's undo above: what an undo puts back is dated
    // now, so the record is compared without pinning its stamp to the clock.
    const [restored] = s.store.snapshot().events;
    expect.soft(restored).toEqual({ ...created, updatedAt: expect.any(Number) });
    expect.soft(restored.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
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
      calendars: [calendar({ id: "imported", name: "Imported" })],
      tasks: [],
      taskLists: [],
      dayNotes: [],
      settings: { ...DEFAULT_SETTINGS, clock: "24h" },
      settingsAt: ms("2026-03-08 09:00"),
      graves: [],
    });
    expect(s.store.snapshot().settings.clock).toBe("24h");

    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().settings.clock).toBe("12h");
  });
});

/* ------------------------------ adopt ------------------------------ */

/**
 * `adopt` normalises on the way in — `sane` clamps settings, feed pull state
 * is swept — so what the store holds afterwards is not byte-identical to the
 * contents it was handed. `mirrorLink.absorb` records its `lastDigest` from
 * the store's own snapshot for exactly this reason: recorded from the file's
 * contents instead, the next `onStoreChange` sees a "change" that is only the
 * normalisation and answers every adopt with one extra write.
 */
describe("adopt", () => {
  const foreign = (settings: typeof DEFAULT_SETTINGS) =>
    readMirrorFile(
      serialiseMirror(
        {
          events: [],
          calendars: [calendar({ id: "imported", name: "Imported" })],
          tasks: [],
          taskLists: [],
          dayNotes: [],
          settings,
          settingsAt: ms("2026-03-08 09:00"),
          graves: [],
        },
        3,
      ),
    );

  it("normalises, so the digest to record is the store's, never the file's", async () => {
    const s = await freshStore();
    const contents = foreign({
      ...DEFAULT_SETTINGS,
      lifeExpectancy: LIFE_EXPECTANCY_RANGE.max + 100,
    });
    if (!contents) throw new Error("fixture failed to parse as a mirror file");

    s.store.adopt(contents);

    // The clamp is real — the store did not take the file at its word…
    expect(s.store.snapshot().settings.lifeExpectancy).toBe(LIFE_EXPECTANCY_RANGE.max);
    // …so the two digests disagree, and only the store's names what a
    // subsequent write would actually serialise.
    expect(mirrorDigest(s.store.snapshot())).not.toBe(mirrorDigest(contents));
  });

  it("is one undoable step that owns its settings, as its toast promises", async () => {
    const s = await freshStore();
    s.store.setClock("12h");
    const before = s.store.snapshot().events;
    const contents = foreign({ ...DEFAULT_SETTINGS, clock: "24h" });
    if (!contents) throw new Error("fixture failed to parse as a mirror file");

    s.store.adopt(contents);
    expect(s.store.snapshot().settings.clock).toBe("24h");
    expect(s.store.snapshot().events).toEqual([]);

    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().settings.clock).toBe("12h");
    expect(s.store.snapshot().events).toEqual(before);
  });
});

const SETTINGS_ACTIONS: { name: string; act: (s: StoreHandle) => void }[] = [
  { name: "setClock", act: (s) => s.store.setClock("24h") },
  { name: "setToggle", act: (s) => s.store.setToggle("moonlight", false) },
  { name: "setMoonAt", act: (s) => s.store.setMoonAt("top-right") },
  { name: "setDailyNoteAt", act: (s) => s.store.setDailyNoteAt("top-right") },
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
      const back = s.store.snapshot().events.find((e) => e.id === created.id);
      // Every instant back where it was, and the stamp moved: an undo is a
      // change made now, or the next merge reverts it (see the restamp case
      // above).
      expect.soft(back).toEqual({ ...created, updatedAt: back?.updatedAt });
      expect.soft(back?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
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

describe("joinAdjacent", () => {
  it("defaults off and persists both toggle choices across reloads without changing events", async () => {
    const s = await freshStore();
    expect(s.store.snapshot().settings.joinAdjacent).toBe(false);
    const created = s.store.create(draft(s));
    s.store.setToggle("joinAdjacent", true);
    expect(JSON.parse(s.storage.getItem(KEY)!).settings.joinAdjacent).toBe(true);

    const enabled = await freshStore(s.storage);
    expect(enabled.store.snapshot().settings.joinAdjacent).toBe(true);
    expect(enabled.store.snapshot().events).toContainEqual(created);
    enabled.store.setToggle("joinAdjacent", false);

    const disabled = await freshStore(s.storage);
    expect(disabled.store.snapshot().settings.joinAdjacent).toBe(false);
    expect(disabled.store.snapshot().events).toContainEqual(created);
  });

  it.each([
    { name: "absent", stored: undefined, want: false },
    { name: "enabled", stored: true, want: true },
    { name: "disabled", stored: false, want: false },
    { name: "a string", stored: "true", want: false },
    { name: "a number", stored: 1, want: false },
    { name: "null", stored: null, want: false },
    { name: "an object", stored: {}, want: false },
  ])("hydrates $name as $want", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        settings: { joinAdjacent: stored, clock: "12h" },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.joinAdjacent).toBe(want);
    expect(s.store.snapshot().settings.clock).toBe("12h");
  });
});

describe("moon placement", () => {
  it("defaults on at the bottom-right", async () => {
    const s = await freshStore();
    expect(s.store.snapshot().settings).toMatchObject({ moon: true, moonAt: "bottom-right" });
  });

  it.each(["sidebar", ...TOTALS_POSITIONS] as const)(
    "persists %s independently of the moon switch",
    async (moonAt) => {
      const s = await freshStore();
      s.store.setToggle("dailyNote", false);
      s.store.setMoonAt(moonAt);
      expect(JSON.parse(s.storage.getItem(KEY)!).settings.moonAt).toBe(moonAt);
      const reloaded = await freshStore(s.storage);
      expect(reloaded.store.snapshot().settings).toMatchObject({ moon: true, moonAt });
      reloaded.store.setToggle("moon", true);
      reloaded.store.setToggle("moon", false);
      expect(reloaded.store.snapshot().settings.moonAt).toBe(moonAt);
    },
  );

  const compatibility = [
    { name: "an older enabled moon", settings: { moon: true } },
    { name: "a legacy moon register", settings: { moonPhase: "minimal" } },
    { name: "an unknown position", settings: { moon: true, moonAt: "outside" } },
    { name: "a non-string position", settings: { moon: true, moonAt: 7 } },
    { name: "a null position", settings: { moon: true, moonAt: null } },
  ];

  it.each(compatibility)("hydrates $name at the bottom-right", async ({ settings }) => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, JSON.stringify({ schema: 2, events: [], calendars: [], settings }));
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings).toMatchObject({ moon: true, moonAt: "bottom-right" });
  });

  it.each(compatibility)("restores $name at the bottom-right", async ({ settings }) => {
    const s = await freshStore();
    s.store.setMoonAt("bottom-right");
    const backup = readBackup({ app: "circal", calendars: [calendar()], settings });
    if (!backup.ok) throw new Error("fixture failed to parse as a backup");
    s.store.restore(backup);
    expect(s.store.snapshot().settings).toMatchObject({ moon: true, moonAt: "bottom-right" });
    expect(s.store.undo()).toBe(true);
    expect(s.store.snapshot().settings).toMatchObject({ moon: true, moonAt: "bottom-right" });
  });

  it.each(TOTALS_POSITIONS)("restores the dial position %s", async (moonAt) => {
    const s = await freshStore();
    const backup = readBackup({
      app: "circal",
      calendars: [calendar()],
      settings: { moon: true, moonAt },
    });
    if (!backup.ok) throw new Error("fixture failed to parse as a backup");
    s.store.restore(backup);
    expect(s.store.snapshot().settings).toMatchObject({ moon: true, moonAt });
    expect(JSON.parse(s.storage.getItem(KEY)!).settings).toMatchObject({ moon: true, moonAt });
  });
});

describe("exclusive dial positions", () => {
  it("moves existing collisions without displacing the moon", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        settings: {
          moon: true,
          moonAt: "bottom-right",
          totals: true,
          totalsAt: "bottom-left",
          dailyNote: true,
          dailyNoteAt: "bottom-right",
        },
      }),
    );
    const s = await freshStore(storage);
    const settings = s.store.snapshot().settings;
    expect(settings.moonAt).toBe("bottom-right");
    expect(settings.totalsAt).toBe("bottom-left");
    expect(TOTALS_POSITIONS).toContain(settings.dailyNoteAt);
    expect(new Set([settings.moonAt, settings.totalsAt, settings.dailyNoteAt]).size).toBe(3);
  });

  it("does not repair a collision by taking a third item's existing position", async () => {
    const s = await freshStore();
    s.store.restore({
      ...s.store.snapshot(),
      settings: {
        ...s.store.snapshot().settings,
        moon: true,
        moonAt: "bottom-right",
        totals: true,
        totalsAt: "bottom-right",
        dailyNote: true,
        dailyNoteAt: "center",
      },
    });
    const settings = s.store.snapshot().settings;
    expect(settings.moonAt).toBe("bottom-right");
    expect(settings.dailyNoteAt).toBe("center");
    expect(["bottom-right", "center"]).not.toContain(settings.totalsAt);
  });

  it("refuses occupied selections and keeps each existing item in place", async () => {
    const s = await freshStore();
    s.store.setToggle("totals", true);
    const before = s.store.snapshot().settings;
    s.store.setDailyNoteAt(before.moonAt as StoreModule.TotalsPosition);
    s.store.setMoonAt(before.dailyNoteAt);
    s.store.setTotalsAt(before.dailyNoteAt);
    expect(s.store.snapshot().settings).toEqual(before);
  });

  it("releases disabled tiles and gives a re-enabled item a free tile", async () => {
    const s = await freshStore();
    s.store.setToggle("moon", false);
    s.store.setDailyNoteAt("bottom-right");
    expect(s.store.snapshot().settings.dailyNoteAt).toBe("bottom-right");
    s.store.setToggle("moon", true);
    expect(s.store.snapshot().settings.dailyNoteAt).toBe("bottom-right");
    expect(s.store.snapshot().settings.moonAt).not.toBe("bottom-right");
    const reloaded = await freshStore(s.storage);
    expect(reloaded.store.snapshot().settings).toEqual(s.store.snapshot().settings);
  });

  it("does not reserve a dial tile for the sidebar moon", async () => {
    const s = await freshStore();
    s.store.setMoonAt("sidebar");
    s.store.setDailyNoteAt("bottom-right");
    expect(s.store.snapshot().settings).toMatchObject({
      moon: true,
      moonAt: "sidebar",
      dailyNoteAt: "bottom-right",
    });
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

  // A preset name is enumerated, so a hand-edited blob can carry anything.
  // An unknown one would leave `<html data-theme>` naming a block no
  // stylesheet answers — chrome half-drawn in two greyscales at once.
  it.each([
    { name: "a name off the list", stored: "sepia", want: "midnight" },
    { name: "a non-string", stored: 7, want: "midnight" },
    { name: "a preset it can", stored: "paper", want: "paper" },
  ])("theme: $name → $want", async ({ stored, want }) => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [],
        feeds: {},
        settings: { theme: stored },
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().settings.theme).toBe(want);
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
    // And it predates travel: an absent run-up must reach `travelMinutes` and
    // `bookedBlock` as `0` rather than as `undefined`, which arrives at the
    // arithmetic as `NaN` and costs the day its whole booked total.
    expect.soft(hydrated.travel).toBe(0);
    // The same blob predates per-event reminder leads, and an absent one must
    // reach `leadOf` as the inheriting state rather than as `undefined`,
    // which is none of the three and would silently stop matching any of
    // them.
    expect.soft(hydrated.remindLead).toBe(REMIND_INHERIT);
    // And it predates the invite path: `attendees` reaching the editor as
    // `undefined` is a crash rather than an empty list, and nobody had asked
    // any of those events anywhere.
    expect.soft(hydrated.organizer).toBeNull();
    expect.soft(hydrated.attendees).toEqual([]);
    expect.soft(hydrated.attendeeCount).toBe(0);
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

  // The same fast path, and the same loss one field further: the destructure
  // has to name `travel` or a typed commute comes back as no commute, which is
  // an arc that silently stops reserving the time it was given.
  it("keeps a stored travel time across a reload", async () => {
    const storage = new MemoryStorage();
    const commute = event({ title: "Studio", start: "2026-03-08 09:30", travel: 25 });
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [commute], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().events[0].travel).toBe(25);
  });

  // The same fast path again, and the reason the guest list is in the shape
  // question: an imported invitation would come back with nobody on it, which
  // is the record of who asked being lost on a reload rather than on an import.
  it("keeps a stored guest list across a reload", async () => {
    const storage = new MemoryStorage();
    const invite = event({
      title: "Design review",
      start: "2026-03-08 09:00",
      organizer: { name: "Ada", address: "ada@example.com" },
      attendees: [attendee("grace@example.com", "accepted", "Grace")],
      attendeeCount: 41,
    });
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [invite], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    const stored = s.store.snapshot().events[0];
    expect.soft(stored.organizer).toEqual({ name: "Ada", address: "ada@example.com" });
    expect.soft(stored.attendees).toEqual([attendee("grace@example.com", "accepted", "Grace")]);
    // The count a truncating import wrote survives too, or the surface stops
    // being able to say how many guests it is not showing.
    expect.soft(stored.attendeeCount).toBe(41);
  });

  // A stored count below the list it labels is a hand-edited blob, and it is
  // the one guest field asked about validity rather than only shape.
  it("repairs a stored count that cannot be true", async () => {
    const storage = new MemoryStorage();
    const broken = {
      ...event({ start: "2026-03-08 09:00", attendees: [attendee("a@x.com")] }),
      attendeeCount: Number.NaN,
    };
    storage.setItem(
      KEY,
      JSON.stringify({ schema: 2, events: [broken], calendars: [], feeds: {}, settings: {} }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().events[0].attendeeCount).toBe(1);
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
    expect.soft(s.store.snapshot().calendars[0].icon).toBe("");
    // The same blob predates per-calendar leads, and an absent one must reach
    // `leadOf` as the inheriting state rather than as `undefined`, which is
    // none of the three and would silently stop matching any of them.
    expect.soft(s.store.snapshot().calendars[0].remindLead).toBe(REMIND_INHERIT);
  });

  it("keeps a stored lead and refuses a stored broken one", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        schema: 2,
        events: [],
        calendars: [
          { id: "a", name: "A", color: "#a3d9e4", icon: "", visible: true, remindLead: 45 },
          // A float matches none of the three states in an inequality-free
          // comparison, for ever — dropped to inheriting like every other
          // unreadable lead.
          { id: "b", name: "B", color: "#a3d9e4", icon: "", visible: true, remindLead: 1.5 },
        ],
        feeds: {},
        settings: {},
      }),
    );
    const s = await freshStore(storage);
    expect(s.store.snapshot().calendars.map((c) => c.remindLead)).toEqual([45, REMIND_INHERIT]);
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

    s.store.restore({
      events: [],
      calendars: [],
      tasks: [],
      taskLists: [],
      dayNotes: [],
      settings: DEFAULT_SETTINGS,
      settingsAt: 0,
      graves: [],
    });
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

  // The guest list deliberately does *not* travel, and it is the sharpest case
  // of `doneKeys`' argument: a copy the user just made is not the invitation
  // somebody else sent, so a duplicate showing "Grace is coming" would be the
  // app inventing an RSVP to a meeting with no organiser and no channel to have
  // been sent on.
  it("arrives with nobody on it, however many guests the original had", () => {
    const copy = duplicateOf(
      event({
        start: "2026-03-08 09:00",
        organizer: { name: "Ada", address: "ada@example.com" },
        attendees: [attendee("grace@example.com", "accepted", "Grace")],
        attendeeCount: 12,
      }),
    );
    expect.soft(copy.organizer).toBeNull();
    expect.soft(copy.attendees).toEqual([]);
    expect.soft(copy.attendeeCount).toBe(0);
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

/* -------------------------------- dayCopies -------------------------------- */

describe("dayCopies", () => {
  const cal = calendar();

  it("shifts a timed event to the same wall clock on the target day, one-off", () => {
    const source = event({ title: "Lunch", start: "2026-03-10 12:30", end: "2026-03-10 13:15" });
    const [copy] = dayCopies([source], [cal], at("2026-03-10"), at("2026-03-17"));
    expect.soft(copy.start).toBe(ms("2026-03-17 12:30"));
    expect.soft(copy.end).toBe(ms("2026-03-17 13:15"));
    expect.soft(copy.title).toBe("Lunch");
    expect.soft(copy.repeat).toBe("never");
  });

  it("copies a series' occurrence as a one-off — a second whole series says everything twice", () => {
    const source = event({
      title: "Standup",
      start: "2026-03-02 09:00",
      end: "2026-03-02 09:30",
      repeat: "weekly",
      exdates: ["2026-03-16"],
      until: ms("2026-06-01 00:00"),
    });
    // The occurrence copied is the *queried* day's, not the seed's.
    const [copy] = dayCopies([source], [cal], at("2026-03-09"), at("2026-03-11"));
    expect.soft(copy.start).toBe(ms("2026-03-11 09:00"));
    expect.soft(copy.repeat).toBe("never");
    expect.soft(copy.until).toBe(0);
    expect.soft(copy.exdates).toEqual([]);
  });

  it("copies only what starts on the day — the trip's third morning is not a second trip", () => {
    const trip = event({
      title: "Trip",
      start: "2026-03-08 00:00",
      end: "2026-03-13 00:00",
      allDay: true,
    });
    expect.soft(dayCopies([trip], [cal], at("2026-03-10"), at("2026-04-10"))).toEqual([]);
    const [copy] = dayCopies([trip], [cal], at("2026-03-08"), at("2026-04-08"));
    // The whole span comes when it starts here, both ends on local midnight.
    expect.soft(copy.start).toBe(ms("2026-04-08 00:00"));
    expect.soft(copy.end).toBe(ms("2026-04-13 00:00"));
  });

  it("keeps 09:00 at 09:00 across a DST transition — wall clock, not milliseconds", () => {
    const source = event({ start: "2026-03-27 09:00", end: "2026-03-27 10:00" });
    // Berlin springs forward on 2026-03-29; a millisecond shift would land 10:00.
    const [copy] = dayCopies([source], [cal], at("2026-03-27"), at("2026-03-30"));
    expect(copy.start).toBe(ms("2026-03-30 09:00"));
  });

  it("skips a hidden calendar — a day's copy is what the day shows", () => {
    const hidden = calendar({ id: "hidden", visible: false });
    const source = event({ start: "2026-03-10 09:00", calendarId: "hidden" });
    expect(dayCopies([source], [cal, hidden], at("2026-03-10"), at("2026-03-11"))).toEqual([]);
  });

  it("copies nothing onto the same day", () => {
    const source = event({ start: "2026-03-10 09:00" });
    expect(dayCopies([source], [cal], at("2026-03-10"), at("2026-03-10 23:00"))).toEqual([]);
  });
});

describe("store.duplicateDay", () => {
  it("lands every copy in one commit, counted, and one undo takes the day back", async () => {
    const s = await freshStore();
    s.store.create(draft(s, 9 * 60, 10 * 60));
    s.store.create(draft(s, 14 * 60, 15 * 60));
    const before = s.store.snapshot().events.length;

    const from = at("2026-03-08");
    const landed = s.store.duplicateDay(from, addDays(from, 7));
    expect.soft(landed).toBe(2);
    expect.soft(s.store.snapshot().events).toHaveLength(before + 2);
    // Stamped at the commit, so a merge can defend them.
    const copies = s.store.snapshot().events.slice(before);
    for (const copy of copies) expect.soft(copy.updatedAt).toBeGreaterThan(0);

    expect.soft(s.store.undo()).toBe(true);
    expect.soft(s.store.snapshot().events).toHaveLength(before);
  });

  it("commits nothing when there is nothing to copy", async () => {
    const s = await freshStore();
    const created = s.store.create(draft(s));
    const landed = s.store.duplicateDay(at("2020-01-01"), at("2020-01-08"));
    expect.soft(landed).toBe(0);
    expect.soft(s.store.snapshot().events).toEqual([created]);
    // No commit means no undo step for it: the undo takes the create back.
    s.store.undo();
    expect.soft(s.store.snapshot().events).toEqual([]);
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
