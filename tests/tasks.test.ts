import { describe, expect, it } from "vitest";
import { at, ms, plan, task, taskList } from "./helpers";
import {
  DUE_SOON_DAYS,
  ESTIMATE_MAX,
  PLANS_MAX,
  compareTasks,
  plannedMinutes,
  readEstimate,
  readPlans,
  readPriority,
  scoreTask,
  scoreTaskBy,
  taskState,
  taskListTree,
  taskListDescendants,
  unplanned,
} from "@/lib/tasks";

/**
 * The task model's own answers: the field validators `readTask` and the
 * store's hydration compose, and the derived readings the sidebar and the
 * auto-scheduler will both feed on. The occurrence half — plans and due pips
 * entering `dayAgenda` — lives in `tests/events.test.ts`, beside the read
 * path it extends.
 */

describe("readEstimate", () => {
  it.each([
    { name: "a whole count of minutes", value: 90, want: 90 },
    { name: "a float, rounded", value: 89.6, want: 90 },
    { name: "a negative, floored at zero", value: -5, want: 0 },
    { name: "over a day, capped", value: ESTIMATE_MAX + 1, want: ESTIMATE_MAX },
    { name: "null — no idea is a legal answer", value: null, want: null },
    { name: "a string", value: "90", want: null },
    { name: "NaN", value: NaN, want: null },
    { name: "Infinity", value: Infinity, want: null },
  ])("$name", ({ value, want }) => {
    expect.soft(readEstimate(value)).toBe(want);
  });
});

describe("readPriority", () => {
  it.each([
    { name: "normal", value: 0, want: 0 },
    { name: "high", value: 1, want: 1 },
    { name: "urgent", value: 2, want: 2 },
    // A hand-edited 9 must not sort above every urgent task for ever.
    { name: "out of range snaps to normal", value: 9, want: 0 },
    { name: "a string is normal", value: "2", want: 0 },
    { name: "absent is normal", value: undefined, want: 0 },
  ])("$name", ({ value, want }) => {
    expect.soft(readPriority(value)).toBe(want);
  });
});

describe("readPlans", () => {
  it("keeps well-formed plans in start order", () => {
    const later = plan("2026-03-10 09:00", "2026-03-10 10:00");
    const earlier = plan("2026-03-09 09:00", "2026-03-09 10:00");
    expect(readPlans([later, earlier])).toEqual([earlier, later]);
  });

  it.each([
    { name: "not an array", value: "plans" },
    { name: "a row that is not an object", value: [42] },
    { name: "a plan with a string instant", value: [{ start: "9am", end: 10 }] },
    { name: "a plan with a NaN end", value: [{ start: 1, end: NaN }] },
    // A plan of no width books nothing and draws nothing.
    { name: "a widthless plan", value: [{ start: 5, end: 5 }] },
    { name: "an inverted plan", value: [{ start: 10, end: 5 }] },
  ])("drops $name", ({ value }) => {
    expect.soft(readPlans(value)).toEqual([]);
  });

  it("caps a hand-edited list at PLANS_MAX so one task cannot flood a day", () => {
    const many = Array.from({ length: PLANS_MAX + 10 }, (_, i) => ({
      start: i * 100,
      end: i * 100 + 50,
    }));
    expect(readPlans(many)).toHaveLength(PLANS_MAX);
  });
});

describe("plannedMinutes and unplanned", () => {
  it("sums the plans in whole minutes", () => {
    const t = task({
      plans: [
        plan("2026-03-09 09:00", "2026-03-09 10:00"),
        plan("2026-03-10 09:00", "2026-03-10 09:30"),
      ],
    });
    expect(plannedMinutes(t)).toBe(90);
  });

  it("no plans at all is unplanned, whatever the estimate says", () => {
    expect.soft(unplanned(task({ estimate: null }))).toBe(true);
    expect.soft(unplanned(task({ estimate: 60 }))).toBe(true);
  });

  it("plans short of the estimate are still unplanned — the sidebar's mark and the scheduler's feed", () => {
    const short = task({ estimate: 120, plans: [plan("2026-03-09 09:00", "2026-03-09 10:00")] });
    expect.soft(unplanned(short)).toBe(true);
    expect.soft(unplanned({ ...short, estimate: 60 })).toBe(false);
  });

  it("plans with no estimate are planned — there is no target to fall short of", () => {
    expect(
      unplanned(task({ estimate: null, plans: [plan("2026-03-09 09:00", "2026-03-09 09:30")] })),
    ).toBe(false);
  });
});

describe("taskState", () => {
  const now = at("2026-03-08 12:00");

  it.each([
    {
      name: "done wins over everything",
      over: { done: true, due: "2020-01-01 09:00" },
      want: "done",
    },
    { name: "a timed deadline just passed", over: { due: "2026-03-08 11:59" }, want: "overdue" },
    { name: "a timed deadline exactly now", over: { due: "2026-03-08 12:00" }, want: "overdue" },
    { name: "a timed deadline later today", over: { due: "2026-03-08 18:00" }, want: "due-soon" },
    { name: "a timed deadline on day seven", over: { due: "2026-03-15 09:00" }, want: "due-soon" },
    { name: "a timed deadline on day eight", over: { due: "2026-03-16 09:00" }, want: "later" },
    // An all-day deadline is measured in local days: "due Friday" is overdue
    // on Saturday, not at Friday noon.
    {
      name: "an all-day deadline today",
      over: { due: "2026-03-08", dueAllDay: true },
      want: "due-soon",
    },
    {
      name: "an all-day deadline yesterday",
      over: { due: "2026-03-07", dueAllDay: true },
      want: "overdue",
    },
    {
      name: "an all-day deadline on day seven",
      over: { due: "2026-03-15", dueAllDay: true },
      want: "due-soon",
    },
    {
      name: "an all-day deadline on day eight",
      over: { due: "2026-03-16", dueAllDay: true },
      want: "later",
    },
  ])("$name", ({ over, want }) => {
    expect.soft(taskState(task(over), now)).toBe(want);
  });

  it("the window is DUE_SOON_DAYS — the sidebar's groups read this one number", () => {
    expect(DUE_SOON_DAYS).toBe(7);
  });
});

describe("scoreTask — scoreEvent's shape, so the two models rank alike", () => {
  it("matches the title, and a notes match of the same quality ranks below it", () => {
    const titled = scoreTask(task({ title: "Renew passport", notes: "" }), "renew");
    const noted = scoreTask(task({ title: "Errand", notes: "Renew passport" }), "renew");
    expect.soft(titled).not.toBeNull();
    expect.soft(noted).not.toBeNull();
    expect.soft(titled!).toBeGreaterThan(noted!);
  });

  it("answers null when nothing matches — a day must not light for a query the list would not find", () => {
    expect(scoreTask(task({ title: "Renew passport", notes: "" }), "zzz")).toBeNull();
  });
});

describe("scoreTaskBy — the winning field named, scoreEventBy's shape", () => {
  it("agrees with scoreTask about the score and names the field", () => {
    const noted = task({ title: "Errand", notes: "Renew passport" });
    expect.soft(scoreTaskBy(noted, "renew")!.score).toBe(scoreTask(noted, "renew")!);
    expect.soft(scoreTaskBy(noted, "renew")!.field).toBe("notes");
    expect.soft(scoreTaskBy(task({ title: "Renew passport" }), "renew")!.field).toBe("title");
  });

  it("answers null exactly where scoreTask does", () => {
    expect(scoreTaskBy(task({ title: "Renew passport", notes: "" }), "zzz")).toBeNull();
  });
});

describe("compareTasks — one order for every list of tasks", () => {
  it("sorts by due, then priority, then title", () => {
    const rows = [
      task({ title: "B", due: "2026-03-10 09:00" }),
      task({ title: "A", due: "2026-03-10 09:00" }),
      task({ title: "Urgent", due: "2026-03-10 09:00", priority: 2 }),
      task({ title: "Sooner", due: "2026-03-09 09:00" }),
    ];
    expect([...rows].sort(compareTasks).map((t) => t.title)).toEqual([
      "Sooner",
      "Urgent",
      "A",
      "B",
    ]);
  });

  it("is a total order over its own tie-breaks", () => {
    const a = task({ title: "Same", due: ms("2026-03-10 09:00") });
    const b = task({ title: "Same", due: ms("2026-03-10 09:00") });
    expect(compareTasks(a, b)).toBe(0);
  });
});

describe("task list hierarchy", () => {
  it("walks parents before children and keeps orphaned and cyclic lists reachable", () => {
    const lists = [
      taskList({ id: "child", name: "Child", parentId: "root" }),
      taskList({ id: "root", name: "Root" }),
      taskList({ id: "orphan", name: "Orphan", parentId: "deleted" }),
      taskList({ id: "a", name: "A", parentId: "b" }),
      taskList({ id: "b", name: "B", parentId: "a" }),
    ];
    expect(taskListTree(lists).map(({ list, depth }) => [list.id, depth])).toEqual([
      ["orphan", 0],
      ["root", 0],
      ["child", 1],
      ["a", 0],
      ["b", 1],
    ]);
    expect(taskListDescendants(lists, "root")).toEqual(new Set(["root", "child"]));
    expect(taskListDescendants(lists, "a")).toEqual(new Set(["a", "b"]));
    expect(taskListTree([...lists].reverse())).toEqual(taskListTree(lists));
  });
});
