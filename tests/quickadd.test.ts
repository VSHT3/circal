import { describe, expect, it } from "vitest";
import { at, day } from "./helpers";
import {
  DEFAULT_DURATION,
  defaultStart,
  parseDate,
  parseDurationToken,
  parseQuickAdd,
  parseRepeat,
  parseSlot,
  repeatPhrase,
} from "@/lib/quickadd";
import { MINUTES_PER_DAY, dayKey } from "@/lib/time";

/* Wednesday, the day the palette is open on in every case below. */
const REFERENCE = day("2026-08-05");

/* Mid-morning, so the next quarter hour is 10:15 and not a boundary. */
const NOW = at("2026-08-05 10:07");

/** What a parse says, in the form a failure can be read in one line. */
function shape(input: string, reference = REFERENCE, now = NOW) {
  const parsed = parseQuickAdd(input, reference, now);
  if (!parsed) return null;
  return {
    title: parsed.title,
    day: dayKey(parsed.day),
    startMin: parsed.startMin,
    endMin: parsed.endMin,
    allDay: parsed.allDay,
  };
}

/* ---------------------------------- parseDate ------------------------------- */

describe("parseDate", () => {
  it.each([
    { query: "today", expected: "2026-08-05" },
    { query: "tomorrow", expected: "2026-08-06" },
    { query: "yesterday", expected: "2026-08-04" },
    { query: "friday", expected: "2026-08-07" },
    { query: "fri", expected: "2026-08-07" },
    { query: "FRIDAY", expected: "2026-08-07" },
    // The weekday it is already on means the next one: a jump to today has a
    // word of its own, so "wednesday" asking for today would be a wasted form.
    { query: "wed", expected: "2026-08-12" },
    { query: "2026-09-14", expected: "2026-09-14" },
    { query: "sep 14", expected: "2026-09-14" },
    { query: "14 sep", expected: "2026-09-14" },
    { query: "september 14", expected: "2026-09-14" },
    // A month already past rolls forward rather than backwards — nobody types
    // a date to land on it eleven months ago.
    { query: "jan 3", expected: "2027-01-03" },
    { query: "+3", expected: "2026-08-08" },
    { query: "-2", expected: "2026-08-03" },
    { query: "in 3 days", expected: "2026-08-08" },
    { query: "9", expected: "2026-08-09" },
    // A day of the month already past belongs to next month.
    { query: "3", expected: "2026-09-03" },
  ])("reads $query as $expected", ({ query, expected }) => {
    const parsed = parseDate(query, REFERENCE);
    expect(parsed && dayKey(parsed)).toBe(expected);
  });

  it.each(["", "   ", "nonsense", "2026-02-30", "2026-13-01", "32", "0", "sep 40"])(
    "refuses %o",
    (query) => {
      expect(parseDate(query, REFERENCE)).toBeNull();
    },
  );

  it("refuses a day of the month the next month does not have", () => {
    expect(parseDate("31", day("2026-09-15"))).toBeNull();
  });

  it("returns local midnight, never a shifted instant", () => {
    const parsed = parseDate("2026-09-14", REFERENCE);
    expect(parsed?.getHours()).toBe(0);
    expect(parsed?.getDate()).toBe(14);
  });
});

/* ------------------------------ duration and slot --------------------------- */

describe("parseDurationToken", () => {
  it.each([
    { query: "45m", expected: 45 },
    { query: "40min", expected: 40 },
    { query: "90mins", expected: 90 },
    { query: "15 minutes", expected: 15 },
    { query: "1h", expected: 60 },
    { query: "1h30", expected: 90 },
    { query: "2h 15m", expected: 135 },
    { query: "2hrs", expected: 120 },
  ])("reads $query as $expected minutes", ({ query, expected }) => {
    expect(parseDurationToken(query)).toBe(expected);
  });

  // The unit is what separates a length from an hour of the day, so a bare
  // number is never a duration here.
  it.each(["", "12", "free", "free 45", "1pm", "13:00", "m"])("refuses %o", (query) => {
    expect(parseDurationToken(query)).toBeNull();
  });
});

describe("parseSlot", () => {
  it.each([
    { query: "free", expected: 30 },
    { query: "free 45", expected: 45 },
    { query: "free 1h", expected: 60 },
    { query: "45m", expected: 45 },
    { query: "1h30", expected: 90 },
  ])("reads $query as $expected minutes", ({ query, expected }) => {
    expect(parseSlot(query)).toBe(expected);
  });

  it.each(["", "lunch", "12", "tomorrow"])("refuses %o", (query) => {
    expect(parseSlot(query)).toBeNull();
  });
});

/* -------------------------------- defaultStart ------------------------------ */

describe("defaultStart", () => {
  it("takes the next quarter hour on today", () => {
    expect(defaultStart(REFERENCE, DEFAULT_DURATION, NOW)).toBe(10 * 60 + 15);
  });

  it("takes a working hour on any other day", () => {
    expect(defaultStart(day("2026-08-06"), DEFAULT_DURATION, NOW)).toBe(9 * 60);
  });

  it("pulls back so the span ends inside the day", () => {
    const start = defaultStart(REFERENCE, DEFAULT_DURATION, at("2026-08-05 23:50"));
    expect(start).toBe(MINUTES_PER_DAY - DEFAULT_DURATION);
  });

  it("never goes negative for a span longer than a day", () => {
    expect(defaultStart(REFERENCE, 3 * MINUTES_PER_DAY, NOW)).toBe(0);
  });
});

/* -------------------------------- parseQuickAdd ----------------------------- */

describe("parseQuickAdd resolves the sentence", () => {
  it("reads a name, a day, a time and a length", () => {
    expect(shape("lunch tomorrow 1pm 45m")).toEqual({
      title: "lunch",
      day: "2026-08-06",
      startMin: 13 * 60,
      endMin: 13 * 60 + 45,
      allDay: false,
    });
  });

  // Right-to-left scanning claims each part wherever it sits, so the order the
  // sentence happens to come out in is not a syntax to remember.
  it.each([
    "lunch tomorrow 1pm 45m",
    "lunch 1pm tomorrow 45m",
    "lunch 45m 1pm tomorrow",
    "lunch tomorrow 45m 1pm",
  ])("reads the same event from %o", (input) => {
    expect(shape(input)).toEqual(shape("lunch tomorrow 1pm 45m"));
  });

  it.each([
    { input: "standup 9:30", startMin: 570, endMin: 570 + DEFAULT_DURATION },
    { input: "standup 09:30", startMin: 570, endMin: 570 + DEFAULT_DURATION },
    { input: "standup 0930", startMin: 570, endMin: 570 + DEFAULT_DURATION },
    { input: "standup 9:30 am", startMin: 570, endMin: 570 + DEFAULT_DURATION },
    // No meridiem reads on the 24-hour clock, exactly as the editor's field does.
    { input: "standup 14", startMin: 840, endMin: 840 + DEFAULT_DURATION },
    { input: "standup 2pm", startMin: 840, endMin: 840 + DEFAULT_DURATION },
  ])("gives $input an hour when only a start was named", ({ input, startMin, endMin }) => {
    expect(shape(input)).toEqual({
      title: "standup",
      day: "2026-08-05",
      startMin,
      endMin,
      allDay: false,
    });
  });

  it.each([
    { input: "dinner 19:00-21:30", startMin: 1140, endMin: 1290 },
    { input: "dinner 19:00 - 21:30", startMin: 1140, endMin: 1290 },
    { input: "dinner 7pm-9:30pm", startMin: 1140, endMin: 1290 },
    { input: "dinner 19–21:30", startMin: 1140, endMin: 1290 },
  ])("reads the range in $input", ({ input, startMin, endMin }) => {
    expect(shape(input)).toMatchObject({ title: "dinner", startMin, endMin });
  });

  it("carries a range through midnight into tomorrow's minutes", () => {
    expect(shape("party 22:00-01:00")).toEqual({
      title: "party",
      day: "2026-08-05",
      startMin: 22 * 60,
      endMin: 25 * 60,
      allDay: false,
    });
  });

  it("lets a named end win over a duration", () => {
    expect(shape("sync 13:00-14:00 30m")).toMatchObject({
      startMin: 13 * 60,
      endMin: 14 * 60,
    });
  });

  it("starts a bare duration where ⌘N would", () => {
    expect(shape("run 40m")).toEqual({
      title: "run",
      day: "2026-08-05",
      startMin: defaultStart(REFERENCE, 40, NOW),
      endMin: defaultStart(REFERENCE, 40, NOW) + 40,
      allDay: false,
    });
  });

  it("starts a bare duration on another day at a working hour", () => {
    expect(shape("run friday 40m")).toEqual({
      title: "run",
      day: "2026-08-07",
      startMin: 9 * 60,
      endMin: 9 * 60 + 40,
      allDay: false,
    });
  });

  // Nothing is invented: a day and a name is an all-day event, because that is
  // all that was said.
  it("makes a day with no time an all-day event", () => {
    expect(shape("dentist friday")).toEqual({
      title: "dentist",
      day: "2026-08-07",
      startMin: 0,
      endMin: MINUTES_PER_DAY,
      allDay: true,
    });
  });

  it("reports all-day for a span that covers the revolution", () => {
    expect(shape("retreat tomorrow 0:00-0:00")).toMatchObject({ allDay: true });
  });
});

describe("parseQuickAdd and the title", () => {
  it.each([
    { input: "lunch at 1pm", title: "lunch" },
    { input: "standup @ 9:30", title: "standup" },
    { input: "run for 40m", title: "run" },
    { input: "flight on friday", title: "flight" },
    { input: "sprint 3 review fri 2pm", title: "sprint 3 review" },
    { input: "one-on-one 3pm", title: "one-on-one" },
    { input: "call Dr Adams  tomorrow   9am", title: "call Dr Adams" },
    { input: "Q3 planning 2026-09-14 10:00", title: "Q3 planning" },
  ])("reads $input as $title", ({ input, title }) => {
    expect(shape(input)?.title).toBe(title);
  });

  it("keeps the case it was typed in", () => {
    expect(shape("Lunch with ANNA tomorrow")?.title).toBe("Lunch with ANNA");
  });

  // A bare word is a search, and the palette already answers that one.
  it.each(["lunch", "des", "call mom", ""])("is not an event: %o", (input) => {
    expect(parseQuickAdd(input, REFERENCE, NOW)).toBeNull();
  });

  // And a bare date or length is a jump or a free-slot search.
  it.each(["tomorrow", "45m", "13:00", "2026-09-14", "in 3 days", "friday 2pm"])(
    "is not an event either: %o",
    (input) => {
      expect(parseQuickAdd(input, REFERENCE, NOW)).toBeNull();
    },
  );
});

describe("parseQuickAdd on the ambiguous forms", () => {
  it("reads 1h30 as a length and 130 as an hour", () => {
    expect(shape("nap 1h30")).toMatchObject({ endMin: shape("nap 1h30")!.startMin + 90 });
    expect(shape("nap 130")).toMatchObject({ startMin: 90, endMin: 90 + DEFAULT_DURATION });
  });

  // A bare number after a name is an hour: the title has already said what the
  // line is, and a day of the month still has `14 sep` and `2026-09-14`.
  it("reads a bare number as an hour, not a day of the month", () => {
    expect(shape("lunch 12")).toMatchObject({ day: "2026-08-05", startMin: 12 * 60 });
  });

  it("reads a day of the month when it carries its month", () => {
    expect(shape("flight 14 sep 7:15")).toEqual({
      title: "flight",
      day: "2026-09-14",
      startMin: 7 * 60 + 15,
      endMin: 8 * 60 + 15,
      allDay: false,
    });
  });

  it("does not read an ISO date as a range of two hours", () => {
    expect(shape("review 2026-09-14 10:00")).toEqual({
      title: "review",
      day: "2026-09-14",
      startMin: 600,
      endMin: 600 + DEFAULT_DURATION,
      allDay: false,
    });
  });

  it("reads a multi-word date phrase", () => {
    expect(shape("checkup in 3 days 8am")).toEqual({
      title: "checkup",
      day: "2026-08-08",
      startMin: 8 * 60,
      endMin: 9 * 60,
      allDay: false,
    });
  });

  it("stops at the first thing it cannot read rather than eating the title", () => {
    expect(shape("beer o'clock 18:00")).toMatchObject({
      title: "beer o'clock",
      startMin: 18 * 60,
    });
  });

  // Minutes, not instants: what a time inside a DST gap becomes is
  // `draftEvent`'s question, and this parser must not quietly answer it.
  it("returns the minutes it was given on a day that has no 02:30", () => {
    expect(shape("move 2026-03-29 2:30", day("2026-03-01"))).toMatchObject({
      day: "2026-03-29",
      startMin: 150,
    });
  });
});

/* ------------------------------- repetition -------------------------------- */

/** BYDAY as plain weekday numbers, which is all this parser ever produces. */
const days = (spec: { byDay: { day: number; nth: number }[] } | null) =>
  spec?.byDay.map((w) => w.day) ?? null;

describe("parseRepeat", () => {
  it.each([
    { query: "daily", repeat: "daily", interval: 1 },
    { query: "every day", repeat: "daily", interval: 1 },
    { query: "weekly", repeat: "weekly", interval: 1 },
    { query: "every week", repeat: "weekly", interval: 1 },
    { query: "monthly", repeat: "monthly", interval: 1 },
    { query: "every month", repeat: "monthly", interval: 1 },
    { query: "yearly", repeat: "yearly", interval: 1 },
    { query: "annually", repeat: "yearly", interval: 1 },
    { query: "hourly", repeat: "hourly", interval: 1 },
    { query: "fortnightly", repeat: "weekly", interval: 2 },
    { query: "biweekly", repeat: "weekly", interval: 2 },
    { query: "every 2 weeks", repeat: "weekly", interval: 2 },
    { query: "every 3 days", repeat: "daily", interval: 3 },
    { query: "every other week", repeat: "weekly", interval: 2 },
    { query: "every other month", repeat: "monthly", interval: 2 },
    { query: "EVERY 2 WEEKS", repeat: "weekly", interval: 2 },
  ])("reads $query as $repeat every $interval", ({ query, repeat, interval }) => {
    expect(parseRepeat(query)).toMatchObject({ repeat, interval, byDay: [] });
  });

  it.each([
    { query: "weekdays", expected: [1, 2, 3, 4, 5] },
    { query: "every weekday", expected: [1, 2, 3, 4, 5] },
    { query: "weekends", expected: [6, 0] },
    { query: "every monday", expected: [1] },
    { query: "every mon", expected: [1] },
    { query: "every mon/wed/fri", expected: [1, 3, 5] },
    { query: "every mon,thu", expected: [1, 4] },
  ])("reads $query as a weekly rule on $expected", ({ query, expected }) => {
    const spec = parseRepeat(query);
    expect(spec).toMatchObject({ repeat: "weekly", interval: 1 });
    expect(days(spec)).toEqual(expected);
  });

  it("takes a weekday with an interval", () => {
    const spec = parseRepeat("every other friday");
    expect(spec).toMatchObject({ repeat: "weekly", interval: 2 });
    expect(days(spec)).toEqual([5]);
  });

  // A rule always carries a word of its own. A bare weekday is a date, and
  // reading `party friday` as fifty-two parties is the worst mistake here.
  it.each(["", "friday", "fri", "tomorrow", "every", "every fortnight", "every 0 weeks", "45m"])(
    "refuses %o",
    (query) => {
      expect(parseRepeat(query)).toBeNull();
    },
  );
});

describe("repeatPhrase", () => {
  it.each([
    { query: "daily", expected: "Daily" },
    { query: "weekly", expected: "Weekly" },
    { query: "every 2 weeks", expected: "Every 2 weeks" },
    { query: "every 3 days", expected: "Every 3 days" },
    { query: "weekdays", expected: "Weekdays" },
    { query: "weekends", expected: "Weekends" },
    { query: "every mon/wed", expected: "Every Mon, Wed" },
    { query: "every other friday", expected: "Every 2 weeks on Fri" },
  ])("prints $query as $expected", ({ query, expected }) => {
    const spec = parseRepeat(query);
    expect(spec && repeatPhrase(spec)).toBe(expected);
  });
});

describe("parseQuickAdd reads a rule out of the sentence", () => {
  const rule = (input: string, reference = REFERENCE) =>
    parseQuickAdd(input, reference, NOW)?.repeat ?? null;

  it("reads the whole sentence with a rule in it", () => {
    expect(shape("morning run 8am 45m daily")).toEqual({
      title: "morning run",
      day: "2026-08-05",
      startMin: 8 * 60,
      endMin: 8 * 60 + 45,
      allDay: false,
    });
    expect(rule("morning run 8am 45m daily")).toMatchObject({
      repeat: "daily",
      interval: 1,
      byDay: [],
    });
  });

  it.each(["morning run 8am 45m daily", "morning run daily 8am 45m", "morning run 45m daily 8am"])(
    "takes the rule wherever it sits in %o",
    (input) => {
      expect(shape(input)).toEqual(shape("morning run 8am 45m daily"));
      expect(rule(input)).toEqual(rule("morning run 8am 45m daily"));
    },
  );

  it("leaves most lines without one", () => {
    expect(rule("lunch tomorrow 1pm 45m")).toBeNull();
  });

  // `every friday` ends in a weekday, so the date matcher would take it for one
  // — leaving `every` in the title and an event that happens once.
  it("does not let the date matcher eat a rule", () => {
    expect(shape("gym every friday 7am")).toMatchObject({ title: "gym" });
    expect(rule("gym every friday 7am")).toMatchObject({ repeat: "weekly" });
  });

  it("keeps a bare weekday as the date it is", () => {
    expect(rule("party friday 21:00")).toBeNull();
    expect(shape("party friday 21:00")).toMatchObject({ day: "2026-08-07" });
  });

  // An event whose own rule skips the day it was created on would vanish off
  // the face as it was saved.
  it("moves the first instance onto a day the rule generates", () => {
    // Wednesday → the next Monday.
    expect(shape("gym every monday 7am")).toMatchObject({ day: "2026-08-10" });
    // Already a weekday, so a weekdays rule does not move it at all.
    expect(shape("standup every weekday 9:15")).toMatchObject({ day: "2026-08-05" });
    // Saturday and Sunday are the next two days from a Friday.
    expect(shape("brunch weekends 11:00", day("2026-08-07"))).toMatchObject({ day: "2026-08-08" });
  });

  it("leaves an explicit date alone even when the rule names weekdays", () => {
    expect(shape("gym 2026-09-14 every monday 7am")).toMatchObject({ day: "2026-09-14" });
  });

  it("makes a rule enough on its own to be an event", () => {
    expect(shape("bins weekly")).toEqual({
      title: "bins",
      day: "2026-08-05",
      startMin: 0,
      endMin: MINUTES_PER_DAY,
      allDay: true,
    });
  });

  it("is still not an event without a title", () => {
    expect(parseQuickAdd("daily", REFERENCE, NOW)).toBeNull();
    expect(parseQuickAdd("every 2 weeks 9am", REFERENCE, NOW)).toBeNull();
  });
});

/* ---------------------------- relative to now ------------------------------ */

describe("parseQuickAdd reads an offset from now", () => {
  // NOW is 10:07, so every case below also proves the quarter-hour rounding:
  // a machine-chosen time in this app always lands on the dial's own grid.
  it.each([
    { input: "dinner in 2h", startMin: 12 * 60, endMin: 13 * 60 },
    { input: "dinner in 2 hours", startMin: 12 * 60, endMin: 13 * 60 },
    { input: "dinner in an hour", startMin: 11 * 60, endMin: 12 * 60 },
    { input: "dinner in 90m", startMin: 11 * 60 + 30, endMin: 12 * 60 + 30 },
    { input: "dinner in 20min", startMin: 10 * 60 + 30, endMin: 11 * 60 + 30 },
    // Greedy: `in 1h 30m` is ninety minutes from now, never "in an hour, for
    // half of one".
    { input: "dinner in 1h 30m", startMin: 11 * 60 + 30, endMin: 12 * 60 + 30 },
    { input: "dinner in 2h 45m", startMin: 12 * 60 + 45, endMin: 13 * 60 + 45 },
    // The quarter you are in, not the next one: at 10:07 the next one is eight
    // minutes away, which is not what "now" means.
    { input: "dinner now", startMin: 10 * 60, endMin: 11 * 60 },
  ])("reads $input as $startMin–$endMin today", ({ input, startMin, endMin }) => {
    expect(shape(input)).toEqual({
      title: "dinner",
      day: "2026-08-05",
      startMin,
      endMin,
      allDay: false,
    });
  });

  // A length beside an offset goes in front of the name, because everything
  // after `in` belongs to the offset.
  it.each(["45min dinner in 1h", "dinner in 1h for 45min", "45m dinner in 1h"])(
    "takes a leading length in %o",
    (input) => {
      expect(shape(input)).toEqual({
        title: "dinner",
        day: "2026-08-05",
        startMin: 11 * 60,
        endMin: 11 * 60 + 45,
        allDay: false,
      });
    },
  );

  it("takes a leading length on its own", () => {
    expect(shape("45m run")).toEqual({
      title: "run",
      day: "2026-08-05",
      startMin: defaultStart(REFERENCE, 45, NOW),
      endMin: defaultStart(REFERENCE, 45, NOW) + 45,
      allDay: false,
    });
  });

  it("never eats the whole line as a length", () => {
    expect(parseQuickAdd("45m", REFERENCE, NOW)).toBeNull();
    expect(parseQuickAdd("in 2h", REFERENCE, NOW)).toBeNull();
    expect(parseQuickAdd("now", REFERENCE, NOW)).toBeNull();
  });

  // The decision: an offset names a clock, a date still names the day.
  it("keeps a named day and takes only the clock from the offset", () => {
    expect(shape("dinner tomorrow in 2h")).toMatchObject({
      day: "2026-08-06",
      startMin: 12 * 60,
    });
    expect(shape("dinner 2026-09-14 in 2h")).toMatchObject({
      day: "2026-09-14",
      startMin: 12 * 60,
    });
  });

  it("rolls onto tomorrow when the offset crosses midnight", () => {
    const late = at("2026-08-05 23:20");
    expect(shape("dinner in 2h", REFERENCE, late)).toMatchObject({
      day: "2026-08-06",
      startMin: 75,
    });
  });

  // With a day named, the roll is the named day's business and not the clock's.
  it("does not roll a named day past itself", () => {
    const late = at("2026-08-05 23:20");
    expect(shape("dinner tomorrow in 2h", REFERENCE, late)).toMatchObject({
      day: "2026-08-06",
      startMin: 75,
    });
  });

  it("measures from now even when another day is on screen", () => {
    expect(shape("dinner in 2h", day("2026-12-24"))).toMatchObject({
      day: "2026-08-05",
      startMin: 12 * 60,
    });
  });

  it("lets an explicit time win over an offset", () => {
    expect(shape("dinner 8pm in 2h")).toMatchObject({ startMin: 20 * 60 });
  });

  it("takes a rule beside an offset", () => {
    expect(shape("gym every monday in 2h")).toMatchObject({
      day: "2026-08-10",
      startMin: 12 * 60,
    });
  });

  // `in` is only an offset when a length follows it. Otherwise it is a word.
  it.each([
    { input: "dinner in Rome 8pm", title: "dinner in Rome" },
    { input: "standup in the studio 9:30", title: "standup in the studio" },
    { input: "coffee in a bit 3pm", title: "coffee in a bit" },
  ])("leaves the preposition alone in $input", ({ input, title }) => {
    expect(shape(input)?.title).toBe(title);
  });

  it("still reads `in 3 days` as the date it always was", () => {
    expect(shape("checkup in 3 days")).toEqual({
      title: "checkup",
      day: "2026-08-08",
      startMin: 0,
      endMin: MINUTES_PER_DAY,
      allDay: true,
    });
  });
});
