import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  InMemoryTransport,
  isSpecType,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  type JSONRPCMessage,
  type ResourceUpdatedNotification,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { at, calendar, dailyNote, event } from "./helpers";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { localZone, MIRROR_VERSION, type MirrorContents } from "@/lib/mirror";
import {
  CLOUD_RESOURCE_POLL_MS,
  FILE_RESOURCE_POLL_MS,
  registerResourceNotifications,
  ResourceNotifications,
  resourceNotificationTransport,
} from "../mcp/notifications";
import { registerResources } from "../mcp/resources";
import type { Loaded, Store } from "../mcp/store";

const cleanups: Array<() => void | Promise<void>> = [];
const envelope = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

function fixture(): MirrorContents {
  return {
    version: MIRROR_VERSION,
    zone: localZone(),
    rev: 1,
    events: [event({ calendarId: "work", start: "2026-03-08 10:00", title: "Meeting" })],
    calendars: [calendar({ id: "work", name: "Work" })],
    tasks: [],
    taskLists: [],
    dayNotes: [dailyNote({ day: "2026-03-08", text: "First note" })],
    settings: { ...DEFAULT_SETTINGS },
    settingsAt: 1,
    graves: [],
  };
}

function memoryStore(transport = "file /calendar.json") {
  const loaded: Loaded = { contents: fixture(), warning: null };
  const load = vi.fn(async (): Promise<Loaded> => structuredClone(loaded));
  const store: Store = {
    transport,
    load,
    async write(mutate) {
      const { result, summary } = mutate(loaded.contents);
      loaded.contents = { ...loaded.contents, ...result, rev: loaded.contents.rev + 1 };
      return summary;
    },
  };
  return { store, loaded, load };
}

async function protocol(era: "legacy" | "modern", transport?: string) {
  const memory = memoryStore(transport);
  const [client, wire] = InMemoryTransport.createLinkedPair();
  const messages: JSONRPCMessage[] = [];
  client.onmessage = (message) => messages.push(message);
  await client.start();
  let observer: ResourceNotifications | undefined;
  const handle = serveStdio(
    () => {
      const server = new McpServer({ name: "circal-test", version: "1" });
      registerResources(server, memory.store);
      observer = registerResourceNotifications(server, memory.store);
      return server;
    },
    { transport: resourceNotificationTransport(wire, () => observer) },
  );
  cleanups.push(() => handle.close());
  let id = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id;
    await client.send({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params: era === "modern" ? { ...params, _meta: envelope } : params,
    });
    await vi.advanceTimersByTimeAsync(0);
    return requestId;
  };
  if (era === "legacy") {
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } else await request("server/discover");
  return {
    ...memory,
    client,
    messages,
    request,
    updates: () =>
      messages.filter((message): message is JSONRPCMessage & ResourceUpdatedNotification =>
        isSpecType.ResourceUpdatedNotification(message),
      ),
    subscribe: (uri: string) =>
      era === "legacy"
        ? request("resources/subscribe", { uri })
        : request("subscriptions/listen", { notifications: { resourceSubscriptions: [uri] } }),
    async unsubscribe(uri: string, subscription: number) {
      if (era === "legacy") await request("resources/unsubscribe", { uri });
      else {
        await client.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: subscription },
        });
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at("2026-03-08 12:00"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(["legacy", "modern"] as const)("%s resource notifications", (era) => {
  it("loads only while subscribed, filters unchanged content, and stops on unsubscribe", async () => {
    const p = await protocol(era);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.load).not.toHaveBeenCalled();
    const subscription = await p.subscribe("circal://settings");
    expect(p.load).toHaveBeenCalledTimes(1);
    expect(p.updates()).toEqual([]);
    p.loaded.contents.rev++;
    p.loaded.contents.events[0].title = "Changed outside MCP";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates()).toEqual([]);
    p.loaded.contents.settings.clock = "12h";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates().map((message) => message.params.uri)).toEqual(["circal://settings"]);
    if (era === "modern") {
      expect(p.updates()[0].params._meta?.[SUBSCRIPTION_ID_META_KEY]).toBe(subscription);
      expect(p.messages.filter(isSpecType.SubscriptionsAcknowledgedNotification)).toHaveLength(1);
    }
    await p.unsubscribe("circal://settings", subscription);
    const loads = p.load.mock.calls.length;
    p.loaded.contents.settings.clock = "24h";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.load).toHaveBeenCalledTimes(loads);
    expect(p.updates()).toHaveLength(1);
  });

  it("detects external file edits with one snapshot across subscribed resources", async () => {
    const p = await protocol(era);
    await p.subscribe("circal://today");
    await p.subscribe("circal://notes/2026-03-08");
    await p.subscribe("circal://calendars");
    p.load.mockClear();
    p.loaded.contents.events[0].title = "External edit";
    p.loaded.contents.dayNotes[0].text = "External note";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.load).toHaveBeenCalledTimes(1);
    expect(
      p
        .updates()
        .map((message) => message.params.uri)
        .sort(),
    ).toEqual(["circal://notes/2026-03-08", "circal://today"]);
  });

  it("detects cloud writes at the bounded cloud interval without changing write results", async () => {
    const p = await protocol(era, "cloud (person@example.test)");
    await p.subscribe("circal://settings");
    const summary = await p.store.write((contents) => ({
      result: { ...contents, settings: { ...contents.settings, clock: "12h" } },
      summary: "saved",
    }));
    expect(summary).toBe("saved");
    await vi.advanceTimersByTimeAsync(CLOUD_RESOURCE_POLL_MS - 1);
    expect(p.updates()).toHaveLength(0);
    expect(p.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.updates()).toHaveLength(1);
  });

  it("recovers from load errors without pretending the resource changed or losing later edits", async () => {
    const p = await protocol(era);
    await p.subscribe("circal://settings");
    p.load.mockRejectedValueOnce(new Error("temporarily unavailable"));
    p.loaded.contents.settings.clock = "12h";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates()).toHaveLength(1);
  });

  it("notifies the today alias at local midnight, but not a fixed day's resource", async () => {
    vi.setSystemTime(at("2026-03-08 23:59"));
    const p = await protocol(era);
    await p.subscribe("circal://today");
    await p.subscribe("circal://days/2026-03-08");
    vi.setSystemTime(at("2026-03-09 00:00"));
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates().map((message) => message.params.uri)).toEqual(["circal://today"]);
  });

  it("drops in-flight snapshots and all future polling after client disconnect", async () => {
    const p = await protocol(era);
    await p.subscribe("circal://settings");
    const { promise, resolve: release } = Promise.withResolvers<Loaded>();
    p.load.mockImplementationOnce(() => promise);
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    const loads = p.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CLOUD_RESOURCE_POLL_MS);
    expect(p.load).toHaveBeenCalledTimes(loads);
    await p.client.close();
    p.loaded.contents.settings.clock = "12h";
    release(structuredClone(p.loaded));
    await vi.advanceTimersByTimeAsync(CLOUD_RESOURCE_POLL_MS);
    expect(p.updates()).toHaveLength(0);
    expect(p.load).toHaveBeenCalledTimes(loads);
  });
});

describe("modern subscription routing", () => {
  it("keeps shared URIs watched until the final subscription cancels, with SDK-stamped IDs", async () => {
    const p = await protocol("modern");
    const first = await p.subscribe("circal://settings");
    const second = await p.subscribe("circal://settings");
    p.loaded.contents.settings.clock = "12h";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates().map((message) => message.params._meta?.[SUBSCRIPTION_ID_META_KEY])).toEqual([
      first,
      second,
    ]);
    await p.unsubscribe("circal://settings", first);
    p.loaded.contents.settings.clock = "24h";
    await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
    expect(p.updates().map((message) => message.params._meta?.[SUBSCRIPTION_ID_META_KEY])).toEqual([
      first,
      second,
      second,
    ]);
    await p.unsubscribe("circal://settings", second);
    const loads = p.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CLOUD_RESOURCE_POLL_MS);
    expect(p.load).toHaveBeenCalledTimes(loads);
  });

  it("does not start polling for rejected listens or filters without supported resources", async () => {
    const p = await protocol("modern");
    const malformed = await p.request("subscriptions/listen", { notifications: "not a filter" });
    expect(p.messages.some((message) => "error" in message && message.id === malformed)).toBe(true);
    await p.request("subscriptions/listen", { notifications: { toolsListChanged: true } });
    await p.subscribe("other://not-circal");
    await vi.advanceTimersByTimeAsync(CLOUD_RESOURCE_POLL_MS);
    expect(p.load).not.toHaveBeenCalled();
  });
});

it("retries failed delivery without rejecting a successful store write", async () => {
  const { store } = memoryStore();
  const notify = vi
    .fn<(uri: string) => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockRejectedValueOnce(new Error("send failed"));
  const notifications = new ResourceNotifications(store, notify);
  cleanups.push(() => notifications.close());
  await notifications.subscribe("circal://settings");
  await expect(
    store.write((contents) => ({
      result: { ...contents, settings: { ...contents.settings, clock: "12h" } },
      summary: "saved",
    })),
  ).resolves.toBe("saved");
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(notify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(notify).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("sends the modern acknowledgement before updates captured while opening another subscription", async () => {
  const p = await protocol("modern");
  await p.subscribe("circal://settings");
  p.loaded.contents.settings.clock = "12h";
  const second = await p.subscribe("circal://settings");
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  const ack = p.messages.findIndex(
    (message) =>
      isSpecType.SubscriptionsAcknowledgedNotification(message) &&
      message.params._meta?.[SUBSCRIPTION_ID_META_KEY] === second,
  );
  const update = p.messages.findIndex(
    (message) =>
      isSpecType.ResourceUpdatedNotification(message) &&
      message.params._meta?.[SUBSCRIPTION_ID_META_KEY] === second,
  );
  expect(ack).toBeGreaterThanOrEqual(0);
  expect(update).toBeGreaterThan(ack);
});

it("finishes a delayed baseline before acknowledging a modern subscription", async () => {
  const p = await protocol("modern");
  const baseline = structuredClone(p.loaded);
  const { promise, resolve } = Promise.withResolvers<Loaded>();
  p.load.mockImplementationOnce(() => promise);
  const pendingSubscription = p.subscribe("circal://settings");
  await vi.advanceTimersByTimeAsync(0);
  expect(
    p.messages.some((message) => isSpecType.SubscriptionsAcknowledgedNotification(message)),
  ).toBe(false);
  resolve(baseline);
  await pendingSubscription;
  expect(
    p.messages.some((message) => isSpecType.SubscriptionsAcknowledgedNotification(message)),
  ).toBe(true);
  p.loaded.contents.settings.clock = "12h";
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(p.updates().map((message) => message.params.uri)).toEqual(["circal://settings"]);
});

it("allows a fresh subscription after a failed baseline and stops a pending read on unsubscribe", async () => {
  const p = await protocol("legacy");
  p.load.mockRejectedValueOnce(new Error("file unavailable"));
  const first = await p.subscribe("circal://settings");
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(p.updates()).toHaveLength(0);
  const { promise, resolve } = Promise.withResolvers<Loaded>();
  p.load.mockImplementationOnce(() => promise);
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  await p.unsubscribe("circal://settings", first);
  p.loaded.contents.settings.clock = "12h";
  resolve(structuredClone(p.loaded));
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(p.updates()).toHaveLength(0);
  await p.subscribe("circal://settings");
  p.loaded.contents.settings.clock = "24h";
  await vi.advanceTimersByTimeAsync(FILE_RESOURCE_POLL_MS);
  expect(p.updates()).toHaveLength(1);
});
