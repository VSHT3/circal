/* ------------------------------------------------------------------ *
 * ICS subscriptions: the pull, the ids it mints, and the undo history
 * a background pull must not destroy.
 *
 * `vi.resetModules()` plus a dynamic import is the only way to get a
 * store with clean module state — `snapshot`, `lastRaw`, `hydrated`,
 * `past` and `future` are module-level and deliberately survive a
 * reload of the *page*, which is exactly what a static import would
 * share between tests.
 * ------------------------------------------------------------------ */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage, event } from "./helpers";

const ICS = (...vevents: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...vevents, "END:VCALENDAR"].join(
    "\r\n",
  );

const VEVENT = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

/** Two events, neither carrying a UID — a non-conforming but very real feed. */
const UID_LESS = ICS(
  VEVENT(["DTSTART:20260308T090000", "DTEND:20260308T100000", "SUMMARY:Standup"]),
  VEVENT(["DTSTART:20260309T140000", "DTEND:20260309T150000", "SUMMARY:Review"]),
);

const WITH_UIDS = ICS(
  VEVENT([
    "UID:a@example.com",
    "DTSTART:20260308T090000",
    "DTEND:20260308T100000",
    "SUMMARY:Standup",
  ]),
);

let storage: MemoryStorage;

function serve(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

beforeEach(() => {
  vi.resetModules();
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* --------------------------------- ids ----------------------------------- */

describe("a feed event's id is stable across pulls", () => {
  it("keeps the same id for a UID-less event on a second pull", async () => {
    serve(UID_LESS);
    // Dynamic: `vi.resetModules()` above only takes effect for imports made
    // after it, so a static import would hand back the previous test's store.
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");

    await refreshFeed(calendar);
    const first = store.snapshot().feeds[calendar.id];
    await refreshFeed(calendar);
    const second = store.snapshot().feeds[calendar.id];

    expect(first, "the fixture pulled no events").toHaveLength(2);
    expect(second.map((e) => e.title)).toEqual(first.map((e) => e.title));
    // A churning id remounts every arc: hover drops, selection drops, and the
    // arc under the pointer vanishes and returns beneath it.
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
  });

  it("gives two different UID-less events different ids", async () => {
    serve(UID_LESS);
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);
    const [a, b] = store.snapshot().feeds[calendar.id];

    expect(a.id).not.toBe(b.id);
  });

  it("derives the id from the event, so an edited event gets a new one", async () => {
    serve(UID_LESS);
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);
    const before = store.snapshot().feeds[calendar.id][0].id;

    serve(
      ICS(
        VEVENT(["DTSTART:20260308T090000", "DTEND:20260308T100000", "SUMMARY:Standup (moved)"]),
        VEVENT(["DTSTART:20260309T140000", "DTEND:20260309T150000", "SUMMARY:Review"]),
      ),
    );
    await refreshFeed(calendar);

    expect(store.snapshot().feeds[calendar.id][0].id).not.toBe(before);
  });

  it("prefers the feed's own UID when it has one", async () => {
    serve(WITH_UIDS);
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);

    expect(store.snapshot().feeds[calendar.id][0].id).toBe(`${calendar.id}:a@example.com`);
  });
});

/* -------------------------------- transp ---------------------------------- */

describe("a subscription's busy/free travels with the mirror", () => {
  // The side of the `TRANSP` fix that motivated it: a birthday published as
  // free used to arrive here booking the hour, because the mirror dropped the
  // field on the way from `fromIcs` into `CalEvent`.
  it("mirrors TRANSP:TRANSPARENT onto the cached event", async () => {
    serve(
      ICS(
        VEVENT([
          "UID:free@example.com",
          "DTSTART:20260308T090000",
          "DTEND:20260308T100000",
          "SUMMARY:Birthday",
          "TRANSP:TRANSPARENT",
        ]),
        VEVENT([
          "UID:busy@example.com",
          "DTSTART:20260308T110000",
          "DTEND:20260308T120000",
          "SUMMARY:Standup",
        ]),
      ),
    );
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);

    const cached = store.snapshot().feeds[calendar.id];
    expect.soft(cached[0].free).toBe(true);
    expect.soft(cached[1].free).toBe(false);
  });
});

/* -------------------------------- errors ---------------------------------- */

describe("a failing feed is recorded, not thrown", () => {
  it("records the error on the calendar and leaves the dial standing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 })),
    );
    const { refreshFeed } = await import("@/lib/feeds");
    const { store } = await import("@/lib/store");

    const calendar = store.addFeed("https://example.com/gone.ics", "example.com");
    await expect(refreshFeed(calendar)).resolves.toBeUndefined();

    const stored = store.snapshot().calendars.find((c) => c.id === calendar.id);
    expect(stored?.feed?.error).toBeTruthy();
  });

  it("does nothing for a calendar that is not a subscription", async () => {
    const { refreshFeed } = await import("@/lib/feeds");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await refreshFeed({ id: "local", name: "Personal", color: "#fff", icon: "", visible: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------- cross-tab -------------------------------- */

/**
 * A `window` with just enough of an event target for `subscribe`. jsdom would
 * do it too, and would cost a dependency and a second environment for one
 * `addEventListener`.
 */
function stubWindow() {
  const handlers = new Set<(e: StorageEvent) => void>();
  vi.stubGlobal("window", {
    addEventListener: (_type: string, fn: (e: StorageEvent) => void) => handlers.add(fn),
    removeEventListener: (_type: string, fn: (e: StorageEvent) => void) => handlers.delete(fn),
  });
  /** What another tab writing the same key looks like from in here. */
  return (key: string) => {
    for (const fn of handlers) fn({ key } as StorageEvent);
  };
}

describe("another tab's write and this tab's undo history", () => {
  it("survives a background feed pull", async () => {
    const fire = stubWindow();
    serve(UID_LESS);
    const { store, subscribe } = await import("@/lib/store");
    const { refreshFeed } = await import("@/lib/feeds");
    subscribe(() => {});

    const created = store.create(event({ title: "Mine", start: "2026-03-08 11:00" }));
    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");

    // The other tab pulls the subscription and writes the shared blob.
    await refreshFeed(calendar);
    fire("circal.v1");

    // Sixty steps of history must not be spent on a subscription refreshing
    // itself — the user cannot even attribute that loss to something they did.
    expect(store.undo()).toBe(true);
    expect(store.snapshot().events.map((e) => e.id)).not.toContain(created.id);
  });

  it("is dropped when the other tab actually moved the base", async () => {
    const fire = stubWindow();
    const { store, subscribe } = await import("@/lib/store");
    subscribe(() => {});

    store.create(event({ title: "Mine" }));

    // The other tab deletes everything and writes the blob directly.
    const blob = JSON.parse(storage.raw("circal.v1") ?? "{}");
    storage.setItem("circal.v1", JSON.stringify({ ...blob, events: [] }));
    fire("circal.v1");

    // Undoing onto a base that has moved would resurrect what the other tab
    // just deleted, so there is nothing to undo onto.
    expect(store.undo()).toBe(false);
  });

  it("ignores a storage event for another key", async () => {
    const fire = stubWindow();
    const { store, subscribe } = await import("@/lib/store");
    subscribe(() => {});

    store.create(event({ title: "Mine" }));
    fire("something.else");

    expect(store.undo()).toBe(true);
  });

  it("does not roll a subscription back when an event is undone", async () => {
    const fire = stubWindow();
    serve(UID_LESS);
    const { store, subscribe } = await import("@/lib/store");
    const { refreshFeed } = await import("@/lib/feeds");
    subscribe(() => {});

    // The subscription is older than the step being undone — otherwise undoing
    // past `addFeed` legitimately takes the calendar with it.
    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);
    fire("circal.v1");
    store.create(event({ title: "Mine", start: "2026-03-08 11:00" }));

    store.undo();

    // Feeds are a live mirror, never part of an undo step.
    expect(store.snapshot().feeds[calendar.id]).toHaveLength(2);
  });

  it("undoing past the subscription hides its mirror but keeps the payload", async () => {
    serve(UID_LESS);
    const { store } = await import("@/lib/store");
    const { refreshFeed } = await import("@/lib/feeds");

    const created = store.create(event({ title: "Mine", start: "2026-03-08 11:00" }));
    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);

    // `addFeed` and the pull are both `record: false`, so this lands on the
    // step before the calendar existed.
    store.undo();
    expect(store.snapshot().events.map((e) => e.id)).not.toContain(created.id);
    expect(store.snapshot().feeds[calendar.id]).toBeUndefined();

    // The key is untouched, so redoing back to the calendar gets the events
    // it already had rather than an empty ring until the next pull.
    expect(storage.raw(`circal.feed.${calendar.id}`)).toBeTruthy();
    store.redo();
    expect(store.snapshot().feeds[calendar.id]).toHaveLength(2);
  });

  it("another tab's payload write is picked up without costing the history", async () => {
    const fire = stubWindow();
    serve(UID_LESS);
    const { store, subscribe } = await import("@/lib/store");
    const { refreshFeed } = await import("@/lib/feeds");
    subscribe(() => {});

    const calendar = store.addFeed("https://example.com/cal.ics", "example.com");
    await refreshFeed(calendar);
    store.create(event({ title: "Mine", start: "2026-03-08 11:00" }));

    // The other tab re-pulls: a write to the payload key, and nothing else
    // this tab has to care about.
    storage.setItem(
      `circal.feed.${calendar.id}`,
      JSON.stringify([event({ title: "Theirs", start: "2026-03-10 09:00" })]),
    );
    fire(`circal.feed.${calendar.id}`);

    expect(store.snapshot().feeds[calendar.id].map((e) => e.title)).toEqual(["Theirs"]);
    // A payload is never part of the base, so it can never invalidate a step.
    expect(store.undo()).toBe(true);
  });
});

/* ------------------------------ staleness --------------------------------- */

describe("refreshStaleFeeds", () => {
  it("pulls only the feeds older than maxAge, and never a local calendar", async () => {
    serve(WITH_UIDS);
    const { refreshStaleFeeds } = await import("@/lib/feeds");
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(WITH_UIDS, { status: 200 });
      }),
    );

    const now = Date.now();
    await refreshStaleFeeds(
      [
        { id: "local", name: "Personal", color: "#fff", icon: "", visible: true },
        {
          id: "old",
          name: "Old",
          color: "#fff",
          icon: "",
          visible: true,
          feed: { url: "https://example.com/old.ics", fetchedAt: now - 60 * 60_000, error: "" },
        },
        {
          id: "fresh",
          name: "Fresh",
          color: "#fff",
          icon: "",
          visible: true,
          feed: { url: "https://example.com/fresh.ics", fetchedAt: now, error: "" },
        },
      ],
      30 * 60_000,
    );

    expect(fetched.some((u) => u.includes("old.ics"))).toBe(true);
    expect(fetched.some((u) => u.includes("fresh.ics"))).toBe(false);
  });
});
