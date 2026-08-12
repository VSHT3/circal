import { describe, expect, it } from "vitest";
import "./helpers";
import { at, byDay, day, rule } from "./helpers";
import { describeRule, isExpressible, nthLabel } from "@/lib/describe";

/* ------------------------------- isExpressible ------------------------------ */

describe("isExpressible gates the editor's three rows", () => {
  // The seed is a Thursday, and the third Thursday of its month — which is
  // what a monthly positional rule has to agree with to be editable here.
  const seed = day("2026-03-19");

  it.each([
    { name: "a plain weekly rule", value: rule({ repeat: "weekly", interval: 1 }), ok: true },
    {
      name: "weekly on named days",
      value: rule({ repeat: "weekly", byDay: byDay("MO,WE") }),
      ok: true,
    },
    {
      name: "monthly on the seed's own position",
      value: rule({ repeat: "monthly", byDay: byDay("3TH") }),
      ok: true,
    },
    {
      name: "monthly on the last of the seed's weekday",
      value: rule({ repeat: "monthly", byDay: byDay("-1TH") }),
      ok: true,
    },
    { name: "a bare never", value: rule(), ok: true },
    // Every one of these is a rule the rows would have to guess at, so the
    // sentence stands in instead.
    {
      name: "weekly on a positional day",
      value: rule({ repeat: "weekly", byDay: byDay("1FR") }),
      ok: false,
    },
    {
      name: "monthly on another weekday",
      value: rule({ repeat: "monthly", byDay: byDay("2MO") }),
      ok: false,
    },
    {
      name: "monthly on two weekdays",
      value: rule({ repeat: "monthly", byDay: byDay("MO,TU") }),
      ok: false,
    },
    {
      name: "monthly on a day of the month",
      value: rule({ repeat: "monthly", byMonthDay: [13] }),
      ok: false,
    },
    {
      name: "anything carrying BYSETPOS",
      value: rule({ repeat: "monthly", byDay: byDay("MO,TU"), bySetPos: [-1] }),
      ok: false,
    },
    {
      name: "anything carrying BYWEEKNO",
      value: rule({ repeat: "yearly", byWeekNo: [20] }),
      ok: false,
    },
    {
      name: "anything carrying BYMONTH",
      value: rule({ repeat: "yearly", byMonth: [3] }),
      ok: false,
    },
    { name: "a clock part", value: rule({ repeat: "daily", byHour: [9, 17] }), ok: false },
    { name: "a sub-daily frequency", value: rule({ repeat: "hourly" }), ok: false },
    {
      name: "daily on named days",
      value: rule({ repeat: "daily", byDay: byDay("MO") }),
      ok: false,
    },
  ])("$name", ({ value, ok }) => {
    expect.soft(isExpressible(value, seed)).toBe(ok);
  });

  it("reads the seed's position from its own date, not from the rule", () => {
    const third = rule({ repeat: "monthly", byDay: byDay("3TH") });
    // The same rule against the first Thursday of a month is a rule that would
    // move the event, so the rows must not claim they can spell it.
    expect(isExpressible(third, day("2026-03-05"))).toBe(false);
  });
});

/* -------------------------------- describeRule ------------------------------- */

describe("describeRule prints a sentence, not a dump of the parts", () => {
  it.each([
    { name: "a plain weekly rule", value: rule({ repeat: "weekly" }), text: "Every week" },
    {
      name: "an interval, pluralised",
      value: rule({ repeat: "weekly", interval: 2 }),
      text: "Every 2 weeks",
    },
    {
      name: "named weekdays, abbreviated",
      value: rule({ repeat: "weekly", byDay: byDay("TU,TH") }),
      text: "Every week on Tue and Thu",
    },
    {
      name: "a positional weekday",
      value: rule({ repeat: "monthly", byDay: byDay("-1FR") }),
      text: "Every month on last Fri",
    },
    {
      name: "days of the month, counted from the end as RFC does",
      value: rule({ repeat: "monthly", byMonthDay: [1, -3] }),
      text: "Every month on the 1st and 3rd from last",
    },
    {
      name: "months",
      value: rule({ repeat: "yearly", byMonth: [1, 6, 12] }),
      text: "Every year in Jan, Jun and Dec",
    },
    {
      name: "one week number",
      value: rule({ repeat: "yearly", byWeekNo: [20] }),
      text: "Every year in week 20",
    },
    {
      name: "several week numbers",
      value: rule({ repeat: "yearly", byWeekNo: [20, 40] }),
      text: "Every year in weeks 20 and 40",
    },
    {
      name: "days of the year",
      value: rule({ repeat: "yearly", byYearDay: [-1] }),
      text: "Every year on the 1st from last day of the year",
    },
    {
      name: "clock parts, summarised rather than listed",
      value: rule({ repeat: "daily", byHour: [9, 17] }),
      text: "Every day at set times",
    },
    {
      name: "a bound",
      value: rule({ repeat: "weekly", until: at("2027-01-01 00:00").getTime() }),
      text: "Every week until 1 Jan 2027",
    },
  ])("$name", ({ value, text }) => {
    expect.soft(describeRule(value)).toBe(text);
  });

  // The one case the sentence exists for: BYSETPOS is an adjective on the days
  // the rule just produced, never a clause bolted on after them.
  it("reads BYSETPOS as an adjective on the days it selects from", () => {
    const lastWeekday = rule({ repeat: "monthly", byDay: byDay("MO,TU,WE,TH,FR"), bySetPos: [-1] });
    expect(describeRule(lastWeekday)).toBe("Every month on the last of Mon, Tue, Wed, Thu and Fri");
  });

  it("keeps BYSETPOS as its own clause when it has no days to qualify", () => {
    expect(describeRule(rule({ repeat: "monthly", bySetPos: [1, -1] }))).toBe(
      "Every month keeping the first and last",
    );
  });

  it("orders every clause behind the frequency", () => {
    const everything = rule({
      repeat: "yearly",
      interval: 2,
      byMonth: [3],
      byDay: byDay("2WE"),
      until: at("2030-06-01 00:00").getTime(),
    });
    expect(describeRule(everything)).toBe("Every 2 years in Mar on second Wed until 1 Jun 2030");
  });
});

/* ---------------------------------- nthLabel --------------------------------- */

describe("nthLabel names a monthly position", () => {
  it.each([
    { nth: 1, text: "First Thursday" },
    { nth: 3, text: "Third Thursday" },
    { nth: 5, text: "Fifth Thursday" },
    { nth: -1, text: "Last Thursday" },
    { nth: -2, text: "Second last Thursday" },
  ])("$nth reads as $text", ({ nth, text }) => {
    expect.soft(nthLabel(nth, 4)).toBe(text);
  });
});
