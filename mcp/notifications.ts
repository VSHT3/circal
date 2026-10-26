import {
  isSpecType,
  ResourceNotFoundError,
  SUBSCRIPTION_ID_META_KEY,
  type McpServer,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";
import { isResourceUri, renderResource } from "./resources";
import type { Store } from "./store";

export const FILE_RESOURCE_POLL_MS = 3_000;
export const CLOUD_RESOURCE_POLL_MS = 30_000;

type Watched = { fingerprint?: string };

/** One snapshot for every subscribed URI; no reads while nobody is listening. */
export class ResourceNotifications {
  private readonly legacy = new Set<string>();
  private readonly modern = new Map<RequestId, Set<string>>();
  private readonly watched = new Map<string, Watched>();
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private initializing = 0;
  private readonly interval: number;

  constructor(
    private readonly store: Store,
    private readonly notify: (uri: string) => Promise<void>,
  ) {
    this.interval = store.transport.startsWith("cloud")
      ? CLOUD_RESOURCE_POLL_MS
      : FILE_RESOURCE_POLL_MS;
  }

  async subscribe(uri: string): Promise<void> {
    if (!isResourceUri(uri)) throw new ResourceNotFoundError(uri);
    if (this.closed || this.legacy.has(uri)) return;
    this.legacy.add(uri);
    this.reconcile();
    await this.refresh();
  }

  unsubscribe(uri: string): void {
    this.legacy.delete(uri);
    this.reconcile();
  }

  async listen(id: RequestId, uris: string[]): Promise<void> {
    if (this.closed) return;
    this.initializing++;
    try {
      this.modern.set(id, new Set(uris.filter(isResourceUri)));
      this.reconcile();
      await this.refresh();
    } finally {
      this.initializing--;
    }
  }

  cancel(id: RequestId): void {
    this.modern.delete(id);
    this.reconcile();
  }

  close(): void {
    this.closed = true;
    this.legacy.clear();
    this.modern.clear();
    this.watched.clear();
    this.stopTimer();
  }

  private reconcile(): void {
    const wanted = new Set(this.legacy);
    for (const uris of this.modern.values()) for (const uri of uris) wanted.add(uri);
    for (const uri of this.watched.keys()) if (!wanted.has(uri)) this.watched.delete(uri);
    for (const uri of wanted) if (!this.watched.has(uri)) this.watched.set(uri, {});
    if (!this.watched.size) this.stopTimer();
  }

  private stopTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed || !this.watched.size) return Promise.resolve();
    this.stopTimer();
    this.pending = this.snapshot().finally(() => {
      this.pending = undefined;
      if (!this.closed && this.watched.size) {
        this.timer = setTimeout(() => void this.refresh(), this.interval);
        this.timer.unref?.();
      }
    });
    return this.pending;
  }

  private async snapshot(): Promise<void> {
    try {
      const loaded = await this.store.load();
      const now = new Date();
      for (const [uri, state] of this.watched) {
        try {
          const fingerprint = JSON.stringify(
            renderResource(uri, loaded, this.store.transport, now),
          );
          // Capture new baselines without emitting before a listen acknowledgement.
          if (this.initializing && state.fingerprint !== undefined) continue;
          if (state.fingerprint === fingerprint) continue;
          if (state.fingerprint !== undefined) await this.notify(uri);
          if (this.watched.get(uri) === state) state.fingerprint = fingerprint;
        } catch {
          // Keep the last good content, so a failed delivery or render retries on the next pass.
        }
      }
    } catch {
      // A temporarily unavailable file/row is not a content change. Keep polling until recovery.
    }
  }
}

export function registerResourceNotifications(
  server: McpServer,
  store: Store,
): ResourceNotifications {
  const notifications = new ResourceNotifications(store, (uri) =>
    server.server.sendResourceUpdated({ uri }),
  );
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler("resources/subscribe", async (request) => {
    await notifications.subscribe(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", (request) => {
    notifications.unsubscribe(request.params.uri);
    return {};
  });
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    notifications.close();
    previousClose?.();
  };
  return notifications;
}

/**
 * serveStdio consumes modern listen requests before server handlers. Observe its
 * acknowledged filter, not the requested one: only the SDK decides which listen
 * requests succeeded. The SDK still owns filtering, subscription IDs and routing.
 */
export function resourceNotificationTransport(
  wire: Transport,
  current: () => ResourceNotifications | undefined,
): Transport {
  const transport: Transport = {
    async start() {
      wire.onmessage = (message, extra) => {
        if (isSpecType.CancelledNotification(message) && message.params.requestId !== undefined)
          current()?.cancel(message.params.requestId);
        transport.onmessage?.(message, extra);
      };
      wire.onerror = (error) => transport.onerror?.(error);
      wire.onclose = () => {
        current()?.close();
        transport.onclose?.();
      };
      await wire.start();
    },
    async send(message, options) {
      if (isSpecType.SubscriptionsAcknowledgedNotification(message)) {
        const id = message.params._meta?.[SUBSCRIPTION_ID_META_KEY];
        if (typeof id === "string" || typeof id === "number") {
          const initialized = current()?.listen(
            id,
            message.params.notifications.resourceSubscriptions ?? [],
          );
          // Commit the baseline before acknowledging, so an immediate edit cannot be lost.
          await initialized;
          await wire.send(message, options);
          return;
        }
      }
      await wire.send(message, options);
    },
    async close() {
      current()?.close();
      await wire.close();
    },
    setProtocolVersion: (version) => wire.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => wire.setSupportedProtocolVersions?.(versions),
  };
  return transport;
}
