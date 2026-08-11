import { describe, expect, it } from "vitest";
import { byDay, day, event, ms } from "./helpers";
import { fromIcs, toIcs, type IcsEvent } from "@/lib/ics";
import { NEVER } from "@/lib/events";
import { startsBetween } from "@/lib/recur";

/* ------------------------------- fixtures ---------------------------------- *
 * `toIcs`/`fromIcs` round-trip most of the model through raw text, so several
 * cases here build ICS text by hand rather than through `toIcs` — that's the
 * only way to probe how `fromIcs` reads a feed circal never wrote itself. */

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

/** One VEVENT wrapped in a minimal VCALENDAR. `uid: null` omits UID
 *  entirely, for the derived-UID cases; any other value overrides it. */
function singleVevent(props: string[], opts: { uid?: string | null } = {}): string {
  const uid = opts.uid === undefined ? "UID:test-uid@example.com" : opts.uid;
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//test//EN",
      "BEGIN:VEVENT",
      ...(uid ? [uid] : []),
      ...props,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n") + "\r\n"
  );
}

/** Several VEVENTs in one VCALENDAR — a series and the overrides that
 *  reference it can only be told apart by `fromIcs` when they arrive
 *  together. Each entry supplies its own UID. */
function vcalendar(...vevents: string[][]): string {
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//test//EN",
      ...vevents.flatMap((props) => ["BEGIN:VEVENT", ...props, "END:VEVENT"]),
      "END:VCALENDAR",
    ].join("\r\n") + "\r\n"
  );
}

/* -------------------------------- round-trip -------------------------------- *
 * The spine of this file: what goes into `toIcs` must come back out of
 * `fromIcs` unchanged, for every shape the model supports. */

describe("round-trip", () => {
  it("a plain timed event", () => {
    const ev = event({
      title: "Standup",
      start: "2026-03-09 09:00",
      end: "2026-03-09 09:30",
      location: "Room 4",
      url: "https://example.com/meet",
      notes: "bring laptop",
    });
    const { events } = fromIcs(toIcs([ev], "Work"));
    expect(events).toHaveLength(1);
    const out = events[0];
    expect.soft(out.title).toBe(ev.title);
    expect.soft(out.start).toBeSameInstantAs(ev.start);
    expect.soft(out.end).toBeSameInstantAs(ev.end);
    expect.soft(out.allDay).toBe(false);
    expect.soft(out.location).toBe(ev.location);
    expect.soft(out.url).toBe(ev.url);
    expect.soft(out.notes).toBe(ev.notes);
    expect.soft(out.uid).toBe(`${ev.id}@circal.app`);
  });

  it("an all-day event, DTEND landing on the day *after* the last day (end is exclusive)", () => {
    const ev = event({
      title: "Conference",
      allDay: true,
      start: "2026-03-09 00:00",
      end: "2026-03-10 00:00",
    });
    const text = toIcs([ev], "Work");
    // The off-by-one that would silently shorten every all-day event: DTEND
    // must name the day after the last day, not the last day itself.
    expect.soft(text).toContain("DTSTART;VALUE=DATE:20260309");
    expect.soft(text).toContain("DTEND;VALUE=DATE:20260310");

    const { events } = fromIcs(text);
    expect(events).toHaveLength(1);
    expect.soft(events[0].allDay).toBe(true);
    expect.soft(events[0].start).toBeSameInstantAs(ev.start);
    expect.soft(events[0].end).toBeSameInstantAs(ev.end);
  });

  it("a multi-day timed event that crosses midnight", () => {
    const ev = event({
      title: "Overnight flight",
      start: "2026-03-09 23:30",
      end: "2026-03-10 06:45",
    });
    const { events } = fromIcs(toIcs([ev], "Travel"));
    expect(events).toHaveLength(1);
    expect.soft(events[0].start).toBeSameInstantAs(ev.start);
    expect.soft(events[0].end).toBeSameInstantAs(ev.end);
    expect.soft(events[0].allDay).toBe(false);
  });

  it("a recurring event's RRULE (weekly, two weekdays, interval, until)", () => {
    const ev = event({
      title: "Standup",
      start: "2026-03-10 09:00", // Tuesday
      end: "2026-03-10 09:15",
      repeat: "weekly",
      interval: 1,
      byDay: byDay("TU,TH"),
      until: ms("2026-04-30 09:15"),
    });
    const { events } = fromIcs(toIcs([ev], "Work"));
    expect(events).toHaveLength(1);
    const out = events[0];
    expect.soft(out.repeat).toBe("weekly");
    expect.soft(out.interval).toBe(1);
    expect.soft(out.byDay).toEqual(byDay("TU,TH"));
    expect.soft(out.until).toBeSameInstantAs(ev.until);
  });

  it("EXDATE and RDATE, a day key and an instant key on the same event", () => {
    const ev = event({
      title: "Daily sync",
      start: "2026-03-09 09:00",
      end: "2026-03-09 09:30",
      repeat: "daily",
      exdates: ["2026-03-11", "2026-03-13T09:00:00"],
      rdates: ["2026-03-20", "2026-03-21T09:00:00"],
    });
    const { events } = fromIcs(toIcs([ev], "Work"));
    expect(events).toHaveLength(1);
    const out = events[0];
    expect.soft([...out.exdates].sort()).toEqual([...ev.exdates].sort());
    expect.soft([...out.rdates].sort()).toEqual([...ev.rdates].sort());
  });

  it("a RECURRENCE-ID override, linked to its series by uid and recurrenceId", () => {
    const seriesId = "series-1";
    const series = event({
      id: seriesId,
      title: "Standup",
      start: "2026-03-09 09:00", // Monday
      end: "2026-03-09 09:15",
      repeat: "weekly",
      byDay: byDay("MO"),
    });
    // The occurrence one week later moved to the afternoon.
    const overriddenInstant = "2026-03-16T09:00:00";
    const override = event({
      seriesId,
      seriesKey: overriddenInstant,
      title: "Standup (moved)",
      start: "2026-03-16 14:00",
      end: "2026-03-16 14:15",
    });

    const { events } = fromIcs(toIcs([series, override], "Work"));
    expect(events).toHaveLength(2);
    const outSeries = events.find((e) => e.recurrenceId === "");
    const outOverride = events.find((e) => e.recurrenceId !== "");
    expect(outSeries).toBeDefined();
    expect(outOverride).toBeDefined();
    // Same UID is what tells a consumer these two VEVENTs are one series.
    expect.soft(outSeries?.uid).toBe(`${seriesId}@circal.app`);
    expect.soft(outOverride?.uid).toBe(outSeries?.uid);
    // RECURRENCE-ID names the *original* slot, not the override's new time.
    expect.soft(outOverride?.recurrenceId).toBe(overriddenInstant);
    expect.soft(outOverride?.title).toBe("Standup (moved)");
    expect.soft(outOverride?.start).toBeSameInstantAs(override.start);
  });
});

/* -------------------------------- folding ----------------------------------- */

describe("line folding (RFC 5545 §3.1, 75-octet limit)", () => {
  it("folds a long content line and unfolds back to the original", () => {
    const notes = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
    const ev = event({ title: "Long notes", notes });
    const text = toIcs([ev], "Work");
    const rawLines = text.split("\r\n").filter((l) => l.length > 0);

    expect.soft(rawLines.every((l) => octets(l) <= 75)).toBe(true);
    // At least one continuation line — proves a fold actually happened, not
    // just that nothing was long enough to need one.
    expect.soft(rawLines.some((l) => l.startsWith(" "))).toBe(true);

    const { events } = fromIcs(text);
    expect(events[0].notes).toBe(notes);
  });

  it("folds by code point and by UTF-8 octet, never splitting a multi-byte character", () => {
    // "SUMMARY:" (8 octets) + 67 ascii bytes lands the running total at
    // exactly 75 — the next character, a 4-byte emoji, must fold onto its
    // own continuation line whole, not 1..3 of its bytes onto this one.
    const title = "A".repeat(67) + "🎉" + "B".repeat(20);
    const text = toIcs([event({ title })], "Work");
    const rawLines = text.split("\r\n").filter((l) => l.length > 0);

    expect.soft(rawLines.every((l) => octets(l) <= 75)).toBe(true);
    const summaryHead = rawLines.find((l) => l.startsWith("SUMMARY:"));
    expect.soft(summaryHead).toBe("SUMMARY:" + "A".repeat(67));
    expect.soft(octets(summaryHead ?? "")).toBe(75);

    // The whole point: the emoji survives as one character, not two lone
    // surrogates either side of a fold.
    const { events } = fromIcs(text);
    expect(events[0].title).toBe(title);
  });
});

/* -------------------------------- escaping ----------------------------------- */

describe("text escaping (RFC 5545 §3.3.11)", () => {
  it("escapes backslash, semicolon, comma and newline; leaves colon alone", () => {
    const raw = "A\\B;C,D\nE:F🎉";
    const escaped = "A\\\\B\\;C\\,D\\nE:F🎉";
    const ev = event({ title: raw, notes: raw });
    const text = toIcs([ev], "Work");

    expect.soft(text).toContain(`SUMMARY:${escaped}`);
    expect.soft(text).toContain(`DESCRIPTION:${escaped}`);

    const { events } = fromIcs(text);
    expect.soft(events[0].title).toBe(raw);
    expect.soft(events[0].notes).toBe(raw);
  });

  it("collapses a CRLF inside a value to the RFC \\n escape — the CR itself is not recoverable", () => {
    const withCr = "line one\r\nline two";
    const ev = event({ title: withCr });
    const { events } = fromIcs(toIcs([ev], "Work"));
    expect(events[0].title).toBe("line one\nline two");
  });
});

/* -------------------------------- line endings -------------------------------- */

describe("line endings", () => {
  it("emits CRLF throughout, never a bare LF", () => {
    const text = toIcs([event({ title: "X" })], "Work");
    expect.soft(text.endsWith("\r\n")).toBe(true);
    expect.soft(text).not.toMatch(/[^\r]\n/);
  });

  it("parses input using bare LF as well as CRLF", () => {
    const withCrlf = toIcs(
      [event({ title: "Bare LF", start: "2026-03-09 09:00", end: "2026-03-09 09:30" })],
      "Work",
    );
    const withLf = withCrlf.replace(/\r\n/g, "\n");
    const a = fromIcs(withCrlf).events[0];
    const b = fromIcs(withLf).events[0];
    expect.soft(b.title).toBe(a.title);
    expect.soft(b.start).toBeSameInstantAs(a.start);
    expect.soft(b.end).toBeSameInstantAs(a.end);
  });
});

/* ---------------------------------- structure ---------------------------------- */

describe("calendar structure", () => {
  it("wraps output in VCALENDAR with VERSION, PRODID, and one VEVENT per event", () => {
    const events3 = [
      event({ title: "One", start: "2026-03-09 09:00", end: "2026-03-09 09:30" }),
      event({ title: "Two", start: "2026-03-10 09:00", end: "2026-03-10 09:30" }),
      event({ title: "Three", start: "2026-03-11 09:00", end: "2026-03-11 09:30" }),
    ];
    const text = toIcs(events3, "Work");
    expect.soft(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect.soft(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect.soft(text).toContain("VERSION:2.0");
    expect.soft(text).toMatch(/PRODID:\S+/);
    expect.soft((text.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
    expect.soft((text.match(/END:VEVENT/g) ?? []).length).toBe(3);
  });

  it("keeps UID stable across repeated exports and round-trips X-WR-CALNAME", () => {
    const ev = event({ id: "fixed-1", title: "Once" });
    const name = 'Home; "Life", Stuff';
    const first = toIcs([ev], name);
    const second = toIcs([ev], name);
    const uidOf = (text: string) => /UID:([^\r\n]+)/.exec(text)?.[1];

    expect.soft(uidOf(first)).toBe(`${ev.id}@circal.app`);
    expect.soft(uidOf(first)).toBe(uidOf(second));
    expect(fromIcs(first).name).toBe(name);
  });
});

/* ------------------------------- malformed input -------------------------------- */

describe("fromIcs never throws on malformed or hostile input", () => {
  const cases = [
    { name: "empty string", input: "" },
    { name: "a stray END:VEVENT with no BEGIN", input: "END:VEVENT\r\n" },
    {
      name: "a VEVENT with no DTSTART",
      input: singleVevent(["SUMMARY:No start"]),
    },
    {
      name: "a VEVENT with an unparseable DTSTART",
      input: singleVevent(["DTSTART:not-a-date", "SUMMARY:Bad start"]),
    },
    {
      name: "an unterminated VEVENT at EOF",
      input: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nDTSTART:20260308T090000Z\r\n",
    },
    { name: "text that is not iCalendar at all", input: "this is not icalendar\nrandom : junk\n" },
  ];

  it.each(cases)("$name", ({ input }) => {
    expect(() => fromIcs(input)).not.toThrow();
    const result = fromIcs(input);
    expect.soft(result.events).toEqual([]);
    expect.soft(result.name).toBe("");
  });

  it("does not throw or produce NaN when DTEND precedes DTSTART", () => {
    const text = singleVevent(["DTSTART:20260308T090000Z", "DTEND:20260308T080000Z"]);
    expect(() => fromIcs(text)).not.toThrow();
    const { events } = fromIcs(text);
    expect(events).toHaveLength(1);
    expect.soft(Number.isFinite(events[0].start)).toBe(true);
    expect.soft(Number.isFinite(events[0].end)).toBe(true);
  });

  it("collapses an unknown FREQ token to a one-off rather than guessing", () => {
    const text = singleVevent([
      "DTSTART:20260308T090000Z",
      "RRULE:FREQ=FORTNIGHTLY;INTERVAL=2;BYDAY=MO",
    ]);
    const { events } = fromIcs(text);
    expect(events).toHaveLength(1);
    // Only the recurrence fields matter here — the ics-only/event fields
    // (uid, title, start...) are irrelevant to whether the rule collapsed.
    const out = events[0];
    expect({
      repeat: out.repeat,
      interval: out.interval,
      until: out.until,
      wkst: out.wkst,
      byMonth: out.byMonth,
      byWeekNo: out.byWeekNo,
      byYearDay: out.byYearDay,
      byMonthDay: out.byMonthDay,
      byDay: out.byDay,
      byHour: out.byHour,
      byMinute: out.byMinute,
      bySecond: out.bySecond,
      bySetPos: out.bySetPos,
      exdates: out.exdates,
      rdates: out.rdates,
    }).toEqual(NEVER);
  });

  it("skips VTIMEZONE and VTODO blocks rather than parsing them as events", () => {
    const text =
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//test//EN",
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Berlin",
        "BEGIN:STANDARD",
        "DTSTART:19701025T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VTODO",
        "UID:todo@example.com",
        "DTSTART:20260101T000000Z",
        "SUMMARY:Buy milk",
        "END:VTODO",
        "BEGIN:VEVENT",
        "UID:real@example.com",
        "DTSTART:20260308T090000Z",
        "SUMMARY:Real event",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n") + "\r\n";

    const { events } = fromIcs(text);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Real event");
  });

  it("derives a stable UID for a VEVENT with no UID — the same text parses to the same id twice", () => {
    const text = singleVevent(["DTSTART:20260308T090000Z", "SUMMARY:No UID here"], { uid: null });
    const a = fromIcs(text).events[0].uid;
    const b = fromIcs(text).events[0].uid;
    expect.soft(a).toBe(b);
    expect.soft(a).toMatch(/@circal\.local$/);
  });

  it("derives different UIDs for two different UID-less VEVENTs in one file", () => {
    const text =
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//test//EN",
        "BEGIN:VEVENT",
        "DTSTART:20260308T090000Z",
        "SUMMARY:First",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "DTSTART:20260309T090000Z",
        "SUMMARY:Second",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n") + "\r\n";
    const { events } = fromIcs(text);
    expect(events).toHaveLength(2);
    expect(events[0].uid).not.toBe(events[1].uid);
  });
});

/* --------------------------------- value types ---------------------------------- */

interface ValueCase {
  name: string;
  dtstart: string;
  allDay: boolean;
  expected: number;
}

describe("DTSTART value types", () => {
  const cases: ValueCase[] = [
    {
      name: "VALUE=DATE — all-day, local",
      dtstart: "DTSTART;VALUE=DATE:20260308",
      allDay: true,
      expected: day("2026-03-08").getTime(),
    },
    {
      name: "bare local datetime — floating, no Z, no TZID",
      dtstart: "DTSTART:20260308T090000",
      allDay: false,
      expected: ms("2026-03-08 09:00"),
    },
    {
      name: "UTC datetime — trailing Z",
      dtstart: "DTSTART:20260308T080000Z",
      allDay: false,
      // Berlin is UTC+1 on March 8 2026, before the DST jump on the 29th.
      expected: ms("2026-03-08 09:00"),
    },
    {
      name: "TZID naming a recognised IANA zone",
      dtstart: "DTSTART;TZID=America/New_York:20260615T090000",
      allDay: false,
      // 09:00 EDT (UTC-4) on 2026-06-15 = 13:00 UTC = 15:00 Berlin (CEST, UTC+2).
      expected: Date.UTC(2026, 5, 15, 13, 0, 0),
    },
    {
      name: "TZID naming an unrecognised zone falls back to floating local",
      dtstart: "DTSTART;TZID=Not/AZone:20260308T090000",
      allDay: false,
      expected: ms("2026-03-08 09:00"),
    },
  ];

  it.each(cases)("$name", ({ dtstart, allDay, expected }) => {
    const { events } = fromIcs(singleVevent([dtstart]));
    expect(events).toHaveLength(1);
    expect.soft(events[0].allDay).toBe(allDay);
    expect.soft(events[0].start).toBeSameInstantAs(expected);
  });
});

/* ---------------------------------- RRULE parsing --------------------------------- */

interface RuleCase {
  name: string;
  rrule: string;
  dtstart?: string;
  check: (out: IcsEvent) => void;
}

describe("RRULE parsing, part by part", () => {
  const cases: RuleCase[] = [
    {
      name: "INTERVAL multiplies the period",
      rrule: "FREQ=WEEKLY;INTERVAL=3",
      check: (out) => expect.soft(out.interval).toBe(3),
    },
    {
      name: "UNTIL in UTC datetime form",
      rrule: "FREQ=DAILY;UNTIL=20260401T000000Z",
      check: (out) => expect.soft(out.until).toBeSameInstantAs(Date.UTC(2026, 3, 1, 0, 0, 0)),
    },
    {
      name: "UNTIL as a bare date resolves to that day's *last* instant, not its first",
      rrule: "FREQ=DAILY;UNTIL=20260401",
      check: (out) => expect.soft(out.until).toBe(day("2026-04-01").getTime() + 86_400_000 - 1),
    },
    {
      name: "WKST names the week's first day",
      rrule: "FREQ=WEEKLY;WKST=SU",
      check: (out) => expect.soft(out.wkst).toBe(0),
    },
    {
      name: "BYMONTH keeps 1..12, drops an out-of-range month",
      rrule: "FREQ=YEARLY;BYMONTH=3,6,13",
      check: (out) => expect.soft(out.byMonth).toEqual([3, 6]),
    },
    {
      name: "BYWEEKNO keeps signed weeks, drops 0",
      rrule: "FREQ=YEARLY;BYWEEKNO=10,-20,0",
      check: (out) => expect.soft(out.byWeekNo).toEqual([10, -20]),
    },
    {
      name: "BYYEARDAY keeps ±1..366, drops out of range",
      rrule: "FREQ=YEARLY;BYYEARDAY=1,-1,400",
      check: (out) => expect.soft(out.byYearDay).toEqual([1, -1]),
    },
    {
      name: "BYMONTHDAY keeps ±1..31, drops out of range",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15,-1,32",
      check: (out) => expect.soft(out.byMonthDay).toEqual([15, -1]),
    },
    {
      name: "BYDAY reads signed ordinals and bare weekdays, drops an ordinal past ±53",
      rrule: "FREQ=MONTHLY;BYDAY=2FR,-1SU,MO,60TH",
      check: (out) => expect.soft(out.byDay).toEqual(byDay("2FR,-1SU,MO")),
    },
    {
      name: "BYHOUR/BYMINUTE/BYSECOND, including the 60th leap second but not the 61st",
      rrule: "FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0,30;BYSECOND=0,60,61",
      check: (out) => {
        expect.soft(out.byHour).toEqual([9, 17]);
        expect.soft(out.byMinute).toEqual([0, 30]);
        expect.soft(out.bySecond).toEqual([0, 60]);
      },
    },
    {
      name: "BYSETPOS keeps signed positions, drops 0",
      rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1,1,0",
      check: (out) => expect.soft(out.bySetPos).toEqual([-1, 1]),
    },
  ];

  it.each(cases)("$name", ({ rrule, dtstart, check }) => {
    const text = singleVevent([dtstart ?? "DTSTART:20260302T090000Z", `RRULE:${rrule}`]);
    const { events } = fromIcs(text);
    expect(events).toHaveLength(1);
    check(events[0]);
  });

  it("walks COUNT into `until`, counted against the raw rule before EXDATE removes anything", () => {
    const dtstart = "DTSTART:20260308T090000"; // Sunday
    const thirdRawInstant = ms("2026-03-10 09:00");

    const withoutExdate = fromIcs(singleVevent([dtstart, "RRULE:FREQ=DAILY;COUNT=3"])).events[0];
    const withExdate = fromIcs(
      singleVevent([dtstart, "RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20260309T090000"]),
    ).events[0];

    expect.soft(withoutExdate.until).toBeSameInstantAs(thirdRawInstant);
    // Excluding the middle day still spends one of the three counted slots —
    // COUNT is walked before EXDATE is applied, so `until` does not move.
    expect.soft(withExdate.until).toBeSameInstantAs(thirdRawInstant);
  });
});

/* --------------------------------- RRULE emission ---------------------------------- */

describe("RRULE emission", () => {
  it("emits parts in RFC part order (FREQ, INTERVAL, WKST, BY* in ABNF order, UNTIL last) and round-trips every one", () => {
    const ev = event({
      title: "Everything",
      start: "2026-03-06 09:30",
      end: "2026-03-06 10:00",
      repeat: "monthly",
      interval: 2,
      wkst: 0,
      byMonth: [3, 6],
      byWeekNo: [10, -20],
      byYearDay: [100, -1],
      byMonthDay: [15, -1],
      byDay: byDay("2FR,-1SU"),
      byHour: [9],
      byMinute: [30],
      bySecond: [0],
      bySetPos: [1, -1],
      until: ms("2026-12-31 23:59:59"),
    });
    const text = toIcs([ev], "Work");
    // Reverses folding by hand — the parsed `Recurrence` no longer carries
    // RRULE's part order, which is what this case is checking.
    const rruleLine = text
      .replace(/\r\n[ \t]/g, "")
      .split("\r\n")
      .find((l) => l.startsWith("RRULE:"));
    expect(rruleLine).toBeDefined();
    const partNames = rruleLine!
      .slice("RRULE:".length)
      .split(";")
      .map((p) => p.split("=")[0]);
    expect(partNames).toEqual([
      "FREQ",
      "INTERVAL",
      "WKST",
      "BYMONTH",
      "BYWEEKNO",
      "BYYEARDAY",
      "BYMONTHDAY",
      "BYDAY",
      "BYHOUR",
      "BYMINUTE",
      "BYSECOND",
      "BYSETPOS",
      "UNTIL",
    ]);

    const out = fromIcs(text).events[0];
    expect.soft(out.repeat).toBe("monthly");
    expect.soft(out.interval).toBe(2);
    expect.soft(out.wkst).toBe(0);
    expect.soft(out.byMonth).toEqual([3, 6]);
    expect.soft(out.byWeekNo).toEqual([10, -20]);
    expect.soft(out.byYearDay).toEqual([100, -1]);
    expect.soft(out.byMonthDay).toEqual([15, -1]);
    expect.soft(out.byDay).toEqual(byDay("2FR,-1SU"));
    expect.soft(out.byHour).toEqual([9]);
    expect.soft(out.byMinute).toEqual([30]);
    expect.soft(out.bySecond).toEqual([0]);
    expect.soft(out.bySetPos).toEqual([1, -1]);
    expect.soft(out.until).toBeSameInstantAs(ev.until);
  });
});

/* ------------------------------ EXDATE / RDATE parsing ------------------------------ */

describe("EXDATE / RDATE across several lines", () => {
  it("reads EXDATE spread over several lines, including several comma-separated values on one", () => {
    // EXDATE/RDATE only mean anything alongside a rule — the model has no
    // way to express extra/excluded instants on a one-off event — so this
    // needs an RRULE present, same as `readRecurrence` requires.
    const text = singleVevent([
      "DTSTART:20260301T090000Z",
      "RRULE:FREQ=DAILY",
      "EXDATE;VALUE=DATE:20260310,20260317",
      "EXDATE:20260324T090000Z",
      "EXDATE:20260331T090000Z,20260407T090000Z",
    ]);
    const { events } = fromIcs(text);
    expect(events[0].exdates).toEqual([
      "2026-03-10",
      "2026-03-17",
      "2026-03-24T10:00:00", // CET, +1 — before the Mar 29 DST jump
      "2026-03-31T11:00:00", // CEST, +2 — after it
      "2026-04-07T11:00:00",
    ]);
  });

  it("reads RDATE spread over several lines and de-duplicates a value repeated across two", () => {
    const text = singleVevent([
      "DTSTART:20260301T090000Z",
      "RRULE:FREQ=DAILY",
      "RDATE;VALUE=DATE:20260315",
      "RDATE;VALUE=DATE:20260315,20260322", // 20260315 repeated — must not double up
      "RDATE:20260329T090000Z",
    ]);
    const { events } = fromIcs(text);
    expect(events[0].rdates).toEqual([
      "2026-03-15",
      "2026-03-22",
      "2026-03-29T11:00:00", // Mar 29 2026 is transition day; 09:00 UTC is already CEST
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * RDATE without RRULE.
 *
 * EXDATE and RDATE are properties of the VEVENT, not of the RRULE, and
 * RFC 5545 allows a series made of RDATEs alone. `readRecurrence` used
 * to return a bare `NEVER` whenever RRULE was absent, dropping both
 * lists with it — a producer that names its dates explicitly lost every
 * one of them at the door.
 *
 * The model was always ready for it: `repeats()` is true for rdates
 * with `repeat: "never"`, and `startsBetween` adds them whatever the
 * frequency.
 * ------------------------------------------------------------------ */

describe("RDATE and EXDATE survive a VEVENT with no RRULE", () => {
  const noRrule = singleVevent([
    "DTSTART:20260308T090000",
    "DTEND:20260308T100000",
    "SUMMARY:Board meeting",
    "RDATE:20260415T090000,20260617T090000",
    "EXDATE:20260308T090000",
  ]);

  it("keeps the RDATEs", () => {
    const [parsed] = fromIcs(noRrule).events;
    expect(parsed.repeat).toBe("never");
    expect(parsed.rdates).toEqual(["2026-04-15T09:00:00", "2026-06-17T09:00:00"]);
  });

  it("keeps the EXDATEs", () => {
    const [parsed] = fromIcs(noRrule).events;
    expect(parsed.exdates).toEqual(["2026-03-08T09:00:00"]);
  });

  it("expands into a real series, seed excluded", () => {
    const [parsed] = fromIcs(noRrule).events;
    // The seed is EXDATEd out, so the whole event is the two named dates.
    expect(startsBetween(parsed, parsed.start, ms("2026-01-01"), ms("2027-01-01"))).toOccurOn([
      "2026-04-15",
      "2026-06-17",
    ]);
  });

  it("still yields NEVER when there are no date lists either", () => {
    const plain = singleVevent(["DTSTART:20260308T090000", "DTEND:20260308T100000"]);
    const [parsed] = fromIcs(plain).events;
    expect(parsed.rdates).toEqual([]);
    expect(parsed.exdates).toEqual([]);
  });

  it("drops the rule but keeps the dates when FREQ is unreadable", () => {
    const bogus = singleVevent([
      "DTSTART:20260308T090000",
      "DTEND:20260308T100000",
      "RRULE:FREQ=FORTNIGHTLY",
      "RDATE:20260415T090000",
    ]);
    const [parsed] = fromIcs(bogus).events;
    expect(parsed.repeat).toBe("never");
    expect(parsed.rdates).toEqual(["2026-04-15T09:00:00"]);
  });
});

/* ------------------- RECURRENCE-ID;RANGE=THISANDFUTURE --------------------- *
 * "this occurrence and every one after it" is two series rather than one
 * patched occurrence, which is what `splitRule` already does for an in-app
 * edit. Read here, in `fromIcs`, because both consumers link overrides
 * themselves and one of them getting it wrong is a series that draws twice. */

describe("RANGE=THISANDFUTURE", () => {
  const UID = "standup@example.com";
  const SERIES = [
    `UID:${UID}`,
    "DTSTART:20260302T090000",
    "DTEND:20260302T093000",
    "SUMMARY:Standup",
    "RRULE:FREQ=WEEKLY",
  ];

  /** From the 16th on, an hour later. */
  const MOVED = [
    `UID:${UID}`,
    "RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000",
    "DTSTART:20260316T100000",
    "DTEND:20260316T103000",
    "SUMMARY:Standup (10am from now on)",
  ];

  const parse = (...vevents: string[][]) => fromIcs(vcalendar(...vevents)).events;
  /** Six Mondays: the whole of the unsplit series, either side of the cut. */
  const window = (e: IcsEvent) => startsBetween(e, e.start, ms("2026-03-01"), ms("2026-04-13"));

  it("promotes the override to a series of its own, with a stable uid", () => {
    const [head, tail] = parse(SERIES, MOVED);
    expect.soft(parse(SERIES, MOVED)).toHaveLength(2);
    expect.soft(head.uid).toBe(UID);
    // Both halves of the id are stable across pulls, so the arc it draws is
    // the same node next time — see `derivedUid` for why that matters.
    expect.soft(tail.uid).toBe(`${UID}#2026-03-16T09:00:00`);
    // It is not an override any more: nothing should suppress an instance
    // for it, and both consumers key a parent off `recurrenceId === ""`.
    expect.soft(tail.recurrenceId).toBe("");
    expect.soft(tail.title).toBe("Standup (10am from now on)");
  });

  it("stops the head the instant before the cut", () => {
    const [head] = parse(SERIES, MOVED);
    expect.soft(head.until).toBe(ms("2026-03-16 09:00") - 1);
    expect(window(head)).toBeInstants(["2026-03-02 09:00", "2026-03-09 09:00"]);
  });

  it("continues the parent's cadence from the override's own DTSTART", () => {
    const [, tail] = parse(SERIES, MOVED);
    expect.soft(tail.repeat).toBe("weekly");
    expect(window(tail)).toBeInstants([
      "2026-03-16 10:00",
      "2026-03-23 10:00",
      "2026-03-30 10:00",
      "2026-04-06 10:00",
    ]);
  });

  it("covers every day the unsplit series had, exactly once", () => {
    // The clock time moves at the cut; the days must not, or the split has
    // either eaten a Monday or handed one to both halves.
    const split = parse(SERIES, MOVED).flatMap(window);
    expect(split.sort((a, b) => a - b)).toOccurOn([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
      "2026-03-30",
      "2026-04-06",
    ]);
  });

  it("folds a chained split left, onto the tail that now owns the instant", () => {
    // The 30th is 10:00 by the time this cut lands, because the first cut
    // moved it — naming 09:00 here would be naming an instant nothing emits.
    const again = [
      `UID:${UID}`,
      "RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T100000",
      "DTSTART:20260330T110000",
      "DTEND:20260330T113000",
      "SUMMARY:Standup (11am)",
    ];
    const events = parse(SERIES, MOVED, again);
    expect.soft(events).toHaveLength(3);
    expect.soft(events[2].uid).toBe(`${UID}#2026-03-30T10:00:00`);
    expect.soft(window(events[0])).toBeInstants(["2026-03-02 09:00", "2026-03-09 09:00"]);
    expect.soft(window(events[1])).toBeInstants(["2026-03-16 10:00", "2026-03-23 10:00"]);
    expect.soft(window(events[2])).toBeInstants(["2026-03-30 11:00", "2026-04-06 11:00"]);
  });

  it("re-points an ordinary override past the cut at the new series", () => {
    const once = [
      `UID:${UID}`,
      "RECURRENCE-ID:20260323T100000",
      "DTSTART:20260323T140000",
      "DTEND:20260323T143000",
      "SUMMARY:Standup (afternoon, once)",
    ];
    const [, tail, override] = parse(SERIES, MOVED, once);
    // Left on the head, nothing suppresses the tail's own 23rd and the day
    // draws both — the rule `store.splitSeries` applies for the same reason.
    expect.soft(override.uid).toBe(tail.uid);
    expect.soft(override.recurrenceId).toBe("2026-03-23T10:00:00");
  });

  it("leaves an ordinary override before the cut on the head", () => {
    const once = [
      `UID:${UID}`,
      "RECURRENCE-ID:20260309T090000",
      "DTSTART:20260309T140000",
      "DTEND:20260309T143000",
      "SUMMARY:Standup (afternoon, once)",
    ];
    const [head, , override] = parse(SERIES, MOVED, once);
    expect(override.uid).toBe(head.uid);
  });

  it("absorbs the head when the cut lands on the series' own first instant", () => {
    const always = [
      `UID:${UID}`,
      "RECURRENCE-ID;RANGE=THISANDFUTURE:20260302T090000",
      "DTSTART:20260302T100000",
      "DTEND:20260302T103000",
      "SUMMARY:Standup (always was 10am)",
    ];
    const events = parse(SERIES, always);
    // A head bounded before its own seed generates nothing, so two events
    // here would be one live series beside a dead one.
    expect.soft(events).toHaveLength(1);
    expect.soft(events[0].uid).toBe(UID);
    expect.soft(events[0].repeat).toBe("weekly");
    expect(window(events[0])[0]).toBeSameInstantAs("2026-03-02 10:00");
  });

  it("partitions the parent's EXDATEs at the cut", () => {
    const renamed = [
      `UID:${UID}`,
      "RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000",
      "DTSTART:20260316T090000",
      "DTEND:20260316T093000",
      "SUMMARY:Standup (renamed)",
    ];
    const [head, tail] = parse([...SERIES, "EXDATE:20260309T090000,20260406T090000"], renamed);
    expect.soft(head.exdates).toEqual(["2026-03-09T09:00:00"]);
    // Not copied to both: a future EXDATE left on the head is inert there,
    // and the day the sender skipped comes back on the tail.
    expect.soft(tail.exdates).toEqual(["2026-04-06T09:00:00"]);
    expect(window(tail)).toBeInstants(["2026-03-16 09:00", "2026-03-23 09:00", "2026-03-30 09:00"]);
  });

  it("keeps the tail's own RRULE rather than inheriting the parent's", () => {
    const fortnightly = [
      `UID:${UID}`,
      "RECURRENCE-ID;RANGE=THISANDFUTURE:20260316T090000",
      "DTSTART:20260316T090000",
      "DTEND:20260316T093000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2",
      "SUMMARY:Standup (fortnightly now)",
    ];
    const [, tail] = parse(SERIES, fortnightly);
    expect.soft(tail.interval).toBe(2);
    expect(window(tail)).toBeInstants(["2026-03-16 09:00", "2026-03-30 09:00"]);
  });

  it("reads the param whatever case it arrives in", () => {
    const lower = MOVED.map((line) =>
      line.startsWith("RECURRENCE-ID") ? "RECURRENCE-ID;RANGE=thisandfuture:20260316T090000" : line,
    );
    expect(parse(SERIES, lower)[1].recurrenceId).toBe("");
  });

  it("leaves a plain RECURRENCE-ID alone", () => {
    const patched = MOVED.map((line) =>
      line.startsWith("RECURRENCE-ID") ? "RECURRENCE-ID:20260316T090000" : line,
    );
    const [head, override] = parse(SERIES, patched);
    expect.soft(head.until).toBe(0);
    expect.soft(override.uid).toBe(UID);
    expect.soft(override.recurrenceId).toBe("2026-03-16T09:00:00");
  });

  it("leaves an orphaned split as an ordinary override", () => {
    // No parent in this file to cut, so there is nothing to promote it out
    // of — and inventing a series for it would invent occurrences too.
    const [only] = parse(MOVED);
    expect.soft(only.uid).toBe(UID);
    expect.soft(only.recurrenceId).toBe("2026-03-16T09:00:00");
  });
});
