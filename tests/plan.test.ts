import { describe, expect, it } from "vitest";
import { at, calendar, event, ms, plan, task } from "./helpers";
import { DEFAULT_WAKING } from "@/lib/events";
import { schedule } from "@/lib/plan";

const cal = calendar();

/** Monday 9 March 2026, 08:00 — a `from` at the waking window's own edge, so
 *  day-zero placements are not clipped by the started-day rule. */
const MONDAY = at("2026-03-09 08:00");

const run = (
  tasks: Parameters<typeof schedule>[0],
  events: Parameters<typeof schedule>[1] = [],
  from: Date = MONDAY,
  horizon = 14,
) => schedule(tasks, events, [cal], DEFAULT_WAKING, from, horizon);

describe("schedule: who is a candidate", () => {
  it("skips done tasks, unsized tasks, and tasks that already have a plan", () => {
    const done = task({ title: "Done", due: "2026-03-13 17:00", estimate: 60, done: true });
    const unsized = task({ title: "Unsized", due: "2026-03-13 17:00", estimate: null });
    const planned = task({
      title: "Planned",
      due: "2026-03-13 17:00",
      estimate: 60,
      plans: [plan("2026-03-09 09:00", "2026-03-09 09:30")],
    });
    const open = task({ title: "Open", due: "2026-03-13 17:00", estimate: 60 });
    const { placements, unplaced } = run([done, unsized, planned, open]);
    expect.soft(placements.map((p) => p.id)).toEqual([open.id]);
    // Non-candidates are not failures: nothing to report about them.
    expect.soft(unplaced).toEqual([]);
  });

  it("places soonest deadline first, priority breaking the tie", () => {
    const later = task({ title: "Later", due: "2026-03-14 17:00", estimate: 60 });
    const urgent = task({ title: "Urgent", due: "2026-03-13 17:00", estimate: 60, priority: 2 });
    const normal = task({ title: "Normal", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = run([later, normal, urgent]);
    expect(placements.map((p) => p.id)).toEqual([urgent.id, normal.id, later.id]);
    // Earlier in the order gets the earlier gap.
    expect(placements[0].plan.start).toBeLessThan(placements[2].plan.start);
  });
});

describe("schedule: where a placement may land", () => {
  it("lands inside waking hours, on the quarter, never over busy time", () => {
    const meeting = event({ start: "2026-03-09 08:00", end: "2026-03-09 10:10" });
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 90 });
    const { placements } = run([t], [meeting]);
    expect(placements).toHaveLength(1);
    // First quarter after the meeting, not 08:00 and not 10:10.
    expect.soft(placements[0].plan.start).toBe(ms("2026-03-09 10:15"));
    expect.soft(placements[0].plan.end).toBe(ms("2026-03-09 11:45"));
  });

  it("books over a free event — free is bookable everywhere here", () => {
    const held = event({ start: "2026-03-09 08:00", end: "2026-03-09 18:00", free: true });
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = run([t], [held]);
    expect(placements).toHaveLength(1);
    expect(placements[0].plan.start).toBe(ms("2026-03-09 08:00"));
  });

  it("never lands after its own deadline, and reports what does not fit", () => {
    // Due 09:30 on the from-day: one quarter-aligned hour fits 08:00–09:00…
    const fits = task({ title: "Fits", due: "2026-03-09 09:30", estimate: 60 });
    // …but two hours cannot end by 09:30, and no later day is legal either.
    const late = task({ title: "Late", due: "2026-03-09 09:30", estimate: 120 });
    const { placements, unplaced } = run([fits, late]);
    expect.soft(placements.map((p) => p.id)).toEqual([fits.id]);
    expect.soft(placements[0]?.plan.end).toBeLessThanOrEqual(ms("2026-03-09 09:30"));
    expect.soft(unplaced.map((t) => t.id)).toEqual([late.id]);
  });

  it("an all-day deadline allows the whole due day", () => {
    const t = task({ title: "Forms", due: ms("2026-03-09 00:00"), dueAllDay: true, estimate: 60 });
    const { placements, unplaced } = run([t]);
    expect.soft(unplaced).toEqual([]);
    expect.soft(placements[0].plan.start).toBe(ms("2026-03-09 08:00"));
  });

  it("the first day starts at `from`, later days at the waking edge", () => {
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = run([t], [], at("2026-03-09 16:33"));
    // 16:33 rounds up to the next quarter, never back into the past.
    expect(placements[0].plan.start).toBe(ms("2026-03-09 16:45"));
  });

  it("overflows to the next day when today is full", () => {
    const wall = event({ start: "2026-03-09 08:00", end: "2026-03-09 23:00" });
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = run([t], [wall]);
    expect(placements[0].plan.start).toBe(ms("2026-03-10 08:00"));
  });
});

describe("schedule: one run cannot double-book itself", () => {
  it("two placements in one run never overlap", () => {
    const a = task({ title: "A", due: "2026-03-13 17:00", estimate: 120 });
    const b = task({ title: "B", due: "2026-03-13 17:00", estimate: 120 });
    const { placements } = run([a, b]);
    expect(placements).toHaveLength(2);
    const [p, q] = placements.map((x) => x.plan).sort((x, y) => x.start - y.start);
    expect(q.start).toBeGreaterThanOrEqual(p.end);
  });

  it("running it twice is a no-op the second time", () => {
    const a = task({ title: "A", due: "2026-03-13 17:00", estimate: 60 });
    const b = task({ title: "B", due: "2026-03-13 17:00", estimate: 60 });
    const first = run([a, b]);
    const after = [a, b].map((t, i) => ({ ...t, plans: [first.placements[i].plan] }));
    const second = run(after);
    expect.soft(second.placements).toEqual([]);
    expect.soft(second.unplaced).toEqual([]);
  });

  it("respects another task's existing plan as booked time", () => {
    const planned = task({
      title: "Planned",
      due: "2026-03-13 17:00",
      estimate: 60,
      plans: [plan("2026-03-09 08:00", "2026-03-09 10:00")],
    });
    const open = task({ title: "Open", due: "2026-03-13 17:00", estimate: 60 });
    const { placements } = run([planned, open]);
    expect(placements.map((p) => p.id)).toEqual([open.id]);
    expect(placements[0].plan.start).toBe(ms("2026-03-09 10:00"));
  });

  it("a horizon with no room reports the task rather than inventing an hour", () => {
    const wall = event({
      start: "2026-03-09 00:00",
      end: "2026-03-30 00:00",
    });
    const t = task({ title: "Essay", due: "2026-03-28 17:00", estimate: 60 });
    const { placements, unplaced } = run([t], [wall], MONDAY, 3);
    expect.soft(placements).toEqual([]);
    expect.soft(unplaced.map((x) => x.id)).toEqual([t.id]);
  });
});

describe("schedule: hidden calendars", () => {
  it("reads free time off the visible agenda — dayAgenda's own filter, freeSlots' own rule", () => {
    const hidden = calendar({ id: "cal-hidden", visible: false });
    const meeting = event({
      calendarId: "cal-hidden",
      start: "2026-03-09 08:00",
      end: "2026-03-09 12:00",
    });
    const t = task({ title: "Essay", due: "2026-03-13 17:00", estimate: 60 });
    const out = schedule([t], [meeting], [cal, hidden], DEFAULT_WAKING, MONDAY, 14);
    // A hidden calendar books nothing anywhere free is measured here: the
    // dial's gaps and a shared link's slots ignore it too, so a placement
    // must not disagree with the face the user was shown.
    expect(out.placements[0].plan.start).toBe(ms("2026-03-09 08:00"));
  });
});
