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

import { readCalendar, readEvent } from "@/lib/backup";
import { describeRule } from "@/lib/describe";
import {
  DEFAULT_WAKING,
  PALETTE,
  REMIND_INHERIT,
  dayAgenda,
  dayLoad,
  freeGaps,
  occurrencesOn,
  recurrenceOf,
  scoreEvent,
  spanLabel,
  type CalEvent,
  type Calendar,
  type Occurrence,
} from "@/lib/events";
import { applyRemove, applySplit, applyToggleDone, applyTruncate, applyUpdate } from "@/lib/mutate";
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
  task: boolean;
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
  if (input.task === true) {
    if (input.start === undefined) throw new RefusalError('a task needs "start" (HH:MM)');
    const at = atMinutes(day, parseTime(input.start, "start")).getTime();
    return { start: at, end: at, allDay: false, task: true };
  }
  const noTimeGiven =
    input.start === undefined && input.end === undefined && input.duration === undefined;
  const allDay = input.allDay === true || (input.allDay === undefined && noTimeGiven);
  if (allDay) {
    const days = input.end ? Math.max(1, daysBetween(day, fromDayKey(input.end)) + 1) : 1;
    return {
      start: startOfDay(day).getTime(),
      end: addDays(startOfDay(day), days).getTime(),
      allDay: true,
      task: false,
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
    task: false,
  };
}

/** A patched span, anchored at `anchorMs` — the series' own seed for an
 *  `"all"` edit, the occurrence's instant for a `"one"` override or a
 *  `"future"` split. A field the patch does not name keeps the base event's
 *  own value, so "just move it an hour" does not also reset its length. */
function resolveSpanForPatch(input: EventFieldsInput, base: CalEvent, anchorMs: number): Span {
  const day = input.date ? parseDay(input.date) : startOfDay(new Date(anchorMs));
  const task = input.task ?? base.task;
  if (task) {
    const startMin =
      input.start !== undefined
        ? parseTime(input.start, "start")
        : minutesOfDay(new Date(anchorMs));
    const at = atMinutes(day, startMin).getTime();
    return { start: at, end: at, allDay: false, task: true };
  }
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
      task: false,
    };
  }
  // A base with no width of its own (it was a task) falls back to a minute
  // rather than `DEFAULT_DURATION` — `Math.max` never returns `0`, so a
  // second fallback here would be unreachable, not a second safety net.
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
    task: false,
  };
}

/* -------------------------------- records ----------------------------------- */

/** Runs an assembled record through `readEvent` — the same boundary a backup
 *  import crosses, and the right one: an agent is exactly the untrusted
 *  input that boundary already assumes. */
function validate(draft: Record<string, unknown>): Omit<CalEvent, "id"> {
  const validated = readEvent({ ...draft, id: "pending" });
  if (!validated)
    throw new RefusalError("the assembled event failed validation (check start, end and task)");
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
    task: span.task,
    doneKeys: [],
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
    task: span.task,
    doneKeys: base.doneKeys,
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
  });
}

/* -------------------------------- formatting -------------------------------- */

function calendarName(calendars: Calendar[], id: string): string {
  return calendars.find((c) => c.id === id)?.name ?? "—";
}

export function eventSummaryLine(event: CalEvent, calendars: Calendar[], clock: Clock): string {
  const when = event.task
    ? `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}`
    : event.allDay
      ? `${dayKey(new Date(event.start))} – ${dayKey(addDays(new Date(event.end), -1))} (all day)`
      : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}`;
  return `${event.title || "Untitled"} — [${calendarName(calendars, event.calendarId)}] — ${when} — id=${event.id}`;
}

export function occurrenceLine(occ: Occurrence, calendars: Calendar[], clock: Clock): string {
  const when = occ.event.allDay
    ? "all day"
    : occ.event.task
      ? `${occ.start.toISOString()} (${formatTimeShort(occ.start, clock)})`
      : `${occ.start.toISOString()} (${formatTimeShort(occ.start, clock)}) – ${occ.end.toISOString()} (${formatTimeShort(occ.end, clock)})`;
  const span = spanLabel(occ);
  const bits = [
    occ.event.title || "Untitled",
    `[${calendarName(calendars, occ.event.calendarId)}]`,
    when,
    ...(span ? [span] : []),
    ...(occ.event.task ? [occ.done ? "done" : "open"] : []),
    `id=${occ.event.id}`,
    `occurrence=${dayKey(occ.start)}`,
  ];
  return bits.join("  ·  ");
}

/* ---------------------------- read-only tools -------------------------------- */

export function listDay(contents: MirrorContents, date: string): string {
  assertDateKey(date);
  const day = fromDayKey(date);
  const agenda = dayAgenda(contents.events, contents.calendars, day);
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
    const occs = occurrencesOn(contents.events, contents.calendars, day);
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
  const scored = contents.events
    .map((event) => ({ event, score: scoreEvent(event, query) }))
    .filter((s): s is { event: CalEvent; score: number } => s.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  return [
    `"${query}" — ${scored.length} match${scored.length === 1 ? "" : "es"}`,
    ...(scored.length
      ? scored.map(({ event }) => eventSummaryLine(event, contents.calendars, clock))
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
  const occs = occurrencesOn(contents.events, contents.calendars, day);
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
  if (!event) throw new RefusalError(`no event with id "${id}"`);
  const calendar = contents.calendars.find((c) => c.id === event.calendarId);
  const clock = contents.settings.clock;
  return [
    `${event.title || "Untitled"}  (id=${event.id})`,
    `Calendar: ${calendarName(contents.calendars, event.calendarId)}${calendar?.feed ? " (subscription, read-only)" : ""}`,
    event.task
      ? `Task at ${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}`
      : event.allDay
        ? `All day, ${dayKey(new Date(event.start))} to ${dayKey(addDays(new Date(event.end), -1))}`
        : `${dayKey(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}–${formatTimeShort(new Date(event.end), clock)}`,
    `Repeats: ${repeats(event) ? describeRule(event) : "never"}`,
    ...(event.location ? [`Location: ${event.location}`] : []),
    ...(event.url ? [`URL: ${event.url}`] : []),
    ...(event.notes ? [`Notes: ${event.notes}`] : []),
    ...(event.seriesId
      ? [`Overrides one occurrence of id=${event.seriesId} (${event.seriesKey})`]
      : []),
    ...(event.task
      ? [
          `Done: ${event.doneKeys.length} occurrence${event.doneKeys.length === 1 ? "" : "s"} ticked`,
        ]
      : []),
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
  const event: CalEvent = { ...record, id: newId() };
  return {
    mutated: {
      events: [...contents.events, event],
      calendars: contents.calendars,
      settings: contents.settings,
    },
    message: `Created ${eventSummaryLine(event, contents.calendars, contents.settings.clock)}`,
  };
}

export function performCreateEvent(contents: MirrorContents, input: EventFieldsInput): WriteResult {
  const record = buildEventRecord(input, contents.calendars, contents.settings);
  const event: CalEvent = { ...record, id: newId() };
  return {
    mutated: {
      events: [...contents.events, event],
      calendars: contents.calendars,
      settings: contents.settings,
    },
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
  if (!original) throw new RefusalError(`no event with id "${id}"`);
  refuseIfFeed(original, contents.calendars);
  const scope = requireScope(original, scopeArg);
  const clock = contents.settings.clock;

  if (scope === "all") {
    const record = applyPatchToEvent(original, patch, contents.calendars, contents.settings);
    const events = applyUpdate(contents.events, original.id, record);
    const updated = events.find((e) => e.id === original.id) as CalEvent;
    return {
      mutated: { events, calendars: contents.calendars, settings: contents.settings },
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
    };
    return {
      mutated: {
        events: [...contents.events, override],
        calendars: contents.calendars,
        settings: contents.settings,
      },
      message: `Updated one occurrence: ${eventSummaryLine(override, contents.calendars, clock)}`,
    };
  }

  // "future"
  const record = applyPatchToEvent(original, patch, contents.calendars, contents.settings, at);
  const split = applySplit(contents.events, original.id, at, record, newId);
  if (!split.created) throw new RefusalError(`no event with id "${id}"`);
  return {
    mutated: { events: split.events, calendars: contents.calendars, settings: contents.settings },
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
  if (!original) throw new RefusalError(`no event with id "${id}"`);
  refuseIfFeed(original, contents.calendars);
  const scope = requireScope(original, scopeArg);
  const title = original.title || "Untitled";

  if (scope === "all") {
    return {
      mutated: {
        events: applyRemove(contents.events, original.id),
        calendars: contents.calendars,
        settings: contents.settings,
      },
      message: `Deleted "${title}" (the whole series).`,
    };
  }

  const at = resolveOccurrenceRequired(original, occurrence, scope);

  if (scope === "one") {
    const events = applyUpdate(contents.events, original.id, {
      exdates: [...original.exdates, instantKey(at)],
    });
    return {
      mutated: { events, calendars: contents.calendars, settings: contents.settings },
      message: `Deleted "${title}" on ${dayKey(new Date(at))} only — the series continues.`,
    };
  }

  return {
    mutated: {
      events: applyTruncate(contents.events, original.id, at),
      calendars: contents.calendars,
      settings: contents.settings,
    },
    message: `Deleted "${title}" from ${dayKey(new Date(at))} on.`,
  };
}

export function performToggleDone(
  contents: MirrorContents,
  id: string,
  occurrence: string | undefined,
): WriteResult {
  const original = contents.events.find((e) => e.id === id);
  if (!original) throw new RefusalError(`no event with id "${id}"`);
  if (!original.task) throw new RefusalError(`"${original.title || "Untitled"}" is not a task`);
  refuseIfFeed(original, contents.calendars);
  const at = resolveInstant(original, occurrence);
  const wasDone = original.doneKeys.includes(instantKey(at));
  const events = applyToggleDone(contents.events, original.id, at);
  return {
    mutated: { events, calendars: contents.calendars, settings: contents.settings },
    message: `${wasDone ? "Reopened" : "Completed"} "${original.title || "Untitled"}" on ${dayKey(new Date(at))}.`,
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
  });
  if (!calendar) throw new RefusalError("the assembled calendar failed validation");
  return {
    mutated: {
      events: contents.events,
      calendars: [...contents.calendars, calendar],
      settings: contents.settings,
    },
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
