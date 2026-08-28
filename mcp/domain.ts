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
  dayAgenda,
  dayLoad,
  freeGaps,
  occurrencesOn,
  taskOccurrences,
  recurrenceOf,
  scoreEvent,
  spanLabel,
  type CalEvent,
  type Calendar,
  type Occurrence,
} from "@/lib/events";
import { scoreTask, type Task } from "@/lib/tasks";
import { applyRemove, applySplit, applyTruncate, applyUpdate } from "@/lib/mutate";
import { parseQuickAdd } from "@/lib/quickadd";
import { NEVER, instantKey, keyToInstant, readRecurrence, repeats, type Repeat } from "@/lib/recur";
import {
  addDays,
  atMinutes,
  daysBetween,
  dayKey,
  formatDuration,
  formatTimeShort,
  fromDayKey,
  minutesOfDay,
  parseClock,
  startOfDay,
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

export function resolveCalendar(
  calendarId: string | undefined,
  calendars: Calendar[],
  settings: Settings,
): Calendar {
  if (calendarId) {
    const found = calendars.find((c) => c.id === calendarId);
    if (!found) throw new RefusalError(`no calendar with id "${calendarId}"`);
    if (found.feed) {
      throw new RefusalError(
        `"${found.name}" is a subscription — its events are pulled from a feed, never written to`,
      );
    }
    return found;
  }
  const id = defaultCalendarId(calendars, settings.defaultCalendar);
  const found = calendars.find((c) => c.id === id);
  if (!found) throw new RefusalError("there is no calendar to put this on — create one first");
  return found;
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
 *  the event does not repeat. */
function buildRecurrence(input: RecurrenceInput | undefined) {
  if (!input) return { ...NEVER };
  const until = input.until ? addDays(fromDayKey(input.until), 1).getTime() - 1 : 0;
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
  /** YYYY-MM-DD, local. */
  date?: string;
  /** HH:MM, 24-hour local clock. */
  start?: string;
  /** HH:MM for a timed event; YYYY-MM-DD (inclusive) for an all-day one. */
  end?: string;
  /** Minutes — an alternative to `end` for a timed event. */
  duration?: number;
  allDay?: boolean;
  /** A dated to-do rather than an event — routed to the task list. */
  task?: boolean;
  calendarId?: string;
  color?: string;
  icon?: string;
  location?: string;
  url?: string;
  notes?: string;
  recurrence?: RecurrenceInput;
}

/** A brand-new event's span. No time named at all reads as all day — the
 *  same rule `parseQuickAdd` uses: nothing here is invented. */
function resolveSpanForCreate(input: EventFieldsInput, day: Date, defaultDuration: number): Span {
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
    start: atMinutes(day, startMin).getTime(),
    end: atMinutes(day, endMin).getTime(),
    allDay: false,
  };
}

/** A patched span, anchored at `anchorMs` — the series' own seed for an
 *  `"all"` edit, the occurrence's instant for a `"one"` override or a
 *  `"future"` split. A field the patch does not name keeps the base event's
 *  own value, so "just move it an hour" does not also reset its length. */
function resolveSpanForPatch(input: EventFieldsInput, base: CalEvent, anchorMs: number): Span {
  const day = input.date ? parseDay(input.date) : startOfDay(new Date(anchorMs));
  const allDay = input.allDay ?? base.allDay;
  if (allDay) {
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
    input.start !== undefined ? parseTime(input.start, "start") : minutesOfDay(new Date(anchorMs));
  const endMin =
    input.end !== undefined
      ? parseTime(input.end, "end")
      : startMin + (input.duration ?? baseDurationMin);
  return {
    start: atMinutes(day, startMin).getTime(),
    end: atMinutes(day, endMin).getTime(),
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
): Omit<CalEvent, "id"> {
  if (!input.date) throw new RefusalError('an event needs "date" (YYYY-MM-DD)');
  const day = parseDay(input.date);
  const calendar = resolveCalendar(input.calendarId, calendars, settings);
  const span = resolveSpanForCreate(input, day, settings.defaultDuration);
  return validate({
    title: input.title ?? "",
    calendarId: calendar.id,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    tzid: "",
    location: input.location ?? "",
    url: input.url ?? "",
    notes: input.notes ?? "",
    ...buildRecurrence(input.recurrence),
    seriesId: "",
    seriesKey: "",
    color: input.color ?? "",
    icon: input.icon ?? "",
    // Busy. There is no tool argument for this yet, and an agent asked to put
    // an hour in the diary means the hour to be spoken for.
    free: false,
    // Inheriting, for the same reason: no tool argument names a lead, and an
    // event created with one of its own would be an agent quietly deciding
    // how much warning its user wants.
    remindLead: REMIND_INHERIT,
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
  const span = resolveSpanForPatch(input, base, anchorMs);
  return validate({
    title: input.title ?? base.title,
    calendarId: calendar.id,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
    tzid: base.tzid,
    location: input.location ?? base.location,
    url: input.url ?? base.url,
    notes: input.notes ?? base.notes,
    ...(input.recurrence ? buildRecurrence(input.recurrence) : recurrenceOf(base)),
    seriesId: base.seriesId,
    seriesKey: base.seriesKey,
    color: input.color ?? base.color,
    icon: input.icon ?? base.icon,
    // Carried, like every other field a patch does not name: `validate` reads
    // the draft through `backup.readEvent`, which defaults an absent `free`
    // to busy — so leaving it out would quietly rebook a free event the
    // moment its title was edited.
    free: base.free,
    // Carried for exactly the reason above, and this is the field where it
    // costs most: an event the user silenced would start speaking again the
    // moment an assistant fixed a typo in its title, because `readEvent`
    // reads an absent lead as inheriting.
    remindLead: base.remindLead,
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

/* -------------------------------- formatting -------------------------------- */

function calendarName(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.name ?? "—";
}

export function eventSummaryLine(event: CalEvent, calendars: Calendar[], clock: Clock): string {
  const when = event.allDay
    ? `${dayKey(new Date(event.start))} – ${dayKey(addDays(new Date(event.end), -1))} (all day)`
    : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}`;
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
      score: scoreEvent(event, query),
    }))
    .concat(
      contents.tasks.map((task) => ({
        line: taskSummaryLine(task, contents.calendars, clock),
        score: scoreTask(task, query),
      })),
    )
    .filter((s): s is { line: string; score: number } => s.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
  return [
    `"${query}" — ${scored.length} match${scored.length === 1 ? "" : "es"}`,
    ...(scored.length ? scored.map(({ line }) => line) : ["(none)"]),
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
    throw new RefusalError(`no event with id "${id}"`);
  }
  const calendar = contents.calendars.find((c) => c.id === event.calendarId);
  const clock = contents.settings.clock;
  return [
    `${event.title || "Untitled"}  (id=${event.id})`,
    `Calendar: ${calendarName(contents.calendars, event.calendarId)}${calendar?.feed ? " (subscription, read-only)" : ""}`,
    event.allDay
      ? `All day, ${dayKey(new Date(event.start))} to ${dayKey(addDays(new Date(event.end), -1))}`
      : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}`,
    `Repeats: ${repeats(event) ? describeRule(event) : "never"}`,
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

/* ------------------------------- write tools ---------------------------------- */

export interface WriteResult {
  mutated: Mutated;
  message: string;
}

export function performQuickAdd(
  contents: MirrorContents,
  text: string,
  date: string | undefined,
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
  const calendar = resolveCalendar(undefined, contents.calendars, contents.settings);
  const record = validate({
    ...draftEvent(parsed.day, parsed.startMin, parsed.endMin, calendar.id),
    title: parsed.title,
    ...parsed.repeat,
  });
  const event: CalEvent = { ...record, id: newId(), updatedAt: Date.now() };
  return {
    mutated: { ...carried(contents), events: [...contents.events, event] },
    message: `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}`,
  };
}

export function performCreateEvent(contents: MirrorContents, input: EventFieldsInput): WriteResult {
  // `task: true` routes to the task list: a task is its own record now, with
  // a deadline rather than a span. `start` names a due time; without one the
  // deadline is a date with no time on it.
  if (input.task === true) {
    if (!input.date) throw new RefusalError('a task needs "date" (YYYY-MM-DD)');
    const day = parseDay(input.date);
    const calendar = resolveCalendar(input.calendarId, contents.calendars, contents.settings);
    const dueAllDay = input.start === undefined;
    const due = dueAllDay
      ? startOfDay(day).getTime()
      : atMinutes(day, parseTime(input.start as string, "start")).getTime();
    // Through `readTask`, `validate`'s own bargain: an agent is exactly the
    // untrusted input that boundary already assumes.
    const task = readTask({
      id: newId(),
      title: input.title ?? "",
      notes: input.notes ?? "",
      calendarId: calendar.id,
      icon: input.icon ?? "",
      color: input.color ?? "",
      due,
      dueAllDay,
      estimate: null,
      priority: 0,
      plans: [],
      done: false,
      updatedAt: Date.now(),
    });
    if (!task)
      throw new RefusalError("the assembled task failed validation (check date and start)");
    return {
      mutated: { ...carried(contents), tasks: [...contents.tasks, task] },
      message: `Created ${taskSummaryLine(task, contents.calendars, contents.settings.clock)}`,
    };
  }
  const record = buildEventRecord(input, contents.calendars, contents.settings);
  const event: CalEvent = { ...record, id: newId(), updatedAt: Date.now() };
  return {
    mutated: { ...carried(contents), events: [...contents.events, event] },
    message: `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}`,
  };
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
    // A task's id lands here from list_day and search; its patch vocabulary
    // is its own and arrives in a later stage, so the refusal says where the
    // record lives rather than pretending it does not exist.
    if (contents.tasks.some((t) => t.id === id)) {
      throw new RefusalError(
        `id "${id}" is a task — update_event edits events. Use toggle_done to tick it, or edit it in the app.`,
      );
    }
    throw new RefusalError(`no event with id "${id}"`);
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
    // Deleting a task is one shape only — it has no series and no scope —
    // and its grave rides with the removal, an event's own rule.
    const task = contents.tasks.find((t) => t.id === id);
    if (task) {
      return {
        mutated: {
          ...carried(contents),
          tasks: contents.tasks.filter((t) => t.id !== id),
          graves: [...contents.graves, { id, at: Date.now() }],
        },
        message: `Deleted the task "${task.title || "Untitled"}".`,
      };
    }
    throw new RefusalError(`no event with id "${id}"`);
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
    throw new RefusalError(`no task with id "${id}"`);
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
