import { describe, expect, it } from "vitest";
import { at, day } from "../helpers";
import { lifeFraction, lifeMilestones, lifeSpan } from "@/lib/life";
import {
  addDays,
  atMinutes,
  dayKey,
  fromDayKey,
  minutesOfDay,
  startOfDay,
  startOfWeek,
} from "@/lib/time";

/* ------------------------------------------------------------------ *
 * Re-runs the zone-sensitive invariants from tests/time.test.ts under
 * America/Los_Angeles. The point of this project: Berlin is east of UTC,
 * LA is west of it, and a bug that only shows up on one side of the
 * meridian must fail here even when tests/time.test.ts is green.
 * ------------------------------------------------------------------ */

describe("dayKey stays local, west of UTC", () => {
  // West of UTC, the mismatch surfaces in the *evening*, not the morning:
  // 23:00 local is already tomorrow in UTC.
  it("a late-evening local instant is still today's local day, not tomorrow's UTC day", () => {
    const d = at("2026-06-15 23:00");
    expect(dayKey(d)).toBe("2026-06-15");
    expect(d.toISOString().slice(0, 10)).toBe("2026-06-16");
    expect(dayKey(d)).not.toBe(d.toISOString().slice(0, 10));
  });

  it("round-trips through fromDayKey to the same local midnight", () => {
    const d = at("2026-06-15 23:00");
    expect(fromDayKey(dayKey(d))).toBeSameInstantAs(day("2026-06-15"));
  });
});

describe("startOfDay + addDays across the US DST transitions", () => {
  // US spring-forward is 2026-03-08 (a week later than Europe's), fall-back
  // is 2026-11-01 (a week earlier) — different dates than Berlin entirely.
  it("adds a calendar day, not 86_400_000ms, across US spring-forward", () => {
    const before = at("2026-03-07 10:00");
    const after = addDays(before, 1);
    expect(after).toBeSameInstantAs("2026-03-08 10:00");
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  it("adds a calendar day, not 86_400_000ms, across US fall-back", () => {
    const before = at("2026-10-31 10:00");
    const after = addDays(before, 1);
    expect(after).toBeSameInstantAs("2026-11-01 10:00");
    expect(after.getTime() - before.getTime()).toBe(25 * 3_600_000);
  });

  it("startOfDay lands on local midnight either side of the US transition", () => {
    expect(startOfDay(at("2026-03-08 15:00"))).toBeSameInstantAs(day("2026-03-08"));
    expect(startOfDay(at("2026-11-01 15:00"))).toBeSameInstantAs(day("2026-11-01"));
  });
});

describe("startOfWeek across the US DST transitions", () => {
  // US spring-forward, 2026-03-08, is a Sunday — the last day of its week and
  // the one a Monday-first walk has to step back six days from. That week is
  // 167 hours long, so a millisecond walk lands at 01:00 on the Monday, and
  // west of UTC an hour before midnight is the day before.
  it.each([
    { name: "the spring-forward Sunday", on: "2026-03-08", monday: "2026-03-02" },
    { name: "the fall-back Sunday", on: "2026-11-01", monday: "2026-10-26" },
  ])("puts $name on the Monday of $monday, at local midnight", ({ on, monday }) => {
    const out = startOfWeek(day(on));
    expect.soft(out).toBeSameInstantAs(day(monday));
    expect.soft(dayKey(out)).toBe(monday);
    expect.soft(minutesOfDay(out)).toBe(0);
  });

  it("agrees with addDays for every day of a transition week", () => {
    const monday = startOfWeek(day("2026-03-08"));
    for (let i = 0; i < 7; i += 1) {
      expect.soft(startOfWeek(addDays(monday, i))).toBeSameInstantAs(monday);
    }
  });

  // A late-evening instant on the Sunday: the trap is reading UTC fields,
  // which west of UTC have already rolled into Monday and start a new week.
  it("keeps a Sunday evening in the week that is ending, not the one starting", () => {
    expect(startOfWeek(at("2026-03-08 23:30"))).toBeSameInstantAs(day("2026-03-02"));
  });
});

describe("atMinutes / minutesOfDay round-trip on a DST-transition day", () => {
  const transitionDay = day("2026-03-08"); // US spring-forward: 02:00 -> 03:00

  it.each([
    { name: "midnight", minutes: 0 },
    { name: "just before the gap", minutes: 119 },
    { name: "one minute before the day ends", minutes: 1439 },
  ])("round-trips $name, outside the missing hour", ({ minutes }) => {
    expect.soft(minutesOfDay(atMinutes(transitionDay, minutes))).toBe(minutes);
  });

  // 02:00-02:59 does not exist as local wall-clock time on this day: setting
  // "minutes since midnight" to a value inside that hour lands the engine
  // past the jump instead, so the round-trip legitimately does not hold here
  // — this documents the gap rather than asserting a bug.
  it("does not round-trip inside the spring-forward gap itself", () => {
    const d = atMinutes(transitionDay, 121); // nominally 02:01
    expect(d).toBeSameInstantAs("2026-03-08 03:01");
    expect(minutesOfDay(d)).toBe(181);
  });
});

describe("life milestones land on local midnight west of UTC", () => {
  // `lifeMilestones` walks the span with `addDays`, which is calendar-based
  // rather than 86,400,000ms at a time — and a mark 10,000 days out crosses
  // twenty US DST transitions on the way. A millisecond walk would drift an
  // hour off midnight and put the dot on the wrong day for anyone west of
  // UTC, which is exactly the class of bug this project exists to catch.
  const span = lifeSpan(day("1990-03-12"), 80);

  it.each([
    { key: "d10000", on: "2017-07-27" },
    { key: "half", on: "2030-03-12" },
    { key: "d20000", on: "2044-12-12" },
  ])("puts $key on local midnight of $on", ({ key, on }) => {
    const mark = lifeMilestones(span).find((m) => m.key === key)!;
    expect(mark.date).toBeSameInstantAs(day(on));
    expect(dayKey(mark.date)).toBe(on);
  });

  it("counts whole local days from the birthday, DST transitions included", () => {
    for (const mark of lifeMilestones(span)) {
      expect(mark.date).toBeSameInstantAs(addDays(span.birth, mark.day - 1));
      expect(minutesOfDay(mark.date)).toBe(0);
    }
  });

  it("lifeFraction stays inside [0,1] at both ends of a span built west of UTC", () => {
    expect(lifeFraction(span, span.birth)).toBe(0);
    expect(lifeFraction(span, at("2070-03-12 23:59"))).toBeLessThanOrEqual(1);
    expect(lifeFraction(span, addDays(span.death, 1))).toBe(1);
  });
});
