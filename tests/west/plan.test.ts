import { describe, expect, it } from "vitest";
import { at, calendar, ms, task } from "../helpers";
import { DEFAULT_WAKING } from "@/lib/events";
import { schedule } from "@/lib/plan";

/**
 * The walk is day-keyed — `startOfDay` + `addDays` from `from`, `atMinutes`
 * back to instants — so it re-runs west of UTC across the US spring-forward,
 * where a day is 23 hours long and `n × 1440` reasoning breaks first.
 * `TZ=America/Los_Angeles` via this project's own config.
 */

const cal = calendar();

describe("schedule west of UTC, across spring-forward", () => {
  it("a placement on the short day still lands at its wall-clock minute", () => {
    // 2026-03-08 is the US transition day; today is full, so the task
    // overflows onto it, and 08:00 must mean the wall clock's 08:00.
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = schedule([t], [], [cal], DEFAULT_WAKING, at("2026-03-08 07:00"), 14);
    expect.soft(placements).toHaveLength(1);
    expect.soft(placements[0].plan.start).toBe(ms("2026-03-08 08:00"));
    expect.soft(placements[0].plan.end).toBe(ms("2026-03-08 09:00"));
  });

  it("two tasks filling the short day never overlap across the skipped hour", () => {
    const a = task({ title: "A", due: "2026-03-13 17:00", estimate: 120 });
    const b = task({ title: "B", due: "2026-03-13 17:00", estimate: 120 });
    const { placements } = schedule([a, b], [], [cal], DEFAULT_WAKING, at("2026-03-08 07:00"), 14);
    expect(placements).toHaveLength(2);
    const [p, q] = placements.map((x) => x.plan).sort((x, y) => x.start - y.start);
    expect(q.start).toBeGreaterThanOrEqual(p.end);
  });
});
