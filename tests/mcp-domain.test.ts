import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attendee, calendar, day, event, ms, resetIds } from "./helpers";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/store";
import { MIRROR_VERSION, localZone, serialiseMirror, type MirrorContents } from "@/lib/mirror";
import { DEFAULT_WAKING, type CalEvent, type Calendar } from "@/lib/events";
import { instantKey } from "@/lib/recur";
import { RefusalError } from "../mcp/file";
import { runFind } from "../mcp/find";
import {
  MAX_RANGE_DAYS,
  MAX_RANGE_OCCURRENCES,
  applyPatchToEvent,
  assertDateKey,
  buildEventRecord,
  describeEvent,
  freeSlots,
  listCalendars,
  listDay,
  listRange,
  performCreateCalendar,
  performCreateEvent,
  performDeleteEvent,
  performQuickAdd,
  performToggleDone,
  performUpdateEvent,
  requireScope,
  resolveCalendar,
  resolveInstant,
  searchEvents,
} from "../mcp/domain";

/**
 * The MCP server's decision layer. Everything *under* it is covered next door
 * — `mutate.ts`, `recur.ts`, `dayAgenda`, `readEvent`, `parseQuickAdd` — so
 * what is pinned here is only what this file alone decides: which arguments it
 * refuses rather than guesses, what a missing field means, what a patch keeps,
 * and what the text it hands back actually says (the caps in particular, since
 * a truncation an agent is not told about is a lie by omission).
 */

const CAL = "cal-work";
const FEED = "cal-feed";

const feed = (over: Partial<Calendar> = {}) =>
  calendar({
    id: FEED,
    name: "Holidays",
    feed: { url: "https://example.test/h.ics", fetchedAt: 0, error: "" },
    ...over,
  });

function contents(over: Partial<MirrorContents> = {}): MirrorContents {
  return {
    events: [],
    calendars: [calendar({ id: CAL })],
    settings: DEFAULT_SETTINGS,
    settingsAt: ms("2026-03-08 09:00"),
    graves: [],
    rev: 1,
    zone: localZone(),
    version: MIRROR_VERSION,
    ...over,
  };
}

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

beforeEach(() => {
  resetIds();
});

/* --------------------------------- dates ---------------------------------- */

describe("a date argument is read strictly or refused, never coerced", () => {
  it.each([
    { name: "an ISO instant where a day key belongs", value: "2026-03-08T09:00:00Z" },
    { name: "a single-digit month", value: "2026-3-08" },
    { name: "an American order", value: "03/08/2026" },
    { name: "prose", value: "tomorrow" },
    { name: "nothing at all", value: "" },
  ])("assertDateKey refuses $name", ({ value }) => {
    expect.soft(() => assertDateKey(value)).toThrow(RefusalError);
  });

  it("assertDateKey names the field it was given, so the agent can fix the right one", () => {
    expect(() => assertDateKey("nope", "from")).toThrow(/"from" must be YYYY-MM-DD/);
  });

  it("accepts a plain local day key", () => {
    expect(() => assertDateKey("2026-03-08")).not.toThrow();
  });
});

describe("resolveInstant reads an occurrence in the event's own time of day", () => {
  const base = event({ id: "e", start: "2026-03-08 09:30", end: "2026-03-08 10:30" });

  it("a bare day means that day at the event's own time — what an exdate means", () => {
    expect(resolveInstant(base, "2026-03-15")).toBe(ms("2026-03-15 09:30"));
  });

  it("a full instant is taken as given, time of day included", () => {
    expect(resolveInstant(base, "2026-03-15T14:00:00")).toBe(ms("2026-03-15 14:00"));
  });

  it("no occurrence at all means the series' own seed", () => {
    expect(resolveInstant(base, undefined)).toBe(base.start);
  });

  it.each([
    { name: "prose", value: "next tuesday" },
    { name: "an instant with a zone suffix this app does not read", value: "2026-03-15T14:00:00Z" },
    { name: "a half-written instant", value: "2026-03-15T14:00" },
  ])("refuses $name", ({ value }) => {
    expect.soft(() => resolveInstant(base, value)).toThrow(RefusalError);
  });
});

/* --------------------------------- scope ----------------------------------- */

describe("requireScope refuses to guess which occurrences an edit meant", () => {
  const daily = event({ id: "e", repeat: "daily" });
  const once = event({ id: "e" });

  it("a repeating event with no scope is refused, and the refusal lists the three", () => {
    expect(() => requireScope(daily, undefined)).toThrow(RefusalError);
    expect(() => requireScope(daily, undefined)).toThrow(/"one".*"future".*"all"/s);
  });

  it("a garbage scope on a repeating event is refused rather than rounded to one", () => {
    expect(() => requireScope(daily, "this-one")).toThrow(RefusalError);
  });

  it.each([
    { name: "one", scope: "one" },
    { name: "future", scope: "future" },
    { name: "all", scope: "all" },
  ])("passes $name through", ({ scope }) => {
    expect.soft(requireScope(daily, scope)).toBe(scope);
  });

  it("an rdate-only event still counts as repeating", () => {
    const extra = event({ id: "e", rdates: ["2026-03-10"] });
    expect(() => requireScope(extra, undefined)).toThrow(RefusalError);
  });

  it("a one-off has only one meaning, so a scope it did not need is ignored", () => {
    expect.soft(requireScope(once, undefined)).toBe("all");
    expect.soft(requireScope(once, "nonsense")).toBe("all");
  });
});

/* ------------------------------- calendars --------------------------------- */

describe("resolveCalendar picks a writable calendar or says why it cannot", () => {
  const cals = [calendar({ id: CAL }), calendar({ id: "cal-home", name: "Home" }), feed()];

  it("an id that exists is honoured", () => {
    expect(resolveCalendar("cal-home", cals, settings()).name).toBe("Home");
  });

  it("an unknown id is refused rather than falling back to the default", () => {
    expect(() => resolveCalendar("cal-nope", cals, settings())).toThrow(/no calendar with id/);
  });

  it("a subscription named outright is refused — a feed is never written to", () => {
    expect(() => resolveCalendar(FEED, cals, settings())).toThrow(/subscription/);
  });

  it("no id falls to the setting", () => {
    expect(resolveCalendar(undefined, cals, settings({ defaultCalendar: "cal-home" })).id).toBe(
      "cal-home",
    );
  });

  it("a setting pointing at a subscription is skipped, not obeyed", () => {
    expect(resolveCalendar(undefined, cals, settings({ defaultCalendar: FEED })).id).toBe(CAL);
  });

  it("a setting pointing at a calendar that is gone falls to the first writable one", () => {
    expect(resolveCalendar(undefined, cals, settings({ defaultCalendar: "cal-deleted" })).id).toBe(
      CAL,
    );
  });

  it("nothing writable at all is refused, not invented", () => {
    expect(() => resolveCalendar(undefined, [feed()], settings())).toThrow(
      /no calendar to put this on/,
    );
  });
});

/* ------------------------------ building a record --------------------------- */

describe("buildEventRecord invents nothing the arguments did not say", () => {
  const cals = [calendar({ id: CAL })];
  const build = (input: Parameters<typeof buildEventRecord>[0]) =>
    buildEventRecord(input, cals, settings());

  it('an event with no "date" is refused', () => {
    expect(() => build({ title: "Lunch" })).toThrow(/needs "date"/);
  });

  it("no time named at all reads as all day, one day long", () => {
    const record = build({ title: "Holiday", date: "2026-03-08" });
    expect.soft(record.allDay).toBe(true);
    expect.soft(record.start).toBe(ms("2026-03-08 00:00"));
    expect.soft(record.end).toBe(ms("2026-03-09 00:00"));
  });

  /**
   * The documented meaning of `end` — "HH:MM for a timed event; YYYY-MM-DD
   * (inclusive) for an all-day one" — only holds once `allDay` is stated:
   * naming `end` at all clears `noTimeGiven`, so a day key on its own is read
   * as a timed event with a missing start. Pinned as it behaves, not as the
   * comment reads.
   */
  it('an all-day "end" is an inclusive last day', () => {
    const record = build({ title: "Trip", date: "2026-03-08", end: "2026-03-10", allDay: true });
    expect.soft(record.allDay).toBe(true);
    expect.soft(record.start).toBe(ms("2026-03-08 00:00"));
    expect.soft(record.end).toBe(ms("2026-03-11 00:00"));
  });

  it('a day-key "end" alone already means all day — the doc\'s own spelling', () => {
    const record = build({ title: "Trip", date: "2026-03-08", end: "2026-03-10" });
    expect.soft(record.allDay).toBe(true);
    expect.soft(record.start).toBe(ms("2026-03-08 00:00"));
    expect.soft(record.end).toBe(ms("2026-03-11 00:00"));
  });

  it('a day-key "end" with a named "start" is a contradiction, refused at the field', () => {
    expect(() =>
      build({ title: "Trip", date: "2026-03-08", start: "09:00", end: "2026-03-10" }),
    ).toThrow(/"end"/);
  });

  it("a start with no length borrows the user's own default duration", () => {
    const record = buildEventRecord(
      { title: "Call", date: "2026-03-08", start: "09:00" },
      cals,
      settings({ defaultDuration: 45 }),
    );
    expect.soft(record.allDay).toBe(false);
    expect.soft(record.start).toBe(ms("2026-03-08 09:00"));
    expect.soft(record.end).toBe(ms("2026-03-08 09:45"));
  });

  it("a duration is an alternative to an end, and a named end wins over the default", () => {
    expect
      .soft(build({ date: "2026-03-08", start: "09:00", duration: 30 }).end)
      .toBe(ms("2026-03-08 09:30"));
    expect
      .soft(build({ date: "2026-03-08", start: "09:00", end: "11:15" }).end)
      .toBe(ms("2026-03-08 11:15"));
  });

  it('"allDay": true wins over a time that was also named', () => {
    const record = build({ date: "2026-03-08", start: "09:00", allDay: true });
    expect.soft(record.allDay).toBe(true);
    expect.soft(record.start).toBe(ms("2026-03-08 00:00"));
  });

  it("a task is an instant and needs a start of its own", () => {
    const record = build({ date: "2026-03-08", start: "07:15", task: true });
    expect.soft(record.task).toBe(true);
    expect.soft(record.start).toBe(ms("2026-03-08 07:15"));
    expect.soft(record.end).toBe(record.start);
    expect.soft(() => build({ date: "2026-03-08", task: true })).toThrow(/a task needs "start"/);
  });

  it("a time that is not a time is refused with the field that carried it", () => {
    expect(() => build({ date: "2026-03-08", start: "half nine" })).toThrow(
      /could not read "start"/,
    );
  });

  it('a recurrence "until" is the last day an occurrence may start, inclusive', () => {
    const record = build({
      date: "2026-03-08",
      start: "09:00",
      recurrence: { repeat: "daily", until: "2026-03-10" },
    });
    expect.soft(record.repeat).toBe("daily");
    expect.soft(record.until).toBe(ms("2026-03-11 00:00") - 1);
  });

  it("a fresh rule carries no exceptions of its own", () => {
    const record = build({
      date: "2026-03-08",
      start: "09:00",
      recurrence: { repeat: "weekly", interval: 2 },
    });
    expect.soft(record.exdates).toEqual([]);
    expect.soft(record.rdates).toEqual([]);
  });

  it("no recurrence means it does not repeat", () => {
    expect(build({ date: "2026-03-08", start: "09:00" }).repeat).toBe("never");
  });

  it("the fields no tool argument names are the safe answer, not an invented one", () => {
    const record = build({ date: "2026-03-08", start: "09:00" });
    expect.soft(record.free).toBe(false);
    expect.soft(record.organizer).toBeNull();
    expect.soft(record.attendees).toEqual([]);
    expect.soft(record.attendeeCount).toBe(0);
  });
});

/* ------------------------------ patching a record --------------------------- */

describe("applyPatchToEvent keeps every field the patch did not name", () => {
  const cals = [calendar({ id: CAL }), feed()];
  const base = event({
    id: "e1",
    title: "Standup",
    start: "2026-03-08 09:00",
    end: "2026-03-08 10:30",
    location: "Room 2",
    notes: "bring the laptop",
    free: true,
    remindLead: 30,
    attendees: [attendee("ada@example.test", "accepted")],
    attendeeCount: 1,
    repeat: "daily",
    exdates: ["2026-03-09"],
  });

  it('"just move it an hour" does not also reset its length', () => {
    const record = applyPatchToEvent(base, { start: "10:00" }, cals, settings());
    expect.soft(record.start).toBe(ms("2026-03-08 10:00"));
    expect.soft(record.end).toBe(ms("2026-03-08 11:30"));
  });

  it("a title-only patch carries free, reminder lead and the guest list through", () => {
    const record = applyPatchToEvent(base, { title: "Standup (short)" }, cals, settings());
    expect.soft(record.title).toBe("Standup (short)");
    expect.soft(record.free).toBe(true);
    expect.soft(record.remindLead).toBe(30);
    expect.soft(record.attendees).toEqual(base.attendees);
    expect.soft(record.attendeeCount).toBe(1);
    expect.soft(record.location).toBe("Room 2");
    expect.soft(record.notes).toBe("bring the laptop");
  });

  it("a patch that names no rule keeps the base's rule and its exceptions", () => {
    const record = applyPatchToEvent(base, { title: "x" }, cals, settings());
    expect.soft(record.repeat).toBe("daily");
    expect.soft(record.exdates).toEqual(["2026-03-09"]);
  });

  it("a patch that names a rule replaces it outright, exceptions included", () => {
    const record = applyPatchToEvent(base, { recurrence: { repeat: "weekly" } }, cals, settings());
    expect.soft(record.repeat).toBe("weekly");
    expect.soft(record.exdates).toEqual([]);
  });

  it('the default anchor is the series\' own seed — an "all" edit', () => {
    const record = applyPatchToEvent(base, { start: "11:00" }, cals, settings());
    expect(record.start).toBe(ms("2026-03-08 11:00"));
  });

  it('an anchored patch lands on the occurrence\'s day — a "one"/"future" edit', () => {
    const record = applyPatchToEvent(
      base,
      { start: "11:00" },
      cals,
      settings(),
      ms("2026-03-11 09:00"),
    );
    expect.soft(record.start).toBe(ms("2026-03-11 11:00"));
    expect.soft(record.end).toBe(ms("2026-03-11 12:30"));
  });

  it("an anchored patch that names no time keeps the occurrence's own time of day", () => {
    const record = applyPatchToEvent(
      base,
      { title: "moved" },
      cals,
      settings(),
      ms("2026-03-11 09:00"),
    );
    expect.soft(record.start).toBe(ms("2026-03-11 09:00"));
    expect.soft(record.end).toBe(ms("2026-03-11 10:30"));
  });

  it('an explicit "date" beats the anchor\'s day', () => {
    const record = applyPatchToEvent(
      base,
      { date: "2026-04-01" },
      cals,
      settings(),
      ms("2026-03-11 09:00"),
    );
    expect(record.start).toBe(ms("2026-04-01 09:00"));
  });

  it("an all-day event keeps its own width when the patch only moves it", () => {
    const trip = event({
      id: "e2",
      allDay: true,
      start: "2026-03-08 00:00",
      end: "2026-03-11 00:00",
    });
    const record = applyPatchToEvent(trip, { date: "2026-04-01" }, cals, settings());
    expect.soft(record.allDay).toBe(true);
    expect.soft(record.start).toBe(ms("2026-04-01 00:00"));
    expect.soft(record.end).toBe(ms("2026-04-04 00:00"));
  });

  it("a patch may not move an event onto a subscription", () => {
    expect(() => applyPatchToEvent(base, { calendarId: FEED }, cals, settings())).toThrow(
      /subscription/,
    );
  });

  it("an unnamed calendar keeps the base's own, even when it is not the default", () => {
    const home = calendar({ id: "cal-home", name: "Home" });
    const onHome = event({ id: "e3", calendarId: "cal-home" });
    const record = applyPatchToEvent(
      onHome,
      { title: "x" },
      [calendar({ id: CAL }), home],
      settings(),
    );
    expect(record.calendarId).toBe("cal-home");
  });
});

/* ---------------------------- read-only tools -------------------------------- */

describe("listDay says how many occurrences and never leaves a section blank", () => {
  const c = contents({
    events: [
      event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", end: "2026-03-08 10:00" }),
      event({
        id: "b",
        calendarId: CAL,
        allDay: true,
        start: "2026-03-08 00:00",
        end: "2026-03-09 00:00",
      }),
    ],
  });

  it("counts both halves of the agenda in the header", () => {
    expect(listDay(c, "2026-03-08").split("\n")[0]).toBe("2026-03-08 — 2 occurrences");
  });

  it("singularises a lone occurrence", () => {
    const one = contents({ events: [c.events[0]!] });
    expect(listDay(one, "2026-03-08").split("\n")[0]).toBe("2026-03-08 — 1 occurrence");
  });

  it("an empty section says (none) rather than nothing at all", () => {
    const text = listDay(contents(), "2026-03-08");
    expect.soft(text).toContain("All day:\n  (none)");
    expect.soft(text).toContain("Timed:\n  (none)");
  });

  it("each line carries the id and the occurrence key an edit will need back", () => {
    const text = listDay(c, "2026-03-08");
    expect.soft(text).toContain("id=a");
    expect.soft(text).toContain("occurrence=2026-03-08");
  });

  it("refuses a date it cannot read", () => {
    expect(() => listDay(c, "08.03.2026")).toThrow(RefusalError);
  });
});

describe("listRange is capped, and says so when a cap bit", () => {
  it("refuses a backwards range", () => {
    expect(() => listRange(contents(), "2026-03-10", "2026-03-08")).toThrow(
      /"to" must not be before "from"/,
    );
  });

  it("a single day is a range of one, not zero", () => {
    expect(listRange(contents(), "2026-03-08", "2026-03-08")).toContain("(1 days) — 0 occurrences");
  });

  it(`refuses more than ${MAX_RANGE_DAYS} days, and names the span asked for`, () => {
    expect(() => listRange(contents(), "2026-01-01", "2027-01-02")).toThrow(
      new RegExp(`capped at ${MAX_RANGE_DAYS} days — asked for 367`),
    );
  });

  it(`accepts exactly ${MAX_RANGE_DAYS} days`, () => {
    expect(() => listRange(contents(), "2026-01-01", "2027-01-01")).not.toThrow();
  });

  it("names both offending fields by their own name", () => {
    expect.soft(() => listRange(contents(), "nope", "2026-03-08")).toThrow(/"from" must be/);
    expect.soft(() => listRange(contents(), "2026-03-08", "nope")).toThrow(/"to" must be/);
  });

  it(`stops at ${MAX_RANGE_OCCURRENCES} occurrences and says the answer was capped`, () => {
    const daily = (id: string, hour: string) =>
      event({
        id,
        calendarId: CAL,
        repeat: "daily",
        start: `2026-01-01 ${hour}:00`,
        end: `2026-01-01 ${hour}:30`,
      });
    const c = contents({ events: [daily("a", "09"), daily("b", "11"), daily("c", "13")] });
    const text = listRange(c, "2026-01-01", "2026-12-31");
    const header = text.split("\n")[0]!;
    expect.soft(header).toContain(`— ${MAX_RANGE_OCCURRENCES} occurrences`);
    expect.soft(header).toContain(`capped at ${MAX_RANGE_OCCURRENCES}`);
    expect
      .soft(text.split("\n").filter((l) => l.startsWith("  ")).length)
      .toBe(MAX_RANGE_OCCURRENCES);
  });

  it("an uncapped answer does not claim to be capped", () => {
    const c = contents({
      events: [event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00" })],
    });
    expect(listRange(c, "2026-03-01", "2026-03-31")).not.toContain("capped");
  });

  it("an empty range says so instead of printing a bare header", () => {
    expect(listRange(contents(), "2026-03-01", "2026-03-31")).toContain("(nothing)");
  });
});

describe("searchEvents ranks, counts and truncates to the limit it was given", () => {
  const c = contents({
    events: [
      event({ id: "a", calendarId: CAL, title: "Dentist" }),
      event({ id: "b", calendarId: CAL, title: "Dentist follow-up" }),
      event({ id: "c", calendarId: CAL, title: "Yoga" }),
    ],
  });

  it("reports the number of matches, not the number of events", () => {
    expect(searchEvents(c, "dentist").split("\n")[0]).toBe('"dentist" — 2 matches');
  });

  it("singularises one match", () => {
    expect(searchEvents(c, "yoga").split("\n")[0]).toBe('"yoga" — 1 match');
  });

  it("no match says (none) rather than an empty answer", () => {
    const text = searchEvents(c, "zzz");
    expect.soft(text).toContain("0 matches");
    expect.soft(text).toContain("(none)");
  });

  it("the limit caps the list and the count with it", () => {
    const text = searchEvents(c, "dentist", 1);
    expect.soft(text.split("\n")[0]).toBe('"dentist" — 1 match');
    expect.soft(text.split("\n")).toHaveLength(2);
  });

  it("a nonsense limit returns nothing rather than a negative slice of everything", () => {
    expect(searchEvents(c, "dentist", -5)).toContain("0 matches");
  });

  it("every hit carries its id, so a follow-up tool call has one", () => {
    expect(searchEvents(c, "yoga")).toContain("id=c");
  });
});

describe("freeSlots answers inside a window, and says which window", () => {
  const busy = contents({
    events: [
      event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", end: "2026-03-08 10:00" }),
    ],
  });

  it("defaults to the user's own waking hours", () => {
    const text = freeSlots(busy, "2026-03-08", 60, undefined, undefined);
    expect.soft(text.split("\n")[0]).toContain("between 08:00 and 22:00");
    expect.soft(text).toContain("08:00–09:00");
    expect.soft(text).toContain("10:00–22:00");
  });

  it("a stored waking window is used over the built-in one", () => {
    const c = { ...busy, settings: settings({ wakingFrom: 7 * 60, wakingTo: 23 * 60 }) };
    expect(freeSlots(c, "2026-03-08", 60, undefined, undefined).split("\n")[0]).toContain(
      "between 07:00 and 23:00",
    );
  });

  it("an explicit from/to beats the setting", () => {
    const text = freeSlots(busy, "2026-03-08", 30, "12:00", "14:00");
    expect.soft(text.split("\n")[0]).toContain("between 12:00 and 14:00");
    expect.soft(text).toContain("12:00–14:00");
  });

  it("a gap shorter than asked for is not offered", () => {
    const packed = contents({
      events: [
        event({ id: "a", calendarId: CAL, start: "2026-03-08 08:00", end: "2026-03-08 21:30" }),
      ],
    });
    expect(freeSlots(packed, "2026-03-08", 60, undefined, undefined)).toContain("  (none)");
  });

  it("an empty day says nothing is booked rather than printing a zero load", () => {
    const text = freeSlots(contents(), "2026-03-08", 60, undefined, undefined);
    expect.soft(text).toContain("Nothing booked today.");
    expect.soft(text).not.toContain("Booked");
  });

  it("a booked day reports the load across the window", () => {
    expect(freeSlots(busy, "2026-03-08", 60, undefined, undefined)).toMatch(/Booked .*, free .*\./);
  });

  it.each([
    { name: "the date", args: ["08/03/2026", "12:00", "14:00"] as const },
    { name: '"from"', args: ["2026-03-08", "noonish", "14:00"] as const },
    { name: '"to"', args: ["2026-03-08", "12:00", "teatime"] as const },
  ])("refuses an unreadable $name", ({ args }) => {
    expect.soft(() => freeSlots(busy, args[0], 30, args[1], args[2])).toThrow(RefusalError);
  });

  it("the built-in waking window is the one the app itself uses", () => {
    expect([DEFAULT_WAKING.from, DEFAULT_WAKING.to]).toEqual([480, 1320]);
  });
});

describe("listCalendars marks the ones an agent must not write to", () => {
  const c = contents({
    calendars: [
      calendar({ id: CAL }),
      feed(),
      calendar({ id: "cal-x", name: "X", visible: false }),
    ],
  });

  it("a subscription is labelled read-only", () => {
    expect(listCalendars(c)).toContain(
      "Holidays — id=cal-feed — #a3d9e4 — subscription (read-only)",
    );
  });

  it("a hidden calendar is still listed, and said to be hidden", () => {
    expect(listCalendars(c)).toContain("X — id=cal-x — #a3d9e4 — hidden");
  });

  it("an ordinary calendar carries no suffix at all", () => {
    expect(listCalendars(c).split("\n")[0]).toBe("Work — id=cal-work — #a3d9e4");
  });
});

describe("describeEvent", () => {
  it("refuses an id it does not have", () => {
    expect(() => describeEvent(contents(), "ghost")).toThrow(/no event with id "ghost"/);
  });

  it("says a subscription's event is read-only where the calendar is named", () => {
    const c = contents({
      calendars: [calendar({ id: CAL }), feed()],
      events: [event({ id: "h", calendarId: FEED, title: "Bank holiday" })],
    });
    expect(describeEvent(c, "h")).toContain("Calendar: Holidays (subscription, read-only)");
  });

  it("an untitled event is named rather than left blank", () => {
    const c = contents({ events: [event({ id: "u", calendarId: CAL, title: "" })] });
    expect(describeEvent(c, "u").split("\n")[0]).toBe("Untitled  (id=u)");
  });

  it("names the series an override belongs to, so the parent can be edited instead", () => {
    const c = contents({
      events: [
        event({ id: "o", calendarId: CAL, seriesId: "parent", seriesKey: "2026-03-11T09:00:00" }),
      ],
    });
    expect(describeEvent(c, "o")).toContain("Overrides one occurrence of id=parent");
  });

  it("a task reports how many occurrences are ticked; an event says nothing about done", () => {
    const c = contents({
      events: [
        event({
          id: "t",
          calendarId: CAL,
          task: true,
          start: "2026-03-08 07:00",
          end: "2026-03-08 07:00",
          doneKeys: ["2026-03-08T07:00:00"],
        }),
        event({ id: "p", calendarId: CAL }),
      ],
    });
    expect.soft(describeEvent(c, "t")).toContain("Done: 1 occurrence ticked");
    expect.soft(describeEvent(c, "p")).not.toContain("Done:");
  });
});

/* ------------------------------- write tools ---------------------------------- */

describe("performQuickAdd refuses a line it could not read rather than filing a guess", () => {
  it("an empty line is refused", () => {
    expect(() => performQuickAdd(contents(), "   ", undefined)).toThrow(/"text" is empty/);
  });

  it("a bare title is refused, and the refusal shows what a usable line looks like", () => {
    expect(() => performQuickAdd(contents(), "lunch", undefined)).toThrow(RefusalError);
    expect(() => performQuickAdd(contents(), "lunch", undefined)).toThrow(
      /name something beyond a bare title/,
    );
  });

  it("a line with a time lands on the reference day and the default calendar", () => {
    const c = contents();
    const { mutated, message } = performQuickAdd(c, "lunch 1pm 45m", "2026-03-08");
    expect.soft(mutated.events).toHaveLength(1);
    const created = mutated.events[0]!;
    expect.soft(created.title).toBe("lunch");
    expect.soft(created.calendarId).toBe(CAL);
    expect.soft(created.start).toBe(ms("2026-03-08 13:00"));
    expect.soft(created.end).toBe(ms("2026-03-08 13:45"));
    expect.soft(message).toContain("Created lunch — [Work] — 2026-03-08 13:00–13:45");
  });

  it("a repeating line keeps its rule", () => {
    const { mutated } = performQuickAdd(contents(), "gym every monday 7am", "2026-03-08");
    expect(mutated.events[0]!.repeat).toBe("weekly");
  });

  it("a bad reference date is refused before the line is even parsed", () => {
    expect(() => performQuickAdd(contents(), "lunch 1pm", "8 March")).toThrow(RefusalError);
  });

  it("refuses when there is no writable calendar to file it on", () => {
    const c = contents({ calendars: [feed()] });
    expect(() => performQuickAdd(c, "lunch 1pm", "2026-03-08")).toThrow(
      /no calendar to put this on/,
    );
  });

  it("leaves the existing events alone and appends", () => {
    const c = contents({ events: [event({ id: "old", calendarId: CAL })] });
    const { mutated } = performQuickAdd(c, "lunch 1pm", "2026-03-08");
    expect.soft(mutated.events).toHaveLength(2);
    expect.soft(mutated.events[0]!.id).toBe("old");
    expect.soft(mutated.calendars).toBe(c.calendars);
    expect.soft(mutated.settings).toBe(c.settings);
  });
});

describe("performCreateEvent", () => {
  it("gives the new record an id and appends it", () => {
    const c = contents();
    const { mutated } = performCreateEvent(c, {
      title: "Call",
      date: "2026-03-08",
      start: "09:00",
    });
    expect.soft(mutated.events).toHaveLength(1);
    expect.soft(mutated.events[0]!.id).toBeTruthy();
    expect.soft(mutated.events[0]!.title).toBe("Call");
  });
});

describe("performUpdateEvent threads the scope through to the right mutation", () => {
  const daily = event({
    id: "e1",
    calendarId: CAL,
    title: "Standup",
    repeat: "daily",
    start: "2026-03-08 09:00",
    end: "2026-03-08 09:30",
  });
  const c = () => contents({ events: [daily] });

  it("refuses an id it does not have", () => {
    expect(() => performUpdateEvent(contents(), "ghost", "all", undefined, {})).toThrow(
      /no event with id "ghost"/,
    );
  });

  it("refuses a subscription's event before it looks at the patch", () => {
    const feedContents = contents({
      calendars: [calendar({ id: CAL }), feed()],
      events: [event({ id: "h", calendarId: FEED, title: "Bank holiday" })],
    });
    expect(() => performUpdateEvent(feedContents, "h", "all", undefined, { title: "x" })).toThrow(
      RefusalError,
    );
    expect(() => performUpdateEvent(feedContents, "h", "all", undefined, { title: "x" })).toThrow(
      /read-only/,
    );
  });

  it("refuses a repeating event with no scope", () => {
    expect(() => performUpdateEvent(c(), "e1", undefined, undefined, { title: "x" })).toThrow(
      /repeats/,
    );
  });

  it.each([
    { name: "one", scope: "one" },
    { name: "future", scope: "future" },
  ])('scope "$name" without an occurrence is refused', ({ scope }) => {
    expect
      .soft(() => performUpdateEvent(c(), "e1", scope, undefined, { title: "x" }))
      .toThrow(/needs "occurrence"/);
  });

  it('"all" edits the series in place', () => {
    const { mutated, message } = performUpdateEvent(c(), "e1", "all", undefined, {
      start: "10:00",
    });
    expect.soft(mutated.events).toHaveLength(1);
    expect.soft(mutated.events[0]!.id).toBe("e1");
    expect.soft(mutated.events[0]!.start).toBe(ms("2026-03-08 10:00"));
    expect.soft(mutated.events[0]!.end).toBe(ms("2026-03-08 10:30"));
    expect.soft(message).toContain("Updated Standup");
  });

  it('"one" adds an override pinned to that occurrence and leaves the series alone', () => {
    const { mutated, message } = performUpdateEvent(c(), "e1", "one", "2026-03-11", {
      title: "Standup (long)",
    });
    expect.soft(mutated.events).toHaveLength(2);
    const override = mutated.events[1]!;
    expect.soft(override.seriesId).toBe("e1");
    expect.soft(override.seriesKey).toBe(instantKey(ms("2026-03-11 09:00")));
    expect.soft(override.repeat).toBe("never");
    expect.soft(override.start).toBe(ms("2026-03-11 09:00"));
    expect.soft(mutated.events[0]!).toEqual(daily);
    expect.soft(message).toContain("Updated one occurrence:");
  });

  it('"future" splits the series and says from which day', () => {
    const { mutated, message } = performUpdateEvent(c(), "e1", "future", "2026-03-11", {
      start: "10:00",
    });
    expect.soft(mutated.events).toHaveLength(2);
    const created = mutated.events.find((e) => e.id !== "e1")!;
    expect.soft(created.start).toBe(ms("2026-03-11 10:00"));
    expect.soft(created.repeat).toBe("daily");
    expect.soft(message).toContain("Updated from 2026-03-11 on:");
  });

  it("a one-off ignores the scope it did not need", () => {
    const once = contents({ events: [event({ id: "s", calendarId: CAL, title: "Once" })] });
    const { mutated } = performUpdateEvent(once, "s", undefined, undefined, { title: "Once more" });
    expect.soft(mutated.events).toHaveLength(1);
    expect.soft(mutated.events[0]!.title).toBe("Once more");
  });
});

describe("performDeleteEvent deletes exactly as much as the scope allowed", () => {
  const daily = event({
    id: "e1",
    calendarId: CAL,
    title: "Standup",
    repeat: "daily",
    start: "2026-03-08 09:00",
    end: "2026-03-08 09:30",
    exdates: ["2026-03-09T09:00:00"],
  });
  const c = () => contents({ events: [daily] });

  it("refuses an id it does not have", () => {
    expect(() => performDeleteEvent(contents(), "ghost", "all", undefined)).toThrow(RefusalError);
  });

  it("refuses a subscription's event", () => {
    const feedContents = contents({
      calendars: [calendar({ id: CAL }), feed()],
      events: [event({ id: "h", calendarId: FEED })],
    });
    expect(() => performDeleteEvent(feedContents, "h", "all", undefined)).toThrow(/read-only/);
  });

  it("refuses a repeating event with no scope", () => {
    expect(() => performDeleteEvent(c(), "e1", undefined, undefined)).toThrow(/repeats/);
  });

  it('"all" removes the series and says so', () => {
    const { mutated, message } = performDeleteEvent(c(), "e1", "all", undefined);
    expect.soft(mutated.events).toEqual([]);
    expect.soft(message).toBe('Deleted "Standup" (the whole series).');
  });

  it('"one" adds the occurrence as an exception and keeps the ones already there', () => {
    const { mutated, message } = performDeleteEvent(c(), "e1", "one", "2026-03-11");
    expect.soft(mutated.events).toHaveLength(1);
    expect
      .soft(mutated.events[0]!.exdates)
      .toEqual(["2026-03-09T09:00:00", instantKey(ms("2026-03-11 09:00"))]);
    expect.soft(message).toBe('Deleted "Standup" on 2026-03-11 only — the series continues.');
  });

  it('"future" truncates instead of removing, and says from which day', () => {
    const { mutated, message } = performDeleteEvent(c(), "e1", "future", "2026-03-11");
    expect.soft(mutated.events).toHaveLength(1);
    expect.soft(mutated.events[0]!.until).toBeLessThan(ms("2026-03-11 09:00"));
    expect.soft(message).toBe('Deleted "Standup" from 2026-03-11 on.');
  });

  it("an untitled event is named in the message rather than leaving quotes empty", () => {
    const blank = contents({ events: [event({ id: "b", calendarId: CAL, title: "" })] });
    expect(performDeleteEvent(blank, "b", undefined, undefined).message).toContain('"Untitled"');
  });
});

describe("performToggleDone ticks one occurrence at a time", () => {
  const task = event({
    id: "t1",
    calendarId: CAL,
    title: "Water the plants",
    task: true,
    repeat: "daily",
    start: "2026-03-08 07:00",
    end: "2026-03-08 07:00",
  });
  const c = (over: Partial<CalEvent> = {}) => contents({ events: [{ ...task, ...over }] });

  it("refuses an id it does not have", () => {
    expect(() => performToggleDone(contents(), "ghost", undefined)).toThrow(RefusalError);
  });

  it("refuses an event that is not a task", () => {
    const plain = contents({ events: [event({ id: "p", calendarId: CAL, title: "Meeting" })] });
    expect(() => performToggleDone(plain, "p", undefined)).toThrow(/"Meeting" is not a task/);
  });

  it("refuses a subscription's task", () => {
    const feedContents = contents({
      calendars: [calendar({ id: CAL }), feed()],
      events: [{ ...task, id: "h", calendarId: FEED }],
    });
    expect(() => performToggleDone(feedContents, "h", undefined)).toThrow(/read-only/);
  });

  it("ticks only the occurrence it was given, never the series", () => {
    const { mutated, message } = performToggleDone(c(), "t1", "2026-03-11");
    expect.soft(mutated.events[0]!.doneKeys).toEqual([instantKey(ms("2026-03-11 07:00"))]);
    expect.soft(message).toBe('Completed "Water the plants" on 2026-03-11.');
  });

  it("a repeating task takes no scope: no occurrence means the seed", () => {
    const { mutated, message } = performToggleDone(c(), "t1", undefined);
    expect.soft(mutated.events[0]!.doneKeys).toEqual([instantKey(ms("2026-03-08 07:00"))]);
    expect.soft(message).toContain("on 2026-03-08.");
  });

  it("a ticked occurrence is reopened, and the message says which way it went", () => {
    const already = c({ doneKeys: [instantKey(ms("2026-03-11 07:00"))] });
    const { mutated, message } = performToggleDone(already, "t1", "2026-03-11");
    expect.soft(mutated.events[0]!.doneKeys).toEqual([]);
    expect.soft(message).toBe('Reopened "Water the plants" on 2026-03-11.');
  });

  it("refuses an occurrence argument it cannot read", () => {
    expect(() => performToggleDone(c(), "t1", "next tuesday")).toThrow(RefusalError);
  });
});

describe("performCreateCalendar", () => {
  it("refuses a blank name", () => {
    expect(() => performCreateCalendar(contents(), "   ", undefined, undefined)).toThrow(
      /needs a "name"/,
    );
  });

  it("trims the name and appends the calendar with an id of its own", () => {
    const c = contents();
    const { mutated, message } = performCreateCalendar(c, "  Side project  ", undefined, undefined);
    expect.soft(mutated.calendars).toHaveLength(2);
    const created = mutated.calendars[1]!;
    expect.soft(created.name).toBe("Side project");
    expect.soft(created.id).toBeTruthy();
    expect.soft(created.visible).toBe(true);
    expect.soft(created.feed).toBeUndefined();
    expect.soft(message).toContain(`Created calendar "Side project" — id=${created.id}`);
  });

  it("takes a colour and icon when given, and picks a palette colour when not", () => {
    const given = performCreateCalendar(contents(), "Gym", "#ff0000", "barbell").mutated
      .calendars[1]!;
    expect.soft(given.color).toBe("#ff0000");
    expect.soft(given.icon).toBe("barbell");
    const picked = performCreateCalendar(contents(), "Gym", undefined, undefined).mutated
      .calendars[1]!;
    expect.soft(picked.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect.soft(picked.icon).toBe("");
  });

  it("leaves the events and settings untouched", () => {
    const c = contents({ events: [event({ id: "a", calendarId: CAL })] });
    const { mutated } = performCreateCalendar(c, "New", undefined, undefined);
    expect.soft(mutated.events).toBe(c.events);
    expect.soft(mutated.settings).toBe(c.settings);
  });
});

/* --------------------------------- --find ------------------------------------ */

describe("--find reports the mirror files it can actually read", () => {
  let home = "";
  let logged: string[] = [];
  let log: MockInstance<(...args: unknown[]) => void>;

  const mirror = (events: CalEvent[] = []) =>
    serialiseMirror(
      {
        events,
        calendars: [calendar({ id: CAL })],
        settings: DEFAULT_SETTINGS,
        settingsAt: 0,
        graves: [],
      },
      7,
    );

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "circal-find-"));
    logged = [];
    log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(async () => {
    log.mockRestore();
    await rm(home, { recursive: true, force: true });
  });

  const output = () => logged.join("\n");

  it("finds a mirror file in the home root and reports what is in it", async () => {
    const path = join(home, "calendar.json");
    await writeFile(path, mirror([event({ id: "a", calendarId: CAL, start: day("2026-03-08") })]));
    await runFind(home);
    expect.soft(output()).toContain("Found 1 circal mirror file:");
    expect.soft(output()).toContain(path);
    expect.soft(output()).toContain("events: 1, calendars: 1");
    expect.soft(output()).toContain("rev: 7");
  });

  it("suggests a config that points at the file it found", async () => {
    const path = join(home, "calendar.json");
    await writeFile(path, mirror());
    await runFind(home);
    expect.soft(output()).toContain(`"--file"`);
    expect.soft(output()).toContain(`claude mcp add circal -- npx -y circal-mcp --file ${path}`);
  });

  it("a .json that is not a mirror file is not reported as one", async () => {
    await writeFile(join(home, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    await writeFile(join(home, "broken.json"), "{ not json");
    await runFind(home);
    expect.soft(output()).toContain("No circal mirror file found.");
    expect.soft(output()).not.toContain("tsconfig.json");
  });

  it("lists where it looked when it found nothing, so the answer is actionable", async () => {
    await runFind(home);
    expect.soft(output()).toContain(join(home, "Library", "Application Support", "circal"));
    expect.soft(output()).toContain(join(home, "Documents"));
    expect.soft(output()).toContain("Settings panel");
  });

  /**
   * `Documents` is a root of its own, so `Documents/deep` is one of *its*
   * subdirectories and is read. The bound is one level under each root, which
   * is two under `home` along a named root — three is where it stops.
   */
  it("descends one level under each root, and no further", async () => {
    await mkdir(join(home, "Documents", "deep", "deeper"), { recursive: true });
    await writeFile(join(home, "Documents", "near.json"), mirror());
    await writeFile(join(home, "Documents", "deep", "far.json"), mirror());
    await writeFile(join(home, "Documents", "deep", "deeper", "buried.json"), mirror());
    await runFind(home);
    expect.soft(output()).toContain(join(home, "Documents", "near.json"));
    expect.soft(output()).toContain(join(home, "Documents", "deep", "far.json"));
    expect.soft(output()).not.toContain("buried.json");
  });

  it("never descends into node_modules, Library or a dotted directory", async () => {
    for (const dir of ["node_modules", "Library", ".cache"]) {
      await mkdir(join(home, dir), { recursive: true });
      await writeFile(join(home, dir, "calendar.json"), mirror());
    }
    await runFind(home);
    expect(output()).toContain("No circal mirror file found.");
  });

  it("finds the macOS app's own default, which the Library skip would otherwise hide", async () => {
    const dir = join(home, "Library", "Application Support", "circal");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "calendar.json"), mirror());
    await runFind(home);
    expect(output()).toContain(join(dir, "calendar.json"));
  });

  it("counts several files, and picks the first for the config", async () => {
    await mkdir(join(home, "Documents"), { recursive: true });
    await writeFile(join(home, "a-calendar.json"), mirror());
    await writeFile(join(home, "Documents", "b-calendar.json"), mirror());
    await runFind(home);
    expect.soft(output()).toContain("Found 2 circal mirror files:");
    expect.soft(output()).toContain(`--file ${join(home, "Documents", "b-calendar.json")}`);
  });
});
