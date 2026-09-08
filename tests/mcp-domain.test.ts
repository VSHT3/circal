import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  at,
  attendee,
  calendar,
  day,
  event,
  grave,
  ms,
  plan,
  resetIds,
  task,
  taskList,
} from "./helpers";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/store";
import { MIRROR_VERSION, localZone, serialiseMirror, type MirrorContents } from "@/lib/mirror";
import type { Task } from "@/lib/tasks";
import {
  DEFAULT_WAKING,
  REMIND_INHERIT,
  REMIND_LEAD_MAX,
  REMIND_SILENT,
  TRAVEL_MAX,
  type CalEvent,
  type Calendar,
} from "@/lib/events";
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
  findCalendar,
  freeSlots,
  keyedId,
  listCalendars,
  listDay,
  listRange,
  listTasks,
  performCreateCalendar,
  performCreateEvent,
  performCreateEvents,
  performCreateTask,
  performDeleteEvent,
  performDeleteTask,
  performQuickAdd,
  performPlanTask,
  performToggleDone,
  performUpdateEvent,
  performUpdateTask,
  requireScope,
  resolveCalendar,
  resolveInstant,
  scopedToCalendar,
  searchEvents,
  syncStatus,
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
    tasks: [],
    taskLists: [],
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

it("assistant edits preserve nested lists and the task's list membership", () => {
  const root = taskList({ id: "root" });
  const child = taskList({ id: "child", parentId: root.id });
  const original = contents({
    taskLists: [root, child],
    tasks: [task({ id: "t", listId: child.id })],
  });
  const edited = performUpdateTask(original, "t", { title: "Renamed" }).mutated;
  expect(edited.tasks[0].title).toBe("Renamed");
  expect(edited.tasks[0].listId).toBe(child.id);
  expect(edited.taskLists).toEqual(original.taskLists);
});

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

  it("a task routes to the task list — see performCreateEvent's own cases", () => {
    // `buildEventRecord` never sees `task: true`; with no time named it reads
    // as an all-day event, which is what the field's absence has always meant.
    expect(build({ date: "2026-03-08" }).allDay).toBe(true);
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
    expect.soft(record.travel).toBe(0);
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
    travel: 45,
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

  it("a title-only patch carries free, travel, reminder lead and the guest list through", () => {
    const record = applyPatchToEvent(base, { title: "Standup (short)" }, cals, settings());
    expect.soft(record.title).toBe("Standup (short)");
    expect.soft(record.free).toBe(true);
    expect.soft(record.travel).toBe(45);
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

  it("a task's id answers with the task itself — one id space for the caller", () => {
    const c = contents({
      tasks: [
        task({
          id: "t",
          calendarId: CAL,
          title: "Water the plants",
          due: "2026-03-08 07:00",
          done: true,
          estimate: 30,
        }),
      ],
      events: [event({ id: "p", calendarId: CAL })],
    });
    const described = describeEvent(c, "t");
    expect.soft(described).toContain("Water the plants  (task, id=t)");
    expect.soft(described).toContain("Status: done");
    expect.soft(described).toContain("Estimate: 30m");
    expect.soft(describeEvent(c, "p")).not.toContain("Status:");
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

  it("has no task spelling left — create_task owns that record now", () => {
    // The one id space still answers for both lists elsewhere; creation does
    // not: an event tool creates events, full stop of the schema's own
    // strictness (an unknown `task` field is rejected before the handler).
    const { mutated } = performCreateEvent(contents(), {
      title: "Renew passport",
      date: "2026-03-08",
      start: "07:15",
    });
    expect.soft(mutated.tasks).toHaveLength(0);
    expect.soft(mutated.events).toHaveLength(1);
  });
});

describe("performCreateTask", () => {
  it("a timed deadline, sized and ranked", () => {
    const { mutated, message } = performCreateTask(contents(), {
      title: "Renew passport",
      date: "2026-03-08",
      time: "07:15",
      estimate: 45,
      priority: "urgent",
    });
    expect.soft(mutated.events).toHaveLength(0);
    expect.soft(mutated.tasks).toHaveLength(1);
    const t = mutated.tasks[0]!;
    expect.soft(t.due).toBe(ms("2026-03-08 07:15"));
    expect.soft(t.dueAllDay).toBe(false);
    expect.soft(t.estimate).toBe(45);
    expect.soft(t.priority).toBe(2);
    expect.soft(t.done).toBe(false);
    expect.soft(message).toContain("(task)");
  });

  it("no time means due on the day, no time on it", () => {
    const { mutated } = performCreateTask(contents(), {
      title: "Renew passport",
      date: "2026-03-08",
    });
    expect.soft(mutated.tasks[0]!.dueAllDay).toBe(true);
    expect.soft(mutated.tasks[0]!.due).toBe(ms("2026-03-08 00:00"));
  });

  it("still needs a date — everything in circal has a day", () => {
    expect(() => performCreateTask(contents(), { title: "x" })).toThrow(/a task needs "date"/);
  });
});

describe("performUpdateTask", () => {
  const base = () => contents({ tasks: [task({ id: "t1", due: "2026-03-08 09:00" })] });

  it("a new day keeps a timed deadline's own minute", () => {
    const { mutated } = performUpdateTask(base(), "t1", { date: "2026-03-10" });
    expect.soft(mutated.tasks[0]!.due).toBe(ms("2026-03-10 09:00"));
    expect.soft(mutated.tasks[0]!.dueAllDay).toBe(false);
  });

  it("a new time keeps the day; null clears the time", () => {
    const timed = performUpdateTask(base(), "t1", { time: "17:30" });
    expect.soft(timed.mutated.tasks[0]!.due).toBe(ms("2026-03-08 17:30"));
    const cleared = performUpdateTask(base(), "t1", { time: null });
    expect.soft(cleared.mutated.tasks[0]!.dueAllDay).toBe(true);
    expect.soft(cleared.mutated.tasks[0]!.due).toBe(ms("2026-03-08 00:00"));
  });

  it("estimate null clears; a patch naming nothing changes nothing but the stamp", () => {
    const sized = performUpdateTask(contents({ tasks: [task({ id: "t1", estimate: 90 })] }), "t1", {
      estimate: null,
    });
    expect.soft(sized.mutated.tasks[0]!.estimate).toBeNull();
    const before = task({ id: "t1", due: "2026-03-08 09:00", estimate: 60, priority: 1 });
    const { mutated } = performUpdateTask(contents({ tasks: [before] }), "t1", {});
    expect.soft(mutated.tasks[0]!.due).toBe(before.due);
    expect.soft(mutated.tasks[0]!.estimate).toBe(60);
    expect.soft(mutated.tasks[0]!.priority).toBe(1);
  });

  it("redirects an event's id to update_event", () => {
    const c = contents({ events: [event({ id: "e1", calendarId: CAL })] });
    expect(() => performUpdateTask(c, "e1", {})).toThrow(/is an event/);
  });
});

describe("performPlanTask", () => {
  it("books a block, length from the estimate when no end is named", () => {
    const c = contents({ tasks: [task({ id: "t1", estimate: 90 })] });
    const { mutated, message } = performPlanTask(
      c,
      "t1",
      "2026-03-09",
      "09:00",
      undefined,
      undefined,
    );
    expect
      .soft(mutated.tasks[0]!.plans)
      .toEqual([{ start: ms("2026-03-09 09:00"), end: ms("2026-03-09 10:30") }]);
    expect.soft(message).toContain("Planned");
  });

  it("keeps the plan list in start order and refuses a backwards block", () => {
    const c = contents({
      tasks: [task({ id: "t1", plans: [plan("2026-03-10 09:00", "2026-03-10 10:00")] })],
    });
    const { mutated } = performPlanTask(c, "t1", "2026-03-09", "09:00", "10:00", undefined);
    expect
      .soft(mutated.tasks[0]!.plans.map((p) => p.start))
      .toEqual([ms("2026-03-09 09:00"), ms("2026-03-10 09:00")]);
    expect(() => performPlanTask(c, "t1", "2026-03-09", "10:00", "09:00", undefined)).toThrow(
      /after "start"/,
    );
  });

  it("refuses a done task — nothing to plan", () => {
    const c = contents({ tasks: [task({ id: "t1", done: true })] });
    expect(() => performPlanTask(c, "t1", "2026-03-09", "09:00", undefined, undefined)).toThrow(
      /already done/,
    );
  });
});

describe("listTasks", () => {
  it("prints the sidebar's own groups, soonest deadline first", () => {
    const c = contents({
      tasks: [
        task({ id: "a", title: "Old", due: "2026-03-01 09:00" }),
        task({ id: "b", title: "Soon", due: "2026-03-09 09:00" }),
        task({ id: "c", title: "Far", due: "2026-06-01 09:00" }),
        task({ id: "d", title: "Ticked", due: "2026-03-09 09:00", done: true }),
      ],
    });
    const out = listTasks(c, at("2026-03-08 12:00"));
    const pos = (needle: string) => out.indexOf(needle);
    expect.soft(pos("Overdue (1):")).toBeGreaterThanOrEqual(0);
    expect.soft(pos("Due soon (1):")).toBeGreaterThan(pos("Overdue (1):"));
    expect.soft(pos("Later (1):")).toBeGreaterThan(pos("Due soon (1):"));
    expect.soft(pos("Done (1):")).toBeGreaterThan(pos("Later (1):"));
  });

  it("says so when there are none", () => {
    expect(listTasks(contents())).toBe("No tasks.");
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

  it("names a task's id for what it is rather than pretending it is missing", () => {
    const withTask = contents({ tasks: [task({ id: "t1", calendarId: CAL })] });
    expect(() => performUpdateEvent(withTask, "t1", "all", undefined, { title: "x" })).toThrow(
      /is a task/,
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

describe("performToggleDone ticks a task whole", () => {
  const c = (over: Partial<Task> = {}) =>
    contents({
      tasks: [
        task({
          id: "t1",
          calendarId: CAL,
          title: "Water the plants",
          due: "2026-03-08 07:00",
          ...over,
        }),
      ],
    });

  it("refuses an id it does not have", () => {
    expect(() => performToggleDone(contents(), "ghost", undefined)).toThrow(RefusalError);
  });

  it("refuses an event's id by saying what it is, not that it is missing", () => {
    const plain = contents({ events: [event({ id: "p", calendarId: CAL, title: "Meeting" })] });
    expect(() => performToggleDone(plain, "p", undefined)).toThrow(/is an event, not a task/);
  });

  it("ticks the task and stamps it, and the message says which way it went", () => {
    const { mutated, message } = performToggleDone(c(), "t1", undefined);
    expect.soft(mutated.tasks[0]!.done).toBe(true);
    expect.soft(mutated.tasks[0]!.updatedAt).toBeGreaterThan(0);
    expect.soft(message).toBe('Completed "Water the plants".');
  });

  it("reopens a ticked one", () => {
    const { mutated, message } = performToggleDone(c({ done: true }), "t1", undefined);
    expect.soft(mutated.tasks[0]!.done).toBe(false);
    expect.soft(message).toBe('Reopened "Water the plants".');
  });

  it("accepts and ignores an occurrence argument — nothing left to disambiguate", () => {
    expect(performToggleDone(c(), "t1", "2026-03-11").mutated.tasks[0]!.done).toBe(true);
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

/* ------------------------ issues #1–#8: agent-session fixes -------------------- */

describe("findCalendar answers an id, a unique name prefix, and nothing vaguer", () => {
  const cals = [
    calendar({ id: CAL }),
    calendar({ id: "cal-adm", name: "Admissions" }),
    calendar({ id: "cal-chores", name: "Admin chores" }),
  ];

  it("an exact id wins outright", () => {
    expect(findCalendar(CAL, cals).id).toBe(CAL);
  });

  it("a unique name prefix resolves, case-insensitively", () => {
    expect(findCalendar("admis", cals).id).toBe("cal-adm");
  });

  it("an ambiguous prefix is refused naming the candidates", () => {
    expect(() => findCalendar("adm", cals)).toThrow(/Admissions, Admin chores/);
  });

  it("an unknown reference is refused", () => {
    expect(() => findCalendar("zzz", cals)).toThrow(/no calendar with id or name "zzz"/);
  });
});

describe("scopedToCalendar filters the records, never the calendar list", () => {
  const c = contents({
    calendars: [calendar({ id: CAL }), calendar({ id: "cal-adm", name: "Admissions" })],
    events: [event({ id: "e1", calendarId: CAL }), event({ id: "e2", calendarId: "cal-adm" })],
    tasks: [task({ id: "t1", calendarId: "cal-adm" }), task({ id: "t2", calendarId: CAL })],
  });

  it("keeps only the named calendar's events and tasks", () => {
    const scoped = scopedToCalendar(c, "Admissions");
    expect.soft(scoped.events.map((e) => e.id)).toEqual(["e2"]);
    expect.soft(scoped.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect.soft(scoped.calendars).toHaveLength(2);
  });

  it("no reference means the whole document, untouched", () => {
    expect(scopedToCalendar(c, undefined)).toBe(c);
  });
});

describe("a not-found answer reads the graves before pleading ignorance", () => {
  it("a graved id names the deletion instead of imitating a typo", () => {
    const c = contents({ graves: [grave("x-dead", "2026-03-01 12:00")] });
    expect.soft(() => describeEvent(c, "x-dead")).toThrow(/deleted 2026-03-01T/);
    expect.soft(() => describeEvent(c, "x-dead")).toThrow(/grave for it is in the document/);
    expect.soft(() => performUpdateTask(c, "x-dead", {})).toThrow(/grave/);
  });

  it("an app-shaped id with no grave hints at another writer", () => {
    expect(() =>
      performUpdateEvent(contents(), "m8s3kq1x-a1b2c3", undefined, undefined, {}),
    ).toThrow(/another writer may have dropped/);
  });

  it("a plain typo stays a plain not-found", () => {
    expect(() => performToggleDone(contents(), "ghost", undefined)).toThrow(
      /no task with id "ghost"$/,
    );
  });
});

describe("syncStatus prints the envelope and the document's shape", () => {
  it("rev, format version, zone, transport and counts, each named", () => {
    const c = contents({
      rev: 227,
      events: [event({ id: "e1", calendarId: CAL })],
      graves: [grave("g", "2026-03-01 00:00")],
    });
    const text = syncStatus(c, "file /tmp/calendar.json");
    expect.soft(text).toContain("rev 227");
    expect.soft(text).toContain(`format version ${MIRROR_VERSION}`);
    expect.soft(text).toContain(localZone());
    expect.soft(text).toContain("Transport: file /tmp/calendar.json");
    expect.soft(text).toContain("1 events, 0 tasks, 1 calendars, 1 graves");
  });

  it("an unrecorded zone is said, not left blank", () => {
    expect(syncStatus(contents({ zone: "" }), "file f")).toContain("(unrecorded)");
  });
});

describe("performCreateEvent with a key upserts instead of duplicating", () => {
  const key = "timeline:kaist-early";
  const fields = { title: "Deadline", date: "2026-10-22", start: "11:00" };

  it("creates under the key's own id", () => {
    const { mutated } = performCreateEvent(contents(), fields, key);
    expect(mutated.events[0]!.id).toBe(keyedId(key));
  });

  it("re-running with the same key updates in place — the mirror converges", () => {
    const first = performCreateEvent(contents(), fields, key);
    const c = contents({ events: [...first.mutated.events] });
    const second = performCreateEvent(c, { ...fields, title: "Deadline moved" }, key);
    expect.soft(second.mutated.events).toHaveLength(1);
    expect.soft(second.mutated.events[0]!.title).toBe("Deadline moved");
    expect.soft(second.message).toContain(`Updated (by key "${key}")`);
  });

  it("a field the re-run omits keeps its value — a patch, not a replace", () => {
    const first = performCreateEvent(contents(), { ...fields, notes: "bring forms" }, key);
    const c = contents({ events: [...first.mutated.events] });
    const second = performCreateEvent(c, fields, key);
    expect(second.mutated.events[0]!.notes).toBe("bring forms");
  });

  it("a keyed create outranks a prior deletion — the source re-asserts, as documented", () => {
    // The app deleted the mirrored record; the next mirror run recreates it
    // with a fresh stamp that wins over the grave. Deliberate: the key is
    // identity, so dropping a record for good means removing it at the
    // source — the sentence the key schema carries.
    const c = contents({ graves: [grave(keyedId(key), "2026-03-01 12:00")] });
    const { mutated } = performCreateEvent(c, fields, key);
    expect.soft(mutated.events[0]!.id).toBe(keyedId(key));
    expect.soft(mutated.events[0]!.updatedAt).toBeGreaterThan(ms("2026-03-01 12:00"));
  });

  it("an unbounded or control-character key is refused — a paste, not a key", () => {
    expect.soft(() => performCreateEvent(contents(), fields, "a".repeat(65))).toThrow(/"key"/);
    expect.soft(() => performCreateEvent(contents(), fields, "line\nbreak")).toThrow(/"key"/);
  });
});

describe("performCreateEvents lands the whole batch in one write, or none of it", () => {
  it("creates every record and reports one line each", () => {
    const { mutated, message } = performCreateEvents(contents(), [
      { title: "A", date: "2026-03-08", start: "09:00" },
      { title: "B", date: "2026-03-09", start: "10:00" },
    ]);
    expect.soft(mutated.events).toHaveLength(2);
    expect.soft(message.split("\n")).toHaveLength(2);
  });

  it("one bad record refuses the batch, naming which", () => {
    expect(() =>
      performCreateEvents(contents(), [
        { title: "A", date: "2026-03-08", start: "09:00" },
        { title: "B", date: "2026-03-09", start: "not a time" },
      ]),
    ).toThrow(/event 2 of 2/);
  });

  it("an empty batch is refused", () => {
    expect(() => performCreateEvents(contents(), [])).toThrow(RefusalError);
  });

  it("two entries sharing a key converge on one record inside the batch", () => {
    const { mutated } = performCreateEvents(contents(), [
      { title: "A", date: "2026-03-08", start: "09:00", key: "k" },
      { title: "A2", date: "2026-03-08", start: "09:30", key: "k" },
    ]);
    expect.soft(mutated.events).toHaveLength(1);
    expect.soft(mutated.events[0]!.title).toBe("A2");
  });
});

describe("the calendar a write lands on is named, pinned, or loudly defaulted", () => {
  const timed = { title: "x", date: "2026-03-08", start: "09:00" };
  const two = () =>
    contents({
      calendars: [calendar({ id: CAL }), calendar({ id: "cal-adm", name: "Admissions" })],
    });

  it("a defaulted create says so in its summary", () => {
    expect(performCreateEvent(contents(), timed).message).toContain(
      "— calendar defaulted, not named",
    );
  });

  it("a named calendar carries no marker", () => {
    expect(performCreateEvent(contents(), { ...timed, calendarId: CAL }).message).not.toContain(
      "defaulted",
    );
  });

  it("a pin catches writes that name no calendar, and is not a defaulting", () => {
    const { mutated, message } = performCreateEvent(two(), timed, undefined, "Admissions");
    expect.soft(mutated.events[0]!.calendarId).toBe("cal-adm");
    expect.soft(message).not.toContain("defaulted");
  });

  it("a named calendar beats the pin", () => {
    const { mutated } = performCreateEvent(
      two(),
      { ...timed, calendarId: CAL },
      undefined,
      "Admissions",
    );
    expect(mutated.events[0]!.calendarId).toBe(CAL);
  });

  it("create_task and quick_add speak the same marker and take the same pin", () => {
    expect
      .soft(performCreateTask(contents(), { title: "t", date: "2026-03-08" }).message)
      .toContain("defaulted, not named");
    expect
      .soft(performQuickAdd(contents(), "lunch tomorrow 1pm", "2026-03-08").message)
      .toContain("defaulted, not named");
    expect
      .soft(performQuickAdd(contents(), "lunch tomorrow 1pm", "2026-03-08", CAL).message)
      .not.toContain("defaulted");
  });

  it("a pin naming a subscription is refused at the write", () => {
    const c = contents({ calendars: [calendar({ id: CAL }), feed()] });
    expect(() => performCreateEvent(c, timed, undefined, "Holidays")).toThrow(/subscription/);
  });
});

describe("remindLead crosses the tool boundary loudly or not at all", () => {
  const make = (remindLead: number | "inherit" | "silent") =>
    performCreateEvent(contents(), { title: "x", date: "2026-03-08", start: "09:00", remindLead });

  it("minutes are stored as given; the two words spell the two non-minute states", () => {
    expect.soft(make(10_080).mutated.events[0]!.remindLead).toBe(10_080);
    expect.soft(make("silent").mutated.events[0]!.remindLead).toBe(REMIND_SILENT);
    expect.soft(make("inherit").mutated.events[0]!.remindLead).toBe(REMIND_INHERIT);
  });

  it("an omitted lead inherits — never a warning the agent was not asked for", () => {
    const { mutated } = performCreateEvent(contents(), {
      title: "x",
      date: "2026-03-08",
      start: "09:00",
    });
    expect(mutated.events[0]!.remindLead).toBe(REMIND_INHERIT);
  });

  it("a patch not naming the lead keeps a silenced event silent", () => {
    const c = contents({
      events: [event({ id: "e1", calendarId: CAL, remindLead: REMIND_SILENT })],
    });
    const { mutated } = performUpdateEvent(c, "e1", undefined, undefined, { title: "renamed" });
    expect(mutated.events[0]!.remindLead).toBe(REMIND_SILENT);
  });

  it("a patch naming one sets it, and describe prints it", () => {
    const c = contents({ events: [event({ id: "e1", calendarId: CAL })] });
    const { mutated } = performUpdateEvent(c, "e1", undefined, undefined, { remindLead: 60 });
    expect.soft(mutated.events[0]!.remindLead).toBe(60);
    expect
      .soft(describeEvent(contents({ events: [...mutated.events] }), "e1"))
      .toContain("Remind: 1h before");
  });

  it("an out-of-range lead is refused, not silently read as inherit", () => {
    expect.soft(() => make(REMIND_LEAD_MAX + 1)).toThrow(/remindLead/);
    expect.soft(() => make(-3)).toThrow(/remindLead/);
    expect.soft(() => make(2.5)).toThrow(/remindLead/);
  });
});

describe("travel crosses the tool boundary on both paths, or not at all", () => {
  it("a create names the run-up and it is stored as given", () => {
    const { mutated } = performCreateEvent(contents(), {
      title: "Dentist",
      date: "2026-03-08",
      start: "09:30",
      travel: 25,
    });
    expect(mutated.events[0]!.travel).toBe(25);
  });

  it("a patch naming it sets it on an event created without one", () => {
    const c = contents({ events: [event({ id: "e1", calendarId: CAL })] });
    const { mutated } = performUpdateEvent(c, "e1", undefined, undefined, { travel: 40 });
    expect(mutated.events[0]!.travel).toBe(40);
  });

  it("a patch not naming it cannot erase a run-up somebody typed", () => {
    const c = contents({ events: [event({ id: "e1", calendarId: CAL, travel: 45 })] });
    const { mutated } = performUpdateEvent(c, "e1", undefined, undefined, { title: "renamed" });
    expect(mutated.events[0]!.travel).toBe(45);
  });

  it("an out-of-range value reads as no travel, the field's own absent value", () => {
    const make = (travel: number) =>
      performCreateEvent(contents(), { title: "x", date: "2026-03-08", start: "09:00", travel })
        .mutated.events[0]!.travel;
    expect.soft(make(TRAVEL_MAX + 1)).toBe(0);
    expect.soft(make(-30)).toBe(0);
    expect.soft(make(12.5)).toBe(0);
  });
});

describe("a foreign zone reads the times on that clock and stays on the event", () => {
  const kaist = (date: string) =>
    performCreateEvent(contents(), {
      title: "KAIST deadline",
      date,
      start: "18:00",
      duration: 60,
      zone: "Asia/Seoul",
    });

  it("22 Oct 18:00 KST is 11:00 in Berlin, stamped Asia/Seoul", () => {
    const e = kaist("2026-10-22").mutated.events[0]!;
    expect.soft(e.start).toBe(ms("2026-10-22 11:00"));
    expect.soft(e.end).toBe(ms("2026-10-22 12:00"));
    expect.soft(e.tzid).toBe("Asia/Seoul");
  });

  it("the same wall time after Berlin's fall-back is 10:00 — the shift is per instant", () => {
    expect(kaist("2026-10-26").mutated.events[0]!.start).toBe(ms("2026-10-26 10:00"));
  });

  it("the summary prints both clocks", () => {
    expect(kaist("2026-10-22").message).toContain("11:00–12:00 (18:00–19:00 Asia/Seoul)");
  });

  it("describe prints the zone line", () => {
    const { mutated } = kaist("2026-10-22");
    expect(
      describeEvent(contents({ events: [...mutated.events] }), mutated.events[0]!.id),
    ).toContain("Zone: Asia/Seoul — 18:00–19:00 there");
  });

  it("an unknown zone is refused loudly, never silently floating", () => {
    expect(() =>
      performCreateEvent(contents(), {
        title: "x",
        date: "2026-10-22",
        start: "18:00",
        zone: "Mars/Olympus",
      }),
    ).toThrow(/not an IANA time zone/);
  });

  it("an all-day event refuses a zone — a date has no clock", () => {
    expect(() =>
      performCreateEvent(contents(), { title: "x", date: "2026-10-22", zone: "Asia/Seoul" }),
    ).toThrow(/all-day/);
  });

  it("a patch naming only the zone re-reads the wall time on the new clock", () => {
    const c = contents({
      events: [
        event({ id: "e1", calendarId: CAL, start: "2026-10-22 18:00", end: "2026-10-22 19:00" }),
      ],
    });
    const { mutated } = performUpdateEvent(c, "e1", undefined, undefined, { zone: "Asia/Seoul" });
    expect.soft(mutated.events[0]!.start).toBe(ms("2026-10-22 11:00"));
    expect.soft(mutated.events[0]!.tzid).toBe("Asia/Seoul");
  });

  it('a patched time speaks the event\'s own zone; zone "" floats the wall time back', () => {
    const first = kaist("2026-10-22");
    const c = contents({ events: [...first.mutated.events] });
    const id = first.mutated.events[0]!.id;
    const moved = performUpdateEvent(c, id, undefined, undefined, { start: "20:00", duration: 60 });
    expect.soft(moved.mutated.events[0]!.start).toBe(ms("2026-10-22 13:00"));
    expect.soft(moved.mutated.events[0]!.tzid).toBe("Asia/Seoul");
    const floated = performUpdateEvent(c, id, undefined, undefined, { zone: "" });
    expect.soft(floated.mutated.events[0]!.tzid).toBe("");
    expect.soft(floated.mutated.events[0]!.start).toBe(ms("2026-10-22 18:00"));
  });
});

describe("performDeleteTask deletes with a grave, and the two delete verbs agree", () => {
  const withTask = () => contents({ tasks: [task({ id: "t1", title: "Renew passport" })] });

  it("removes the task and buries the id", () => {
    const { mutated, message } = performDeleteTask(withTask(), "t1");
    expect.soft(mutated.tasks).toHaveLength(0);
    expect.soft(mutated.graves.map((g) => g.id)).toContain("t1");
    expect.soft(message).toContain('Deleted the task "Renew passport"');
  });

  it("delete_event on the same id produces the same removal", () => {
    const viaEvent = performDeleteEvent(withTask(), "t1", undefined, undefined);
    expect.soft(viaEvent.mutated.tasks).toHaveLength(0);
    expect.soft(viaEvent.mutated.graves.map((g) => g.id)).toContain("t1");
  });

  it("an event's id is redirected", () => {
    const c = contents({ events: [event({ id: "e1", calendarId: CAL })] });
    expect(() => performDeleteTask(c, "e1")).toThrow(/is an event/);
  });
});

describe("search names the field a hit matched when it was not the title", () => {
  const c = contents({
    events: [
      event({ id: "a", calendarId: CAL, title: "Dentist" }),
      event({ id: "b", calendarId: CAL, title: "Errand", notes: "pick up dentist forms" }),
      event({ id: "l", calendarId: CAL, title: "Meeting", location: "Dentist street 5" }),
    ],
    tasks: [task({ id: "t", title: "Chores", notes: "book dentist" })],
  });
  const lineFor = (id: string) =>
    searchEvents(c, "dentist")
      .split("\n")
      .find((l) => l.includes(`id=${id}`))!;

  it("a title hit carries no marker — the default reading", () => {
    expect(lineFor("a")).not.toContain("matched");
  });

  it("notes and location hits say so, tasks included", () => {
    expect.soft(lineFor("b")).toContain("matched notes");
    expect.soft(lineFor("l")).toContain("matched location");
    expect.soft(lineFor("t")).toContain("matched notes");
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
        tasks: [],
        taskLists: [],
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
