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

import { fnv1a, fromIcs, toIcs } from "./ics";
import { placeForZone } from "./places";
import { DEFAULT_SETTINGS, newId, store, type Settings, type Snapshot } from "./store";
import { notify } from "./notify";
import { dayKey } from "./time";
import { isRecord } from "./utils";
import { ICON_MAX, readRecurrence, recurrenceOf, type CalEvent, type Calendar } from "./events";

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

export function readSettings(value: unknown): Settings {
  if (!isRecord(value)) return DEFAULT_SETTINGS;
  const place = value.place;
  return {
    // A face the backup did not name is the current default, not the old one:
    // there are exactly two spellings and both are written out by every
    // version that has ever had the setting.
    clock: value.clock === "12h" || value.clock === "24h" ? value.clock : DEFAULT_SETTINGS.clock,
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
    // Absent means the backup predates the labels, and the label default is
    // on: a dial whose arcs are anonymous is not what anybody chose. `sane()`
    // is what pins the value to a mode the panel can show.
    arcLabels: (typeof value.arcLabels === "string"
      ? value.arcLabels
      : DEFAULT_SETTINGS.arcLabels) as Settings["arcLabels"],
    // Off unless the backup says so — the same reading its default takes, and
    // an inherited mark arriving unasked would remark every arc on the face.
    inheritMarks: value.inheritMarks === true,
    // Off unless the backup says otherwise: absent means it was written
    // before the line existed, and it is not a line to arrive unasked.
    totals: value.totals === true,
    totalsAt: (typeof value.totalsAt === "string"
      ? value.totalsAt
      : DEFAULT_SETTINGS.totalsAt) as Settings["totalsAt"],
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
    // Marks on the grid, read absent-as-on like the dial switches: a backup
    // written before they existed came from a build where every life was
    // unmarked by omission rather than by choice.
    milestones: value.milestones !== false,
    // Same reading for the loupe, and the same reason: a file written before
    // it existed is not a file that turned it off.
    lifeLoupe: value.lifeLoupe !== false,
    // A line the user wrote, so an absent one is the default rather than
    // silence — a blank centre is a thing to choose, not to inherit from a
    // file. `sane()` trims it and pins the length.
    yearQuote: typeof value.yearQuote === "string" ? value.yearQuote : DEFAULT_SETTINGS.yearQuote,
    // Ambient. A backup from before the mode came from a build with no mode,
    // so every one of these reads as the default rather than as a choice —
    // and the one that could act on its own, the timer, defaults to never.
    // `sane()` pins the delay and the label mode to values the panel can show.
    ambientAfter:
      typeof value.ambientAfter === "number" ? value.ambientAfter : DEFAULT_SETTINGS.ambientAfter,
    ambientDim: value.ambientDim !== false,
    ambientDaylight: value.ambientDaylight !== false,
    ambientMoonlight: value.ambientMoonlight !== false,
    ambientZoneRing: value.ambientZoneRing === true,
    ambientArcLabels: (typeof value.ambientArcLabels === "string"
      ? value.ambientArcLabels
      : DEFAULT_SETTINGS.ambientArcLabels) as Settings["ambientArcLabels"],
    // Both of these appear because the user asked for them, so an absent one
    // is off rather than on — the opposite reading from the dial switches
    // above, and for the opposite reason: one is a thing the face already
    // drew, these are things that were never there. `sane()` pins the two
    // that are picked off a list.
    moonPhase: (typeof value.moonPhase === "string"
      ? value.moonPhase
      : DEFAULT_SETTINGS.moonPhase) as Settings["moonPhase"],
    remind: value.remind === true,
    remindLead:
      typeof value.remindLead === "number" ? value.remindLead : DEFAULT_SETTINGS.remindLead,
  };
}

/**
 * `instantKey`'s form, which is the only one a done key is ever written in.
 * EXDATE carries a day-only form too because DATE is one of its RFC value
 * types; nothing outside this app writes a `doneKeys` entry, so a key that is
 * not a full instant matches no occurrence and is dropped.
 */
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function readDoneKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((k): k is string => typeof k === "string" && INSTANT_KEY.test(k)))]
    : [];
}

/**
 * The id an event with none of its own gets: its own content, hashed. Enough
 * fields to separate two records that are genuinely different, and every one
 * of them a field the exporter wrote — a `seriesKey` is in there because an
 * override sits on the same day as the instance it replaces.
 */
function derivedId(value: Record<string, unknown>, start: number, end: number): string {
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  return `${start}-${fnv1a([start, end, text("title"), text("location"), text("seriesKey")].join("|"))}`;
}

/**
 * A backup is external input, so nothing is trusted: every field is checked
 * and anything unreadable is dropped rather than allowed to become an event
 * with a `NaN` start, which renders as an arc of the whole day.
 */
export function readEvent(value: unknown): CalEvent | null {
  if (!isRecord(value)) return null;
  const { id, title, calendarId, start, end } = value;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // A task is the one shape whose `end` is allowed to equal its `start`: it is
  // a moment, not a span. Everything else with no width is a corrupt record —
  // it draws as an arc of the whole day or as nothing, and both are worse than
  // dropping it.
  const task = value.task === true;
  if (task ? end < start : end <= start) return null;
  return {
    // Derived from the record's own fields, never minted: `Math.random()` gave
    // a different id every read, so the same backup imported twice was two
    // copies of every event with no way left to tell that they were one. The
    // same fix, and the same hash, `ics.ts` already uses for a VEVENT that
    // arrives with no UID.
    id: typeof id === "string" && id ? id : derivedId(value, start, end),
    title: typeof title === "string" ? title : "Untitled",
    calendarId: typeof calendarId === "string" ? calendarId : "",
    start,
    end,
    allDay: value.allDay === true,
    location: typeof value.location === "string" ? value.location : "",
    url: typeof value.url === "string" ? value.url : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    // What a legal rule is lives in `recur.ts`: this file had its own copy of
    // every RFC bound and the store had a third, and the three did not agree.
    ...readRecurrence(value),
    seriesId: typeof value.seriesId === "string" ? value.seriesId : "",
    seriesKey: typeof value.seriesKey === "string" ? value.seriesKey : "",
    color: typeof value.color === "string" ? value.color : "",
    icon: typeof value.icon === "string" ? value.icon.slice(0, ICON_MAX) : "",
    task,
    // The same instant-key check EXDATE gets, and the same reason: a key this
    // does not spell matches no occurrence, so it is a row of dead weight that
    // survives every future export.
    doneKeys: readDoneKeys(value.doneKeys),
  };
}

export function readCalendar(value: unknown): Calendar | null {
  if (!isRecord(value)) return null;
  const { id, name, color, icon } = value;
  if (typeof id !== "string" || !id) return null;
  const feedUrl = isRecord(value.feed) && typeof value.feed.url === "string" ? value.feed.url : "";
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    color: typeof color === "string" && color ? color : "#8ecbff",
    // Length is the whole check. An icon name this build does not carry
    // renders as the dot rather than as nothing, so an unknown one is worth
    // keeping — a backup restored into an older build and back again should
    // not lose the mark — but an unbounded string here is a paste.
    icon: typeof icon === "string" ? icon.slice(0, ICON_MAX) : "",
    visible: value.visible !== false,
    ...(feedUrl ? { feed: { url: feedUrl, fetchedAt: 0, error: "" } } : {}),
  };
}

export function importBackup(text: string) {
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
  // An override naming a series the backup did not carry would never render
  // — occurrencesOn only hides the parent's instant once the override is
  // seen, and there is no parent here to hide it from — so it stands alone.
  const seriesIds = new Set(events.map((e) => e.id));

  store.restore({
    events: events.map((e) => {
      const parented = known.has(e.calendarId) ? e : { ...e, calendarId: fallback };
      return e.seriesId && !seriesIds.has(e.seriesId)
        ? { ...parented, seriesId: "", seriesKey: "" }
        : parented;
    }),
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
  // The id each parent VEVENT will get, keyed by uid — an override shares its
  // parent's uid (that is what makes it an override) and links to it through
  // this map rather than through the uid itself, since a uid is not what the
  // store indexes events by.
  const idByUid = new Map<string, string>();
  for (const e of events) {
    if (!e.recurrenceId) idByUid.set(e.uid, newId());
  }
  store.addCalendarWithEvents(
    label,
    events.map((e) => {
      const parentId = idByUid.get(e.uid);
      const isOverride = e.recurrenceId !== "";
      return {
        id: isOverride ? newId() : (parentId ?? newId()),
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
        url: e.url,
        notes: e.notes,
        ...recurrenceOf(e),
        // No parent in this same import — an orphaned override — leaves both
        // blank rather than pointing at an id nothing will ever generate.
        seriesId: isOverride && parentId ? parentId : "",
        seriesKey: isOverride && parentId ? e.recurrenceId : "",
        color: "",
        // An .ics carries no mark of its own; the imported calendar's is the
        // whole answer until somebody sets one.
        icon: "",
        // Only from an .ics circal itself wrote. Nothing else has a way to say
        // "this VEVENT is a task", and reading a zero-length VEVENT as one
        // would turn every other producer's instantaneous event into a to-do.
        task: e.task,
        doneKeys: e.doneKeys,
      };
    }),
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
