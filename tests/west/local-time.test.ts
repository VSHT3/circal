import { describe, expect, it } from "vitest";
import { at, day, event, rule } from "../helpers";
import {
  lifeFraction,
  lifeMilestones,
  lifeSpan,
  loupeCell,
  loupeCellAt,
  loupeLayout,
} from "@/lib/life";
import {
  addDays,
  atMinutes,
  dayKey,
  fromDayKey,
  minutesOfDay,
  startOfDay,
  startOfWeek,
  weekOffset,
  zonedToUtc,
} from "@/lib/time";
import { startsBetweenIn } from "@/lib/recur";
import { keptEvents, movedEvent, travelShift } from "@/lib/travel";

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
    const out = startOfWeek(day(on), 1);
    expect.soft(out).toBeSameInstantAs(day(monday));
    expect.soft(dayKey(out)).toBe(monday);
    expect.soft(minutesOfDay(out)).toBe(0);
  });

  it("agrees with addDays for every day of a transition week", () => {
    const monday = startOfWeek(day("2026-03-08"), 1);
    for (let i = 0; i < 7; i += 1) {
      expect.soft(startOfWeek(addDays(monday, i), 1)).toBeSameInstantAs(monday);
    }
  });

  // A late-evening instant on the Sunday: the trap is reading UTC fields,
  // which west of UTC have already rolled into Monday and start a new week.
  it("keeps a Sunday evening in the week that is ending, not the one starting", () => {
    expect(startOfWeek(at("2026-03-08 23:30"), 1)).toBeSameInstantAs(day("2026-03-02"));
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

describe("the loupe's cells stay on local days west of UTC", () => {
  // `loupeCell` measures a day's place from 1 January with `startOfDay`, and a
  // year west of UTC contains two transitions that a millisecond count would
  // drift an hour across — which lands a day one row up or down, and a row
  // here is a *weekday*. Both transitions are inside the year walked below.
  const span = lifeSpan(day("1990-03-12"), 80);
  const layout = loupeLayout(800, 200, 1.9, 1);
  if (!layout) throw new Error("a strip this size must resolve");

  it("puts every day of a year on its own weekday's row, both transitions included", () => {
    for (let d = day("2026-01-01"); d.getFullYear() === 2026; d = addDays(d, 1)) {
      expect.soft(loupeCell(d, 1).row).toBe(weekOffset(d, 1));
    }
  });

  it("reads back local midnight, never the hour the clock moved", () => {
    // 8 March 2026 is the spring-forward Sunday in Los Angeles and 1 November
    // the fall-back one: the two days most likely to come back off by one.
    for (const key of ["2026-03-08", "2026-11-01"]) {
      const d = day(key);
      const { col, row } = loupeCell(d, 1);
      const back = loupeCellAt(
        layout,
        span,
        2026,
        col * layout.pitch + layout.pitch / 2,
        row * layout.pitch + layout.pitch / 2,
      );
      expect(back).toBeSameInstantAs(d);
      expect(dayKey(back!)).toBe(key);
    }
  });
});

describe("a Sunday-start week and the loupe's rows stay on local days west of UTC", () => {
  // Same two transitions as above, but cut on Sunday rather than Monday: the
  // spring-forward and fall-back Sundays are now the week's own leading edge
  // rather than its last day, so a `getDay()`-based reader that only ever
  // saw the Monday case would still get this one wrong.
  it("startOfWeek: each transition Sunday begins its own week, at local midnight", () => {
    for (const on of ["2026-03-08", "2026-11-01"]) {
      const out = startOfWeek(day(on), 0);
      expect.soft(out).toBeSameInstantAs(day(on));
      expect.soft(minutesOfDay(out)).toBe(0);
    }
  });

  it("loupeCell: every day of the year lands on its own weekday row, both transitions included", () => {
    for (let d = day("2026-01-01"); d.getFullYear() === 2026; d = addDays(d, 1)) {
      expect.soft(loupeCell(d, 0).row).toBe(weekOffset(d, 0));
    }
  });
});

/* ------------------------------------------------------------------ *
 * `startsBetweenIn` shifts a rule into its *own* zone's wall clock before
 * walking it, never the reader's — so the same feed, expanded from this
 * file's Los Angeles process, must hold the exact instants
 * `tests/recur.test.ts` gets from Berlin. Nothing here is TZ-pinned by
 * construction the way `dayKey`/`startOfWeek` are; this is the negative
 * case, proving the reader's own zone never leaks in. ------------------- */

describe("startsBetweenIn: a zoned rule expands the same from LA as from Berlin", () => {
  it("a weekly 09:00 New York rule holds 09:00 New York across the US/EU transition gap", () => {
    // Same fixture as `tests/recur.test.ts`'s Berlin case: the US springs
    // forward 2026-03-08, the EU 2026-03-29 — the three weeks AUDIT.md's
    // own example names. Every instant below is built through `zonedToUtc`,
    // so it names the same real moments regardless of which process built
    // it, and the assertion is that `startsBetweenIn` agrees from here too.
    const seed = zonedToUtc(2026, 2, 15, 9, 0, "America/New_York");
    const from = zonedToUtc(2026, 2, 1, 0, 0, "America/New_York");
    const to = zonedToUtc(2026, 4, 1, 0, 0, "America/New_York");
    const sundays = [
      [2, 15],
      [2, 22],
      [3, 1],
      [3, 8],
      [3, 15],
      [3, 22],
      [3, 29],
    ] as const;
    const expected = sundays.map(([mo, d]) => zonedToUtc(2026, mo, d, 9, 0, "America/New_York"));
    const result = startsBetweenIn(rule({ repeat: "weekly" }), seed, from, to, "America/New_York");
    expect(result).toBeInstants(expected);
  });
});

/* ------------------------------------------------------------------ *
 * The travel notice's arithmetic, west of UTC. Two halves, and both need
 * this project: the timed shift must not depend on who is reading (the
 * negative case above, one function over), while an all-day event is
 * re-anchored to *local* midnight — the day-keyed half, which is exactly
 * where `toISOString`-shaped thinking passes in Berlin and fails here.
 * ------------------------------------------------------------------ */

describe("travel: a timed event's shift is the same from LA as from Berlin", () => {
  it("carries the wall clock of the zone it is moved into, whoever is reading", () => {
    // `tests/travel.test.ts` asserts the same two shifts from Berlin: six
    // hours in July, five in the three weeks the transition dates disagree.
    const july = zonedToUtc(2026, 7, 15, 9, 0, "Europe/Berlin");
    const march = zonedToUtc(2026, 3, 15, 9, 0, "Europe/Berlin");
    expect.soft(travelShift(july, "Europe/Berlin", "America/New_York")).toBe(6 * 3_600_000);
    expect.soft(travelShift(march, "Europe/Berlin", "America/New_York")).toBe(5 * 3_600_000);
  });
});

describe("travel: an all-day event re-anchors to local midnight west of UTC", () => {
  it("keeps the date and lands on this machine's own midnight, not five hours off it", () => {
    // The case the shift would break: moved *into* the reader's own zone,
    // which is what the real prompt always does, so `day()` and `dayKey()`
    // are the local answers and a stray offset shows up as the 4th.
    const moved = movedEvent(
      event({
        start: zonedToUtc(2026, 10, 5, 0, 0, "Europe/Berlin"),
        end: zonedToUtc(2026, 10, 6, 0, 0, "Europe/Berlin"),
        allDay: true,
      }),
      "Europe/Berlin",
      "America/Los_Angeles",
    );
    expect.soft(moved.start).toBe(day("2026-10-05").getTime());
    expect.soft(minutesOfDay(new Date(moved.start))).toBe(0);
    expect.soft(dayKey(new Date(moved.end - 1))).toBe("2026-10-05");
  });

  it("keeps every day of a span across this zone's own transition", () => {
    // Los Angeles goes back on 1 November 2026, so 31 October to 2 November
    // inclusive is 73 hours here — and a span rebuilt as `n × 1440` minutes
    // would end at 23:00 on the last evening, which an exclusive `end` then
    // drops off the dial.
    const moved = movedEvent(
      event({
        start: zonedToUtc(2026, 10, 31, 0, 0, "Europe/Berlin"),
        end: zonedToUtc(2026, 11, 3, 0, 0, "Europe/Berlin"),
        allDay: true,
      }),
      "Europe/Berlin",
      "America/Los_Angeles",
    );
    expect.soft(moved.start).toBe(day("2026-10-31").getTime());
    expect.soft(moved.end).toBe(day("2026-11-03").getTime());
    expect.soft(moved.end - moved.start).toBe(73 * 3_600_000);
    expect.soft(dayKey(new Date(moved.end - 1))).toBe("2026-11-02");
  });

  it("stamps a timed event and leaves an all-day one floating, west of UTC too", () => {
    const timed = event({ start: zonedToUtc(2026, 7, 15, 9, 0, "Europe/Berlin") });
    const allDay = event({
      start: zonedToUtc(2026, 10, 5, 0, 0, "Europe/Berlin"),
      end: zonedToUtc(2026, 10, 6, 0, 0, "Europe/Berlin"),
      allDay: true,
    });
    const kept = keptEvents([timed, allDay], "Europe/Berlin", "America/Los_Angeles");
    expect.soft(kept[0].tzid).toBe("Europe/Berlin");
    expect.soft(kept[0].start).toBe(timed.start);
    expect.soft(kept[1].tzid).toBe("");
    expect.soft(kept[1].start).toBe(day("2026-10-05").getTime());
  });
});
