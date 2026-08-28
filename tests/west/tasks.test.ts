import { describe, expect, it } from "vitest";
import { at, calendar, day, plan, task } from "../helpers";
import { taskOccurrences } from "@/lib/events";
import { taskState } from "@/lib/tasks";

/**
 * Deadlines and plans are day-keyed — `taskState` compares local days and
 * `taskOccurrences` clips to a local midnight — so the whole file re-runs
 * west of UTC, where `toISOString()`-shaped reasoning breaks first.
 * `TZ=America/Los_Angeles` via this project's own config.
 */

const cal = calendar();

describe("taskState west of UTC", () => {
  const now = at("2026-03-08 12:00");

  it("an all-day deadline is overdue the local day after it, not at a UTC boundary", () => {
    expect.soft(taskState(task({ due: "2026-03-07", dueAllDay: true }), now)).toBe("overdue");
    expect.soft(taskState(task({ due: "2026-03-08", dueAllDay: true }), now)).toBe("due-soon");
  });

  it("the seven-day window is counted in local days across the DST transition", () => {
    // 2026-03-08 is the US spring-forward day; day seven is still due-soon
    // and day eight is later, exactly as east of UTC.
    expect.soft(taskState(task({ due: "2026-03-15", dueAllDay: true }), now)).toBe("due-soon");
    expect.soft(taskState(task({ due: "2026-03-16", dueAllDay: true }), now)).toBe("later");
  });
});

describe("taskOccurrences west of UTC", () => {
  it("a due pip lands on its own local day", () => {
    const t = task({ due: "2026-03-08 18:30" });
    expect.soft(taskOccurrences([t], [cal], day("2026-03-08"))).toHaveLength(1);
    expect.soft(taskOccurrences([t], [cal], day("2026-03-09"))).toHaveLength(0);
  });

  it("a plan across the spring-forward midnight clips at the local boundary", () => {
    const t = task({
      due: "2026-03-13 17:00",
      plans: [plan("2026-03-07 23:00", "2026-03-08 03:00")],
    });
    const [second] = taskOccurrences([t], [cal], day("2026-03-08"));
    expect.soft(second.startMin).toBe(0);
    // 03:00 on the short day is minute 180 of the face, whatever the clock
    // skipped: minutes since local midnight, not elapsed time.
    expect.soft(second.endMin).toBe(180);
    expect.soft(second.continuesBefore).toBe(true);
  });
});
