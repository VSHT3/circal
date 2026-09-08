import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "./helpers";
import { MemoryStorage, attendee, calendar, event, ms, plan, task, taskList } from "./helpers";
import {
  readBackup,
  readEvent,
  readSettings,
  readCalendar,
  readTask,
  backupDue,
} from "@/lib/backup";
import { DEFAULT_SETTINGS } from "@/lib/store";
import {
  ATTENDEE_MAX,
  GUEST_ADDRESS_MAX,
  GUEST_NAME_MAX,
  NEVER,
  REMIND_INHERIT,
  REMIND_SILENT,
  TRAVEL_MAX,
  type CalEvent,
} from "@/lib/events";
import { placeForZone } from "@/lib/places";

/* ---------------------------------------------------------------------- *
 * This module is the only place a backup file — hand-edited, corrupted,
 * or written by a future/older version of the app — gets to touch the
 * live store. Every case here is something such a file could actually
 * contain.
 * ---------------------------------------------------------------------- */

const START = ms("2026-03-08 09:00");
const END = ms("2026-03-08 10:00");
const baseEvent = { start: START, end: END };

it("reads nested lists and membership from backups without inventing lists in old backups", () => {
  const root = taskList({ id: "root" });
  const child = taskList({ id: "child", parentId: root.id });
  const legacy = { app: "circal", calendars: [calendar()], tasks: [{ id: "old", due: START }] };
  const old = readBackup(legacy);
  expect(old.ok && old.taskLists).toEqual([]);
  expect(old.ok && old.tasks[0].listId).toBe("");
  const restored = readBackup({
    ...legacy,
    taskLists: [root, child, { id: "broken", name: " " }, null],
    tasks: [task({ listId: child.id })],
  });
  expect(restored.ok && restored.taskLists).toEqual([root, child]);
  expect(restored.ok && restored.tasks[0].listId).toBe(child.id);
});

/* ---------------------------------- readEvent --------------------------- */

describe("readEvent — rejects", () => {
  it.each([
    { name: "a non-object", value: "not an event" },
    { name: "an array", value: [1, 2, 3] },
    { name: "null", value: null },
  ])("$name", ({ value }) => {
    expect(readEvent(value)).toBeNull();
  });

  // The source comment: an unreadable event must be dropped rather than
  // become an arc of the whole day. Pin every way `start`/`end` go bad.
  it.each([
    { name: "missing start", value: { ...baseEvent, start: undefined } },
    { name: "missing end", value: { ...baseEvent, end: undefined } },
    { name: "non-numeric start", value: { ...baseEvent, start: "9am" } },
    { name: "non-numeric end", value: { ...baseEvent, end: "10am" } },
    { name: "NaN start", value: { ...baseEvent, start: NaN } },
    { name: "NaN end", value: { ...baseEvent, end: NaN } },
    { name: "Infinity start", value: { ...baseEvent, start: Infinity } },
    { name: "Infinity end", value: { ...baseEvent, end: Infinity } },
    { name: "end equal to start", value: { ...baseEvent, end: START } },
    { name: "end before start", value: { ...baseEvent, end: START - 1000 } },
  ])("drops the event on $name rather than drawing an arc of the whole day", ({ value }) => {
    expect(readEvent(value)).toBeNull();
  });
});

describe("readEvent — defaults", () => {
  it("titles an untitled event rather than leaving it blank", () => {
    expect(readEvent({ ...baseEvent })?.title).toBe("Untitled");
  });

  it("derives the same id every time it reads the same record", () => {
    // It was `Math.random()`, so a backup imported twice was two copies of
    // every event with nothing left to tell they were one.
    const once = readEvent({ ...baseEvent, title: "Standup", location: "Room 2" });
    const again = readEvent({ ...baseEvent, title: "Standup", location: "Room 2" });
    expect(once?.id).toMatch(new RegExp(`^${START}-`));
    expect(again?.id).toBe(once?.id);
  });

  it.each([
    { name: "a different title", patch: { title: "Retro" } },
    { name: "a different place", patch: { location: "Room 3" } },
    { name: "a different end", patch: { end: END + 60_000 } },
    { name: "the instance it overrides", patch: { seriesKey: "2026-03-15T09:00:00" } },
  ])("gives a different id to a record with $name", ({ patch }) => {
    const base = readEvent({ ...baseEvent, title: "Standup", location: "Room 2" });
    const other = readEvent({ ...baseEvent, title: "Standup", location: "Room 2", ...patch });
    expect.soft(other?.id).not.toBe(base?.id);
  });

  it("keeps a given id rather than generating one", () => {
    expect(readEvent({ ...baseEvent, id: "evt-1" })?.id).toBe("evt-1");
  });

  it("falls back to no calendar when calendarId is absent", () => {
    expect(readEvent({ ...baseEvent })?.calendarId).toBe("");
  });

  it.each(["location", "url", "notes", "color"] as const)(
    'falls back to "" for a wrong-typed %s',
    (field) => {
      expect.soft(readEvent({ ...baseEvent, [field]: 42 })?.[field]).toBe("");
      expect.soft(readEvent({ ...baseEvent, [field]: null })?.[field]).toBe("");
      expect.soft(readEvent({ ...baseEvent, [field]: {} })?.[field]).toBe("");
    },
  );

  it.each([
    { name: "a recognised IANA zone", value: "America/New_York", expected: "America/New_York" },
    { name: "an unrecognised zone", value: "Not/AZone", expected: "" },
    { name: "an empty string", value: "", expected: "" },
    { name: "a wrong-typed value", value: 42, expected: "" },
  ])("tzid $name reads as $expected — a hostile tzid is refused", ({ value, expected }) => {
    expect(readEvent({ ...baseEvent, tzid: value })?.tzid).toBe(expected);
  });

  it.each([
    { input: true, expected: true },
    { input: "true", expected: false },
    { input: 1, expected: false },
    { input: undefined, expected: false },
  ])(
    "allDay $input reads as $expected — only a literal true turns it on",
    ({ input, expected }) => {
      expect(readEvent({ ...baseEvent, allDay: input })?.allDay).toBe(expected);
    },
  );

  // The same rule for the same reason: a truthy string in a hand-edited or
  // hostile backup must not quietly take an hour off the day's booked total.
  it.each([
    { input: true, expected: true },
    { input: "TRANSPARENT", expected: false },
    { input: 1, expected: false },
    { input: undefined, expected: false },
  ])("free $input reads as $expected — only a literal true means free", ({ input, expected }) => {
    expect(readEvent({ ...baseEvent, free: input })?.free).toBe(expected);
  });

  // A bounded number rather than a boolean, so the hostile cases are the ones
  // in between: a negative run-up draws backwards out of the arc and one over
  // the ceiling dashes the whole ring. `TRAVEL_MAX` is 1440, so a full
  // revolution is legal and a minute more is not. Where those bounds live is
  // `events.ts`, pinned there — this asserts the reader asks rather than
  // deciding for itself.
  it.each([
    { name: "absent", input: undefined, expected: 0 },
    { name: "null", input: null, expected: 0 },
    { name: "a string", input: "20", expected: 0 },
    { name: "a negative", input: -5, expected: 0 },
    { name: "a fraction of a minute", input: 19.5, expected: 0 },
    { name: "a minute past the ceiling", input: TRAVEL_MAX + 1, expected: 0 },
    { name: "no travel written out", input: 0, expected: 0 },
    { name: "a commute somebody typed", input: 25, expected: 25 },
    { name: "the ceiling itself", input: TRAVEL_MAX, expected: TRAVEL_MAX },
  ])("travel: $name", ({ input, expected }) => {
    expect(readEvent({ ...baseEvent, travel: input })?.travel).toBe(expected);
  });

  // Not a boolean but a number with a range, so the hostile cases are the
  // ones in between: every unreadable value comes back inheriting, which is
  // what an event exported before this field existed already was. What the
  // legal ones are lives in `remind.ts` and is pinned there — this asserts
  // that this reader asks it rather than deciding for itself.
  it.each([
    { name: "a lead the panel offers", input: 15, expected: 15 },
    { name: "silence", input: REMIND_SILENT, expected: REMIND_SILENT },
    { name: "as it starts", input: 0, expected: 0 },
    { name: "absent", input: undefined, expected: REMIND_INHERIT },
    { name: "a string", input: "15", expected: REMIND_INHERIT },
    { name: "a negative that is neither state", input: -7, expected: REMIND_INHERIT },
    { name: "a lead a decade long", input: 5_000_000, expected: REMIND_INHERIT },
  ])("remindLead: $name", ({ input, expected }) => {
    expect(readEvent({ ...baseEvent, remindLead: input })?.remindLead).toBe(expected);
  });

  // The guest list is the one field on this model that arrives from a stranger
  // and has no natural length, so this reader is where the caps are enforced.
  // What the numbers are lives in `events.ts` and is pinned in
  // `tests/events.test.ts` — these assert that this boundary asks it.
  it("reads an organiser and a guest list a backup actually carried", () => {
    const read = readEvent({
      ...baseEvent,
      organizer: { name: "Ada", address: "ada@example.com" },
      attendees: [{ name: "Grace", address: "grace@example.com", status: "accepted" }],
      attendeeCount: 1,
    });
    expect.soft(read?.organizer).toEqual({ name: "Ada", address: "ada@example.com" });
    expect.soft(read?.attendees).toEqual([attendee("grace@example.com", "accepted", "Grace")]);
    expect.soft(read?.attendeeCount).toBe(1);
  });

  it.each([
    { name: "a string", value: "ada@example.com" },
    { name: "a record with no address", value: { name: "Ada" } },
    { name: "absent", value: undefined },
  ])("organizer $name reads as nobody rather than a blank row", ({ value }) => {
    expect(readEvent({ ...baseEvent, organizer: value })?.organizer).toBeNull();
  });

  it("drops the guest rows that name nobody and keeps the event", () => {
    const read = readEvent({
      ...baseEvent,
      attendees: [{ name: "Ghost" }, 7, null, { address: "grace@example.com" }],
    });
    expect.soft(read).not.toBeNull();
    expect.soft(read?.attendees).toEqual([attendee("grace@example.com")]);
    expect.soft(read?.attendeeCount).toBe(1);
  });

  it("caps a hostile guest list rather than refusing the event", () => {
    // A mailing-list invitation is thousands of addresses inside one shared
    // `localStorage` quota. Losing the calendar entry over the length of its
    // guest list would be the wrong trade, and the count keeps the loss visible.
    const read = readEvent({
      ...baseEvent,
      // Distinct in the *prefix*, because de-duplication is on the address as
      // it will be stored: two addresses that differ only past the cap are one
      // stored row, and RFC 5321 says no real mailbox is that long anyway.
      attendees: Array.from({ length: 5000 }, (_, i) => ({
        name: "N".repeat(500),
        address: `${i}${"a".repeat(500)}@example.com`,
      })),
    });
    expect.soft(read?.attendees).toHaveLength(ATTENDEE_MAX);
    expect.soft(read?.attendeeCount).toBe(5000);
    for (const guest of read?.attendees ?? []) {
      expect.soft(guest.name.length).toBeLessThanOrEqual(GUEST_NAME_MAX);
      expect.soft(guest.address.length).toBeLessThanOrEqual(GUEST_ADDRESS_MAX);
    }
  });

  it("never lets the stored count understate the list it labels", () => {
    // "and −2 others" is a truncation announcing itself backwards.
    const read = readEvent({
      ...baseEvent,
      attendees: [{ address: "a@x.com" }, { address: "b@x.com" }, { address: "c@x.com" }],
      attendeeCount: 1,
    });
    expect(read?.attendeeCount).toBe(3);
  });

  it("fills every recurrence field with NEVER's shape when none are given at all", () => {
    const result = readEvent({ ...baseEvent }) as CalEvent;
    const {
      repeat,
      interval,
      until,
      wkst,
      byMonth,
      byWeekNo,
      byYearDay,
      byMonthDay,
      byDay,
      byHour,
      byMinute,
      bySecond,
      bySetPos,
      exdates,
      rdates,
    } = result;
    expect({
      repeat,
      interval,
      until,
      wkst,
      byMonth,
      byWeekNo,
      byYearDay,
      byMonthDay,
      byDay,
      byHour,
      byMinute,
      bySecond,
      bySetPos,
      exdates,
      rdates,
    }).toEqual(NEVER);
  });
});

/* ------------------------------ readRecurrence --------------------------- */

describe("readRecurrence bounds (through readEvent)", () => {
  // Validation is frequency-agnostic, so one repeating frequency exercises
  // every BY* bound; "yearly" is used throughout so every field is legal to
  // set in the first place.
  const withRule = (patch: Record<string, unknown>) =>
    readEvent({ ...baseEvent, repeat: "yearly", ...patch }) as CalEvent;

  type Case = { name: string; patch: Record<string, unknown>; check: (e: CalEvent) => void };

  const cases: Case[] = [
    {
      name: "interval 0 divides by nothing, so it clamps to 1",
      patch: { interval: 0 },
      check: (e) => expect.soft(e.interval).toBe(1),
    },
    {
      name: "negative interval clamps to 1",
      patch: { interval: -5 },
      check: (e) => expect.soft(e.interval).toBe(1),
    },
    {
      name: "fractional interval truncates",
      patch: { interval: 2.7 },
      check: (e) => expect.soft(e.interval).toBe(2),
    },
    {
      name: "interval above MAX_INTERVAL clamps to 999",
      patch: { interval: 5000 },
      check: (e) => expect.soft(e.interval).toBe(999),
    },
    {
      name: "byMonth drops 0 and 13, a day the calendar does not have",
      patch: { byMonth: [0, 13, 6] },
      check: (e) => expect.soft(e.byMonth).toEqual([6]),
    },
    {
      name: "byMonthDay drops 0, 32 and -32, keeps a real day",
      patch: { byMonthDay: [0, 32, -32, 15] },
      check: (e) => expect.soft(e.byMonthDay).toEqual([15]),
    },
    {
      name: "byYearDay drops 0 and 367, keeps a real day",
      patch: { byYearDay: [0, 367, -1] },
      check: (e) => expect.soft(e.byYearDay).toEqual([-1]),
    },
    {
      name: "byWeekNo drops 0 and 54, keeps a real week",
      patch: { byWeekNo: [0, 54, -1] },
      check: (e) => expect.soft(e.byWeekNo).toEqual([-1]),
    },
    {
      name: "byHour drops 24, a fictional hour",
      patch: { byHour: [24, 5] },
      check: (e) => expect.soft(e.byHour).toEqual([5]),
    },
    {
      name: "byMinute drops 60, keeps a real minute",
      patch: { byMinute: [60, 5] },
      check: (e) => expect.soft(e.byMinute).toEqual([5]),
    },
    {
      name: "bySecond allows the 60th leap second but drops 61",
      patch: { bySecond: [60, 61, 5] },
      check: (e) => expect.soft(e.bySecond.sort()).toEqual([5, 60]),
    },
    {
      name: "an unknown frequency does not divide by zero — it resets the whole rule to NEVER",
      patch: { repeat: "fortnightly" },
      check: (e) => {
        expect.soft(e.repeat).toBe("never");
        expect.soft(e.interval).toBe(NEVER.interval);
        expect.soft(e.byMonth).toEqual(NEVER.byMonth);
      },
    },
    {
      name: "byMonth as a non-array (not just a bad member) is dropped whole",
      patch: { byMonth: "3" },
      check: (e) => expect.soft(e.byMonth).toEqual([]),
    },
    {
      name: "byDay as a non-array is dropped whole",
      patch: { byDay: "MO" },
      check: (e) => expect.soft(e.byDay).toEqual([]),
    },
  ];

  it.each(cases)("$name", ({ patch, check }) => check(withRule(patch)));

  it("drops byDay entries RFC 5545 does not have: out-of-range day, a string, null", () => {
    const result = withRule({
      byDay: [{ day: 7, nth: 0 }, { day: -1, nth: 0 }, "MO", null, { day: 1, nth: 0 }],
    });
    expect(result.byDay).toEqual([{ day: 1, nth: 0 }]);
  });

  it("drops a byDay nth outside ±5 — a sixth 'last Monday' does not exist", () => {
    const result = withRule({
      byDay: [
        { day: 1, nth: 6 },
        { day: 1, nth: -6 },
        { day: 1, nth: 5 },
      ],
    });
    expect(result.byDay).toEqual([{ day: 1, nth: 5 }]);
  });

  // The three readers each used to decide this for themselves. A rule with no
  // frequency still resets to NEVER, but an RDATE-only series is a real series
  // — `repeats()` says so — and dropping its dates with the rule is how a
  // round trip through a backup lost every date a producer named explicitly.
  it("keeps the dates a rule of 'never' still carries", () => {
    const result = readEvent({
      ...baseEvent,
      repeat: "never",
      rdates: ["2026-04-01T09:00:00", "2026-05-01"],
      exdates: ["2026-06-01"],
    }) as CalEvent;
    expect(result.repeat).toBe("never");
    expect(result.rdates).toEqual(["2026-04-01T09:00:00", "2026-05-01"]);
    expect(result.exdates).toEqual(["2026-06-01"]);
  });

  it("keeps them through an unreadable frequency too, and drops a malformed key", () => {
    const result = readEvent({
      ...baseEvent,
      repeat: "fortnightly",
      rdates: ["2026-04-01T09:00:00", "not a date", "2026-04-01T09:00:00"],
    }) as CalEvent;
    expect(result.repeat).toBe("never");
    expect(result.rdates).toEqual(["2026-04-01T09:00:00"]);
  });
});

/* --------------------------------- readSettings --------------------------- */

describe("readSettings", () => {
  it("a non-object backup blob returns DEFAULT_SETTINGS outright", () => {
    expect(readSettings("not an object")).toBe(DEFAULT_SETTINGS);
    expect(readSettings(null)).toBe(DEFAULT_SETTINGS);
  });

  it.each([
    { name: "a preset this build carries", stored: "paper", want: "paper" },
    { name: "a preset it does not", stored: "sepia", want: DEFAULT_SETTINGS.theme },
    { name: "junk", stored: 7, want: DEFAULT_SETTINGS.theme },
  ])("readSettings theme: $name → $want", ({ stored, want }) => {
    // A restored calendar must not spend one commit looking broken: an
    // unknown preset resets to midnight here rather than half-applying.
    expect(readSettings({ theme: stored }).theme).toBe(want);
  });

  it.each([
    "showZoneName",
    "showZoneOffset",
    "daylight",
    "tickSound",
    "tickHaptics",
    "ambientDim",
    "ambientDaylight",
    "ambientMoonlight",
    "backupNudge",
  ] as const)(
    "%s reads absent as on — a backup written before the switch existed came from a dial showing it",
    (field) => {
      expect.soft(readSettings({})[field]).toBe(true);
      expect.soft(readSettings({ [field]: false })[field]).toBe(false);
      // Junk that isn't the literal `false` stays on.
      expect.soft(readSettings({ [field]: "false" })[field]).toBe(true);
    },
  );

  it.each(["zoneDaylight", "zoneMoonlight", "totals", "ambientZoneRing"] as const)(
    "%s reads absent as off, and only a literal true turns it on",
    (field) => {
      expect.soft(readSettings({})[field]).toBe(false);
      expect.soft(readSettings({ [field]: true })[field]).toBe(true);
      expect.soft(readSettings({ [field]: "true" })[field]).toBe(false);
      expect.soft(readSettings({ [field]: 1 })[field]).toBe(false);
    },
  );

  // Two spellings are read; anything else is the current default, which is
  // also what a backup written before the setting existed gets.
  it.each([
    { input: "24h", expected: "24h" },
    { input: "12h", expected: "12h" },
    { input: "AM/PM", expected: DEFAULT_SETTINGS.clock },
    { input: undefined, expected: DEFAULT_SETTINGS.clock },
    { input: 24, expected: DEFAULT_SETTINGS.clock },
  ])("clock $input reads as $expected", ({ input, expected }) => {
    expect(readSettings({ clock: input }).clock).toBe(expected);
  });

  // The mode's own timer. A backup from before it existed came from a build
  // with no timer at all, which is exactly what "never" means.
  it("ambientAfter reads absent as never, and a number as itself", () => {
    expect.soft(readSettings({}).ambientAfter).toBe(0);
    expect.soft(readSettings({ ambientAfter: 10 }).ambientAfter).toBe(10);
    expect.soft(readSettings({ ambientAfter: "10" }).ambientAfter).toBe(0);
  });

  describe.each([
    { name: "both absent defaults on", value: {}, expected: true },
    { name: "legacy night: false maps to moonlight off", value: { night: false }, expected: false },
    { name: "legacy night: true maps to moonlight on", value: { night: true }, expected: true },
    {
      name: "moonlight wins when both are present (false beats legacy true)",
      value: { moonlight: false, night: true },
      expected: false,
    },
    {
      name: "moonlight wins when both are present (true beats legacy false)",
      value: { moonlight: true, night: false },
      expected: true,
    },
  ])("the legacy night key maps onto moonlight — $name", ({ value, expected }) => {
    it("resolves to the expected moonlight value", () => {
      expect(readSettings(value).moonlight).toBe(expected);
    });
  });

  describe.each([
    { name: "absent zone", value: {}, expected: null },
    {
      name: "zone with no place behind it",
      value: { place: { zone: "Etc/GMT+5" } },
      expected: null,
    },
    { name: "place is not an object", value: { place: "Europe/Berlin" }, expected: null },
    { name: "place object with no zone key", value: { place: {} }, expected: null },
    {
      name: "a known zone re-derives its coordinates",
      value: { place: { zone: "Europe/Berlin", lat: 999, lon: 999 } },
      expected: placeForZone("Europe/Berlin"),
    },
  ])(
    "place is re-derived via placeForZone, never trusted verbatim — $name",
    ({ value, expected }) => {
      it("matches the table lookup, not whatever the backup claimed", () => {
        expect(readSettings(value).place).toEqual(expected);
      });
    },
  );

  // Only the type is checked here; `sane()` is what pins the value to a mode
  // the panel can show — same division as `totalsAt`.
  it.each([
    { name: "absent, so the label default stands", value: {}, expected: "always" },
    { name: "a mode it names", value: { arcLabels: "hover" }, expected: "hover" },
    { name: "off, which is a choice", value: { arcLabels: "off" }, expected: "off" },
    { name: "a non-string", value: { arcLabels: 1 }, expected: "always" },
  ])("arcLabels reads $name", ({ value, expected }) => {
    expect(readSettings(value).arcLabels).toBe(expected);
  });

  // `weekStart`'s legal values are exactly its type's three members, so this
  // check is necessarily also the validity check — unlike `wakingFrom`/`to`
  // below, which stay real numbers of any size until `sane()` bounds them.
  it.each([
    { name: "absent, so the default stands", value: {}, expected: DEFAULT_SETTINGS.weekStart },
    { name: "a legal, non-default weekday", value: { weekStart: 0 }, expected: 0 },
    { name: "an illegal weekday", value: { weekStart: 3 }, expected: DEFAULT_SETTINGS.weekStart },
    { name: "a non-number", value: { weekStart: "0" }, expected: DEFAULT_SETTINGS.weekStart },
  ])("weekStart reads $name", ({ value, expected }) => {
    expect(readSettings(value).weekStart).toBe(expected);
  });

  it.each(["wakingFrom", "wakingTo"] as const)(
    "%s reads absent as the default, a number as itself, and anything else as the default",
    (field) => {
      expect.soft(readSettings({})[field]).toBe(DEFAULT_SETTINGS[field]);
      expect.soft(readSettings({ [field]: 100 })[field]).toBe(100);
      expect.soft(readSettings({ [field]: "100" })[field]).toBe(DEFAULT_SETTINGS[field]);
    },
  );

  // Types only, like `wakingFrom`/`to` — `sane()` is what pins an interval off
  // `BACKUP_INTERVALS` to the default, so `readSettings` keeps any real number.
  it("backupInterval reads absent as the default, a number as itself, a non-number as the default", () => {
    expect.soft(readSettings({}).backupInterval).toBe(DEFAULT_SETTINGS.backupInterval);
    expect.soft(readSettings({ backupInterval: 14 }).backupInterval).toBe(14);
    expect.soft(readSettings({ backupInterval: 999 }).backupInterval).toBe(999);
    expect
      .soft(readSettings({ backupInterval: "30" }).backupInterval)
      .toBe(DEFAULT_SETTINGS.backupInterval);
  });
});

/* ----------------------------------- backupDue ---------------------------- */

describe("backupDue", () => {
  const DAY = 86_400_000;
  const now = ms("2026-03-08 12:00");

  it("is not due one hour short of the interval", () => {
    expect(backupDue(now - (30 * DAY - 3_600_000), 30, now)).toBe(false);
  });

  it("is due exactly at the interval, and past it", () => {
    expect.soft(backupDue(now - 30 * DAY, 30, now)).toBe(true);
    expect.soft(backupDue(now - 31 * DAY, 30, now)).toBe(true);
  });

  it("a zero clock (garbage/unknown, never a fresh install) is due at once", () => {
    expect(backupDue(0, 30, now)).toBe(true);
  });

  it("a backup this instant is not due", () => {
    expect(backupDue(now, 30, now)).toBe(false);
  });

  it("reads the interval it is given, not a fixed one", () => {
    const at = now - 10 * DAY;
    expect.soft(backupDue(at, 7, now)).toBe(true);
    expect.soft(backupDue(at, 14, now)).toBe(false);
  });
});

/* --------------------------------- readCalendar ---------------------------- */

describe("readCalendar", () => {
  it.each([
    { name: "missing id", value: {} },
    { name: "empty id", value: { id: "" } },
    { name: "non-object", value: "cal-1" },
    { name: "null", value: null },
  ])("rejects $name", ({ value }) => {
    expect(readCalendar(value)).toBeNull();
  });

  it("defaults name to the id when absent", () => {
    expect(readCalendar({ id: "cal-x" })?.name).toBe("cal-x");
  });

  it("defaults color to the documented fallback when absent or empty", () => {
    expect.soft(readCalendar({ id: "cal-x" })?.color).toBe("#8ecbff");
    expect.soft(readCalendar({ id: "cal-x", color: "" })?.color).toBe("#8ecbff");
  });

  it.each([
    { input: false, expected: false },
    { input: "false", expected: true },
    { input: 0, expected: true },
    { input: undefined, expected: true },
  ])(
    "visible $input reads as $expected — only a literal false turns it off",
    ({ input, expected }) => {
      expect(readCalendar({ id: "cal-x", visible: input })?.visible).toBe(expected);
    },
  );

  it.each([
    { name: "absent", value: undefined, want: "" },
    { name: "not a string", value: 7, want: "" },
    { name: "a known Phosphor name", value: "barbell", want: "barbell" },
    // Kept rather than dropped: an unknown name renders as the dot, and a
    // backup that has been through an older build should not lose the mark.
    { name: "an unknown name", value: "unicorn", want: "unicorn" },
    { name: "an emoji", value: "🎸", want: "🎸" },
  ])("icon $name", ({ value, want }) => {
    expect(readCalendar({ id: "cal-x", icon: value })?.icon).toBe(want);
  });

  // This used to assert `toHaveLength(ICON_MAX)` — it was pinning the bug. A
  // pasted essay is lowercase ASCII, so `isIconName` calls it a name, and a
  // name is now kept whole or dropped rather than cut down to sixteen
  // characters that match no path in `marks.ts`.
  it("drops a pasted icon rather than storing a truncated one", () => {
    expect(readCalendar({ id: "cal-x", icon: "x".repeat(500) })?.icon).toBe("");
  });

  // The regression that started all of this: ten of the 247 shipped names are
  // longer than the old shared cap, and one of them is a `SEED_MARKS` entry, so
  // a brand-new install corrupted its own seed data on the first round trip.
  it.each([
    "person-simple-run",
    "dots-three-circle",
    "presentation-chart",
    "thermometer-simple",
    "person-simple-tai-chi",
    "globe-hemisphere-west",
    "currency-circle-dollar",
  ])("keeps the shipped name %s whole", (icon) => {
    expect.soft(readCalendar({ id: "cal-x", icon })?.icon).toBe(icon);
    expect.soft(readEvent({ ...baseEvent, icon })?.icon).toBe(icon);
  });

  // Same validator as an event's lead — the six-reader rule — so the table
  // here is only the boundary's own concern: absent reads as inheriting,
  // which is every calendar written before the field existed.
  it.each([
    { name: "a lead the panel offers", input: 15, expected: 15 },
    { name: "silence", input: REMIND_SILENT, expected: REMIND_SILENT },
    { name: "as it starts", input: 0, expected: 0 },
    { name: "absent", input: undefined, expected: REMIND_INHERIT },
    { name: "a string", input: "15", expected: REMIND_INHERIT },
    { name: "a negative that is neither state", input: -7, expected: REMIND_INHERIT },
  ])("remindLead: $name", ({ input, expected }) => {
    expect(readCalendar({ id: "cal-x", remindLead: input })?.remindLead).toBe(expected);
  });

  it("a feed with a string url produces a feed with fetchedAt reset to 0", () => {
    const result = readCalendar({ id: "cal-x", feed: { url: "https://example.com/f.ics" } });
    expect(result?.feed).toEqual({ url: "https://example.com/f.ics", fetchedAt: 0, error: "" });
  });

  it.each([
    { name: "no feed key at all", value: { id: "cal-x" } },
    { name: "a feed object with no url", value: { id: "cal-x", feed: {} } },
    { name: "a feed with a non-string url", value: { id: "cal-x", feed: { url: 42 } } },
  ])("$name produces no feed key at all, not a feed with an empty url", ({ value }) => {
    expect(readCalendar(value)).not.toHaveProperty("feed");
  });
});

/* --------------------------------- readTask -------------------------------- */

describe("readTask", () => {
  const baseTask = { id: "t1", due: ms("2026-03-08 18:30") };

  it.each([
    { name: "a non-object", value: "not a task" },
    { name: "null", value: null },
    { name: "missing id", value: { due: ms("2026-03-08 18:30") } },
    { name: "empty id", value: { id: "", due: ms("2026-03-08 18:30") } },
    // Everything in circal has a day: a task with no readable deadline is a
    // record no surface could ever find.
    { name: "missing due", value: { id: "t1" } },
    { name: "a string due", value: { id: "t1", due: "friday" } },
    { name: "a NaN due", value: { id: "t1", due: NaN } },
  ])("drops $name", ({ value }) => {
    expect(readTask(value)).toBeNull();
  });

  it("fills the fields a minimal record leaves out, each with its own default", () => {
    const read = readTask(baseTask)!;
    expect.soft(read.title).toBe("Untitled");
    expect.soft(read.dueAllDay).toBe(false);
    expect.soft(read.estimate).toBeNull();
    expect.soft(read.priority).toBe(0);
    expect.soft(read.plans).toEqual([]);
    expect.soft(read.done).toBe(false);
    expect.soft(read.updatedAt).toBe(0);
  });

  it("clamps through the field validators — one opinion per field, tasks.ts's own", () => {
    const read = readTask({
      ...baseTask,
      estimate: 100_000,
      priority: 9,
      plans: [
        { start: ms("2026-03-09 10:00"), end: ms("2026-03-09 09:00") },
        plan("2026-03-09 09:00", "2026-03-09 10:00"),
      ],
      done: "yes",
    })!;
    expect.soft(read.estimate).toBe(24 * 60);
    expect.soft(read.priority).toBe(0);
    expect.soft(read.plans).toEqual([plan("2026-03-09 09:00", "2026-03-09 10:00")]);
    // A truthy string is not a tick: only a literal `true` finishes work.
    expect.soft(read.done).toBe(false);
  });

  it("round-trips a full task unchanged", () => {
    const full = task({
      title: "Renew passport",
      notes: "bring photos",
      estimate: 45,
      priority: 2,
      plans: [plan("2026-03-09 09:00", "2026-03-09 10:00")],
      done: true,
      updatedAt: ms("2026-03-08 09:00"),
    });
    expect(readTask(full)).toEqual(full);
  });
});

/* --------------------------------- importBackup ---------------------------- */

describe("importBackup", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Dynamic import is intentional here, not incidental: `backup.ts` and
  // `store.ts` hold module-scope singleton state (the in-memory snapshot),
  // so a fresh instance per test — via `vi.resetModules()` above plus a
  // re-import — is the only way to isolate one test's restore from the next.
  async function load() {
    const backup = await import("@/lib/backup");
    const { store } = await import("@/lib/store");
    return { backup, store };
  }

  it("parks an event on the first calendar when its own calendar was not carried", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" }), calendar({ id: "cal-b" })],
        events: [event({ id: "e1", calendarId: "cal-missing" })],
      }),
    );
    const snap = store.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].calendarId).toBe("cal-a");
  });

  it("does not reparent an event whose calendar IS carried", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" }), calendar({ id: "cal-b" })],
        events: [event({ id: "e1", calendarId: "cal-b" })],
      }),
    );
    expect(store.snapshot().events[0].calendarId).toBe("cal-b");
  });

  it("restores tasks, parking one on the first calendar when its own was not carried", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" }), calendar({ id: "cal-b" })],
        events: [],
        tasks: [
          task({ id: "t1", calendarId: "cal-b" }),
          task({ id: "t2", calendarId: "cal-missing" }),
        ],
      }),
    );
    const snap = store.snapshot();
    expect.soft(snap.tasks.map((t) => t.calendarId).sort()).toEqual(["cal-a", "cal-b"]);
  });

  it("clears seriesId/seriesKey on an override whose parent was not carried, so it renders standalone", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" })],
        events: [
          event({
            id: "e1",
            calendarId: "cal-a",
            seriesId: "ghost-parent",
            seriesKey: "2026-03-08",
          }),
        ],
      }),
    );
    const restored = store.snapshot().events[0];
    expect(restored.seriesId).toBe("");
    expect(restored.seriesKey).toBe("");
  });

  it("keeps the link when the parent series IS carried in the same backup", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" })],
        events: [
          event({ id: "parent", calendarId: "cal-a" }),
          event({ id: "child", calendarId: "cal-a", seriesId: "parent", seriesKey: "2026-03-08" }),
        ],
      }),
    );
    const child = store.snapshot().events.find((e) => e.id === "child");
    expect(child?.seriesId).toBe("parent");
    expect(child?.seriesKey).toBe("2026-03-08");
  });

  it("refuses a backup that is not {app: 'circal'}, leaving the store untouched", async () => {
    const { backup, store } = await load();
    const before = store.snapshot();
    backup.importBackup(
      JSON.stringify({ app: "not-circal", events: [event()], calendars: [calendar()] }),
    );
    expect(store.snapshot()).toEqual(before);
  });

  it("refuses a backup with zero valid calendars, leaving the store untouched", async () => {
    const { backup, store } = await load();
    const before = store.snapshot();
    backup.importBackup(JSON.stringify({ app: "circal", events: [event()], calendars: [] }));
    expect(store.snapshot()).toEqual(before);
  });

  it("drops unreadable events but still restores the readable ones", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" })],
        events: [{ title: "no start/end" }, event({ id: "ok", calendarId: "cal-a" })],
      }),
    );
    const snap = store.snapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0].id).toBe("ok");
  });

  it("a restored blob carrying hostile weekStart/waking values comes back sane", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" })],
        events: [],
        settings: { weekStart: 9, wakingFrom: 2000, wakingTo: -50 },
      }),
    );
    const settings = store.snapshot().settings;
    expect.soft(settings.weekStart).toBe(DEFAULT_SETTINGS.weekStart);
    // wakingFrom clamps to 1440, wakingTo clamps to 0 — still inverted after
    // clamping, so `sane()` reverts the pair rather than keeping one half of
    // a broken window.
    expect.soft(settings.wakingFrom).toBe(DEFAULT_SETTINGS.wakingFrom);
    expect.soft(settings.wakingTo).toBe(DEFAULT_SETTINGS.wakingTo);
  });

  it("a backup written before weekStart/waking existed restores on their defaults", async () => {
    const { backup, store } = await load();
    backup.importBackup(
      JSON.stringify({
        app: "circal",
        calendars: [calendar({ id: "cal-a" })],
        events: [],
        settings: { clock: "24h" }, // a settings object from before these fields existed
      }),
    );
    const settings = store.snapshot().settings;
    expect.soft(settings.weekStart).toBe(DEFAULT_SETTINGS.weekStart);
    expect.soft(settings.wakingFrom).toBe(DEFAULT_SETTINGS.wakingFrom);
    expect.soft(settings.wakingTo).toBe(DEFAULT_SETTINGS.wakingTo);
  });
});

/* ----------------------------------------------------------------------- *
 * exportBackup/exportIcs both end in `download()`, which creates a Blob,
 * an <a> element and calls document.createElement — reachable only with a
 * document. Testing them would mean pulling in jsdom for two call sites in
 * one file; the plan explicitly asks not to. Skipped, reported instead.
 * ----------------------------------------------------------------------- */
