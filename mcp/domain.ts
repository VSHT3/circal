/* ------------------------------------------------------------------ *
 * The decision layer between MCP tool arguments and circal's own
 * domain functions. Every event this module builds is validated
 * through `readEvent` before it is ever written — an agent is exactly
 * the untrusted input `backup.ts` already assumes, so this is that
 * same boundary and not a second one.
 *
 * Nothing here touches the file system: `tools.ts` reads and writes
 * through `file.ts`, and hands this module the `MirrorContents` it
 * already has.
 * ------------------------------------------------------------------ */

import { readCalendar, readEvent, readTask } from "@/lib/backup";
import { describeRule } from "@/lib/describe";
import {
  DEFAULT_WAKING,
  PALETTE,
  REMIND_INHERIT,
  REMIND_LEAD_MAX,
  REMIND_SILENT,
  dayAgenda,
  dayLoad,
  freeGaps,
  occurrencesOn,
  taskOccurrences,
  readRemindLead,
  recurrenceOf,
  scoreEventBy,
  spanLabel,
  type CalEvent,
  type MatchField,
  type Calendar,
  type Occurrence,
} from "@/lib/events";
import { PLANS_MAX, compareTasks, scoreTaskBy, taskState, type Task } from "@/lib/tasks";
import { applyRemove, applySplit, applyTruncate, applyUpdate } from "@/lib/mutate";
import { parseQuickAdd } from "@/lib/quickadd";
import { NEVER, instantKey, keyToInstant, readRecurrence, repeats, type Repeat } from "@/lib/recur";
import { remindLabel } from "@/lib/remind";
import {
  addDays,
  atMinutes,
  daysBetween,
  dayKey,
  formatDuration,
  formatTimeShort,
  fromDayKey,
  instantOfWall,
  isZone,
  minutesOfDay,
  parseClock,
  startOfDay,
  wallClockIn,
  type Clock,
} from "@/lib/time";
import { defaultCalendarId, draftEvent, newId, type Settings } from "@/lib/store";
import { RefusalError, type Mutated } from "./file";
import type { MirrorContents } from "@/lib/mirror";

/* --------------------------------- dates ---------------------------------- */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateKey(value: string, field = "date"): void {
  if (!DATE_KEY_RE.test(value)) {
    throw new RefusalError(`"${field}" must be YYYY-MM-DD, local — got "${value}"`);
  }
}

function parseDay(value: string, field = "date"): Date {
  assertDateKey(value, field);
  return fromDayKey(value);
}

function parseTime(value: string, field: string): number {
  const minutes = parseClock(value);
  if (minutes === null) {
    throw new RefusalError(
      `could not read "${field}": "${value}" is not a time — try "14:30" or "2:30pm"`,
    );
  }
  return minutes;
}

/** Resolves an `occurrence` argument (a bare `YYYY-MM-DD` or a full instant,
 *  `keyToInstant`'s own two forms) against an event's own time of day —
 *  exactly what `exdates`/`rdates` already mean by a bare day. */
export function resolveInstant(event: CalEvent, occurrence: string | undefined): number {
  if (!occurrence) return event.start;
  const at = keyToInstant(occurrence, new Date(event.start));
  if (at === null) {
    throw new RefusalError(`"${occurrence}" is not a date or instant this app understands`);
  }
  return at;
}

/* --------------------------------- scope ----------------------------------- */

export type Scope = "one" | "future" | "all";

/** The sharp edge: a repeating event with no scope is refused rather than
 *  guessed. An event that does not repeat has only one meaning, so scope is
 *  ignored for it — the caller need not have known to omit it. */
export function requireScope(event: CalEvent, scope: string | undefined): Scope {
  if (!repeats(event)) return "all";
  if (scope !== "one" && scope !== "future" && scope !== "all") {
    throw new RefusalError(
      `"${event.title || "Untitled"}" repeats — say which occurrences with "scope": ` +
        `"one" (just this occurrence), "future" (this one and everything after), or ` +
        `"all" (the whole series). "one" and "future" also need "occurrence" (a date or instant).`,
    );
  }
  return scope;
}

/* ------------------------------- calendars --------------------------------- */

/** Finds the calendar a reference names: an exact id first, else a unique
 *  case-insensitive name prefix — so "Admissions" (or "adm") works wherever
 *  a calendarId does, without a list_calendars round trip. Ambiguity is
 *  refused naming the candidates rather than resolved by list order. */
export function findCalendar(ref: string, calendars: Calendar[]): Calendar {
  const byId = calendars.find((c) => c.id === ref);
  if (byId) return byId;
  const needle = ref.trim().toLowerCase();
  const matches = needle ? calendars.filter((c) => c.name.toLowerCase().startsWith(needle)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RefusalError(
      `"${ref}" names ${matches.length} calendars (${matches.map((c) => c.name).join(", ")}) — ` +
        `use an id from list_calendars`,
    );
  }
  throw new RefusalError(`no calendar with id or name "${ref}"`);
}

function requireWritable(calendar: Calendar): Calendar {
  if (calendar.feed) {
    throw new RefusalError(
      `"${calendar.name}" is a subscription — its events are pulled from a feed, never written to`,
    );
  }
  return calendar;
}

/** The calendar a write lands on: the one the caller named, else the
 *  connection's own pin (`--calendar`), else the user default — and only the
 *  last of the three is a guess, which `defaultedCalendar` lets the caller
 *  say out loud in its summary. */
export function resolveCalendar(
  calendarId: string | undefined,
  calendars: Calendar[],
  settings: Settings,
  pin?: string,
): Calendar {
  if (calendarId) return requireWritable(findCalendar(calendarId, calendars));
  if (pin) return requireWritable(findCalendar(pin, calendars));
  const id = defaultCalendarId(calendars, settings.defaultCalendar);
  const found = calendars.find((c) => c.id === id);
  if (!found) throw new RefusalError("there is no calendar to put this on — create one first");
  return found;
}

/** Whether a write's calendar was defaulted rather than named or pinned —
 *  the wrong-calendar hazard worth a loud marker in every create summary. */
export function defaultedCalendar(
  calendarId: string | undefined,
  pin: string | undefined,
): boolean {
  return calendarId === undefined && !pin;
}

/** A read filter: the same document, scoped to one calendar's records. The
 *  calendar list stays whole so names keep resolving in every printed line. */
export function scopedToCalendar(
  contents: MirrorContents,
  ref: string | undefined,
): MirrorContents {
  if (!ref) return contents;
  const calendar = findCalendar(ref, contents.calendars);
  return {
    ...contents,
    events: contents.events.filter((e) => e.calendarId === calendar.id),
    tasks: contents.tasks.filter((t) => t.calendarId === calendar.id),
  };
}

function refuseIfFeed(event: CalEvent, calendars: Calendar[]): void {
  const calendar = calendars.find((c) => c.id === event.calendarId);
  if (calendar?.feed) {
    throw new RefusalError(
      `"${calendar.name}" is a subscription — "${event.title || "Untitled"}" is pulled from a ` +
        `feed and is read-only, the same as it is in the editor`,
    );
  }
}

/* ------------------------------ recurrence ---------------------------------- */

export interface RecurrenceInput {
  repeat: Repeat;
  interval?: number;
  /** YYYY-MM-DD, local, inclusive — the last day an occurrence may start. */
  until?: string;
  wkst?: number;
  byMonth?: number[];
  byMonthDay?: number[];
  byWeekNo?: number[];
  byYearDay?: number[];
  byDay?: { day: number; nth?: number }[];
  bySetPos?: number[];
}

/** A fresh rule replaces the whole recurrence, exceptions included — a rule
 *  authored in one message has no `exdates` of its own yet. Omitted entirely,
 *  the event does not repeat. `zone` is the event's own (`tzid`), so `until`
 *  bounds the last day on the clock the rule is walked over, not this
 *  process's — hours apart across a zone, a whole day at the boundary. */
function buildRecurrence(input: RecurrenceInput | undefined, zone = "") {
  if (!input) return { ...NEVER };
  const boundary = input.until ? addDays(fromDayKey(input.until), 1) : null;
  const until = boundary ? (zone ? instantOfWall(boundary, zone) : boundary.getTime()) - 1 : 0;
  return readRecurrence({ ...input, until, exdates: [], rdates: [] });
}

/* --------------------------------- span ------------------------------------- */

interface Span {
  start: number;
  end: number;
  allDay: boolean;
}

export interface EventFieldsInput {
  title?: string;
  /** YYYY-MM-DD, local — or `zone`'s own wall date when one is named. */
  date?: string;
  /** HH:MM, 24-hour, on the local clock — or on `zone`'s when one is named. */
  start?: string;
  /** HH:MM for a timed event; YYYY-MM-DD (inclusive) for an all-day one. */
  end?: string;
  /** Minutes — an alternative to `end` for a timed event. */
  duration?: number;
  allDay?: boolean;
  calendarId?: string;
  color?: string;
  icon?: string;
  location?: string;
  url?: string;
  notes?: string;
  /** IANA zone the times are written in — a deadline abroad. `""` clears an
   *  existing zone back to floating (this reader's own clock). */
  zone?: string;
  /** Minutes before start; or `"silent"` (never fires) / `"inherit"` (follow
   *  the calendar, then the setting — every event's default). */
  remindLead?: number | "inherit" | "silent";
  recurrence?: RecurrenceInput;
}

/** An instant from a wall date and minute count — read on `zone`'s own clock
 *  when one is named, else this process's. `atMinutes` normalises an
 *  over-midnight minute count either way. */
function spanInstant(day: Date, minutes: number, zone: string): number {
  return zone ? instantOfWall(atMinutes(day, minutes), zone) : atMinutes(day, minutes).getTime();
}

/** A `zone` argument, read loudly: `readEvent` would quietly drop a zone this
 *  runtime cannot resolve, and a silently-floating deadline abroad is the
 *  hour-off error the field exists to remove. */
function zoneFrom(value: string): string {
  if (value === "") return "";
  if (!isZone(value)) {
    throw new RefusalError(
      `"${value}" is not an IANA time zone this runtime knows — try "Asia/Seoul"`,
    );
  }
  return value;
}

/** A `remindLead` argument, read loudly for `zoneFrom`'s reason —
 *  `readRemindLead` reads an out-of-range lead as inherit, which here would
 *  silently discard exactly the warning the caller asked for. */
function leadFrom(value: number | "inherit" | "silent"): number {
  if (value === "inherit") return REMIND_INHERIT;
  if (value === "silent") return REMIND_SILENT;
  if (readRemindLead(value) !== value) {
    throw new RefusalError(
      `"remindLead" must be whole minutes, 0 to ${REMIND_LEAD_MAX} — got ${value}`,
    );
  }
  return value;
}

/** A brand-new event's span. No time named at all reads as all day — the
 *  same rule `parseQuickAdd` uses: nothing here is invented. With a `zone`,
 *  the date and times are that zone's wall clock. */
function resolveSpanForCreate(
  input: EventFieldsInput,
  day: Date,
  defaultDuration: number,
  zone: string,
): Span {
  // A `YYYY-MM-DD`-shaped `end` is a day, never a time — the all-day spelling
  // the field's own doc allows. Counting it as "a time was given" forced
  // `{date, end}` (a multi-day holiday, phrased exactly as documented) into
  // the timed branch and refused it asking for an HH:MM `start`.
  const endIsDay = input.end !== undefined && DATE_KEY_RE.test(input.end);
  const noTimeGiven =
    input.start === undefined &&
    (input.end === undefined || endIsDay) &&
    input.duration === undefined;
  const allDay = input.allDay === true || (input.allDay === undefined && noTimeGiven);
  if (allDay) {
    // An all-day event is never zoned — its date is the one the calendar
    // printed, not an hour a transition could move (`CalEvent.tzid`'s rule).
    if (zone) {
      throw new RefusalError(
        'an all-day event carries no clock to zone — drop "zone" or give a timed "start"',
      );
    }
    const days = input.end ? Math.max(1, daysBetween(day, fromDayKey(input.end)) + 1) : 1;
    return {
      start: startOfDay(day).getTime(),
      end: addDays(startOfDay(day), days).getTime(),
      allDay: true,
    };
  }
  if (input.start === undefined) throw new RefusalError('a timed event needs "start" (HH:MM)');
  const startMin = parseTime(input.start, "start");
  const endMin =
    input.end !== undefined
      ? parseTime(input.end, "end")
      : startMin + (input.duration ?? defaultDuration);
  return {
    start: spanInstant(day, startMin, zone),
    end: spanInstant(day, endMin, zone),
    allDay: false,
  };
}

/** A patched span, anchored at `anchorMs` — the series' own seed for an
 *  `"all"` edit, the occurrence's instant for a `"one"` override or a
 *  `"future"` split. A field the patch does not name keeps the base event's
 *  own value, so "just move it an hour" does not also reset its length.
 *
 *  `zone` is the span's target zone (the patch's, else the base's own), and
 *  the defaults are read off the anchor's wall clock in the *base's* zone —
 *  so a patch naming only `zone` re-reads the event's displayed wall time on
 *  the new clock ("that 18:00 was meant in Seoul"), and a patch naming only
 *  a time keeps the zoned event on its own clock. */
function resolveSpanForPatch(
  input: EventFieldsInput,
  base: CalEvent,
  anchorMs: number,
  zone: string,
): Span {
  const anchorWall = base.tzid ? wallClockIn(anchorMs, base.tzid) : new Date(anchorMs);
  const day = input.date ? parseDay(input.date) : startOfDay(anchorWall);
  const allDay = input.allDay ?? base.allDay;
  if (allDay) {
    // An all-day event is never zoned. A zone the patch spelled out is
    // refused; one merely inherited from a timed base is dropped with the
    // clock the base is losing.
    if (input.zone) {
      throw new RefusalError(
        'an all-day event carries no clock to zone — drop "zone" or give a timed "start"',
      );
    }
    const baseDays = Math.max(
      1,
      daysBetween(startOfDay(new Date(base.start)), startOfDay(new Date(base.end))),
    );
    const days = input.end ? Math.max(1, daysBetween(day, fromDayKey(input.end)) + 1) : baseDays;
    return {
      start: startOfDay(day).getTime(),
      end: addDays(startOfDay(day), days).getTime(),
      allDay: true,
    };
  }
  // A degenerate base span (an older document's zero-width record) falls
  // back to a minute rather than `DEFAULT_DURATION` — `Math.max` never
  // returns `0`, so a second fallback here would be unreachable.
  const baseDurationMin = Math.max(1, Math.round((base.end - base.start) / 60_000));
  const startMin =
    input.start !== undefined ? parseTime(input.start, "start") : minutesOfDay(anchorWall);
  const endMin =
    input.end !== undefined
      ? parseTime(input.end, "end")
      : startMin + (input.duration ?? baseDurationMin);
  return {
    start: spanInstant(day, startMin, zone),
    end: spanInstant(day, endMin, zone),
    allDay: false,
  };
}

/* -------------------------------- records ----------------------------------- */

/** Runs an assembled record through `readEvent` — the same boundary a backup
 *  import crosses, and the right one: an agent is exactly the untrusted
 *  input that boundary already assumes. */
function validate(draft: Record<string, unknown>): Omit<CalEvent, "id"> {
  const validated = readEvent({ ...draft, id: "pending" });
  if (!validated)
    throw new RefusalError("the assembled event failed validation (check start and end)");
  const { id: _drop, ...rest } = validated;
  return rest;
}

export function buildEventRecord(
  input: EventFieldsInput,
  calendars: Calendar[],
  settings: Settings,
  pin?: string,
): Omit<CalEvent, "id"> {
  if (!input.date) throw new RefusalError('an event needs "date" (YYYY-MM-DD)');
  const day = parseDay(input.date);
  const calendar = resolveCalendar(input.calendarId, calendars, settings, pin);
  const zone = input.zone ? zoneFrom(input.zone) : "";
  const span = resolveSpanForCreate(input, day, settings.defaultDuration, zone);
  return validate({
    title: input.title ?? "",
    calendarId: calendar.id,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    // The zone the times were spelled in, kept so every surface can print
    // both clocks — and so a rule walks that zone's own wall calendar.
    tzid: zone,
    location: input.location ?? "",
    url: input.url ?? "",
    notes: input.notes ?? "",
    ...buildRecurrence(input.recurrence, zone),
    seriesId: "",
    seriesKey: "",
    color: input.color ?? "",
    icon: input.icon ?? "",
    // Busy. There is no tool argument for this yet, and an agent asked to put
    // an hour in the diary means the hour to be spoken for.
    free: false,
    // Inheriting unless the caller named a lead of its own — an event created
    // with one it was not asked for would be an agent quietly deciding how
    // much warning its user wants.
    remindLead: input.remindLead !== undefined ? leadFrom(input.remindLead) : REMIND_INHERIT,
    // Nobody, for the reason there is no tool argument and never will be: an
    // agent has no channel to invite anyone on either, so a guest list it
    // assembled would be a list of people who were never asked.
    organizer: null,
    attendees: [],
    attendeeCount: 0,
    // The stamp is the caller's: `performCreateEvent` and the quick-add path
    // are where this record starts existing, the same rule `draftEvent`
    // follows in the app.
    updatedAt: 0,
  });
}

/** A patched event, anchored at `anchorMs` (default: the base event's own
 *  seed — an `"all"` edit). Every field the patch omits keeps the base
 *  event's value, recurrence included, unless `patch.recurrence` replaces it
 *  outright. */
export function applyPatchToEvent(
  base: CalEvent,
  input: EventFieldsInput,
  calendars: Calendar[],
  settings: Settings,
  anchorMs: number = base.start,
): Omit<CalEvent, "id"> {
  const calendar =
    input.calendarId !== undefined
      ? resolveCalendar(input.calendarId, calendars, settings)
      : (calendars.find((c) => c.id === base.calendarId) ??
        resolveCalendar(undefined, calendars, settings));
  const zone = input.zone !== undefined ? zoneFrom(input.zone) : base.tzid;
  const span = resolveSpanForPatch(input, base, anchorMs, zone);
  return validate({
    title: input.title ?? base.title,
    calendarId: calendar.id,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    // The patch's zone, else the base's — cleared with the clock when the
    // patch flips the event all-day, since an all-day event is never zoned.
    tzid: span.allDay ? "" : zone,
    location: input.location ?? base.location,
    url: input.url ?? base.url,
    notes: input.notes ?? base.notes,
    ...(input.recurrence ? buildRecurrence(input.recurrence, zone) : recurrenceOf(base)),
    seriesId: base.seriesId,
    seriesKey: base.seriesKey,
    color: input.color ?? base.color,
    icon: input.icon ?? base.icon,
    // Carried, like every other field a patch does not name: `validate` reads
    // the draft through `backup.readEvent`, which defaults an absent `free`
    // to busy — so leaving it out would quietly rebook a free event the
    // moment its title was edited.
    free: base.free,
    // Carried unless the patch names one — `readEvent` reads an absent lead
    // as inheriting, so leaving it out would un-silence an event the user
    // silenced the moment an assistant fixed a typo in its title.
    remindLead: input.remindLead !== undefined ? leadFrom(input.remindLead) : base.remindLead,
    // Carried, and this is the field where dropping it would be least
    // recoverable: the guest list is a record of a message somebody else sent,
    // and `readEvent` reads an absent one as no invitation at all — so an
    // assistant fixing a typo in the title would erase the only copy of who
    // had asked and who was coming.
    organizer: base.organizer,
    attendees: base.attendees,
    attendeeCount: base.attendeeCount,
    // Carried, and overwritten by the reducer that commits the patch: it is
    // the base's stamp until this edit lands, never a fresh record's zero.
    updatedAt: base.updatedAt,
  });
}

/* --------------------------------- writes ---------------------------------- */

/**
 * Everything a write leaves alone, carried across.
 *
 * A mutation here round-trips the *whole* document, so a field this module
 * does not name is a field it silently drops — measured rather than feared:
 * the published `circal-mcp@0.1.0` bundle dropped nine keys per document that
 * way. `graves` and `settingsAt` are the two that would be lost most quietly,
 * because nothing on either side would look wrong afterwards; the browser
 * would simply resurrect every event an agent had deleted on the next merge.
 */
function carried(contents: MirrorContents): Mutated {
  return {
    events: contents.events,
    calendars: contents.calendars,
    tasks: contents.tasks,
    settings: contents.settings,
    settingsAt: contents.settingsAt,
    graves: contents.graves,
  };
}

/** The shape this app's own ids take (`newId`, plus the `x-` prefix an
 *  upsert key mints), so a not-found can tell a typo from a record another
 *  writer removed without leaving a grave. */
const ID_SHAPE_RE = /^([0-9a-z]+-[0-9a-z]{6}|x-.+)$/;

/** A not-found that reads the graves before answering: an id that was
 *  deliberately deleted is a different fact from one that never existed, and
 *  saying which turns a transport-level hunt into a one-call diagnosis. */
function notFound(contents: MirrorContents, id: string, kind: "event" | "task"): RefusalError {
  const grave = contents.graves.find((g) => g.id === id);
  if (grave) {
    return new RefusalError(
      `no ${kind} with id "${id}" — deleted ${new Date(grave.at).toISOString()} (a grave for ` +
        `it is in the document, so this writer or another one removed it)`,
    );
  }
  if (ID_SHAPE_RE.test(id)) {
    return new RefusalError(
      `no ${kind} with id "${id}", and no grave for it either — the id has this app's shape, ` +
        `so another writer may have dropped or rewritten it; re-read with list_day or search`,
    );
  }
  return new RefusalError(`no ${kind} with id "${id}"`);
}

/* -------------------------------- formatting -------------------------------- */

function calendarName(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.name ?? "—";
}

/** A zoned event's own wall clock, printed beside the local times — the
 *  "18:00 KST · 11:00 here" a deadline abroad is owed on every surface. */
function zoneSuffix(event: CalEvent, clock: Clock): string {
  if (!event.tzid || event.allDay) return "";
  const start = formatTimeShort(wallClockIn(event.start, event.tzid), clock);
  const end = formatTimeShort(wallClockIn(event.end, event.tzid), clock);
  return ` (${start}–${end} ${event.tzid})`;
}

export function eventSummaryLine(event: CalEvent, calendars: Calendar[], clock: Clock): string {
  const when = event.allDay
    ? `${dayKey(new Date(event.start))} – ${dayKey(addDays(new Date(event.end), -1))} (all day)`
    : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}${zoneSuffix(event, clock)}`;
  return `${event.title || "Untitled"} — [${calendarName(calendars, event.calendarId)}] — ${when} — id=${event.id}`;
}

/** A task's one line, `eventSummaryLine`'s own shape: what it is called,
 *  where it is filed, when it is due, and the id every write tool needs. */
export function taskSummaryLine(task: Task, calendars: Calendar[], clock: Clock): string {
  const when = task.dueAllDay
    ? `due ${dayKey(new Date(task.due))}`
    : `due ${dayKey(new Date(task.due))} ${formatTimeShort(new Date(task.due), clock)}`;
  const bits = [
    `${task.title || "Untitled"} (task)`,
    `[${calendarName(calendars, task.calendarId)}]`,
    when,
    task.done ? "done" : "open",
    ...(task.estimate !== null ? [`~${formatDuration(task.estimate)}`] : []),
    ...(task.priority > 0 ? [task.priority === 2 ? "urgent" : "high"] : []),
    `id=${task.id}`,
  ];
  return bits.join(" — ");
}

export function occurrenceLine(occ: Occurrence, calendars: Calendar[], clock: Clock): string {
  // A due date's pip is one instant; a plan and an event print their span.
  const pip = occ.task && occ.start.getTime() === occ.end.getTime();
  const when = occ.event.allDay
    ? "all day"
    : pip
      ? `${occ.start.toISOString()} (${formatTimeShort(occ.start, clock)}) due`
      : `${occ.start.toISOString()} (${formatTimeShort(occ.start, clock)}) – ${occ.end.toISOString()} (${formatTimeShort(occ.end, clock)})`;
  const span = spanLabel(occ);
  const bits = [
    occ.event.title || "Untitled",
    `[${calendarName(calendars, occ.event.calendarId)}]`,
    when,
    ...(span ? [span] : []),
    ...(occ.task ? [occ.done ? "done" : "open"] : []),
    `id=${occ.event.id}`,
    `occurrence=${dayKey(occ.start)}`,
  ];
  return bits.join("  ·  ");
}

/* ---------------------------- read-only tools -------------------------------- */

export function listDay(contents: MirrorContents, date: string): string {
  assertDateKey(date);
  const day = fromDayKey(date);
  const agenda = dayAgenda(contents.events, contents.calendars, day, contents.tasks);
  const clock = contents.settings.clock;
  return [
    `${date} — ${agenda.all.length} occurrence${agenda.all.length === 1 ? "" : "s"}`,
    "",
    "All day:",
    ...(agenda.allDay.length
      ? agenda.allDay.map((o) => `  ${occurrenceLine(o, contents.calendars, clock)}`)
      : ["  (none)"]),
    "",
    "Timed:",
    ...(agenda.timed.length
      ? agenda.timed.map((o) => `  ${occurrenceLine(o, contents.calendars, clock)}`)
      : ["  (none)"]),
  ].join("\n");
}

export const MAX_RANGE_DAYS = 366;
export const MAX_RANGE_OCCURRENCES = 500;

export function listRange(contents: MirrorContents, from: string, to: string): string {
  assertDateKey(from, "from");
  assertDateKey(to, "to");
  const fromDay = fromDayKey(from);
  const toDay = fromDayKey(to);
  const span = daysBetween(fromDay, toDay) + 1;
  if (span < 1) throw new RefusalError('"to" must not be before "from"');
  if (span > MAX_RANGE_DAYS) {
    throw new RefusalError(`the range is capped at ${MAX_RANGE_DAYS} days — asked for ${span}`);
  }
  const clock = contents.settings.clock;
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  for (let i = 0; i < span && !truncated; i++) {
    const day = addDays(fromDay, i);
    // The dial's own merge: plans and due pips beside the events.
    const occs = [
      ...occurrencesOn(contents.events, contents.calendars, day),
      ...taskOccurrences(contents.tasks, contents.calendars, day),
    ].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
    if (occs.length === 0) continue;
    lines.push(`${dayKey(day)}:`);
    for (const occ of occs) {
      if (count >= MAX_RANGE_OCCURRENCES) {
        truncated = true;
        break;
      }
      lines.push(`  ${occurrenceLine(occ, contents.calendars, clock)}`);
      count++;
    }
  }
  const header =
    `${from} to ${to} (${span} days) — ${count} occurrence${count === 1 ? "" : "s"}` +
    (truncated ? `, capped at ${MAX_RANGE_OCCURRENCES}` : "");
  return [header, ...(lines.length ? lines : ["(nothing)"])].join("\n");
}

export function searchEvents(contents: MirrorContents, query: string, limit = 20): string {
  const clock = contents.settings.clock;
  const cap = Math.max(0, limit);
  const scored = contents.events
    .map((event) => ({
      line: eventSummaryLine(event, contents.calendars, clock),
      hit: scoreEventBy(event, query),
    }))
    .concat(
      contents.tasks.map((task) => ({
        line: taskSummaryLine(task, contents.calendars, clock),
        hit: scoreTaskBy(task, query),
      })),
    )
    .filter((s): s is { line: string; hit: { field: MatchField; score: number } } => s.hit !== null)
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, cap);
  return [
    `"${query}" — ${scored.length} match${scored.length === 1 ? "" : "es"}`,
    // A hit outside the title says so: a notes match on a long note is
    // otherwise indistinguishable from what the record is called.
    ...(scored.length
      ? scored.map(({ line, hit }) =>
          hit.field === "title" ? line : `${line} — matched ${hit.field}`,
        )
      : ["(none)"]),
  ].join("\n");
}

export function freeSlots(
  contents: MirrorContents,
  date: string,
  minutes: number,
  from: string | undefined,
  to: string | undefined,
): string {
  assertDateKey(date);
  const day = fromDayKey(date);
  const occs = dayAgenda(contents.events, contents.calendars, day, contents.tasks).all;
  const fromMin =
    from !== undefined
      ? parseTime(from, "from")
      : (contents.settings.wakingFrom ?? DEFAULT_WAKING.from);
  const toMin =
    to !== undefined ? parseTime(to, "to") : (contents.settings.wakingTo ?? DEFAULT_WAKING.to);
  const clock = contents.settings.clock;
  const gaps = freeGaps(occs, minutes, fromMin, toMin);
  const load = dayLoad(occs, { from: fromMin, to: toMin });
  return [
    `${date} — free ${formatDuration(minutes)}+ slots between ` +
      `${formatTimeShort(atMinutes(day, fromMin), clock)} and ${formatTimeShort(atMinutes(day, toMin), clock)}`,
    ...(gaps.length
      ? gaps.map(
          (g) =>
            `  ${formatTimeShort(atMinutes(day, g.start), clock)}–${formatTimeShort(atMinutes(day, g.end), clock)} (${formatDuration(g.end - g.start)})`,
        )
      : ["  (none)"]),
    load
      ? `Booked ${formatDuration(load.booked)}, free ${formatDuration(load.free)} of the window.`
      : "Nothing booked today.",
  ].join("\n");
}

export function listCalendars(contents: MirrorContents): string {
  return contents.calendars
    .map(
      (c) =>
        `${c.name} — id=${c.id} — ${c.color}` +
        `${c.feed ? " — subscription (read-only)" : ""}${c.visible ? "" : " — hidden"}`,
    )
    .join("\n");
}

export function describeEvent(contents: MirrorContents, id: string): string {
  const event = contents.events.find((e) => e.id === id);
  if (!event) {
    // The id may name a task — one id space for the caller, two lists here.
    const task = contents.tasks.find((t) => t.id === id);
    if (task) return describeTask(contents, task);
    throw notFound(contents, id, "event");
  }
  const calendar = contents.calendars.find((c) => c.id === event.calendarId);
  const clock = contents.settings.clock;
  return [
    `${event.title || "Untitled"}  (id=${event.id})`,
    `Calendar: ${calendarName(contents.calendars, event.calendarId)}${calendar?.feed ? " (subscription, read-only)" : ""}`,
    event.allDay
      ? `All day, ${dayKey(new Date(event.start))} to ${dayKey(addDays(new Date(event.end), -1))}`
      : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}`,
    // Both clocks for a zoned event — the times above are local, and the
    // hours the deadline was written in are the ones its owner reasons in.
    ...(event.tzid && !event.allDay
      ? [
          `Zone: ${event.tzid} — ${formatTimeShort(wallClockIn(event.start, event.tzid), clock)}–${formatTimeShort(wallClockIn(event.end, event.tzid), clock)} there`,
        ]
      : []),
    `Repeats: ${repeats(event) ? describeRule(event) : "never"}`,
    ...(event.remindLead !== REMIND_INHERIT
      ? [`Remind: ${event.remindLead === REMIND_SILENT ? "silent" : remindLabel(event.remindLead)}`]
      : []),
    ...(event.location ? [`Location: ${event.location}`] : []),
    ...(event.url ? [`URL: ${event.url}`] : []),
    ...(event.notes ? [`Notes: ${event.notes}`] : []),
    ...(event.seriesId
      ? [`Overrides one occurrence of id=${event.seriesId} (${event.seriesKey})`]
      : []),
  ].join("\n");
}

function describeTask(contents: MirrorContents, task: Task): string {
  const clock = contents.settings.clock;
  return [
    `${task.title || "Untitled"}  (task, id=${task.id})`,
    `Calendar: ${calendarName(contents.calendars, task.calendarId)}`,
    task.dueAllDay
      ? `Due ${dayKey(new Date(task.due))}`
      : `Due ${dayKey(new Date(task.due))} ${formatTimeShort(new Date(task.due), clock)}`,
    `Status: ${task.done ? "done" : "open"}`,
    ...(task.estimate !== null ? [`Estimate: ${formatDuration(task.estimate)}`] : []),
    ...(task.priority > 0 ? [`Priority: ${task.priority === 2 ? "urgent" : "high"}`] : []),
    ...(task.plans.length
      ? task.plans.map(
          (p) =>
            `Planned: ${dayKey(new Date(p.start))} ${formatTimeShort(new Date(p.start), clock)}–${formatTimeShort(new Date(p.end), clock)}`,
        )
      : []),
    ...(task.notes ? [`Notes: ${task.notes}`] : []),
  ].join("\n");
}

/** The envelope and the document's shape, for an agent (or a human) reasoning
 *  about sync — the out-of-band fetch-decrypt-print script the 2026-08-30
 *  task-loss diagnosis needed, as a read-only tool. */
export function syncStatus(contents: MirrorContents, transport: string): string {
  return [
    `Document: rev ${contents.rev}, format version ${contents.version}, zone ` +
      `${contents.zone || "(unrecorded)"}`,
    `Transport: ${transport}`,
    `Counts: ${contents.events.length} events, ${contents.tasks.length} tasks, ` +
      `${contents.calendars.length} calendars, ${contents.graves.length} graves`,
  ].join("\n");
}

/* ------------------------------- write tools ---------------------------------- */

export interface WriteResult {
  mutated: Mutated;
  message: string;
}

/** The loud half of the default-calendar hazard: a write whose calendar was
 *  neither named nor pinned says so in its own summary, because the wrong
 *  calendar is the kind of error nobody notices until the wrong person gets
 *  a reminder. */
function defaultedSuffix(defaulted: boolean): string {
  return defaulted ? " — calendar defaulted, not named" : "";
}

export function performQuickAdd(
  contents: MirrorContents,
  text: string,
  date: string | undefined,
  pin?: string,
): WriteResult {
  if (!text.trim()) throw new RefusalError('"text" is empty');
  const reference = date ? parseDay(date) : startOfDay(new Date());
  const parsed = parseQuickAdd(text, reference, new Date(), contents.settings.defaultDuration);
  if (!parsed) {
    throw new RefusalError(
      `could not read "${text}" as an event — name something beyond a bare title, e.g. ` +
        `"lunch tomorrow 1pm 45m" or "gym every monday 7am"`,
    );
  }
  const calendar = resolveCalendar(undefined, contents.calendars, contents.settings, pin);
  const record = validate({
    ...draftEvent(parsed.day, parsed.startMin, parsed.endMin, calendar.id),
    title: parsed.title,
    ...parsed.repeat,
  });
  const event: CalEvent = { ...record, id: newId(), updatedAt: Date.now() };
  return {
    mutated: { ...carried(contents), events: [...contents.events, event] },
    message:
      `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}` +
      defaultedSuffix(defaultedCalendar(undefined, pin)),
  };
}

/** The prefix an upsert key's id wears, so a keyed record is recognisable
 *  and can never collide with a minted `newId`. */
const KEYED_ID_PREFIX = "x-";

export function keyedId(key: string): string {
  return `${KEYED_ID_PREFIX}${key}`;
}

/**
 * Create — or, given a `key`, converge. The key becomes the event's id
 * (`x-<key>`), so the same key always names the same record: re-running a
 * mirror updates in place instead of duplicating, and the ordinary stamps
 * and graves carry the merge semantics unchanged. An existing keyed event is
 * patched whole-series, `applyPatchToEvent`'s own bargain: fields the input
 * omits keep their value.
 */
export function performCreateEvent(
  contents: MirrorContents,
  input: EventFieldsInput,
  key?: string,
  pin?: string,
): WriteResult {
  const suffix = defaultedSuffix(defaultedCalendar(input.calendarId, pin));
  if (key) {
    const id = keyedId(key);
    const existing = contents.events.find((e) => e.id === id);
    if (existing) {
      refuseIfFeed(existing, contents.calendars);
      const record = applyPatchToEvent(existing, input, contents.calendars, contents.settings);
      const events = applyUpdate(contents.events, id, record, Date.now());
      const updated = events.find((e) => e.id === id) as CalEvent;
      return {
        mutated: { ...carried(contents), events },
        message:
          `Updated (by key "${key}") ` +
          eventSummaryLine(updated, contents.calendars, contents.settings.clock) +
          suffix,
      };
    }
    const record = buildEventRecord(input, contents.calendars, contents.settings, pin);
    const event: CalEvent = { ...record, id, updatedAt: Date.now() };
    return {
      mutated: { ...carried(contents), events: [...contents.events, event] },
      message:
        `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}` + suffix,
    };
  }
  const record = buildEventRecord(input, contents.calendars, contents.settings, pin);
  const event: CalEvent = { ...record, id: newId(), updatedAt: Date.now() };
  return {
    mutated: { ...carried(contents), events: [...contents.events, event] },
    message:
      `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}` + suffix,
  };
}

/** How many records one batch may carry — a bound on the one CAS write's
 *  size, not a rate limit. */
export const CREATE_BATCH_MAX = 100;

/** The batch: every record lands in one read-mutate-seal-CAS cycle and one
 *  `rev` bump, and any one refusal refuses the whole batch before anything
 *  is written — a CAS write is all-or-nothing, so the summary can never
 *  disagree with the document. */
export function performCreateEvents(
  contents: MirrorContents,
  inputs: (EventFieldsInput & { key?: string })[],
  pin?: string,
): WriteResult {
  if (inputs.length === 0) throw new RefusalError('"events" is empty');
  if (inputs.length > CREATE_BATCH_MAX) {
    throw new RefusalError(
      `the batch is capped at ${CREATE_BATCH_MAX} events — got ${inputs.length}`,
    );
  }
  let current = contents;
  const lines: string[] = [];
  for (const [index, input] of inputs.entries()) {
    let outcome: WriteResult;
    try {
      outcome = performCreateEvent(current, input, input.key, pin);
    } catch (error) {
      if (error instanceof RefusalError) {
        throw new RefusalError(`event ${index + 1} of ${inputs.length}: ${error.message}`);
      }
      throw error;
    }
    current = { ...current, ...outcome.mutated };
    lines.push(outcome.message);
  }
  return { mutated: carried(current), message: lines.join("\n") };
}

/* ------------------------------- task tools ------------------------------------ */

/** The three states an agent may spell, in the model's own rank. */
const PRIORITY_RANK: Record<string, 0 | 1 | 2> = { normal: 0, high: 1, urgent: 2 };

export interface TaskFieldsInput {
  title?: string;
  /** YYYY-MM-DD, local — the due day. */
  date?: string;
  /** HH:MM due time; `null` clears it to a day with no time on it. */
  time?: string | null;
  /** Minutes; `null` clears it back to "no idea". */
  estimate?: number | null;
  priority?: "normal" | "high" | "urgent";
  calendarId?: string;
  color?: string;
  icon?: string;
  notes?: string;
}

/** Finds the task an id names, or refuses with the right redirection — the
 *  one id space serves two lists, and "no such id" would be a lie about a
 *  record that merely lives next door (or in a grave, which `notFound`
 *  checks before answering). */
function requireTask(contents: MirrorContents, id: string, tool: string): Task {
  const task = contents.tasks.find((t) => t.id === id);
  if (task) return task;
  if (contents.events.some((e) => e.id === id)) {
    throw new RefusalError(`"${id}" is an event, not a task — ${tool} works on tasks`);
  }
  throw notFound(contents, id, "task");
}

/** `readTask` as a gate: the assembled record must survive the same
 *  validator a backup does, `validate`'s own bargain one list over. */
function requireValidTask(assembled: Task): Task {
  const task = readTask(assembled);
  if (!task) throw new RefusalError("the assembled task failed validation (check date and time)");
  return task;
}

export function performCreateTask(
  contents: MirrorContents,
  input: TaskFieldsInput,
  pin?: string,
): WriteResult {
  if (!input.date) throw new RefusalError('a task needs "date" (YYYY-MM-DD), its due day');
  const day = parseDay(input.date);
  const calendar = resolveCalendar(input.calendarId, contents.calendars, contents.settings, pin);
  const dueAllDay = input.time === undefined || input.time === null;
  const task = requireValidTask({
    id: newId(),
    title: input.title ?? "",
    notes: input.notes ?? "",
    calendarId: calendar.id,
    icon: input.icon ?? "",
    color: input.color ?? "",
    due: dueAllDay
      ? startOfDay(day).getTime()
      : atMinutes(day, parseTime(input.time as string, "time")).getTime(),
    dueAllDay,
    estimate: input.estimate ?? null,
    priority: PRIORITY_RANK[input.priority ?? "normal"],
    plans: [],
    done: false,
    updatedAt: Date.now(),
  });
  return {
    mutated: { ...carried(contents), tasks: [...contents.tasks, task] },
    message:
      `Created ${taskSummaryLine(task, contents.calendars, contents.settings.clock)}` +
      defaultedSuffix(defaultedCalendar(input.calendarId, pin)),
  };
}

export function performUpdateTask(
  contents: MirrorContents,
  id: string,
  patch: TaskFieldsInput,
): WriteResult {
  const original = requireTask(contents, id, "update_task");
  // The deadline, re-derived only from what the patch names: a new day keeps
  // a timed deadline's own minute, a new time keeps the day, `time: null`
  // clears the minute — and a patch naming neither leaves both alone.
  const day = patch.date ? parseDay(patch.date) : startOfDay(new Date(original.due));
  const dueAllDay =
    patch.time === null ? true : patch.time !== undefined ? false : original.dueAllDay;
  const dueMin =
    typeof patch.time === "string"
      ? parseTime(patch.time, "time")
      : minutesOfDay(new Date(original.due));
  const calendar = patch.calendarId
    ? resolveCalendar(patch.calendarId, contents.calendars, contents.settings)
    : undefined;
  const next = requireValidTask({
    ...original,
    title: patch.title ?? original.title,
    notes: patch.notes ?? original.notes,
    calendarId: calendar?.id ?? original.calendarId,
    color: patch.color ?? original.color,
    icon: patch.icon ?? original.icon,
    due: dueAllDay ? startOfDay(day).getTime() : atMinutes(day, dueMin).getTime(),
    dueAllDay,
    estimate: patch.estimate !== undefined ? patch.estimate : original.estimate,
    priority: patch.priority !== undefined ? PRIORITY_RANK[patch.priority] : original.priority,
    updatedAt: Date.now(),
  });
  return {
    mutated: {
      ...carried(contents),
      tasks: contents.tasks.map((t) => (t.id === id ? next : t)),
    },
    message: `Updated ${taskSummaryLine(next, contents.calendars, contents.settings.clock)}`,
  };
}

export function performPlanTask(
  contents: MirrorContents,
  id: string,
  date: string,
  start: string,
  end: string | undefined,
  duration: number | undefined,
): WriteResult {
  const original = requireTask(contents, id, "plan_task");
  if (original.done) throw new RefusalError("this task is already done — nothing to plan");
  if (original.plans.length >= PLANS_MAX) {
    throw new RefusalError(`this task already carries ${PLANS_MAX} plans, the cap`);
  }
  const day = parseDay(date);
  const startMin = parseTime(start, "start");
  const endMin =
    end !== undefined
      ? parseTime(end, "end")
      : startMin + (duration ?? original.estimate ?? contents.settings.defaultDuration);
  if (endMin <= startMin) throw new RefusalError('"end" must be after "start"');
  const plan = { start: atMinutes(day, startMin).getTime(), end: atMinutes(day, endMin).getTime() };
  const next: Task = {
    ...original,
    plans: [...original.plans, plan].sort((a, b) => a.start - b.start || a.end - b.end),
    updatedAt: Date.now(),
  };
  const clock = contents.settings.clock;
  return {
    mutated: { ...carried(contents), tasks: contents.tasks.map((t) => (t.id === id ? next : t)) },
    message: `Planned "${next.title || "Untitled"}" ${date} ${formatTimeShort(new Date(plan.start), clock)}–${formatTimeShort(new Date(plan.end), clock)}`,
  };
}

/** The sidebar's own grouping, printed: Overdue / Due soon / Later, then
 *  Done, each row `taskSummaryLine`'s shape. `now` is a parameter for the
 *  test's sake only; the tool never passes one. */
export function listTasks(contents: MirrorContents, now: Date = new Date()): string {
  if (contents.tasks.length === 0) return "No tasks.";
  const clock = contents.settings.clock;
  const groups: [string, Task[]][] = [
    ["Overdue", []],
    ["Due soon", []],
    ["Later", []],
    ["Done", []],
  ];
  const index: Record<string, number> = { overdue: 0, "due-soon": 1, later: 2, done: 3 };
  for (const task of contents.tasks) groups[index[taskState(task, now)]][1].push(task);
  const sections = groups
    .filter(([, rows]) => rows.length > 0)
    .map(([label, rows]) =>
      [
        `${label} (${rows.length}):`,
        ...rows.sort(compareTasks).map((t) => `  ${taskSummaryLine(t, contents.calendars, clock)}`),
      ].join("\n"),
    );
  return sections.join("\n\n");
}

export function performUpdateEvent(
  contents: MirrorContents,
  id: string,
  scopeArg: string | undefined,
  occurrence: string | undefined,
  patch: EventFieldsInput,
): WriteResult {
  const original = contents.events.find((e) => e.id === id);
  if (!original) {
    // A task's id lands here from list_day and search — the refusal says
    // where the record lives rather than pretending it does not exist.
    if (contents.tasks.some((t) => t.id === id)) {
      throw new RefusalError(`id "${id}" is a task — use update_task, plan_task or toggle_done.`);
    }
    throw notFound(contents, id, "event");
  }
  refuseIfFeed(original, contents.calendars);
  const scope = requireScope(original, scopeArg);
  const clock = contents.settings.clock;

  if (scope === "all") {
    const record = applyPatchToEvent(original, patch, contents.calendars, contents.settings);
    const events = applyUpdate(contents.events, original.id, record, Date.now());
    const updated = events.find((e) => e.id === original.id) as CalEvent;
    return {
      mutated: { ...carried(contents), events },
      message: `Updated ${eventSummaryLine(updated, contents.calendars, clock)}`,
    };
  }

  const at = resolveOccurrenceRequired(original, occurrence, scope);

  if (scope === "one") {
    const record = applyPatchToEvent(original, patch, contents.calendars, contents.settings, at);
    const override: CalEvent = {
      ...record,
      ...NEVER,
      seriesId: original.id,
      seriesKey: instantKey(at),
      id: newId(),
      // An agent's write is a mutation like the app's, so it stamps like one:
      // unstamped, the browser's own copy of this document wins on the next
      // merge and the agent's work is quietly dropped.
      updatedAt: Date.now(),
    };
    return {
      mutated: { ...carried(contents), events: [...contents.events, override] },
      message: `Updated one occurrence: ${eventSummaryLine(override, contents.calendars, clock)}`,
    };
  }

  // "future"
  const record = applyPatchToEvent(original, patch, contents.calendars, contents.settings, at);
  const split = applySplit(contents.events, original.id, at, record, newId, Date.now());
  if (!split.created) throw new RefusalError(`no event with id "${id}"`);
  return {
    mutated: { ...carried(contents), events: split.events },
    message: `Updated from ${dayKey(new Date(at))} on: ${eventSummaryLine(split.created, contents.calendars, clock)}`,
  };
}

export function performDeleteEvent(
  contents: MirrorContents,
  id: string,
  scopeArg: string | undefined,
  occurrence: string | undefined,
): WriteResult {
  const original = contents.events.find((e) => e.id === id);
  if (!original) {
    // The id may name a task — one id space for the caller. Deleting one is
    // `performDeleteTask`'s single shape, delete_task's own handler.
    if (contents.tasks.some((t) => t.id === id)) return performDeleteTask(contents, id);
    throw notFound(contents, id, "event");
  }
  refuseIfFeed(original, contents.calendars);
  const scope = requireScope(original, scopeArg);
  const title = original.title || "Untitled";

  if (scope === "all") {
    const removed = applyRemove(contents.events, original.id, Date.now());
    return {
      // The graves ride with the removal, because an agent's deletion has to
      // survive the browser's next merge: without them the tab still holding
      // the event wins on stamps and writes it straight back.
      mutated: {
        ...carried(contents),
        events: removed.events,
        graves: [...contents.graves, ...removed.graves],
      },
      message: `Deleted "${title}" (the whole series).`,
    };
  }

  const at = resolveOccurrenceRequired(original, occurrence, scope);

  if (scope === "one") {
    const events = applyUpdate(
      contents.events,
      original.id,
      { exdates: [...original.exdates, instantKey(at)] },
      Date.now(),
    );
    return {
      mutated: { ...carried(contents), events },
      message: `Deleted "${title}" on ${dayKey(new Date(at))} only — the series continues.`,
    };
  }

  const cut = applyTruncate(contents.events, original.id, at, Date.now());
  return {
    mutated: {
      ...carried(contents),
      events: cut.events,
      graves: [...contents.graves, ...cut.graves],
    },
    message: `Deleted "${title}" from ${dayKey(new Date(at))} on.`,
  };
}

/** Deletes a task — one shape only: it has no series and no scope, and its
 *  grave rides with the removal, an event's own rule. `delete_event` on a
 *  task id lands here too, so the alias and the original cannot drift. */
export function performDeleteTask(contents: MirrorContents, id: string): WriteResult {
  const task = contents.tasks.find((t) => t.id === id);
  if (!task) {
    if (contents.events.some((e) => e.id === id)) {
      throw new RefusalError(`"${id}" is an event, not a task — use delete_event`);
    }
    throw notFound(contents, id, "task");
  }
  return {
    mutated: {
      ...carried(contents),
      tasks: contents.tasks.filter((t) => t.id !== id),
      graves: [...contents.graves, { id, at: Date.now() }],
    },
    message: `Deleted the task "${task.title || "Untitled"}".`,
  };
}

/** Ticks a task off, or back on. `occurrence` is accepted and ignored — a
 *  task has one deadline and is finished once, so there is nothing for the
 *  argument to disambiguate any more. */
export function performToggleDone(
  contents: MirrorContents,
  id: string,
  _occurrence: string | undefined,
): WriteResult {
  const original = contents.tasks.find((t) => t.id === id);
  if (!original) {
    if (contents.events.some((e) => e.id === id)) {
      throw new RefusalError(`"${id}" is an event, not a task`);
    }
    throw notFound(contents, id, "task");
  }
  const tasks = contents.tasks.map((t) =>
    t.id === id ? { ...t, done: !t.done, updatedAt: Date.now() } : t,
  );
  return {
    mutated: { ...carried(contents), tasks },
    message: `${original.done ? "Reopened" : "Completed"} "${original.title || "Untitled"}".`,
  };
}

export function performCreateCalendar(
  contents: MirrorContents,
  name: string,
  color: string | undefined,
  icon: string | undefined,
): WriteResult {
  const trimmed = name.trim();
  if (!trimmed) throw new RefusalError('a calendar needs a "name"');
  const calendar = readCalendar({
    id: newId(),
    name: trimmed,
    color: color || PALETTE[(contents.calendars.length * 3) % PALETTE.length],
    icon: icon ?? "",
    visible: true,
    updatedAt: Date.now(),
  });
  if (!calendar) throw new RefusalError("the assembled calendar failed validation");
  return {
    mutated: { ...carried(contents), calendars: [...contents.calendars, calendar] },
    message: `Created calendar "${calendar.name}" — id=${calendar.id}`,
  };
}

function resolveOccurrenceRequired(
  event: CalEvent,
  occurrence: string | undefined,
  scope: Scope,
): number {
  if (!occurrence) {
    throw new RefusalError(
      `scope "${scope}" needs "occurrence" (a YYYY-MM-DD date or full instant)`,
    );
  }
  return resolveInstant(event, occurrence);
}
