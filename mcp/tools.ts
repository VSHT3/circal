/* ------------------------------------------------------------------ *
 * The tool table: one Zod schema and one handler per tool, registered
 * onto the `McpServer` handed in from `index.ts`. The SDK derives the
 * JSON Schema a model sees from each Zod schema and validates
 * arguments against it before a handler ever runs — the defensive
 * argument coercion the v1 server needed here is now the SDK's job,
 * not this file's.
 * ------------------------------------------------------------------ */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { REMIND_LEAD_MAX } from "@/lib/events";
import type { Store } from "./store";
import {
  CREATE_BATCH_MAX,
  UPSERT_KEY_RE,
  MAX_RANGE_DAYS,
  MAX_RANGE_OCCURRENCES,
  describeEvent,
  freeSlots,
  listCalendars,
  listDay,
  listRange,
  listTasks,
  performCreateCalendar,
  performCreateEvent,
  performCreateEvents,
  performCreateTask,
  performDeleteEvent,
  performDeleteTask,
  performPlanTask,
  performQuickAdd,
  performToggleDone,
  performUpdateEvent,
  performUpdateTask,
  scopedToCalendar,
  searchEvents,
  syncStatus,
} from "./domain";

/* -------------------------------- results ------------------------------------ */

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function withWarning(text: string, warning: string | null): string {
  return warning ? `${warning}\n\n${text}` : text;
}

/** Runs a handler body and turns a thrown `Error` into a result the model can
 *  read, rather than a transport-level error it cannot see. A `RefusalError`
 *  is circal's own domain saying no — a bad scope, a subscription calendar, a
 *  zone mismatch. Anything else that is a real `Error` (an I/O failure) is
 *  reported the same way. Anything that is not even an `Error` is not ours to
 *  interpret, so it is left to propagate. */
async function guarded(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return textResult(await run());
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

/* ------------------------------- schemas -------------------------------------- */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_KEY_MESSAGE = "must be YYYY-MM-DD, local";

function dateKey(description: string) {
  return z.string().regex(DATE_KEY_RE, DATE_KEY_MESSAGE).describe(description);
}

const RECURRENCE_DESCRIPTION =
  "Replaces the event's whole recurrence rule, exceptions included. Omit entirely for a " +
  "one-off event on create, or to leave an existing rule untouched on update.";

const recurrenceSchema = z
  .strictObject({
    repeat: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).describe("Every Nth period; 1 = every one.").optional(),
    until: dateKey(
      "YYYY-MM-DD, local, inclusive — the last day an occurrence may start. Omit for no end.",
    ).optional(),
    wkst: z
      .number()
      .int()
      .min(0)
      .max(6)
      .describe("Week-start weekday, 0=Sunday..6=Saturday.")
      .optional(),
    byDay: z
      .array(
        z.strictObject({
          day: z.number().int().min(0).max(6),
          nth: z.number().int().min(-5).max(5).optional(),
        }),
      )
      .describe(
        "Which weekdays, for a weekly or monthly rule. day: 0=Sunday..6=Saturday. nth (monthly only): " +
          "1st..5th from the start of the month, negative from the end, 0 or omitted = every one.",
      )
      .optional(),
    byMonthDay: z
      .array(z.number().int().min(-31).max(31))
      .describe("Days of the month, 1-31 or negative counted from the end.")
      .optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    byWeekNo: z.array(z.number().int().min(-53).max(53)).optional(),
    byYearDay: z.array(z.number().int().min(-366).max(366)).optional(),
    bySetPos: z
      .array(z.number().int())
      .describe("Which of the period's own occurrences to keep, e.g. -1 = the last one.")
      .optional(),
  })
  .describe(RECURRENCE_DESCRIPTION);

/** Shared shape between `create_event`'s fields and `update_event`'s
 *  `patch` — every field optional here; `createEventFieldsSchema` below
 *  overrides `date` to required, the one place the two diverge. */
function eventFieldsShape() {
  return {
    title: z.string().optional(),
    date: dateKey("YYYY-MM-DD, local.").optional(),
    start: z
      .string()
      .describe("HH:MM, 24-hour local clock. Required for a timed event.")
      .optional(),
    end: z
      .string()
      .describe(
        "HH:MM for a timed event, or YYYY-MM-DD (inclusive) for a multi-day all-day event. " +
          "Alternative to duration.",
      )
      .optional(),
    duration: z.number().describe("Minutes — an alternative to end, for a timed event.").optional(),
    allDay: z
      .boolean()
      .describe("Forces an all-day event. Inferred when start, end and duration are all omitted.")
      .optional(),
    calendarId: z
      .string()
      .describe(
        "Defaults to the user's default calendar. Must not be a subscription — those are read-only.",
      )
      .optional(),
    color: z.string().describe("#rrggbb. Empty follows the calendar's own colour.").optional(),
    icon: z
      .string()
      .describe("A Phosphor icon name or one emoji. Empty follows the calendar's own mark.")
      .optional(),
    location: z.string().optional(),
    url: z.string().optional(),
    notes: z.string().optional(),
    zone: z
      .string()
      .describe(
        'IANA zone the date and times are written in, e.g. "Asia/Seoul" — for a deadline ' +
          "abroad. Stored on the event so every surface prints both clocks; timed events " +
          'only. On update, "" clears it back to floating (local) time, and patched times ' +
          "are read on the event's own zone.",
      )
      .optional(),
    remindLead: z
      .union([z.number().int().min(0).max(REMIND_LEAD_MAX), z.enum(["inherit", "silent"])])
      .describe(
        'Reminder lead: minutes before the start (0 = as it starts), "silent" (never fires), ' +
          'or "inherit" (follow the calendar, then the setting — the default).',
      )
      .optional(),
    recurrence: recurrenceSchema.optional(),
  };
}

const upsertKeySchema = z
  .string()
  .regex(UPSERT_KEY_RE, "letters, digits, . _ : -, up to 64")
  .describe(
    "Caller-chosen external key for idempotent upsert: the same key always names the same " +
      "event, so re-running a mirror updates in place instead of duplicating. A keyed create " +
      "also overrides a prior deletion — the source of truth re-asserts — so to drop a record " +
      "for good, remove it from the source, not just the calendar. Omitted, every call creates " +
      "a fresh event.",
  );

const createEventFieldsSchema = z.strictObject({
  ...eventFieldsShape(),
  date: dateKey("YYYY-MM-DD, local."),
  key: upsertKeySchema.optional(),
});

const patchEventFieldsSchema = z.strictObject(eventFieldsShape());

/** Shared shape between `create_task`'s fields and `update_task`'s `patch` —
 *  every field optional here; create overrides `date` to required,
 *  `eventFieldsShape`'s own bargain one record over. */
function taskFieldsShape() {
  return {
    title: z.string().optional(),
    date: dateKey("YYYY-MM-DD, local — the due day.").optional(),
    time: z
      .string()
      .nullable()
      .describe(
        "HH:MM due time, 24-hour local clock. Omit for a deadline that is a date with no " +
          "time on it; null (on update) clears an existing due time back to that.",
      )
      .optional(),
    estimate: z
      .number()
      .nullable()
      .describe("Minutes of work this looks like. null (on update) clears it back to unknown.")
      .optional(),
    priority: z.enum(["normal", "high", "urgent"]).optional(),
    calendarId: z
      .string()
      .describe(
        "Defaults to the user's default calendar. Must not be a subscription — those are read-only.",
      )
      .optional(),
    color: z.string().describe("#rrggbb. Empty follows the calendar's own colour.").optional(),
    icon: z
      .string()
      .describe("A Phosphor icon name or one emoji. Empty follows the calendar's own mark.")
      .optional(),
    notes: z.string().optional(),
  };
}

const createTaskFieldsSchema = z.strictObject({
  ...taskFieldsShape(),
  date: dateKey("YYYY-MM-DD, local — the due day."),
});

const patchTaskFieldsSchema = z.strictObject(taskFieldsShape());

const SCOPE_DESCRIPTION =
  'Required when the target event repeats: "one" (just this occurrence), "future" (this one and ' +
  'everything after), or "all" (the whole series). Ignored when the event does not repeat.';
const OCCURRENCE_DESCRIPTION =
  'Which occurrence, as a YYYY-MM-DD date or a full "YYYY-MM-DDTHH:mm:ss" instant. Required with ' +
  'scope "one" or "future".';

const scopeSchema = z.enum(["one", "future", "all"]).describe(SCOPE_DESCRIPTION);
const occurrenceSchema = z.string().describe(OCCURRENCE_DESCRIPTION);

const calendarFilterSchema = z
  .string()
  .describe("Scope to one calendar — its id, or a unique name prefix. Omit for every calendar.");

/* --------------------------------- tools -------------------------------------- */

/** `pin` is the connection's own default calendar (`--calendar` /
 *  `CIRCAL_CALENDAR`): writes that name no calendar land on it instead of
 *  the user default — an admissions agent stays on its calendar. */
export function registerTools(server: McpServer, store: Store, pin?: string): void {
  server.registerTool(
    "list_day",
    {
      description:
        "The agenda for one local day: recurrence expanded, all-day and timed occurrences listed " +
        "separately, each with its id (for update_event/delete_event/toggle_done), its occurrence key, " +
        "and — for a multi-day span — its Day N/M position.",
      inputSchema: z.strictObject({
        date: dateKey("YYYY-MM-DD, local."),
        calendar: calendarFilterSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date, calendar }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listDay(scopedToCalendar(contents, calendar), date), warning);
      }),
  );

  server.registerTool(
    "list_range",
    {
      description:
        `The agenda across several local days, one section per day that has something on it. Capped ` +
        `at ${MAX_RANGE_DAYS} days of span and ${MAX_RANGE_OCCURRENCES} occurrences total — a wide range ` +
        `may come back truncated, which the response says.`,
      inputSchema: z.strictObject({
        from: dateKey("YYYY-MM-DD, local, inclusive."),
        to: dateKey("YYYY-MM-DD, local, inclusive."),
        calendar: calendarFilterSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, calendar }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listRange(scopedToCalendar(contents, calendar), from, to), warning);
      }),
  );

  server.registerTool(
    "search",
    {
      description:
        "Ranked title/location/notes search over the user's own events (never a subscription's). " +
        "Each result names the field it matched when it was not the title.",
      inputSchema: z.strictObject({
        query: z.string(),
        limit: z.number().int().min(1).describe("Default 20.").optional(),
        calendar: calendarFilterSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, calendar }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(
          searchEvents(scopedToCalendar(contents, calendar), query, limit),
          warning,
        );
      }),
  );

  server.registerTool(
    "free_slots",
    {
      description:
        "Gaps of at least `minutes` on one day, inside a window that defaults to the user's own waking " +
        "hours setting. Also reports the day's booked and free minutes across that window.",
      inputSchema: z.strictObject({
        date: dateKey("YYYY-MM-DD, local."),
        minutes: z.number().describe("Minimum slot length, in minutes."),
        from: z
          .string()
          .describe("HH:MM, local. Defaults to the user's waking-hours start.")
          .optional(),
        to: z
          .string()
          .describe("HH:MM, local. Defaults to the user's waking-hours end.")
          .optional(),
        calendar: calendarFilterSchema.optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date, minutes, from, to, calendar }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(
          freeSlots(scopedToCalendar(contents, calendar), date, minutes, from, to),
          warning,
        );
      }),
  );

  server.registerTool(
    "list_calendars",
    {
      description:
        "Every calendar: id, name, colour, whether it is a read-only subscription, and visibility.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listCalendars(contents), warning);
      }),
  );

  server.registerTool(
    "describe_event",
    {
      description: "One event in full, including its recurrence rendered as an English sentence.",
      inputSchema: z.strictObject({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(describeEvent(contents, id), warning);
      }),
  );

  server.registerTool(
    "quick_add",
    {
      description:
        "Creates an event from one line of text, through circal's own quick-add grammar — the same " +
        'parser the app\'s own command palette uses. Understands things like "lunch tomorrow 1pm 45m" ' +
        'and "gym every monday 7am". Returns the resolved event for confirmation.',
      inputSchema: z.strictObject({
        text: z.string(),
        date: dateKey(
          'YYYY-MM-DD, local — what "tomorrow" etc. is relative to. Defaults to today.',
        ).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text, date }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performQuickAdd(contents, text, date, pin);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "create_event",
    {
      description:
        "Creates an event from explicit fields, for anything quick_add's grammar cannot spell — a full " +
        "recurrence, a specific calendar, notes, a foreign time zone, a reminder lead. Every field is " +
        "validated the same way an imported backup is. `key` makes the call an idempotent upsert.",
      inputSchema: createEventFieldsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guarded(() =>
        store.write((contents) => {
          const { key, ...fields } = input;
          const outcome = performCreateEvent(contents, fields, key, pin);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "create_events",
    {
      description:
        `Creates (or, with a per-record \`key\`, upserts) up to ${CREATE_BATCH_MAX} events in one ` +
        "write — one revision bump, all-or-nothing: any refused record refuses the whole batch " +
        "naming which. The convergent way to mirror an external document into the calendar.",
      inputSchema: z.strictObject({
        events: z.array(createEventFieldsSchema).min(1).max(CREATE_BATCH_MAX),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ events }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performCreateEvents(contents, events, pin);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "update_event",
    {
      description:
        "Patches an existing event. Every field in `patch` is optional and left alone when omitted. " +
        SCOPE_DESCRIPTION,
      inputSchema: z.strictObject({
        id: z.string(),
        scope: scopeSchema.optional(),
        occurrence: occurrenceSchema.optional(),
        patch: patchEventFieldsSchema,
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, scope, occurrence, patch }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performUpdateEvent(contents, id, scope, occurrence, patch);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "delete_event",
    {
      description: `Deletes an event, or one occurrence, or a series' tail. ${SCOPE_DESCRIPTION}`,
      inputSchema: z.strictObject({
        id: z.string(),
        scope: scopeSchema.optional(),
        occurrence: occurrenceSchema.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, scope, occurrence }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performDeleteEvent(contents, id, scope, occurrence);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "delete_task",
    {
      description:
        "Deletes a task. The same removal delete_event performs on a task id — this name exists " +
        "so the task verbs read as the set they are (create_task, update_task, delete_task).",
      inputSchema: z.strictObject({ id: z.string() }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performDeleteTask(contents, id);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "toggle_done",
    {
      description: "Ticks a task off, or back on — a task has one deadline and is finished once.",
      inputSchema: z.strictObject({
        id: z.string(),
        occurrence: z
          .string()
          .describe("Accepted for compatibility and ignored — a task is ticked whole.")
          .optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ id, occurrence }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performToggleDone(contents, id, occurrence);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "Every task, grouped the way the app's own sidebar groups them — Overdue, Due soon, " +
        "Later, Done — soonest deadline first inside each group.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listTasks(contents), warning);
      }),
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Creates a task: a piece of work with a deadline, distinct from an event. `date` is the " +
        "due day; add `time` for a timed deadline, `estimate` so auto-schedule can size it.",
      inputSchema: createTaskFieldsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performCreateTask(contents, input, pin);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Patches an existing task. Every field in `patch` is optional and left alone when " +
        "omitted; ticking is toggle_done's job and planning is plan_task's.",
      inputSchema: z.strictObject({ id: z.string(), patch: patchTaskFieldsSchema }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ id, patch }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performUpdateTask(contents, id, patch);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "plan_task",
    {
      description:
        "Books a block of time for a task on the clock — the drag onto the dial, performed by " +
        "the assistant. Length falls back to the task's estimate, then the default duration.",
      inputSchema: z.strictObject({
        id: z.string(),
        date: dateKey("YYYY-MM-DD, local — the day to work on it."),
        start: z.string().describe("HH:MM, 24-hour local clock."),
        end: z.string().describe("HH:MM. Alternative to duration.").optional(),
        duration: z.number().describe("Minutes — an alternative to end.").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, date, start, end, duration }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performPlanTask(contents, id, date, start, end, duration);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "create_calendar",
    {
      description:
        "Adds a calendar of the user's own — never a subscription; those come from the app's Settings.",
      inputSchema: z.strictObject({
        name: z.string(),
        color: z.string().describe("#rrggbb. Defaults to the next palette colour.").optional(),
        icon: z.string().describe("A Phosphor icon name or one emoji.").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, color, icon }) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performCreateCalendar(contents, name, color, icon);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "sync_status",
    {
      description:
        "The document's envelope and shape — revision, format version, recorded zone, transport, " +
        "and record counts (events, tasks, calendars, graves). The first tool to reach for when " +
        "reasoning about sync, a lost record, or a revision that moved.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(syncStatus(contents, store.transport), warning);
      }),
  );
}
