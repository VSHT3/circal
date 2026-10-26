import { McpServer, type GetPromptResult, type ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, calendar, dailyNote, event, resetIds } from "../helpers";
import { localZone, MIRROR_VERSION, type MirrorContents } from "@/lib/mirror";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { registerPrompts } from "../../mcp/prompts";
import type { Store } from "../../mcp/store";

function prompts(overrides: Partial<MirrorContents> = {}) {
  const contents: MirrorContents = {
    version: MIRROR_VERSION,
    zone: localZone(),
    rev: 1,
    events: [],
    calendars: [calendar()],
    tasks: [],
    taskLists: [],
    dayNotes: [],
    settings: { ...DEFAULT_SETTINGS },
    settingsAt: 0,
    graves: [],
    ...overrides,
  };
  const store = {
    transport: "cloud (test)",
    load: vi.fn(async () => ({ contents, warning: null })),
    write: vi.fn(async () => {
      throw new Error("Read-only prompt must not write");
    }),
  } satisfies Store;
  const server = new McpServer({ name: "west-prompt-test", version: "1" });
  const registration = vi.spyOn(server, "registerPrompt");
  registerPrompts(server, store);
  return {
    store,
    async get(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
      const index = registration.mock.calls.findIndex(
        ([registeredName]) => registeredName === name,
      );
      const prompt = registration.mock.results[index]?.value;
      if (!prompt) throw new Error(`Missing prompt ${name}`);
      const result = await prompt.handler(args, {} as ServerContext);
      if (!("messages" in result)) throw new Error("Expected prompt messages");
      return result;
    },
  };
}

function contextOf(result: GetPromptResult) {
  const content = result.messages[1].content;
  if (content.type !== "text") throw new Error("Expected snapshot text");
  return JSON.parse(content.text) as {
    today: string;
    timezone: string;
    period: { from: string; to: string };
    agenda?: string;
    note?: string;
    days?: { date: string; note: string }[];
  };
}

beforeEach(() => {
  resetIds();
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-03-07 23:30"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCP prompt dates west of UTC", () => {
  it.each(["plan_day", "review_note"])(
    "%s chooses the local day when UTC is already tomorrow",
    async (name) => {
      const { get, store } = prompts({
        events: [
          event({
            title: "Late local meeting",
            start: "2026-03-07 23:00",
            end: "2026-03-07 23:45",
          }),
        ],
        dayNotes: [
          dailyNote({ day: "2026-03-07", text: "Saturday note" }),
          dailyNote({ day: "2026-03-08", text: "Sunday note" }),
        ],
      });
      const context = contextOf(await get(name));
      expect(context.today).toBe("2026-03-07");
      expect(context.period).toEqual({ from: "2026-03-07", to: "2026-03-07" });
      expect(context.timezone).toBe("America/Los_Angeles");
      expect(context.note).toContain("Saturday note");
      expect(context.note).not.toContain("Sunday note");
      if (name === "plan_day") expect(context.agenda).toContain("Late local meeting");
      expect(store.load).toHaveBeenCalledTimes(1);
      expect(store.write).not.toHaveBeenCalled();
    },
  );

  it.each([
    { from: "2026-03-04", to: "2026-03-10", next: "2026-03-11" },
    { from: "2026-10-28", to: "2026-11-03", next: "2026-11-04" },
    { from: "2026-12-29", to: "2027-01-04", next: "2027-01-05" },
  ])("keeps all seven local days across $from to $to", async ({ from, to, next }) => {
    const { get, store } = prompts({
      events: [
        event({ title: "First midnight", start: `${from} 00:00`, end: `${from} 00:30` }),
        event({ title: "Seventh evening", start: `${to} 23:00`, end: `${to} 23:30` }),
        event({ title: "Outside week", start: `${next} 00:00` }),
      ],
      dayNotes: [dailyNote({ day: to, text: "Seventh-day note" })],
    });
    const context = contextOf(await get("review_week", { from }));
    expect(context.period).toEqual({ from, to });
    expect(context.days).toHaveLength(7);
    expect(context.days?.map(({ date }) => date)[0]).toBe(from);
    expect(context.days?.map(({ date }) => date)[6]).toBe(to);
    expect(context.days?.[6].note).toContain("Seventh-day note");
    expect(context.agenda).toContain("First midnight");
    expect(context.agenda).toContain("Seventh evening");
    expect(context.agenda).not.toContain("Outside week");
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.write).not.toHaveBeenCalled();
  });
});
