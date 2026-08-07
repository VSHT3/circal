import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "./helpers";
import { MemoryStorage, calendar, event, ms } from "./helpers";
import { readEvent, readSettings, readCalendar } from "@/lib/backup";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { NEVER, type CalEvent } from "@/lib/events";
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

  it("generates an id when none is given", () => {
    const result = readEvent({ ...baseEvent });
    expect(result?.id).toMatch(new RegExp(`^${START}-`));
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
});

/* --------------------------------- readSettings --------------------------- */

describe("readSettings", () => {
  it("a non-object backup blob returns DEFAULT_SETTINGS outright", () => {
    expect(readSettings("not an object")).toBe(DEFAULT_SETTINGS);
    expect(readSettings(null)).toBe(DEFAULT_SETTINGS);
  });

  it.each([
    "showZoneName",
    "showZoneOffset",
    "daylight",
    "tickSound",
    "tickHaptics",
    "ambientDim",
    "ambientLightcycle",
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
});

/* ----------------------------------------------------------------------- *
 * exportBackup/exportIcs both end in `download()`, which creates a Blob,
 * an <a> element and calls document.createElement — reachable only with a
 * document. Testing them would mean pulling in jsdom for two call sites in
 * one file; the plan explicitly asks not to. Skipped, reported instead.
 * ----------------------------------------------------------------------- */
