import { z } from "zod";
import { readSettings } from "@/lib/backup";
import { isDayNoteDay } from "@/lib/dayNotes";
import type { MirrorContents } from "@/lib/mirror";
import { canonicalJson } from "@/lib/merge";
import { placeForZone } from "@/lib/places";
import {
  AMBIENT_DELAYS,
  ARC_LABEL_MODES,
  BACKUP_INTERVALS,
  LIFE_EXPECTANCY_RANGE,
  TOTALS_POSITIONS,
  WEEK_STARTS,
  YEAR_QUOTE_MAX,
  sane,
  type Settings,
} from "@/lib/store";
import { MIN_DURATION } from "@/lib/quickadd";
import { REMIND_LEADS } from "@/lib/remind";
import { THEMES } from "@/lib/theme";
import { MINUTES_PER_DAY, isZone } from "@/lib/time";
import { carried, type WriteResult } from "./domain";
import { assertVersionAllowsMutation, assertZoneAllowsMutation, RefusalError } from "./file";

type Preferences = Omit<Settings, "deviceZone" | "stampedZones" | "place"> & {
  place: { zone: string } | null;
};

/** Types advertise the preferences; the app's normalizer owns their bounds. */
export const settingsPatchSchema = z
  .strictObject({
    theme: z.enum(THEMES),
    clock: z.enum(["12h", "24h"]),
    secondZone: z.string().describe('IANA timezone, or "" to hide the second ring.'),
    showZoneName: z.boolean(),
    showZoneOffset: z.boolean(),
    zoneDaylight: z.boolean(),
    zoneMoonlight: z.boolean(),
    place: z
      .strictObject({ zone: z.string() })
      .nullable()
      .describe(
        "A supported city timezone; null disables the lightcycle. Coordinates are derived by circal.",
      ),
    daylight: z.boolean(),
    moonlight: z.boolean(),
    arcLabels: z.enum(ARC_LABEL_MODES),
    joinAdjacent: z.boolean(),
    inheritMarks: z.boolean(),
    totals: z.boolean(),
    totalsAt: z.enum(TOTALS_POSITIONS),
    tickSound: z.boolean(),
    tickHaptics: z.boolean(),
    birth: z.string().describe('Birth date as YYYY-MM-DD, or "" to clear.'),
    lifeExpectancy: z
      .number()
      .describe(
        `Whole years from ${LIFE_EXPECTANCY_RANGE.min} to ${LIFE_EXPECTANCY_RANGE.max}, inclusive.`,
      ),
    milestones: z.boolean(),
    lifeLoupe: z.boolean(),
    yearQuote: z
      .string()
      .describe(
        `At most ${YEAR_QUOTE_MAX} characters, with no leading or trailing whitespace. An empty string hides the quote.`,
      ),
    ambientAfter: z
      .literal(AMBIENT_DELAYS)
      .describe("Idle minutes before ambient mode; 0 disables automatic ambient mode."),
    ambientDim: z.boolean(),
    ambientDaylight: z.boolean(),
    ambientMoonlight: z.boolean(),
    ambientZoneRing: z.boolean(),
    ambientArcLabels: z.enum(ARC_LABEL_MODES),
    moon: z.boolean(),
    moonAt: z.enum(["sidebar", ...TOTALS_POSITIONS]),
    dailyNote: z.boolean(),
    dailyNoteAt: z.enum(TOTALS_POSITIONS),
    remind: z
      .boolean()
      .describe(
        "Synced reminder preference only; does not grant notification permission on a device.",
      ),
    remindLead: z
      .literal(REMIND_LEADS)
      .describe("Minutes before an event to remind; 0 reminds at its start."),
    backupNudge: z.boolean(),
    backupInterval: z
      .literal(BACKUP_INTERVALS)
      .describe("Days without a backup before the backup nudge appears."),
    defaultDuration: z
      .number()
      .describe(
        `New event duration in whole minutes from ${MIN_DURATION} to ${MINUTES_PER_DAY}, inclusive.`,
      ),
    defaultCalendar: z
      .string()
      .describe('An existing writable calendar id, or "" for the first writable calendar.'),
    weekStart: z.literal(WEEK_STARTS),
    wakingFrom: z
      .number()
      .describe(
        `Start of the waking window in whole minutes since midnight, 0 to ${MINUTES_PER_DAY}; must be before wakingTo.`,
      ),
    wakingTo: z
      .number()
      .describe(
        `End of the waking window in whole minutes since midnight, 0 to ${MINUTES_PER_DAY}; must be after wakingFrom.`,
      ),
    autoSchedule: z.boolean(),
  } satisfies { [K in keyof Preferences]: z.ZodType<Preferences[K]> })
  .partial();

export function getSettings(contents: MirrorContents): string {
  const {
    deviceZone: _deviceZone,
    stampedZones: _stampedZones,
    ...preferences
  } = contents.settings;
  return [
    "Synced preferences (update_settings changes only supplied fields):",
    JSON.stringify(preferences, null, 2),
    'To change place, supply {"zone":"Europe/Berlin"} or null; coordinates and label are derived.',
    "Excluded: deviceZone and stampedZones travel bookkeeping, credentials, cloud sessions and encryption keys, mirror paths and handles, and device permissions. Notification permission and haptic support remain device-local.",
  ].join("\n");
}

export function performUpdateSettings(contents: MirrorContents, patch: unknown): WriteResult {
  assertVersionAllowsMutation(contents);
  assertZoneAllowsMutation(contents, process.env);
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new RefusalError(`Invalid settings patch: ${parsed.error.message}`);
  }
  const requested = parsed.data;
  const keys = Object.keys(requested) as (keyof Preferences)[];
  if (keys.some((key) => requested[key] === undefined)) {
    throw new RefusalError("Settings values must not be undefined; omit an unchanged preference.");
  }
  if (requested.secondZone && !isZone(requested.secondZone)) {
    throw new RefusalError(`Unknown secondZone: "${requested.secondZone}".`);
  }
  if (
    requested.defaultCalendar &&
    !contents.calendars.some(
      (calendar) => calendar.id === requested.defaultCalendar && !calendar.feed,
    )
  ) {
    throw new RefusalError(
      `defaultCalendar must name an existing writable calendar: "${requested.defaultCalendar}".`,
    );
  }
  const place =
    requested.place === undefined
      ? contents.settings.place
      : requested.place === null
        ? null
        : placeForZone(requested.place.zone);
  if (requested.place && !place) {
    throw new RefusalError(`No supported lightcycle place for "${requested.place.zone}".`);
  }
  const merged: Settings = { ...contents.settings, ...requested, place };
  const normalized = sane(readSettings(merged));
  if (requested.birth && !isDayNoteDay(requested.birth)) {
    throw new RefusalError("birth must be a real date in YYYY-MM-DD form, or an empty string.");
  }
  for (const key of keys) {
    if (canonicalJson(merged[key]) !== canonicalJson(normalized[key])) {
      throw new RefusalError(
        `Invalid setting "${key}": circal would normalize it to ${JSON.stringify(normalized[key])}. No settings were changed.`,
      );
    }
  }
  // The waking pair resets together; changing one must not silently reset the other.
  if (
    (requested.wakingFrom !== undefined || requested.wakingTo !== undefined) &&
    (merged.wakingFrom !== normalized.wakingFrom || merged.wakingTo !== normalized.wakingTo)
  ) {
    throw new RefusalError("wakingFrom must be before wakingTo. No settings were changed.");
  }
  const mutated = carried(contents);
  if (keys.every((key) => canonicalJson(merged[key]) === canonicalJson(contents.settings[key]))) {
    return { mutated, message: "Settings unchanged." };
  }
  return {
    mutated: {
      ...mutated,
      settings: merged,
      settingsAt: Math.max(Date.now(), contents.settingsAt + 1),
    },
    message: `Updated synced preferences: ${keys.join(", ")}. Device permissions were not changed.`,
  };
}
