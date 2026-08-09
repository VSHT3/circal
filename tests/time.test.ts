import { describe, expect, it } from "vitest";
import { at, day } from "./helpers";
import {
  addDays,
  addMonths,
  atMinutes,
  clamp,
  daysBetween,
  daysInMonth,
  dayKey,
  formatDayRange,
  formatDuration,
  formatOffset,
  formatRelativeDay,
  formatTime,
  formatTimeShort,
  fromDayKey,
  isSameDay,
  minutesOfDay,
  mondayOffset,
  parseClock,
  snap,
  splitTime,
  startOfDay,
  startOfWeek,
  zoneOffset,
  zonedToUtc,
} from "@/lib/time";

/** Minus sign in `formatOffset` is U+2212, not ASCII hyphen. */
const MINUS = "\u2212";

/* ---------------------------------- dayKey --------------------------------- */

describe("dayKey", () => {
  it("round-trips through fromDayKey to the same local midnight", () => {
    const d = at("2026-03-08 14:20");
    expect(fromDayKey(dayKey(d))).toBeSameInstantAs(day("2026-03-08"));
  });

  it("round-trips a leap day", () => {
    expect(fromDayKey(dayKey(at("2024-02-29 09:00")))).toBeSameInstantAs(day("2024-02-29"));
  });

  // The single most important invariant in the file: dayKey reads LOCAL
  // fields, toISOString reads UTC ones. Berlin is east of UTC, so right after
  // local midnight the UTC clock is still on the previous day — dayKey must
  // not agree with toISOString here, or the store keys events under the
  // wrong day for anyone not sitting on UTC.
  it("disagrees with toISOString for an instant just past local midnight", () => {
    const d = at("2026-03-08 00:30");
    expect(dayKey(d)).toBe("2026-03-08");
    expect(d.toISOString().slice(0, 10)).toBe("2026-03-07");
    expect(dayKey(d)).not.toBe(d.toISOString().slice(0, 10));
  });
});

/* ------------------------------- day arithmetic ----------------------------- */

describe("startOfDay", () => {
  it("zeroes the time but keeps the calendar date", () => {
    const out = startOfDay(at("2026-05-14 23:59:59"));
    expect(out).toBeSameInstantAs(day("2026-05-14"));
  });
});

describe("addDays across DST", () => {
  // Europe/Berlin: 2026-03-29 is the spring-forward day (02:00 -> 03:00).
  it("adds a calendar day, not 86_400_000ms, across spring-forward", () => {
    const before = at("2026-03-28 10:00");
    const after = addDays(before, 1);
    expect(after).toBeSameInstantAs("2026-03-29 10:00");
    expect(after.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  // 2026-10-25 is the fall-back day (03:00 -> 02:00).
  it("adds a calendar day, not 86_400_000ms, across fall-back", () => {
    const before = at("2026-10-24 10:00");
    const after = addDays(before, 1);
    expect(after).toBeSameInstantAs("2026-10-25 10:00");
    expect(after.getTime() - before.getTime()).toBe(25 * 3_600_000);
  });

  it("is symmetric going backwards across a transition", () => {
    const after = at("2026-03-29 10:00");
    expect(addDays(after, -1)).toBeSameInstantAs("2026-03-28 10:00");
  });

  it("adds exactly 24h on an ordinary day", () => {
    const before = at("2026-06-01 10:00");
    expect(addDays(before, 1).getTime() - before.getTime()).toBe(86_400_000);
  });
});

describe("mondayOffset / startOfWeek", () => {
  // 2026-08-09 is a Sunday, so it belongs to the week that began on the 3rd —
  // the trap a `getDay()`-based implementation falls into, since Sunday is 0
  // and a naive subtraction sends it forward six days instead of back one.
  it.each([
    { on: "2026-08-03", weekday: "Monday", offset: 0 },
    { on: "2026-08-06", weekday: "Thursday", offset: 3 },
    { on: "2026-08-09", weekday: "Sunday", offset: 6 },
  ])("$weekday is offset $offset and belongs to the week of Aug 3", ({ on, offset }) => {
    expect.soft(mondayOffset(day(on))).toBe(offset);
    expect.soft(startOfWeek(day(on))).toBeSameInstantAs(day("2026-08-03"));
  });

  // The life grid's columns are built on this: a year starts as many blank
  // slots in as its 1 January is deep into its own week.
  it.each([
    { name: "1 Jan 1990 is a Monday", date: day("1990-01-01"), want: 0 },
    { name: "1 Jan 2023 is a Sunday", date: day("2023-01-01"), want: 6 },
  ])("$name -> offset $want", ({ date, want }) => {
    expect(mondayOffset(date)).toBe(want);
  });

  it("takes a time of day down to the week's own midnight", () => {
    expect(startOfWeek(at("2026-08-09 23:59"))).toBeSameInstantAs(day("2026-08-03"));
  });

  it("is idempotent, and seven of them is one week back", () => {
    const monday = startOfWeek(day("2026-08-06"));
    expect(startOfWeek(monday)).toBeSameInstantAs(monday);
    expect(startOfWeek(addDays(monday, -1))).toBeSameInstantAs(addDays(monday, -7));
  });

  // Berlin springs forward on 2026-03-29, a Sunday — so the week containing it
  // is 167 hours long and a millisecond walk back lands at 01:00 on the 23rd.
  it("lands on local midnight through a spring-forward week", () => {
    const out = startOfWeek(day("2026-03-29"));
    expect(out).toBeSameInstantAs(day("2026-03-23"));
    expect(minutesOfDay(out)).toBe(0);
  });
});

describe("addMonths across a month end", () => {
  it("clamps Jan 31 + 1 month to Feb 28 in a non-leap year", () => {
    expect(addMonths(day("2026-01-31"), 1)).toBeSameInstantAs(day("2026-02-28"));
  });

  it("clamps Jan 31 + 1 month to Feb 29 in a leap year", () => {
    expect(addMonths(day("2024-01-31"), 1)).toBeSameInstantAs(day("2024-02-29"));
  });

  it("clamps going backwards across a shorter month", () => {
    expect(addMonths(day("2026-03-31"), -1)).toBeSameInstantAs(day("2026-02-28"));
  });

  it("n=0 is a no-op on a month-end date", () => {
    expect(addMonths(day("2026-05-31"), 0)).toBeSameInstantAs(day("2026-05-31"));
  });
});

describe("daysInMonth", () => {
  it.each([
    { name: "Feb 2024 (div-4 leap)", year: 2024, month: 1, expected: 29 },
    { name: "Feb 2000 (div-400 leap)", year: 2000, month: 1, expected: 29 },
    { name: "Feb 1900 (div-100, not leap)", year: 1900, month: 1, expected: 28 },
    { name: "Feb 2100 (div-100, not leap)", year: 2100, month: 1, expected: 28 },
    { name: "Feb 2026 (ordinary)", year: 2026, month: 1, expected: 28 },
    { name: "Jan 2026 (31-day month)", year: 2026, month: 0, expected: 31 },
  ])("$name", ({ year, month, expected }) => {
    expect.soft(daysInMonth(year, month)).toBe(expected);
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days across spring-forward, unaffected by the missing hour", () => {
    expect(daysBetween(day("2026-03-28"), day("2026-03-30"))).toBe(2);
  });

  it("counts whole calendar days across fall-back, unaffected by the extra hour", () => {
    expect(daysBetween(day("2026-10-24"), day("2026-10-26"))).toBe(2);
  });

  it("is zero for the same day regardless of time of day", () => {
    expect(daysBetween(at("2026-06-01 00:01"), at("2026-06-01 23:59"))).toBe(0);
  });

  it("is negative for a date going backwards", () => {
    expect(daysBetween(day("2026-06-10"), day("2026-06-05"))).toBe(-5);
  });

  it("counts a single calendar day between 23:59 and the next day's 00:01", () => {
    expect(daysBetween(at("2026-06-01 23:59"), at("2026-06-02 00:01"))).toBe(1);
  });
});

describe("isSameDay", () => {
  it("is true for the same date at different times", () => {
    expect(isSameDay(at("2026-06-01 00:01"), at("2026-06-01 23:59"))).toBe(true);
  });

  it("is false across a midnight boundary one minute apart", () => {
    expect(isSameDay(at("2026-06-01 23:59"), at("2026-06-02 00:00"))).toBe(false);
  });
});

describe("minutesOfDay / atMinutes round-trip", () => {
  it.each([
    { name: "midnight", minutes: 0 },
    { name: "one minute past midnight", minutes: 1 },
    { name: "just before noon", minutes: 719 },
    { name: "noon", minutes: 720 },
    { name: "one minute before midnight", minutes: 1439 },
  ])("$name ($minutes)", ({ minutes }) => {
    const d = atMinutes(day("2026-06-15"), minutes);
    expect.soft(minutesOfDay(d)).toBe(minutes);
  });

  it("overflows into the next day rather than clamping — callers must clamp themselves", () => {
    const d = atMinutes(day("2026-06-15"), 1500);
    expect(d).toBeSameInstantAs("2026-06-16 01:00");
  });
});

/* --------------------------------- parseClock ------------------------------- */

describe("parseClock", () => {
  it.each([
    { name: "12-hour with space and caps", input: "10:45 AM", expected: 645 },
    { name: "12-hour lowercase no space", input: "10:45am", expected: 645 },
    { name: "bare digits, no colon", input: "1045", expected: 645 },
    { name: "hour + terse meridiem letter", input: "9p", expected: 21 * 60 },
    { name: "24-hour with colon", input: "13:00", expected: 13 * 60 },
    { name: "midnight, 24-hour", input: "00:00", expected: 0 },
    { name: "12am is midnight", input: "12am", expected: 0 },
    { name: "12pm is noon", input: "12pm", expected: 720 },
  ])("$name: $input -> $expected", ({ input, expected }) => {
    expect.soft(parseClock(input)).toBe(expected);
  });

  it.each([
    { name: "empty string", input: "" },
    { name: "not a time at all", input: "abc" },
    // 24:00 has no meridiem and hours > 23 are rejected — unlike ISO, this
    // parser has no "end of day" spelling.
    { name: "24:00 has no meridiem to save it", input: "24:00" },
    { name: "hour out of range, no meridiem", input: "25:00" },
    { name: "minutes out of range", input: "10:75" },
  ])("rejects $name", ({ input }) => {
    expect.soft(parseClock(input)).toBeNull();
  });
});

/* ----------------------------- formatTime / splitTime ------------------------ */

describe("formatTime / formatTimeShort / splitTime", () => {
  it.each([
    {
      name: "midnight, 12h",
      stamp: "2026-01-01 00:00",
      clock: "12h" as const,
      expected: "12:00 AM",
    },
    { name: "noon, 12h", stamp: "2026-01-01 12:00", clock: "12h" as const, expected: "12:00 PM" },
    {
      name: "one minute after midnight, 12h",
      stamp: "2026-01-01 00:01",
      clock: "12h" as const,
      expected: "12:01 AM",
    },
    {
      name: "one minute after noon, 12h",
      stamp: "2026-01-01 12:01",
      clock: "12h" as const,
      expected: "12:01 PM",
    },
    { name: "midnight, 24h", stamp: "2026-01-01 00:00", clock: "24h" as const, expected: "00:00" },
    { name: "noon, 24h", stamp: "2026-01-01 12:00", clock: "24h" as const, expected: "12:00" },
    { name: "evening, 24h", stamp: "2026-01-01 21:15", clock: "24h" as const, expected: "21:15" },
  ])("$name", ({ stamp, clock, expected }) => {
    expect.soft(formatTime(at(stamp), clock)).toBe(expected);
  });

  it.each([
    {
      name: "midnight drops :00, 12h",
      stamp: "2026-01-01 00:00",
      clock: "12h" as const,
      expected: "12 AM",
    },
    {
      name: "noon drops :00, 12h",
      stamp: "2026-01-01 12:00",
      clock: "12h" as const,
      expected: "12 PM",
    },
    {
      name: "on the hour drops :00, 12h",
      stamp: "2026-01-01 13:00",
      clock: "12h" as const,
      expected: "1 PM",
    },
    {
      name: "off the hour keeps minutes, 12h",
      stamp: "2026-01-01 13:05",
      clock: "12h" as const,
      expected: "1:05 PM",
    },
    // 24h clock never drops minutes — a bare "13" wouldn't read as a time.
    {
      name: "on the hour keeps :00, 24h",
      stamp: "2026-01-01 13:00",
      clock: "24h" as const,
      expected: "13:00",
    },
  ])("$name", ({ stamp, clock, expected }) => {
    expect.soft(formatTimeShort(at(stamp), clock)).toBe(expected);
  });

  it("splitTime separates the AM/PM suffix so the caller can style it", () => {
    expect(splitTime(at("2026-01-01 00:00"), "12h")).toEqual({ time: "12:00", suffix: "AM" });
    expect(splitTime(at("2026-01-01 12:00"), "12h")).toEqual({ time: "12:00", suffix: "PM" });
    expect(splitTime(at("2026-01-01 07:05"), "24h")).toEqual({ time: "07:05", suffix: "" });
  });
});

describe("formatDuration", () => {
  it.each([
    { name: "zero", minutes: 0, expected: "0m" },
    { name: "just under an hour", minutes: 59, expected: "59m" },
    { name: "exactly an hour", minutes: 60, expected: "1h" },
    { name: "hour and a half", minutes: 90, expected: "1h 30m" },
    { name: "a full day", minutes: 1440, expected: "24h" },
    { name: "a multi-day span", minutes: 2880, expected: "48h" },
  ])("$name ($minutes min) -> $expected", ({ minutes, expected }) => {
    expect.soft(formatDuration(minutes)).toBe(expected);
  });
});

describe("formatRelativeDay", () => {
  const today = at("2026-06-15 09:00");

  it.each([
    { name: "today", stamp: "2026-06-15 22:00", expected: "Today" },
    { name: "tomorrow", stamp: "2026-06-16 00:30", expected: "Tomorrow" },
    { name: "yesterday", stamp: "2026-06-14 23:30", expected: "Yesterday" },
    { name: "far in the future", stamp: "2026-08-12 10:00", expected: "Aug 12" },
    { name: "far in the past", stamp: "2026-01-03 10:00", expected: "Jan 3" },
  ])("$name", ({ stamp, expected }) => {
    expect.soft(formatRelativeDay(at(stamp), today)).toBe(expected);
  });
});

describe("formatDayRange", () => {
  it.each([
    {
      name: "names the month once when both ends share it",
      from: "2026-08-08",
      to: "2026-08-14",
      expected: "8 – 14 Aug",
    },
    {
      name: "names both months when the range crosses one",
      from: "2026-08-28",
      to: "2026-09-03",
      expected: "28 Aug – 3 Sep",
    },
    {
      name: "a single day is still a range, printed once",
      from: "2026-08-08",
      to: "2026-08-08",
      expected: "8 – 8 Aug",
    },
    // The year ring clamps a drag inside one year, so this is the shape the
    // formatter has to be honest about rather than the one it is asked for.
    {
      name: "names both years when the range crosses one",
      from: "2026-12-28",
      to: "2027-01-03",
      expected: "28 Dec 2026 – 3 Jan 2027",
    },
  ])("$name", ({ from, to, expected }) => {
    expect.soft(formatDayRange(day(from), day(to))).toBe(expected);
  });

  // The readout prints the length beside the range, and the two must agree:
  // both ends are inclusive, so a Sunday-to-Saturday drag is seven days and
  // not six. This is the arithmetic the year view does on `daysBetween`.
  it("is inclusive of both ends, as the day count beside it assumes", () => {
    expect(daysBetween(day("2026-08-08"), day("2026-08-14")) + 1).toBe(7);
  });
});

/* -------------------------------- snap / clamp ------------------------------- */

describe("snap", () => {
  it("rounds to the nearest 15 by default", () => {
    expect(snap(22)).toBe(15);
    expect(snap(23)).toBe(30);
  });

  it("honours a custom step", () => {
    expect(snap(50, 30)).toBe(60);
    expect(snap(44, 30)).toBe(30);
  });
});

describe("clamp", () => {
  it.each([
    { name: "within range", v: 5, lo: 0, hi: 10, expected: 5 },
    { name: "below range", v: -5, lo: 0, hi: 10, expected: 0 },
    { name: "above range", v: 15, lo: 0, hi: 10, expected: 10 },
    { name: "on the boundary", v: 10, lo: 0, hi: 10, expected: 10 },
  ])("$name", ({ v, lo, hi, expected }) => {
    expect.soft(clamp(v, lo, hi)).toBe(expected);
  });
});

/* -------------------------------- time zones --------------------------------- */

describe("zoneOffset", () => {
  it("is a fixed half-hour offset year-round for a zone with no DST", () => {
    expect(zoneOffset(at("2026-01-15 12:00"), "Asia/Kolkata")).toBe(330);
    expect(zoneOffset(at("2026-07-15 12:00"), "Asia/Kolkata")).toBe(330);
  });

  // Southern-hemisphere DST runs opposite Europe's: on 2026-07-15 Berlin is
  // in summer time (+120) while Sydney is in its winter, DST off (+600).
  it("disagrees with Berlin's DST state in July, opposite hemispheres", () => {
    const midJuly = at("2026-07-15 12:00");
    expect(zoneOffset(midJuly, "Europe/Berlin")).toBe(120);
    expect(zoneOffset(midJuly, "Australia/Sydney")).toBe(600);
  });
});

describe("zonedToUtc", () => {
  /** Independent check: format the produced instant back in `zone` and
   *  compare wall-clock fields, without going through the module under test. */
  function wallClockIn(instant: number, zone: string) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(instant)) if (p.type !== "literal") parts[p.type] = p.value;
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }

  it.each([
    {
      name: "Kolkata, half-hour offset",
      zone: "Asia/Kolkata",
      y: 2026,
      mo: 6,
      d: 15,
      h: 14,
      mi: 30,
    },
    { name: "Berlin, summer", zone: "Europe/Berlin", y: 2026, mo: 7, d: 15, h: 9, mi: 0 },
    { name: "Sydney, its winter", zone: "Australia/Sydney", y: 2026, mo: 7, d: 15, h: 9, mi: 0 },
  ])("round-trips an ordinary wall-clock time — $name", ({ zone, y, mo, d, h, mi }) => {
    const instant = zonedToUtc(y, mo, d, h, mi, zone);
    const want = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    expect.soft(wallClockIn(instant, zone)).toBe(want);
  });

  it("resolves a spring-forward gap time in Berlin to the instant after the gap", () => {
    // 2026-03-29 Berlin: clocks jump 02:00 -> 03:00, so 02:30 doesn't exist.
    const instant = zonedToUtc(2026, 3, 29, 2, 30, "Europe/Berlin");
    expect(wallClockIn(instant, "Europe/Berlin")).toBe("2026-03-29 03:30");
  });

  // The regression this defends: the old two-pass estimate converged from the
  // naive UTC reading, so which side of the gap it landed on depended on the
  // sign of the zone's offset. Berlin (above) was right and Los Angeles was an
  // hour early. Both faces of the same rule now, which is the point.
  it("resolves a spring-forward gap time in Los Angeles to the instant after the gap too", () => {
    // 2026-03-08 LA: clocks jump 02:00 -> 03:00, so 02:30 doesn't exist.
    const instant = zonedToUtc(2026, 3, 8, 2, 30, "America/Los_Angeles");
    expect(wallClockIn(instant, "America/Los_Angeles")).toBe("2026-03-08 03:30");
  });

  it("resolves a fall-back ambiguity to the first of the two", () => {
    // 2026-11-01 LA: 01:30 happens twice, PDT then PST. Every calendar takes
    // the first, and the two differ by a real hour.
    const instant = zonedToUtc(2026, 11, 1, 1, 30, "America/Los_Angeles");
    expect(wallClockIn(instant, "America/Los_Angeles")).toBe("2026-11-01 01:30");
    expect(new Date(instant).toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("resolves a fall-back ambiguity east of UTC the same way", () => {
    // 2026-10-25 Berlin: 02:30 happens twice, CEST then CET.
    const instant = zonedToUtc(2026, 10, 25, 2, 30, "Europe/Berlin");
    expect(wallClockIn(instant, "Europe/Berlin")).toBe("2026-10-25 02:30");
    expect(new Date(instant).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("formatOffset", () => {
  it.each([
    { name: "same zone", minutes: 0, expected: "same" },
    { name: "positive whole hour", minutes: 60, expected: "+1" },
    { name: "negative whole hour", minutes: -60, expected: `${MINUS}1` },
    { name: "positive half hour", minutes: 330, expected: "+5:30" },
    { name: "negative half hour", minutes: -210, expected: `${MINUS}3:30` },
  ])("$name", ({ minutes, expected }) => {
    expect.soft(formatOffset(minutes)).toBe(expected);
  });
});
