/* ------------------------------------------------------------------ *
 * `src/lib/recur.ts` — RFC 5545 §3.3.10 recurrence, generated from scratch.
 *
 * The first table transcribes RFC 5545 §3.8.5.3's own worked examples
 * verbatim: every RRULE the RFC spells out, fed through `startsBetween`
 * with a window standing in for COUNT/UNTIL, checked against the RFC's own
 * printed date list. If this table is green, the module's header claim
 * ("verified against every one of them") is no longer a claim.
 * ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  countedUntil,
  instantKey,
  keyToInstant,
  recurrenceOf,
  repeats,
  splitRule,
  startsBetween,
  type Recurrence,
} from "@/lib/recur";
import { at, byDay, ms, rule } from "./helpers";

/* ------------------------ RFC 5545 §3.8.5.3, day-level ------------------------ */

interface RfcCase {
  name: string;
  seed: string;
  /** Window end, exclusive — stands in for the RFC's COUNT/UNTIL. */
  to: string;
  from?: string;
  /** This rule's own `until`, as opposed to the window bound above. */
  until?: string;
  overrides: Partial<Recurrence>;
  expected: string[];
}

const rfcCases: RfcCase[] = [
  {
    name: "FREQ=DAILY;COUNT=10",
    seed: "1997-09-02 09:00",
    to: "1997-09-12",
    overrides: { repeat: "daily" },
    expected: [
      "1997-09-02",
      "1997-09-03",
      "1997-09-04",
      "1997-09-05",
      "1997-09-06",
      "1997-09-07",
      "1997-09-08",
      "1997-09-09",
      "1997-09-10",
      "1997-09-11",
    ],
  },
  {
    name: "FREQ=DAILY;INTERVAL=2 (every other day)",
    seed: "1997-09-02 09:00",
    to: "1997-09-11",
    overrides: { repeat: "daily", interval: 2 },
    expected: ["1997-09-02", "1997-09-04", "1997-09-06", "1997-09-08", "1997-09-10"],
  },
  {
    name: "FREQ=DAILY;INTERVAL=10;COUNT=5",
    seed: "1997-09-02 09:00",
    to: "1997-10-13",
    overrides: { repeat: "daily", interval: 10 },
    expected: ["1997-09-02", "1997-09-12", "1997-09-22", "1997-10-02", "1997-10-12"],
  },
  {
    name: "FREQ=WEEKLY;COUNT=10",
    seed: "1997-09-02 09:00",
    to: "1997-11-05",
    overrides: { repeat: "weekly" },
    expected: [
      "1997-09-02",
      "1997-09-09",
      "1997-09-16",
      "1997-09-23",
      "1997-09-30",
      "1997-10-07",
      "1997-10-14",
      "1997-10-21",
      "1997-10-28",
      "1997-11-04",
    ],
  },
  {
    // WKST changes what "every other week" means; this is the RFC's own reason for
    // documenting it at all.
    name: "FREQ=WEEKLY;INTERVAL=2;WKST=SU",
    seed: "1997-09-02 09:00",
    to: "1997-11-01",
    overrides: { repeat: "weekly", interval: 2, wkst: 0 },
    expected: ["1997-09-02", "1997-09-16", "1997-09-30", "1997-10-14", "1997-10-28"],
  },
  {
    name: "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10",
    seed: "1997-09-02 09:00",
    to: "1997-10-03",
    overrides: { repeat: "weekly", byDay: byDay("TU,TH") },
    expected: [
      "1997-09-02",
      "1997-09-04",
      "1997-09-09",
      "1997-09-11",
      "1997-09-16",
      "1997-09-18",
      "1997-09-23",
      "1997-09-25",
      "1997-09-30",
      "1997-10-02",
    ],
  },
  {
    name: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=SU;UNTIL=19971224T000000Z",
    seed: "1997-09-01 09:00",
    to: "1998-01-01",
    until: "1997-12-23",
    overrides: { repeat: "weekly", interval: 2, wkst: 0, byDay: byDay("MO,WE,FR") },
    expected: [
      "1997-09-01",
      "1997-09-03",
      "1997-09-05",
      "1997-09-15",
      "1997-09-17",
      "1997-09-19",
      "1997-09-29",
      "1997-10-01",
      "1997-10-03",
      "1997-10-13",
      "1997-10-15",
      "1997-10-17",
      "1997-10-27",
      "1997-10-29",
      "1997-10-31",
      "1997-11-10",
      "1997-11-12",
      "1997-11-14",
      "1997-11-24",
      "1997-11-26",
      "1997-11-28",
      "1997-12-08",
      "1997-12-10",
      "1997-12-12",
      "1997-12-22",
    ],
  },
  {
    name: "FREQ=MONTHLY;BYDAY=1FR;COUNT=10",
    seed: "1997-09-05 09:00",
    to: "1998-06-06",
    overrides: { repeat: "monthly", byDay: byDay("1FR") },
    expected: [
      "1997-09-05",
      "1997-10-03",
      "1997-11-07",
      "1997-12-05",
      "1998-01-02",
      "1998-02-06",
      "1998-03-06",
      "1998-04-03",
      "1998-05-01",
      "1998-06-05",
    ],
  },
  {
    name: "FREQ=MONTHLY;BYDAY=-1SU",
    seed: "1997-09-07 09:00",
    to: "1998-03-30",
    overrides: { repeat: "monthly", byDay: byDay("-1SU") },
    expected: [
      "1997-09-28",
      "1997-10-26",
      "1997-11-30",
      "1997-12-28",
      "1998-01-25",
      "1998-02-22",
      "1998-03-29",
    ],
  },
  {
    name: "FREQ=MONTHLY;INTERVAL=2;BYDAY=1SU,-1SU;COUNT=10",
    seed: "1997-09-07 09:00",
    to: "1998-06-01",
    overrides: { repeat: "monthly", interval: 2, byDay: byDay("1SU,-1SU") },
    expected: [
      "1997-09-07",
      "1997-09-28",
      "1997-11-02",
      "1997-11-30",
      "1998-01-04",
      "1998-01-25",
      "1998-03-01",
      "1998-03-29",
      "1998-05-03",
      "1998-05-31",
    ],
  },
  {
    name: "FREQ=MONTHLY;BYMONTHDAY=-3 (third-to-last day)",
    seed: "1997-09-28 09:00",
    to: "1998-03-01",
    overrides: { repeat: "monthly", byMonthDay: [-3] },
    expected: ["1997-09-28", "1997-10-29", "1997-11-28", "1997-12-29", "1998-01-29", "1998-02-26"],
  },
  {
    name: "FREQ=MONTHLY;BYMONTHDAY=2,15;COUNT=10",
    seed: "1997-09-02 09:00",
    to: "1998-01-16",
    overrides: { repeat: "monthly", byMonthDay: [2, 15] },
    expected: [
      "1997-09-02",
      "1997-09-15",
      "1997-10-02",
      "1997-10-15",
      "1997-11-02",
      "1997-11-15",
      "1997-12-02",
      "1997-12-15",
      "1998-01-02",
      "1998-01-15",
    ],
  },
  {
    // BYMONTHDAY=-1, across September (30) → October (31) → November (30) → ... :
    // the negative form tracks each month's real length, unlike a rule seeded on 31.
    name: "FREQ=MONTHLY;BYMONTHDAY=1,-1;COUNT=10",
    seed: "1997-09-30 09:00",
    to: "1998-02-02",
    overrides: { repeat: "monthly", byMonthDay: [1, -1] },
    expected: [
      "1997-09-30",
      "1997-10-01",
      "1997-10-31",
      "1997-11-01",
      "1997-11-30",
      "1997-12-01",
      "1997-12-31",
      "1998-01-01",
      "1998-01-31",
      "1998-02-01",
    ],
  },
  {
    // The seed (1997-09-02, a Tuesday) never satisfies BYDAY=FR;BYMONTHDAY=13, so
    // unlike the RFC's own text this needs no EXDATE to keep it out of the set.
    name: "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13 (Friday the 13th)",
    seed: "1997-09-02 09:00",
    to: "1998-11-14",
    overrides: { repeat: "monthly", byDay: byDay("FR"), byMonthDay: [13] },
    expected: ["1998-02-13", "1998-03-13", "1998-11-13"],
  },
  {
    name: "FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13 (1st Sat after 1st Sun)",
    seed: "1997-09-13 09:00",
    to: "1998-06-14",
    overrides: { repeat: "monthly", byDay: byDay("SA"), byMonthDay: [7, 8, 9, 10, 11, 12, 13] },
    expected: [
      "1997-09-13",
      "1997-10-11",
      "1997-11-08",
      "1997-12-13",
      "1998-01-10",
      "1998-02-07",
      "1998-03-07",
      "1998-04-11",
      "1998-05-09",
      "1998-06-13",
    ],
  },
  {
    name: "FREQ=YEARLY;BYMONTH=6,7;COUNT=10",
    seed: "1997-06-10 09:00",
    to: "2001-07-11",
    overrides: { repeat: "yearly", byMonth: [6, 7] },
    expected: [
      "1997-06-10",
      "1997-07-10",
      "1998-06-10",
      "1998-07-10",
      "1999-06-10",
      "1999-07-10",
      "2000-06-10",
      "2000-07-10",
      "2001-06-10",
      "2001-07-10",
    ],
  },
  {
    name: "FREQ=YEARLY;INTERVAL=2;BYMONTH=1,2,3;COUNT=10",
    seed: "1997-03-10 09:00",
    to: "2003-03-11",
    overrides: { repeat: "yearly", interval: 2, byMonth: [1, 2, 3] },
    expected: [
      "1997-03-10",
      "1999-01-10",
      "1999-02-10",
      "1999-03-10",
      "2001-01-10",
      "2001-02-10",
      "2001-03-10",
      "2003-01-10",
      "2003-02-10",
      "2003-03-10",
    ],
  },
  {
    // Also the leap-year case for BYYEARDAY: day 100/200 of 2000 land one day earlier
    // than in 1997/2003, because 2000's Feb 29 shifts everything after it.
    name: "FREQ=YEARLY;INTERVAL=3;BYYEARDAY=1,100,200;COUNT=10",
    seed: "1997-01-01 09:00",
    to: "2006-01-02",
    overrides: { repeat: "yearly", interval: 3, byYearDay: [1, 100, 200] },
    expected: [
      "1997-01-01",
      "1997-04-10",
      "1997-07-19",
      "2000-01-01",
      "2000-04-09",
      "2000-07-18",
      "2003-01-01",
      "2003-04-10",
      "2003-07-19",
      "2006-01-01",
    ],
  },
  {
    name: "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
    seed: "1997-05-12 09:00",
    to: "2000-01-01",
    overrides: { repeat: "yearly", byWeekNo: [20], byDay: byDay("MO") },
    expected: ["1997-05-12", "1998-05-11", "1999-05-17"],
  },
  {
    name: "FREQ=YEARLY;BYDAY=20MO",
    seed: "1997-05-19 09:00",
    to: "2000-01-01",
    overrides: { repeat: "yearly", byDay: byDay("20MO") },
    expected: ["1997-05-19", "1998-05-18", "1999-05-17"],
  },
  {
    name: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1 (last workday)",
    seed: "1997-09-01 09:00",
    to: "1998-01-01",
    overrides: { repeat: "monthly", byDay: byDay("MO,TU,WE,TH,FR"), bySetPos: [-1] },
    expected: ["1997-09-30", "1997-10-31", "1997-11-28", "1997-12-31"],
  },
  {
    name: "FREQ=MONTHLY;BYDAY=TU,WE,TH;BYSETPOS=3;COUNT=3 (3rd instance)",
    seed: "1997-09-04 09:00",
    to: "1997-12-01",
    overrides: { repeat: "monthly", byDay: byDay("TU,WE,TH"), bySetPos: [3] },
    expected: ["1997-09-04", "1997-10-07", "1997-11-06"],
  },
];

describe("RFC 5545 §3.8.5.3 worked examples", () => {
  it.each(rfcCases)("$name", ({ seed, from, to, until, overrides, expected }) => {
    const seedMs = ms(seed);
    const r = rule({ ...overrides, until: until ? ms(until) : 0 });
    const result = startsBetween(r, seedMs, from ? ms(from) : seedMs, ms(to));
    expect.soft(result).toOccurOn(expected);
  });
});

/* ---------------------- RFC 5545 §3.8.5.3, sub-daily ---------------------- */

interface SubDailyCase {
  name: string;
  seed: string;
  to: string;
  overrides: Partial<Recurrence>;
  expected: string[];
}

const subDailyCases: SubDailyCase[] = [
  {
    name: "FREQ=HOURLY;INTERVAL=3 (9AM–5PM)",
    seed: "1997-09-02 09:00",
    to: "1997-09-02 18:00",
    overrides: { repeat: "hourly", interval: 3 },
    expected: ["1997-09-02 09:00", "1997-09-02 12:00", "1997-09-02 15:00"],
  },
  {
    name: "FREQ=MINUTELY;INTERVAL=15;COUNT=6",
    seed: "1997-09-02 09:00",
    to: "1997-09-02 10:16",
    overrides: { repeat: "minutely", interval: 15 },
    expected: [
      "1997-09-02 09:00",
      "1997-09-02 09:15",
      "1997-09-02 09:30",
      "1997-09-02 09:45",
      "1997-09-02 10:00",
      "1997-09-02 10:15",
    ],
  },
  {
    name: "FREQ=MINUTELY;INTERVAL=90;COUNT=4",
    seed: "1997-09-02 09:00",
    to: "1997-09-02 13:31",
    overrides: { repeat: "minutely", interval: 90 },
    expected: ["1997-09-02 09:00", "1997-09-02 10:30", "1997-09-02 12:00", "1997-09-02 13:30"],
  },
];

describe("RFC 5545 §3.8.5.3 worked examples — sub-daily", () => {
  it.each(subDailyCases)("$name", ({ seed, to, overrides, expected }) => {
    const seedMs = ms(seed);
    const result = startsBetween(rule(overrides), seedMs, seedMs, ms(to));
    expect.soft(result).toBeInstants(expected);
  });
});

/* ---------------------------------- interval ---------------------------------- */

describe("interval", () => {
  it("0 is floored to 1 by Math.max(1, ...) — a rule can't fire less than every period", () => {
    const seed = ms("2026-01-01 09:00");
    const zero = startsBetween(
      rule({ repeat: "daily", interval: 0 }),
      seed,
      seed,
      ms("2026-01-06"),
    );
    const one = startsBetween(rule({ repeat: "daily", interval: 1 }), seed, seed, ms("2026-01-06"));
    expect(zero).toBeInstants(one);
  });

  it("a fractional interval truncates toward zero, not the nearest integer", () => {
    // Math.trunc(1.9) === 1: daily, not every-other-day (which Math.round(1.9) would give).
    const seed = ms("2026-01-01 09:00");
    const result = startsBetween(
      rule({ repeat: "daily", interval: 1.9 }),
      seed,
      seed,
      ms("2026-01-06"),
    );
    expect(result).toOccurOn([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
  });
});

/* ----------------------------------- until ------------------------------------ */

describe("until", () => {
  it("is inclusive of an occurrence starting exactly on it", () => {
    const seed = ms("2026-01-01 09:00");
    const second = ms("2026-01-02 09:00");
    const r = rule({ repeat: "daily", until: second });
    expect(startsBetween(r, seed, seed, ms("2026-01-10"))).toBeInstants([
      "2026-01-01 09:00",
      "2026-01-02 09:00",
    ]);
  });

  it("excludes an occurrence starting one millisecond after it", () => {
    const seed = ms("2026-01-01 09:00");
    const second = ms("2026-01-02 09:00");
    const r = rule({ repeat: "daily", until: second - 1 });
    expect(startsBetween(r, seed, seed, ms("2026-01-10"))).toBeInstants(["2026-01-01 09:00"]);
  });
});

/* ------------------------------- countedUntil ---------------------------------- */

describe("countedUntil — the COUNT→until walk", () => {
  it("walks period by period to the nth occurrence's own start", () => {
    const seed = ms("2026-01-01 09:00");
    const until = countedUntil(rule({ repeat: "daily" }), seed, 5);
    expect(until).toBeSameInstantAs("2026-01-05 09:00");
  });

  it("agrees with the RFC's own BYDAY=1FR;COUNT=10 walk", () => {
    const seed = ms("1997-09-05 09:00");
    const until = countedUntil(rule({ repeat: "monthly", byDay: byDay("1FR") }), seed, 10);
    expect(until).toBeSameInstantAs("1998-06-05 09:00");
  });

  it("counts by the rule, before EXDATE — an excluded day still spends one of the count", () => {
    const seed = ms("2026-01-01 09:00");
    const bare = rule({ repeat: "daily" });
    const withExdate = rule({ repeat: "daily", exdates: ["2026-01-03"] });

    // The walk never looks at exdates, so both land on the same 5th-by-the-rule instant.
    const untilBare = countedUntil(bare, seed, 5);
    const untilExcluded = countedUntil(withExdate, seed, 5);
    expect.soft(untilExcluded).toBe(untilBare);

    // Applying that boundary to the excluding rule then surfaces only 4 occurrences —
    // the excluded day was counted, not skipped-and-replaced by a 5th.
    const visible = startsBetween(
      rule({ ...withExdate, until: untilExcluded! }),
      seed,
      seed,
      ms("2026-01-10"),
    );
    expect.soft(visible).toOccurOn(["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"]);
  });

  it.each([
    { name: "repeat: never", repeat: "never" as const, count: 5 },
    { name: "count below 1 (zero)", repeat: "daily" as const, count: 0 },
    { name: "count below 1 (negative)", repeat: "daily" as const, count: -3 },
    { name: "count past WALK_CAP", repeat: "daily" as const, count: 2001 },
  ])("returns null for $name", ({ repeat, count }) => {
    expect(countedUntil(rule({ repeat }), ms("2026-01-01 09:00"), count)).toBeNull();
  });

  it("sub-daily rules walk a day at a time and still land on the right instant", () => {
    const seed = ms("1997-09-02 09:00");
    const until = countedUntil(rule({ repeat: "minutely", interval: 15 }), seed, 6);
    expect(until).toBeSameInstantAs("1997-09-02 10:15");
  });
});

/* ------------------------------- EXDATE / RDATE -------------------------------- */

describe("EXDATE and RDATE", () => {
  it("a bare-day EXDATE resolves against the seed's time of day and removes the whole day", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({ repeat: "daily", exdates: ["2026-01-03"] });
    const result = startsBetween(r, seed, seed, ms("2026-01-06"));
    expect(result).toOccurOn(["2026-01-01", "2026-01-02", "2026-01-04", "2026-01-05"]);
  });

  it("an instant-keyed EXDATE removes only that instant, not the day's other occurrences", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({
      repeat: "daily",
      byHour: [9, 15],
      exdates: [instantKey(ms("2026-01-01 09:00"))],
    });
    const result = startsBetween(r, seed, seed, ms("2026-01-03"));
    expect(result).toBeInstants(["2026-01-01 15:00", "2026-01-02 09:00", "2026-01-02 15:00"]);
  });

  it("a bare-day RDATE resolves against the seed's time of day", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({ repeat: "never", rdates: ["2026-05-10"] });
    const result = startsBetween(r, seed, seed, ms("2026-06-01"));
    expect(result).toBeInstants(["2026-01-01 09:00", "2026-05-10 09:00"]);
  });

  it("an instant-keyed RDATE keeps its own time of day, ignoring the seed's", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({ repeat: "never", rdates: ["2026-05-10T14:30:00"] });
    const result = startsBetween(r, seed, seed, ms("2026-06-01"));
    expect(result).toBeInstants(["2026-01-01 09:00", "2026-05-10 14:30"]);
  });

  it("an RDATE past UNTIL is kept — it was named explicitly, it is not the rule running on", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({ repeat: "daily", until: ms("2026-01-04 09:00"), rdates: ["2026-03-01"] });
    const result = startsBetween(r, seed, seed, ms("2026-03-02"));
    expect(result).toOccurOn([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-03-01",
    ]);
  });

  it("EXDATE subtracts last — from the seed and from RDATEs alike", () => {
    const seed = ms("2026-01-01 09:00");
    const r = rule({
      repeat: "never",
      rdates: ["2026-06-01"],
      exdates: ["2026-01-01", "2026-06-01"],
    });
    const result = startsBetween(r, seed, seed, ms("2026-07-01"));
    expect(result).toEqual([]);
  });
});

/* ------------------------------------ the seed ---------------------------------- */

describe("the seed", () => {
  it.each([
    { name: "in window", from: "2026-01-01", to: "2026-01-02", expectSeed: true },
    {
      name: "window opens after the seed",
      from: "2026-01-02",
      to: "2026-01-03",
      expectSeed: false,
    },
    {
      name: "window closes before the seed",
      from: "2025-12-01",
      to: "2026-01-01",
      expectSeed: false,
    },
  ])("repeat: never, $name", ({ from, to, expectSeed }) => {
    const seed = ms("2026-01-01 09:00");
    const result = startsBetween(rule({ repeat: "never" }), seed, ms(from), ms(to));
    expect(result).toBeInstants(expectSeed ? [seed] : []);
  });

  it("a rule that contradicts its own seed's weekday never fires on the seed's day", () => {
    // 2026-04-01 is a Wednesday; the rule only ever generates Tuesdays. The
    // Tuesday before the seed is filtered as before-the-seed, but the seed's own
    // Wednesday was never a candidate at all — an editor can write this
    // contradiction, and the event must still leave the day it's on.
    const seed = ms("2026-04-01 09:00");
    const r = rule({ repeat: "weekly", byDay: byDay("TU") });
    const result = startsBetween(r, seed, seed, ms("2026-04-08 09:00"));
    expect(result).toOccurOn(["2026-04-07"]);
  });

  it("a rule synchronised with its seed's weekday does generate the seed", () => {
    const seed = ms("2026-04-01 09:00"); // Wednesday
    const r = rule({ repeat: "weekly", byDay: byDay("WE") });
    const result = startsBetween(r, seed, seed, ms("2026-04-08 09:00"));
    expect(result).toOccurOn(["2026-04-01"]);
  });
});

/* ------------------------------ sub-daily / MAX_INSTANTS ------------------------ */

describe("sub-daily rules and MAX_INSTANTS", () => {
  it("a SECONDLY rule over a day is capped at 512, not dropped — ordered, starting at the seed", () => {
    const seed = ms("2026-04-01 00:00:00");
    const result = startsBetween(rule({ repeat: "secondly" }), seed, seed, seed + 86_400_000);
    expect.soft(result).toHaveLength(512);
    expect.soft(result[0]).toBe(seed);
    for (let i = 1; i < result.length; i++) {
      expect.soft(result[i]).toBeGreaterThan(result[i - 1]);
    }
  });

  it("the cap is per call, not per rule — a wider window returns no more than one call's worth", () => {
    const seed = ms("2026-04-01 00:00:00");
    const r = rule({ repeat: "secondly" });
    const oneDay = startsBetween(r, seed, seed, seed + 86_400_000);
    const twoDays = startsBetween(r, seed, seed, seed + 2 * 86_400_000);
    expect.soft(oneDay).toHaveLength(512);
    expect.soft(twoDays).toHaveLength(512);
  });
});

/* ---------------------------------- window semantics ----------------------------- */

describe("window semantics", () => {
  it("from is inclusive, to is exclusive", () => {
    const seed = ms("2026-01-01 09:00");
    const second = ms("2026-01-02 09:00");
    const r = rule({ repeat: "daily" });
    expect.soft(startsBetween(r, seed, seed, second)).toBeInstants([seed]);
    expect.soft(startsBetween(r, seed, second, ms("2026-01-10"))[0]).toBe(second);
  });

  it("nothing before the seed is ever emitted, however early the window opens", () => {
    const seed = ms("2026-04-01 09:00"); // Wednesday, unfiltered weekly recurrence
    const r = rule({ repeat: "weekly" });
    const result = startsBetween(r, seed, seed - 30 * 86_400_000, seed + 8 * 86_400_000);
    expect(result).toBeInstants([seed, seed + 7 * 86_400_000]);
  });

  it("results are sorted and deduplicated — an RDATE colliding with a generated instant counts once", () => {
    const seed = ms("2026-01-01 09:00");
    const dayTwo = ms("2026-01-02 09:00");
    const r = rule({ repeat: "daily", rdates: [instantKey(dayTwo)] });
    const result = startsBetween(r, seed, seed, ms("2026-01-04"));
    expect(result).toOccurOn(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  it("an RDATE that doesn't collide is merged into ascending order, not appended", () => {
    const seed = ms("2026-01-01 09:00");
    const between = ms("2026-01-01 20:00");
    const r = rule({ repeat: "daily", rdates: [instantKey(between)] });
    const result = startsBetween(r, seed, seed, ms("2026-01-03"));
    expect(result).toBeInstants([seed, between, ms("2026-01-02 09:00")]);
  });
});

/* --------------------------------------- DST -------------------------------------- */

describe("DST — Europe/Berlin", () => {
  it("a daily 09:00 rule stays at 09:00 local across the spring-forward (2026-03-29)", () => {
    const seed = ms("2026-03-25 09:00");
    const result = startsBetween(rule({ repeat: "daily" }), seed, seed, ms("2026-04-02"));
    expect(result).toBeInstants([
      "2026-03-25 09:00",
      "2026-03-26 09:00",
      "2026-03-27 09:00",
      "2026-03-28 09:00",
      "2026-03-29 09:00",
      "2026-03-30 09:00",
      "2026-03-31 09:00",
      "2026-04-01 09:00",
    ]);
  });

  it("a daily 09:00 rule stays at 09:00 local across the fall-back (2026-10-25)", () => {
    const seed = ms("2026-10-22 09:00");
    const result = startsBetween(rule({ repeat: "daily" }), seed, seed, ms("2026-10-29"));
    expect(result).toBeInstants([
      "2026-10-22 09:00",
      "2026-10-23 09:00",
      "2026-10-24 09:00",
      "2026-10-25 09:00",
      "2026-10-26 09:00",
      "2026-10-27 09:00",
      "2026-10-28 09:00",
    ]);
  });
});

/* ----------------------------------- month-end rollover ---------------------------- */

describe("month-end rollover", () => {
  it("a monthly rule seeded on the 31st fires only in 31-day months — it never rolls to a shorter one's last day", () => {
    const seed = ms("2026-01-31 09:00");
    const result = startsBetween(rule({ repeat: "monthly" }), seed, seed, ms("2027-01-01"));
    expect(result).toOccurOn([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
    ]);
  });

  it("BYMONTHDAY=-1 tracks each month's true last day, including Feb 29 in a leap year", () => {
    const seed = ms("2028-01-15 09:00");
    const r = rule({ repeat: "monthly", byMonthDay: [-1] });
    const result = startsBetween(r, seed, seed, ms("2028-05-01"));
    expect(result).toOccurOn(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  });
});

describe("BYYEARDAY=-1 across a leap year", () => {
  it.each([
    { name: "leap year 2028", seed: "2028-01-01 09:00", from: "2028-12-01", to: "2029-01-01" },
    { name: "common year 2027", seed: "2027-01-01 09:00", from: "2027-12-01", to: "2028-01-01" },
  ])("$name: lands on Dec 31, not Dec 30", ({ seed, from, to }) => {
    const r = rule({ repeat: "yearly", byYearDay: [-1] });
    const result = startsBetween(r, ms(seed), ms(from), ms(to));
    expect(result).toOccurOn([`${from.slice(0, 4)}-12-31`]);
  });
});

/* ------------------------------- instantKey / keyToInstant ------------------------- */

describe("instantKey / keyToInstant", () => {
  it("round-trips a full instant regardless of which seed is passed in", () => {
    const d = at("2026-07-04 15:42:07");
    const key = instantKey(d);
    expect.soft(key).toBe("2026-07-04T15:42:07");
    const unrelatedSeed = at("1970-01-01 00:00:00");
    expect.soft(keyToInstant(key, unrelatedSeed)).toBe(d.getTime());
  });

  it("resolves a bare day against the seed's own time of day", () => {
    const seed = at("2026-01-01 08:15:30");
    expect(keyToInstant("2026-07-04", seed)).toBe(at("2026-07-04 08:15:30").getTime());
  });

  it("returns null for a key that isn't a date at all", () => {
    expect(keyToInstant("not-a-date", at("2026-01-01"))).toBeNull();
  });
});

/* ------------------------------------ recurrenceOf ---------------------------------- */

describe("recurrenceOf", () => {
  it("returns a deep copy — mutating the copy's arrays and byDay entries leaves the source untouched", () => {
    const source = rule({
      byDay: byDay("MO,WE"),
      byMonth: [1, 2],
      exdates: ["2026-01-01"],
    });
    const copy = recurrenceOf(source);
    copy.byDay[0].nth = 99;
    copy.byMonth.push(12);
    copy.exdates.push("2026-02-02");

    expect.soft(source.byDay[0].nth).toBe(0);
    expect.soft(source.byMonth).toEqual([1, 2]);
    expect.soft(source.exdates).toEqual(["2026-01-01"]);
  });
});

/* ---------------------------------------- repeats ------------------------------------ */

describe("repeats", () => {
  it.each([
    { name: "never, no rdates", repeat: "never" as const, rdates: [] as string[], expected: false },
    {
      name: "never, with rdates",
      repeat: "never" as const,
      rdates: ["2026-01-01"],
      expected: true,
    },
    { name: "daily", repeat: "daily" as const, rdates: [] as string[], expected: true },
  ])("$name → $expected", ({ repeat, rdates, expected }) => {
    expect(repeats(rule({ repeat, rdates }))).toBe(expected);
  });
});

/* ---------------------------------------- splitRule ---------------------------------- */

describe("splitRule", () => {
  const seed = ms("2026-01-05 09:00");
  const cut = ms("2026-01-19 09:00");

  it("stops the head the instant before the cut, so the two halves cover every day once", () => {
    const r = rule({ repeat: "daily" });
    const { head } = splitRule(r, seed, cut);
    const before = startsBetween({ ...r, ...head }, seed, seed, ms("2026-02-01"));
    const after = startsBetween(r, cut, cut, ms("2026-02-01"));
    expect
      .soft(before)
      .toOccurOn(Array.from({ length: 14 }, (_, i) => `2026-01-${String(5 + i).padStart(2, "0")}`));
    expect(after[0]).toBeSameInstantAs("2026-01-19 09:00");
  });

  it("keeps an existing UNTIL when it is already earlier — a split cannot extend a series", () => {
    const early = ms("2026-01-12 09:00");
    const { head } = splitRule(rule({ repeat: "weekly", until: early }), seed, cut);
    expect(head.until).toBe(early);
  });

  it("bounds an unbounded series rather than leaving it forever", () => {
    const { head } = splitRule(rule({ repeat: "weekly" }), seed, cut);
    expect(head.until).toBe(cut - 1);
  });

  it("moves a future RDATE to the tail — UNTIL does not bound one, so it would fire twice", () => {
    const r = rule({ repeat: "weekly", rdates: ["2026-01-07", "2026-03-01"] });
    const { head, tail } = splitRule(r, seed, cut);
    expect.soft(head.rdates).toEqual(["2026-01-07"]);
    expect.soft(tail.rdates).toEqual(["2026-03-01"]);
    // The proof rather than the field: the head must not still land in March.
    expect(startsBetween({ ...r, ...head }, seed, ms("2026-02-01"), ms("2026-04-01"))).toEqual([]);
  });

  it("carries a future EXDATE to the tail — a skipped day stays skipped", () => {
    const r = rule({ repeat: "daily", exdates: ["2026-01-06", "2026-01-26"] });
    const { head, tail } = splitRule(r, seed, cut);
    expect.soft(head.exdates).toEqual(["2026-01-06"]);
    expect.soft(tail.exdates).toEqual(["2026-01-26"]);
    // The whole tail, because `toOccurOn` compares the list positionally: a
    // negated one-day expectation would pass on any list of any other length.
    expect(startsBetween({ ...r, ...tail }, cut, cut, ms("2026-02-01"))).toOccurOn([
      "2026-01-19",
      "2026-01-20",
      "2026-01-21",
      "2026-01-22",
      "2026-01-23",
      "2026-01-24",
      "2026-01-25",
      "2026-01-27",
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
      "2026-01-31",
    ]);
  });

  it("splits an instant-keyed EXDATE by its own clock, not the seed's day", () => {
    const r = rule({
      repeat: "daily",
      byHour: [9, 15],
      exdates: [instantKey(ms("2026-01-19 08:00")), instantKey(ms("2026-01-19 15:00"))],
    });
    const { head, tail } = splitRule(r, seed, cut);
    expect.soft(head.exdates).toEqual([instantKey(ms("2026-01-19 08:00"))]);
    expect(tail.exdates).toEqual([instantKey(ms("2026-01-19 15:00"))]);
  });

  it("leaves a key it cannot spell with the head, where it is already inert", () => {
    const { head, tail } = splitRule(rule({ repeat: "daily", exdates: ["not-a-date"] }), seed, cut);
    expect.soft(head.exdates).toEqual(["not-a-date"]);
    expect(tail.exdates).toEqual([]);
  });
});
