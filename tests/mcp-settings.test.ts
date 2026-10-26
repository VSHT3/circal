import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, calendar, dailyNote, event, grave, ms, resetIds, task, taskList } from "./helpers";
import { DEFAULT_SETTINGS, TOTALS_POSITIONS, YEAR_QUOTE_MAX, type Settings } from "@/lib/store";
import { mergeDocuments } from "@/lib/merge";
import {
  localZone,
  MIRROR_VERSION,
  readMirrorFile,
  serialiseMirror,
  type MirrorContents,
} from "@/lib/mirror";
import { placeForZone } from "@/lib/places";
import { RefusalError } from "../mcp/file";
import { getSettings, performUpdateSettings, settingsPatchSchema } from "../mcp/settings";

function contents(settings: Partial<Settings> = {}): MirrorContents {
  return {
    version: MIRROR_VERSION,
    zone: localZone(),
    rev: 3,
    events: [event({ calendarId: "work", updatedAt: ms("2026-03-08 09:00") })],
    tasks: [task({ calendarId: "work", updatedAt: ms("2026-03-08 09:00") })],
    taskLists: [taskList({ updatedAt: ms("2026-03-08 09:00") })],
    dayNotes: [dailyNote({ updatedAt: ms("2026-03-08 09:00") })],
    calendars: [
      calendar({ id: "work", name: "Work", updatedAt: ms("2026-03-08 09:00") }),
      calendar({ id: "home", name: "Home", updatedAt: ms("2026-03-08 09:00") }),
      calendar({
        id: "feed",
        feed: { url: "https://example.test/feed.ics", fetchedAt: 0, error: "" },
      }),
    ],
    settings: {
      ...DEFAULT_SETTINGS,
      deviceZone: "Europe/Berlin",
      stampedZones: ["America/New_York"],
      ...settings,
    },
    settingsAt: ms("2026-03-08 09:00"),
    graves: [grave("removed", "2026-03-08 09:00")],
  };
}

beforeEach(() => {
  resetIds();
  vi.spyOn(Date, "now").mockReturnValue(ms("2026-03-08 12:00"));
  vi.stubEnv("CIRCAL_ALLOW_ZONE_MISMATCH", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("getSettings", () => {
  it("lists every synced preference and explains the device-only exclusions", () => {
    const input = contents({ moonAt: "sidebar", dailyNoteAt: "top-left" });
    const text = getSettings(input);
    for (const key of Object.keys(input.settings)) {
      if (key === "deviceZone" || key === "stampedZones") {
        expect(text).not.toContain(`"${key}":`);
      } else {
        expect(text).toContain(`"${key}":`);
      }
    }
    expect(text).toContain('"moonAt": "sidebar"');
    expect(text).toContain('"dailyNoteAt": "top-left"');
    expect(text).toContain("Synced preferences");
    expect(text).toContain("deviceZone and stampedZones");
    expect(text).toContain("credentials");
    expect(text).toContain("device permissions");
    expect(text).toContain("coordinates and label are derived");
  });
});

describe("performUpdateSettings", () => {
  it("accepts all user-facing preferences together without losing device fields or records", () => {
    const input = contents();
    const before = structuredClone(input);
    const patch = {
      theme: "paper",
      clock: "12h",
      secondZone: "America/New_York",
      showZoneName: false,
      showZoneOffset: false,
      zoneDaylight: true,
      zoneMoonlight: true,
      place: { zone: "Europe/Berlin" },
      daylight: false,
      moonlight: false,
      arcLabels: "hover",
      joinAdjacent: true,
      inheritMarks: true,
      totals: true,
      totalsAt: "left",
      tickSound: false,
      tickHaptics: false,
      birth: "1990-02-28",
      lifeExpectancy: 95,
      milestones: false,
      lifeLoupe: false,
      yearQuote: "Make room for today.",
      ambientAfter: 5,
      ambientDim: false,
      ambientDaylight: false,
      ambientMoonlight: false,
      ambientZoneRing: true,
      ambientArcLabels: "off",
      moon: true,
      moonAt: "sidebar",
      dailyNote: true,
      dailyNoteAt: "top-right",
      remind: true,
      remindLead: 10,
      backupNudge: false,
      backupInterval: 14,
      defaultDuration: 45,
      defaultCalendar: "home",
      weekStart: 6,
      wakingFrom: 360,
      wakingTo: 1380,
      autoSchedule: true,
    };
    const { mutated, message } = performUpdateSettings(input, patch);
    expect(mutated.settings).toEqual({
      ...input.settings,
      ...patch,
      place: placeForZone("Europe/Berlin"),
    });
    for (const key of [
      "events",
      "tasks",
      "taskLists",
      "dayNotes",
      "calendars",
      "graves",
    ] as const) {
      expect(mutated[key]).toBe(input[key]);
    }
    expect(mutated.settings.stampedZones).toBe(input.settings.stampedZones);
    expect(mutated.settingsAt).toBeSameInstantAs("2026-03-08 12:00");
    expect(message).toContain("Device permissions were not changed");
    expect(input).toEqual(before);
  });

  it.each(TOTALS_POSITIONS)("supports %s for all three dial positions", (position) => {
    const { mutated } = performUpdateSettings(contents(), {
      totalsAt: position,
      moonAt: position,
      dailyNoteAt: position,
    });
    expect(mutated.settings).toMatchObject({
      totalsAt: position,
      moonAt: position,
      dailyNoteAt: position,
    });
  });

  it("resolves supported city aliases using the same place table as the app", () => {
    expect(
      performUpdateSettings(contents(), { place: { zone: "Asia/Calcutta" } }).mutated.settings
        .place,
    ).toEqual(placeForZone("Asia/Calcutta"));
  });

  it("clears optional choices without resetting anything else", () => {
    const input = contents({
      birth: "1990-01-01",
      place: placeForZone("Europe/Berlin"),
      secondZone: "UTC",
      defaultCalendar: "home",
    });
    const patch = { birth: "", place: null, secondZone: "", defaultCalendar: "" };
    expect(performUpdateSettings(input, patch).mutated.settings).toEqual({
      ...input.settings,
      ...patch,
    });
  });

  it("patches one field without normalizing an omitted legacy preference", () => {
    const input = contents({
      wakingFrom: 360,
      wakingTo: 1320,
      defaultCalendar: "deleted-calendar",
      yearQuote: " old spacing ",
    });
    expect(performUpdateSettings(input, { theme: "ember" }).mutated.settings).toEqual({
      ...input.settings,
      theme: "ember",
    });
  });

  it.each([
    ["unknown key", { madeUp: true }],
    ["device zone", { deviceZone: "UTC" }],
    ["travel stamps", { stampedZones: [] }],
    ["credentials", { password: "secret" }],
    ["notification permission", { notificationPermission: "granted" }],
    ["non-object", null],
    ["boolean type", { moon: "true" }],
    ["undefined", { moon: undefined }],
    ["theme", { theme: "blue" }],
    ["clock", { clock: "digital" }],
    ["arc mode", { arcLabels: "sometimes" }],
    ["ambient arc mode", { ambientArcLabels: "sometimes" }],
    ["moon position", { moonAt: "edge" }],
    ["note position", { dailyNoteAt: "sidebar" }],
    ["totals position", { totalsAt: "sidebar" }],
    ["week start", { weekStart: 2 }],
    ["unknown zone", { secondZone: "Atlantis/Here" }],
    ["unknown place", { place: { zone: "Atlantis/Here" } }],
    ["zone without place", { place: { zone: "UTC" } }],
    ["empty place zone", { place: { zone: "" } }],
    ["forged place coordinates", { place: { zone: "Europe/Berlin", lat: 0 } }],
    ["missing calendar", { defaultCalendar: "missing" }],
    ["subscription calendar", { defaultCalendar: "feed" }],
    ["birthday spelling", { birth: "March 8" }],
    ["impossible birthday", { birth: "2026-02-30" }],
    ["short life", { lifeExpectancy: 0 }],
    ["long life", { lifeExpectancy: 151 }],
    ["fractional life", { lifeExpectancy: 80.5 }],
    ["trimmed quote", { yearQuote: " padded " }],
    ["long quote", { yearQuote: "x".repeat(YEAR_QUOTE_MAX + 1) }],
    ["ambient delay", { ambientAfter: 3 }],
    ["reminder lead", { remindLead: 7 }],
    ["backup interval", { backupInterval: 3 }],
    ["duration floor", { defaultDuration: 0 }],
    ["duration ceiling", { defaultDuration: 1441 }],
    ["duration fraction", { defaultDuration: 30.5 }],
    ["not finite", { defaultDuration: Infinity }],
    ["not a number", { wakingFrom: NaN }],
    ["negative waking time", { wakingFrom: -1 }],
    ["late waking time", { wakingTo: 1441 }],
    ["fractional waking time", { wakingFrom: 480.5 }],
    ["inverted waking window", { wakingFrom: 1000, wakingTo: 900 }],
    ["empty waking window", { wakingFrom: 600, wakingTo: 600 }],
  ])("refuses %s atomically", (_name, patch) => {
    const input = contents({ theme: "ember" });
    const before = structuredClone(input);
    expect(() => performUpdateSettings(input, patch)).toThrow(RefusalError);
    expect(input).toEqual(before);
  });

  it("refuses an invalid field even beside a valid change", () => {
    const input = contents();
    expect(() => performUpdateSettings(input, { theme: "paper", defaultDuration: -1 })).toThrow(
      RefusalError,
    );
    expect(input.settings.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it("does not silently reset the omitted half of an invalid waking pair", () => {
    const input = contents({ wakingFrom: 0, wakingTo: DEFAULT_SETTINGS.wakingFrom });
    expect(() => performUpdateSettings(input, { wakingFrom: DEFAULT_SETTINGS.wakingFrom })).toThrow(
      RefusalError,
    );
    expect(input.settings.wakingTo).toBe(DEFAULT_SETTINGS.wakingFrom);
  });

  it.each([{}, { theme: DEFAULT_SETTINGS.theme }])("does not restamp a no-op patch %j", (patch) => {
    const input = contents();
    const { mutated, message } = performUpdateSettings(input, patch);
    expect(mutated.settings).toBe(input.settings);
    expect(mutated.settingsAt).toBe(input.settingsAt);
    expect(message).toBe("Settings unchanged.");
  });

  it("increments stamps even when the clock is behind the saved preference", () => {
    const input = contents();
    input.settingsAt = ms("2026-03-09 12:00");
    const first = performUpdateSettings(input, { theme: "paper" }).mutated;
    const second = performUpdateSettings({ ...input, ...first }, { theme: "ember" }).mutated;
    expect(first.settingsAt).toBeSameInstantAs(new Date(input.settingsAt + 1));
    expect(second.settingsAt).toBeSameInstantAs(new Date(input.settingsAt + 2));
  });

  it("refuses future document formats, even on an empty patch", () => {
    const input = { ...contents(), version: MIRROR_VERSION + 1 };
    expect(() => performUpdateSettings(input, {})).toThrow(/format.*version/i);
  });

  it("respects the zone mismatch guard and its explicit override", () => {
    const input = { ...contents(), zone: "Pacific/Honolulu" };
    expect(() => performUpdateSettings(input, { theme: "paper" })).toThrow(RefusalError);
    vi.stubEnv("CIRCAL_ALLOW_ZONE_MISMATCH", "1");
    expect(performUpdateSettings(input, { theme: "paper" }).mutated.settings.theme).toBe("paper");
  });

  it("advertises only supported preference keys and rejects nested unknown fields", () => {
    const input = contents();
    expect(Object.keys(settingsPatchSchema.shape).sort()).toEqual(
      Object.keys(input.settings)
        .filter((key) => key !== "deviceZone" && key !== "stampedZones")
        .sort(),
    );
    expect(settingsPatchSchema.safeParse({ theme: "paper", unexpected: true }).success).toBe(false);
    expect(
      settingsPatchSchema.safeParse({ place: { zone: "Europe/Berlin", label: "Fake" } }).success,
    ).toBe(false);
  });

  it("survives mirror round-trip and wins synced settings without losing other records", () => {
    const original = contents();
    const { mutated } = performUpdateSettings(original, {
      moon: true,
      moonAt: "sidebar",
      dailyNote: true,
      dailyNoteAt: "bottom-left",
      defaultCalendar: "home",
      place: { zone: "Europe/Berlin" },
    });
    const restored = readMirrorFile(serialiseMirror(mutated, original.rev + 1));
    expect(restored).not.toBeNull();
    const combined = mergeDocuments(original, restored!, at("2026-03-08 12:00").getTime());
    expect(combined.settings).toEqual(mutated.settings);
    expect(combined.settingsAt).toBeSameInstantAs("2026-03-08 12:00");
    expect(combined.events).toEqual(original.events);
    expect(combined.tasks).toEqual(original.tasks);
    expect(combined.taskLists).toEqual(original.taskLists);
    expect(combined.dayNotes).toEqual(original.dayNotes);
    expect(combined.graves).toEqual(original.graves);
  });
});
