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
import { isThemeName } from "./theme";
import { placeForZone } from "./places";
import {
  DEFAULT_SETTINGS,
  markBackedUp,
  newId,
  readDailyNoteFont,
  store,
  type Settings,
  type Snapshot,
} from "./store";
import { notify } from "./notify";
import { dayKey, isZone } from "./time";
import { isRecord } from "./utils";
import { bytesToBase64Url } from "@/lib/base64";
import {
  readGraves,
  readTaskList,
  readGuests,
  readMark,
  readPerson,
  readRecurrence,
  readRemindLead,
  readStamp,
  readTravel,
  recurrenceOf,
  type CalEvent,
  type Calendar,
  type Grave,
} from "./events";
import {
  readEstimate,
  readPlans,
  readPriority,
  readTaskOrder,
  type Task,
  type TaskList,
} from "./tasks";
import { readDayNotes, type DailyNote } from "./dayNotes";

const BACKUP_VERSION = 1;

interface Backup {
  app: "circal";
  version: number;
  exportedAt: string;
  events: CalEvent[];
  calendars: Calendar[];
  tasks: Task[];
  taskLists: TaskList[];
  dayNotes: DailyNote[];
  settings: Settings;
  /**
   * The deletions and the settings stamp travel with the events, because a
   * backup is also the mirror file — a document that dropped them would come
   * back through the mirror as a calendar with no record of what had been
   * deleted, and every id it had lost would be resurrected by the next merge.
   */
  graves: Grave[];
  settingsAt: number;
}

/**
 * The shell's own save, injected as `window.__circalSave` (see
 * `mac/main.swift`). It exists because a WKWebView withholds the download an
 * `<a download>` triggers — measured: the click resolves to nothing, so the
 * app build saved no file at all while the web build was correct. The shim
 * hands the shell a name and the bytes and lets an `NSSavePanel` place them;
 * the shell writes what it is given and knows nothing about the contents.
 */
interface SaveWindow {
  __circalSave?: (filename: string, body: string, encoding?: "base64url") => Promise<boolean>;
}

export async function download(
  filename: string,
  mime: string,
  body: string | Blob,
): Promise<boolean> {
  const shell = (window as unknown as SaveWindow).__circalSave;
  if (shell) {
    // The one place either path is chosen, so no call site learns there are
    // two ways to save — the same bargain `mirrorLink.ts` strikes for the
    // picker beside `showSaveFilePicker`. The boolean is whether a file was
    // written: the shell's save panel can be cancelled, and a caller that
    // toasts "Exported" over a cancel is lying.
    if (body instanceof Blob) {
      const bytes = new Uint8Array(await body.arrayBuffer());
      return shell(filename, bytesToBase64Url(bytes), "base64url");
    }
    return shell(filename, body);
  }
  const url = URL.createObjectURL(
    body instanceof Blob ? body : new Blob([body], { type: `${mime};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking synchronously cancels the download in Safari; one turn is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  // A started browser download is the only answer this path has — there is no
  // cancel to observe once the click lands — so it reports success.
  return true;
}

/* --------------------------------- export --------------------------------- */

export async function exportIcs(snapshot: Snapshot) {
  if (snapshot.events.length === 0 && snapshot.tasks.length === 0) {
    notify("Nothing to export yet");
    return;
  }
  const saved = await download(
    `circal-${dayKey(new Date())}.ics`,
    "text/calendar",
    toIcs(snapshot.events, "circal", snapshot.tasks),
  );
  // Nothing on a cancel: the user cancelled, they know, and a toast apologising
  // for obeying is chrome.
  if (saved) {
    const parts = [];
    if (snapshot.events.length > 0)
      parts.push(`${snapshot.events.length} event${snapshot.events.length === 1 ? "" : "s"}`);
    if (snapshot.tasks.length > 0)
      parts.push(`${snapshot.tasks.length} task${snapshot.tasks.length === 1 ? "" : "s"}`);
    notify(`Exported ${parts.join(" · ")}`);
  }
}

/**
 * One event as an `.ics` file — the booking reply's fallback, for a sender
 * who reads their calendar somewhere other than circal. The event travels
 * alone: the receiver is answering an offer, not exporting a calendar. The
 * filename is `exportIcs`'s own spelling, dated by the event rather than by
 * today, because the event's day is the one fact the recipient files it under.
 */
export async function exportEventIcs(event: CalEvent) {
  const saved = await download(
    `circal-${dayKey(new Date(event.start))}.ics`,
    "text/calendar",
    toIcs([event], "circal"),
  );
  if (saved) notify("Saved as an .ics file");
}

export async function exportBackup(snapshot: Snapshot) {
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
    tasks: snapshot.tasks,
    taskLists: snapshot.taskLists,
    dayNotes: snapshot.dayNotes,
    settings: snapshot.settings,
    settingsAt: snapshot.settingsAt,
    graves: snapshot.graves,
  };
  const saved = await download(
    `circal-${dayKey(new Date())}.json`,
    "application/json",
    JSON.stringify(backup, null, 2),
  );
  // Only on a written file: `download` returns false for a cancelled save
  // panel, and a cancel that reset the backup clock would silence the nudge
  // over a backup that was never taken. This is the one `.json` write, so it
  // is the one place the clock advances — the `.ics` export never touches it,
  // because an .ics is events handed to another app, not a restore path.
  if (saved) {
    markBackedUp();
    notify("Backup saved");
  }
}

/* --------------------------------- the nudge ------------------------------- */

const DAY_MS = 86_400_000;

/**
 * Whether the main screen should say a `.json` backup is overdue: `now` is at
 * least `intervalDays` past `lastBackup`.
 *
 * A `lastBackup` of `0` is due at once. The store anchors first run at now, so
 * a fresh browser never reaches this with `0`; it happens only for a stored
 * value that was garbage — a corrupt clock is a calendar whose backup age is
 * unknown, and unknown is worth the same warning as overdue. Dismissing
 * restarts the interval, so it does not nag past the first no.
 *
 * Pure and clockless by argument: the caller passes `now`, so the predicate
 * says the same thing in every zone and can be pinned in a test without a
 * clock to stub. Whether the *setting* is on, and whether a mirror is live,
 * are the caller's questions — this one is only about the interval.
 */
export function backupDue(lastBackup: number, intervalDays: number, now: number): boolean {
  return now - lastBackup >= intervalDays * DAY_MS;
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
    // A preset this build does not carry resets rather than half-applies:
    // `sane()` would pin it anyway, but a restored calendar should not spend
    // one commit looking broken first.
    theme: isThemeName(value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
    secondZone: typeof value.secondZone === "string" ? value.secondZone : "",
    // The zone the browser that wrote this backup was in. Carried rather than
    // dropped, and deliberately not replaced with the reader's own: a Berlin
    // calendar restored in New York is exactly the journey the travel notice
    // exists to ask about, and the events in the file are floating. `sane()`
    // refuses a zone `Intl` cannot resolve; absent reads as a first run, which
    // asks nothing.
    deviceZone: typeof value.deviceZone === "string" ? value.deviceZone : "",
    // The zones that browser's "keep" answer stamped, so the row that offers
    // to take them off survives a restore with the events it is about. Strings
    // only here; `sane()` is what refuses one `Intl` cannot resolve.
    stampedZones: Array.isArray(value.stampedZones)
      ? value.stampedZones.filter((zone): zone is string => typeof zone === "string")
      : [],
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
    joinAdjacent: value.joinAdjacent === true,
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
    // Explicit choices, including the legacy moon register, survive new defaults.
    moon:
      typeof value.moon === "boolean"
        ? value.moon
        : typeof value.moonPhase === "string"
          ? value.moonPhase !== "off"
          : DEFAULT_SETTINGS.moon,
    moonAt: (typeof value.moonAt === "string"
      ? value.moonAt
      : DEFAULT_SETTINGS.moonAt) as Settings["moonAt"],
    dailyNote: typeof value.dailyNote === "boolean" ? value.dailyNote : DEFAULT_SETTINGS.dailyNote,
    dailyNoteAt: (typeof value.dailyNoteAt === "string"
      ? value.dailyNoteAt
      : DEFAULT_SETTINGS.dailyNoteAt) as Settings["dailyNoteAt"],
    dailyNoteFont: readDailyNoteFont(value.dailyNoteFont),
    remind: value.remind === true,
    remindLead:
      typeof value.remindLead === "number" ? value.remindLead : DEFAULT_SETTINGS.remindLead,
    // Absent-as-on, like the dial switches: a backup written before the nudge
    // existed came from a build that could not have turned this data-safety
    // warning off, so it reads as the default rather than as a choice.
    backupNudge: value.backupNudge !== false,
    // Types only: `sane()` pins an interval off the list to the default.
    backupInterval:
      typeof value.backupInterval === "number"
        ? value.backupInterval
        : DEFAULT_SETTINGS.backupInterval,
    // What a new event starts as. `sane()` clamps the length; the calendar is
    // an id and is deliberately not checked against the backup's own
    // calendars — `defaultCalendarId` resolves it at the moment it is used,
    // and a restore that dropped it would silently reset a preference over a
    // calendar the user is about to re-import.
    defaultDuration:
      typeof value.defaultDuration === "number"
        ? value.defaultDuration
        : DEFAULT_SETTINGS.defaultDuration,
    defaultCalendar: typeof value.defaultCalendar === "string" ? value.defaultCalendar : "",
    // Types only: `sane()` is what pins an illegal weekday or an inverted
    // waking window to the defaults, same as every other bounded field here.
    weekStart:
      value.weekStart === 0 || value.weekStart === 1 || value.weekStart === 6
        ? value.weekStart
        : DEFAULT_SETTINGS.weekStart,
    wakingFrom:
      typeof value.wakingFrom === "number" ? value.wakingFrom : DEFAULT_SETTINGS.wakingFrom,
    wakingTo: typeof value.wakingTo === "number" ? value.wakingTo : DEFAULT_SETTINGS.wakingTo,
    // Off unless the backup says so — a restore must not start writing to
    // the calendar because the field was absent.
    autoSchedule: value.autoSchedule === true,
  };
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
  // Nothing with no width is an event: it draws as an arc of the whole day or
  // as nothing, and both are worse than dropping it. A moment with a deadline
  // is a `Task` now, read by `readTask` below.
  if (end <= start) return null;
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
    // An unknown zone must not come back as a zone, and a dropped one
    // degrades to floating — which is what the app did with every event
    // before this field existed, so the failure mode is not a new one.
    tzid: typeof value.tzid === "string" && isZone(value.tzid) ? value.tzid : "",
    location: typeof value.location === "string" ? value.location : "",
    url: typeof value.url === "string" ? value.url : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    // What a legal rule is lives in `recur.ts`: this file had its own copy of
    // every RFC bound and the store had a third, and the three did not agree.
    ...readRecurrence(value),
    seriesId: typeof value.seriesId === "string" ? value.seriesId : "",
    seriesKey: typeof value.seriesKey === "string" ? value.seriesKey : "",
    color: typeof value.color === "string" ? value.color : "",
    // What a legal mark is lives in `events.ts`, next to the two vocabularies
    // it has to tell apart. This used to slice at one shared cap, which turned
    // ten of the 247 shipped names into strings matching no path.
    icon: readMark(value.icon),
    // Anything other than a literal `true` is busy, which is what an event
    // exported before this field existed was. A truthy string in a
    // hand-edited blob must not quietly take a meeting off the day's total.
    free: value.free === true,
    // What a legal travel is lives in `events.ts`, beside the clipping and the
    // ceiling it shares bounds with: a hand-edited blob's `-5` or `"20"` comes
    // back `0`, which is what an event exported before this field existed was.
    travel: readTravel(value.travel),
    // What a legal lead is lives in `remind.ts`, beside the three states it
    // has to distinguish: an unreadable one comes back inheriting, which is
    // what an event exported before this field existed already did.
    remindLead: readRemindLead(value.remindLead),
    // The one field on this model that arrives from a stranger with no natural
    // length, so this is where the caps are enforced rather than where they are
    // chosen: `readGuests` in `events.ts` owns the numbers, because a
    // subscription's ATTENDEE lines never pass through this file and the two
    // paths must not disagree about how big a guest list may be. The count
    // comes through so a restore prints the same "and 40 others" the import
    // did — clamped up to the list it labels, since a blob understating it
    // would print a negative remainder.
    organizer: readPerson(value.organizer),
    ...readGuests(value.attendees, value.attendeeCount),
    // What a legal stamp is lives in `events.ts`, beside the graves it is
    // compared against. `0` for anything unreadable and for every backup taken
    // before stamping existed, which is what tells a merge that a document is
    // not one it can merge.
    updatedAt: readStamp(value.updatedAt),
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
    // Same validator as an event's, same reason. An icon name this build does
    // not carry still renders as the dot rather than as nothing, so an unknown
    // one is worth keeping — a backup restored into an older build and back
    // again should not lose the mark — but an unbounded string is a paste, and
    // an over-long *name* is now dropped rather than cut into junk.
    icon: readMark(icon),
    // Same validator as an event's lead, same reason: the middle level of the
    // inherit chain arrives from the same untrusted JSON the top one does, and
    // a second opinion about what a legal lead is would be `readRecurrence`'s
    // documented mistake. Absent reads as inheriting, which is what every
    // calendar written before this field existed already did.
    remindLead: readRemindLead(value.remindLead),
    visible: value.visible !== false,
    updatedAt: readStamp(value.updatedAt),
    ...(feedUrl ? { feed: { url: feedUrl, fetchedAt: 0, error: "" } } : {}),
  };
}

/**
 * The one validator for a stored task — three readers (a backup, the mirror
 * document, the store's own hydration) share this opinion about what a task
 * legally is, `readEvent`'s own bargain. The per-field clamps live in
 * `tasks.ts` beside the model; this composes them and refuses the records no
 * clamp can save: a due date that is not a finite instant is not a deadline,
 * and everything in circal has a day.
 */
export function readTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const { id, title, due } = value;
  if (typeof id !== "string" || !id) return null;
  if (typeof due !== "number" || !Number.isFinite(due)) return null;
  return {
    id,
    title: typeof title === "string" ? title : "Untitled",
    notes: typeof value.notes === "string" ? value.notes : "",
    calendarId: typeof value.calendarId === "string" ? value.calendarId : "",
    listId: typeof value.listId === "string" ? value.listId : "",
    ...(readTaskOrder(value.order) !== undefined ? { order: readTaskOrder(value.order) } : {}),
    // The mark and the colour take an event's own validators and defaults.
    icon: readMark(value.icon),
    color: typeof value.color === "string" ? value.color : "",
    due,
    dueAllDay: value.dueAllDay === true,
    estimate: readEstimate(value.estimate),
    priority: readPriority(value.priority),
    plans: readPlans(value.plans),
    done: value.done === true,
    updatedAt: readStamp(value.updatedAt),
  };
}

/**
 * The validated contents of a backup, or why it is not one.
 *
 * Split out of `importBackup` because the mirror file *is* a backup file —
 * same shape, same readers — and a second parser for it would be a second
 * opinion about what a legal event is, which is the mistake `recur.ts`
 * already documents one layer down. `importBackup` is this plus a store write
 * and two notices; `mirror.ts` is this plus a revision number.
 */
export type BackupRead =
  | {
      ok: true;
      events: CalEvent[];
      calendars: Calendar[];
      tasks: Task[];
      taskLists: TaskList[];
      dayNotes: DailyNote[];
      settings: Settings;
      settingsAt: number;
      graves: Grave[];
    }
  | { ok: false; reason: "not-circal" | "no-calendars" };

export function readBackup(parsed: unknown): BackupRead {
  if (!isRecord(parsed) || parsed.app !== "circal") return { ok: false, reason: "not-circal" };
  const events = (Array.isArray(parsed.events) ? parsed.events : [])
    .map(readEvent)
    .filter((e): e is CalEvent => e !== null);
  const calendars = (Array.isArray(parsed.calendars) ? parsed.calendars : [])
    .map(readCalendar)
    .filter((c): c is Calendar => c !== null);
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
    .map(readTask)
    .filter((t): t is Task => t !== null);
  const taskLists = (Array.isArray(parsed.taskLists) ? parsed.taskLists : [])
    .map(readTaskList)
    .filter((list): list is TaskList => list !== null);

  if (calendars.length === 0) return { ok: false, reason: "no-calendars" };
  // An event pointing at a calendar the backup did not carry would render in
  // the orphan colour forever; park it on the first calendar instead.
  const known = new Set(calendars.map((c) => c.id));
  const fallback = calendars[0].id;
  // An override naming a series the backup did not carry would never render
  // — occurrencesOn only hides the parent's instant once the override is
  // seen, and there is no parent here to hide it from — so it stands alone.
  const seriesIds = new Set(events.map((e) => e.id));

  return {
    ok: true,
    events: events.map((e) => {
      const parented = known.has(e.calendarId) ? e : { ...e, calendarId: fallback };
      return e.seriesId && !seriesIds.has(e.seriesId)
        ? { ...parented, seriesId: "", seriesKey: "" }
        : parented;
    }),
    calendars,
    taskLists,
    dayNotes: readDayNotes(parsed.dayNotes),
    // A task's calendar is parked the same way an event's is, same reason.
    tasks: tasks.map((t) => (known.has(t.calendarId) ? t : { ...t, calendarId: fallback })),
    settings: readSettings(parsed.settings),
    // Not through `readSettings`: this is bookkeeping about the object rather
    // than a field of it, and a reader that clamped it into `Settings` would
    // have to teach every one of the thirty-eight about a stamp.
    settingsAt: readStamp(parsed.settingsAt),
    graves: readGraves(parsed.graves),
  };
}

export function importBackup(text: string) {
  const read = readBackup(JSON.parse(text));
  if (!read.ok) {
    notify(
      read.reason === "not-circal" ? "Not a circal backup" : "Backup has no calendars",
      "error",
    );
    return;
  }
  store.restore(read);
  notify(`Restored ${read.events.length} events`);
}

export function importIcs(text: string, filename: string) {
  const { name, events, tasks } = fromIcs(text);
  if (events.length === 0 && tasks.length === 0) {
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
        tzid: e.tzid,
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
        // `TRANSP`, which every calendar writes: an event another app marked
        // free arrives free here rather than silently booking the hour.
        free: e.free,
        // `X-APPLE-TRAVEL-DURATION`, which Apple Calendar writes and reserves
        // as busy: the run-up is part of what the sender said the event costs,
        // so dropping it would import a meeting you arrive late to.
        travel: e.travel,
        // The first `VALARM` this reader could model, or inheriting when the
        // VEVENT carried none — a sender's alarm is a fact about that event
        // and travels with it, the same way `TRANSP` does.
        remindLead: e.remindLead,
        // The whole of the invite path, and the reason it is a read: an `.ics`
        // that arrives by mail is the one file that carries these, and until
        // now the import threw away the only record of who had asked and who
        // was coming. Already capped and counted by `fromIcs`.
        organizer: e.organizer,
        attendees: e.attendees,
        attendeeCount: e.attendeeCount,
        // `addCalendarWithEvents` stamps the whole import in one instant, the
        // same way `create` stamps a draft: these records begin to exist at
        // the commit, not here.
        updatedAt: 0,
      };
    }),
    // VTODOs, on the same new calendar. Fresh ids for `importBackup`'s
    // reason inverted: a `.ics` import always lands in a calendar of its
    // own, so a uid-stable id would let two imports of one file collide
    // across calendars without ever replacing anything.
    tasks.map((t) => ({
      id: newId(),
      title: t.title,
      notes: t.notes,
      listId: "",
      icon: "",
      color: "",
      due: t.due,
      dueAllDay: t.dueAllDay,
      estimate: t.estimate,
      priority: t.priority,
      plans: t.plans,
      done: t.done,
      updatedAt: 0,
    })),
  );
  const parts = [];
  if (events.length > 0) parts.push(`${events.length} event${events.length === 1 ? "" : "s"}`);
  if (tasks.length > 0) parts.push(`${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
  notify(`Imported ${parts.join(" · ")} into “${label}”`);
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
