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

import type { Store } from "./store";
import {
  MAX_RANGE_DAYS,
  MAX_RANGE_OCCURRENCES,
  describeEvent,
  freeSlots,
  listCalendars,
  listDay,
  listRange,
  performCreateCalendar,
  performCreateEvent,
  performDeleteEvent,
  performQuickAdd,
  performToggleDone,
  performUpdateEvent,
  searchEvents,
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
      .describe(
        "HH:MM, 24-hour local clock. Required for a timed event; on a task it names the " +
          "due time, and omitting it makes the deadline a date with no time on it.",
      )
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
    task: z
      .boolean()
      .describe(
        "A dated to-do rather than an event: a task record with a deadline. `date` is the " +
          "due day and `start` the optional due time; end/duration/allDay/recurrence do not apply.",
      )
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
    recurrence: recurrenceSchema.optional(),
  };
}

const createEventFieldsSchema = z.strictObject({
  ...eventFieldsShape(),
  date: dateKey("YYYY-MM-DD, local."),
});

const patchEventFieldsSchema = z.strictObject(eventFieldsShape());

const SCOPE_DESCRIPTION =
  'Required when the target event repeats: "one" (just this occurrence), "future" (this one and ' +
  'everything after), or "all" (the whole series). Ignored when the event does not repeat.';
const OCCURRENCE_DESCRIPTION =
  'Which occurrence, as a YYYY-MM-DD date or a full "YYYY-MM-DDTHH:mm:ss" instant. Required with ' +
  'scope "one" or "future".';

const scopeSchema = z.enum(["one", "future", "all"]).describe(SCOPE_DESCRIPTION);
const occurrenceSchema = z.string().describe(OCCURRENCE_DESCRIPTION);

/* --------------------------------- tools -------------------------------------- */

export function registerTools(server: McpServer, store: Store): void {
  server.registerTool(
    "list_day",
    {
      description:
        "The agenda for one local day: recurrence expanded, all-day and timed occurrences listed " +
        "separately, each with its id (for update_event/delete_event/toggle_done), its occurrence key, " +
        "and — for a multi-day span — its Day N/M position.",
      inputSchema: z.strictObject({ date: dateKey("YYYY-MM-DD, local.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listDay(contents, date), warning);
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
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(listRange(contents, from, to), warning);
      }),
  );

  server.registerTool(
    "search",
    {
      description:
        "Ranked title/location/notes search over the user's own events (never a subscription's).",
      inputSchema: z.strictObject({
        query: z.string(),
        limit: z.number().int().min(1).describe("Default 20.").optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(searchEvents(contents, query, limit), warning);
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
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date, minutes, from, to }) =>
      guarded(async () => {
        const { contents, warning } = await store.load();
        return withWarning(freeSlots(contents, date, minutes, from, to), warning);
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
          const outcome = performQuickAdd(contents, text, date);
          return { result: outcome.mutated, summary: outcome.message };
        }),
      ),
  );

  server.registerTool(
    "create_event",
    {
      description:
        "Creates an event from explicit fields, for anything quick_add's grammar cannot spell — a full " +
        "recurrence, a specific calendar, notes. Every field is validated the same way an imported backup is.",
      inputSchema: createEventFieldsSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guarded(() =>
        store.write((contents) => {
          const outcome = performCreateEvent(contents, input);
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
}
