/* ------------------------------------------------------------------ *
 * Export and import.
 *
 * The most important file in the app, for an unglamorous reason: without it
 * the only copy of a user's calendar is one browser's localStorage, and
 * "Clear site data" is one menu away with no warning and no undo. Everything
 * else here is a feature; this is the thing that stops circal from being able
 * to lose your year.
 *
 * Two formats, because they answer different questions. `.ics` is "give my
 * events to something else"; `.json` is "give me my circal back exactly as it
 * was", including calendars and settings.
 * ------------------------------------------------------------------ */

import { fromIcs, toIcs } from "./ics";
import { placeForZone } from "./places";
import { DEFAULT_SETTINGS, store, type Settings, type Snapshot } from "./store";
import { notify } from "./notify";
import { dayKey } from "./time";
import { isRecord } from "./utils";
import type { CalEvent, Calendar } from "./events";

const BACKUP_VERSION = 1;

interface Backup {
  app: "circal";
  version: number;
  exportedAt: string;
  events: CalEvent[];
  calendars: Calendar[];
  settings: Settings;
}

function download(filename: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking synchronously cancels the download in Safari; one turn is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* --------------------------------- export --------------------------------- */

export function exportIcs(snapshot: Snapshot) {
  if (snapshot.events.length === 0) {
    notify("Nothing to export yet");
    return;
  }
  download(`circal-${dayKey(new Date())}.ics`, "text/calendar", toIcs(snapshot.events, "circal"));
  notify(`Exported ${snapshot.events.length} events`);
}

export function exportBackup(snapshot: Snapshot) {
  const backup: Backup = {
    app: "circal",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    events: snapshot.events,
    // A subscription's cached events are not yours to back up, but the
    // subscription itself is worth restoring, so the URL rides along with its
    // pull state cleared.
    calendars: snapshot.calendars.map((c) =>
      c.feed ? { ...c, feed: { ...c.feed, fetchedAt: 0, error: "" } } : c,
    ),
    settings: snapshot.settings,
  };
  download(
    `circal-${dayKey(new Date())}.json`,
    "application/json",
    JSON.stringify(backup, null, 2),
  );
  notify("Backup saved");
}

/* --------------------------------- import --------------------------------- */

function readSettings(value: unknown): Settings {
  if (!isRecord(value)) return DEFAULT_SETTINGS;
  const place = value.place;
  return {
    clock: value.clock === "24h" ? "24h" : "12h",
    secondZone: typeof value.secondZone === "string" ? value.secondZone : "",
    // The dial switches read absent-as-on: a backup written before they
    // existed came from a dial that was showing all of them.
    showZoneName: value.showZoneName !== false,
    showZoneOffset: value.showZoneOffset !== false,
    // Except the second zone's two halves, off unless asked for — absent
    // means they were never switched on.
    zoneDaylight: value.zoneDaylight === true,
    zoneMoonlight: value.zoneMoonlight === true,
    // Re-derived from the zone rather than trusted: a backup carries a name we
    // can look up, and the table is the authority on where that place is.
    place: isRecord(place) && typeof place.zone === "string" ? placeForZone(place.zone) : null,
    daylight: value.daylight !== false,
    // `night` is what the dark half was called before it was split off.
    moonlight: value.moonlight !== undefined ? value.moonlight !== false : value.night !== false,
    // Same reading as the dial switches: a backup from before the detents
    // existed came from a build where every step was silent by omission, not
    // by choice, and the default is on.
    tickSound: value.tickSound !== false,
    tickHaptics: value.tickHaptics !== false,
    // The life span. Anything unreadable resets to "never asked", which shows
    // the prompt again rather than drawing a grid around a date we guessed.
    birth: typeof value.birth === "string" ? value.birth : "",
    lifeExpectancy:
      typeof value.lifeExpectancy === "number" && Number.isFinite(value.lifeExpectancy)
        ? value.lifeExpectancy
        : DEFAULT_SETTINGS.lifeExpectancy,
  };
}

/**
 * A backup is external input, so nothing is trusted: every field is checked
 * and anything unreadable is dropped rather than allowed to become an event
 * with a `NaN` start, which renders as an arc of the whole day.
 */
function readEvent(value: unknown): CalEvent | null {
  if (!isRecord(value)) return null;
  const { id, title, calendarId, start, end } = value;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const repeat = value.repeat;
  return {
    id: typeof id === "string" && id ? id : `${start}-${Math.random().toString(36).slice(2, 8)}`,
    title: typeof title === "string" ? title : "Untitled",
    calendarId: typeof calendarId === "string" ? calendarId : "",
    start,
    end,
    allDay: value.allDay === true,
    location: typeof value.location === "string" ? value.location : "",
    url: typeof value.url === "string" ? value.url : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    repeat:
      repeat === "daily" || repeat === "weekly" || repeat === "monthly" || repeat === "yearly"
        ? repeat
        : "never",
    color: typeof value.color === "string" ? value.color : "",
  };
}

function readCalendar(value: unknown): Calendar | null {
  if (!isRecord(value)) return null;
  const { id, name, color } = value;
  if (typeof id !== "string" || !id) return null;
  const feedUrl = isRecord(value.feed) && typeof value.feed.url === "string" ? value.feed.url : "";
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    color: typeof color === "string" && color ? color : "#8ecbff",
    visible: value.visible !== false,
    ...(feedUrl ? { feed: { url: feedUrl, fetchedAt: 0, error: "" } } : {}),
  };
}

function importBackup(text: string) {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.app !== "circal") {
    notify("Not a circal backup", "error");
    return;
  }
  const events = (Array.isArray(parsed.events) ? parsed.events : [])
    .map(readEvent)
    .filter((e): e is CalEvent => e !== null);
  const calendars = (Array.isArray(parsed.calendars) ? parsed.calendars : [])
    .map(readCalendar)
    .filter((c): c is Calendar => c !== null);

  if (calendars.length === 0) {
    notify("Backup has no calendars", "error");
    return;
  }
  // An event pointing at a calendar the backup did not carry would render in
  // the orphan colour forever; park it on the first calendar instead.
  const known = new Set(calendars.map((c) => c.id));
  const fallback = calendars[0].id;

  store.restore({
    events: events.map((e) => (known.has(e.calendarId) ? e : { ...e, calendarId: fallback })),
    calendars,
    settings: readSettings(parsed.settings),
  });
  notify(`Restored ${events.length} events — ⌘Z to undo`);
}

function importIcs(text: string, filename: string) {
  const { name, events } = fromIcs(text);
  if (events.length === 0) {
    notify("No events found in that file", "error");
    return;
  }
  const label = name || filename.replace(/\.ics$/i, "") || "Imported";
  store.addCalendarWithEvents(
    label,
    events.map((e) => ({
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      location: e.location,
      url: e.url,
      notes: e.notes,
      repeat: e.repeat,
      color: "",
    })),
  );
  notify(`Imported ${events.length} events into “${label}” — ⌘Z to undo`);
}

/**
 * Opens the OS file picker and routes by extension. A `.json` is a whole-store
 * restore; a `.ics` lands in a new calendar of its own so an import can always
 * be told apart from what you wrote yourself — and removed in one action.
 */
export function importFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ics,.json,text/calendar,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (/\.json$/i.test(file.name)) importBackup(text);
      else importIcs(text, file.name);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not read that file", "error");
    }
  };
  input.click();
}
