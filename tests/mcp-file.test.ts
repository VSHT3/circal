import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendar, event } from "./helpers";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { MIRROR_VERSION, localZone, readMirrorFile, serialiseMirror } from "@/lib/mirror";
import type { CalEvent } from "@/lib/events";
import {
  RefusalError,
  casWrite,
  loadForRead,
  resolveFilePath,
  zoneWarning,
  type Mutated,
} from "../mcp/file";

/**
 * The MCP server's own file layer, which is where every bug reproduced on
 * 2026-08-17 actually lived. The domain logic under it is already covered —
 * the server imports the app's own `mutate.ts`, `dayAgenda` and `readEvent`,
 * all tested next door — so what is pinned here is the four things this layer
 * alone decides: which path it will touch, whether it may write at all, that a
 * write lands whole, and that concurrent writes cannot bury each other.
 *
 * A real temp directory rather than a mock: `atomicWrite`'s whole claim is
 * about temp files, renames and fsync, and none of that is observable through
 * a stubbed `fs`.
 */

const CAL = "work";

let dir = "";
let path = "";

/** A `MirrorEnv` in this test's own directory, with no override granted. */
const ctx = (env: NodeJS.ProcessEnv = {}) => ({ path, env });

const snapshot = (events: CalEvent[] = []): Mutated => ({
  events,
  tasks: [],
  calendars: [calendar({ id: CAL })],
  settings: DEFAULT_SETTINGS,
  settingsAt: 0,
  graves: [],
});

/** Put a file on disk at a given rev and zone, bypassing the writer. */
async function seed(rev: number, zone = localZone(), overrides: Record<string, unknown> = {}) {
  const text = serialiseMirror(snapshot(), rev, zone);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...parsed, ...overrides }, null, 2), "utf8");
}

const onDisk = async () => readMirrorFile(await readFile(path, "utf8"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "circal-mcp-test-"));
  path = join(dir, "calendar.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------ which file -------------------------------- */

describe("resolveFilePath never guesses", () => {
  it("takes --file from argv", () => {
    expect(resolveFilePath(["--file", "/tmp/a.json"], {})).toBe("/tmp/a.json");
  });

  it("falls back to CIRCAL_FILE", () => {
    expect(resolveFilePath([], { CIRCAL_FILE: "/tmp/b.json" })).toBe("/tmp/b.json");
  });

  it("prefers the flag over the environment", () => {
    expect(resolveFilePath(["--file", "/tmp/a.json"], { CIRCAL_FILE: "/tmp/b.json" })).toBe(
      "/tmp/a.json",
    );
  });

  // The refusal is the feature: a guessed path here means writing over the
  // wrong year's calendar.
  it.each([
    { name: "nothing at all", argv: [] as string[], env: {} },
    { name: "a bare --file with no value", argv: ["--file"], env: {} },
    { name: "an empty CIRCAL_FILE", argv: [] as string[], env: { CIRCAL_FILE: "" } },
  ])("throws on $name rather than picking one", ({ argv, env }) => {
    expect(() => resolveFilePath(argv, env)).toThrow(/needs a mirror file/i);
  });
});

/* ------------------------------ may it write ------------------------------- */

describe("the zone gate", () => {
  it("warns on a read but does not refuse it", async () => {
    await seed(1, "Asia/Tokyo");
    const { contents, warning } = await loadForRead(ctx());
    expect(contents.rev).toBe(1);
    expect(warning).toMatch(/Asia\/Tokyo/);
  });

  it("says nothing about a file written here", async () => {
    await seed(1);
    expect((await loadForRead(ctx())).warning).toBeNull();
  });

  it("a file that named no zone is taken at its word", async () => {
    await seed(1, "");
    expect(zoneWarning((await loadForRead(ctx())).contents)).toBeNull();
  });

  it("refuses a write across a mismatch", async () => {
    await seed(1, "Asia/Tokyo");
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow(
      RefusalError,
    );
    // And left the file exactly as it found it.
    expect((await onDisk())?.rev).toBe(1);
  });

  it("writes across a mismatch once the operator has said so", async () => {
    await seed(1, "Asia/Tokyo");
    await casWrite(ctx({ CIRCAL_ALLOW_ZONE_MISMATCH: "1" }), () => ({
      result: snapshot(),
      summary: 1,
    }));
    expect((await onDisk())?.rev).toBe(2);
  });
});

/**
 * The durable half of the stale-bundle bug: an older reader round-tripping a
 * newer file drops every field it has no name for, silently, on a write it
 * thought was a patch. Refusing is the only thing the reader can do about it
 * from inside.
 */
describe("the version gate", () => {
  it("refuses to write a file from a newer build", async () => {
    await seed(1, localZone(), { version: MIRROR_VERSION + 1 });
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow(
      RefusalError,
    );
    expect((await onDisk())?.rev).toBe(1);
  });

  it("names both versions, so the message is actionable", async () => {
    await seed(1, localZone(), { version: 99 });
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow(
      new RegExp(`version 99.+understands ${MIRROR_VERSION}`, "s"),
    );
  });

  // No override, deliberately: a zone mismatch is something an operator can
  // reason about and be right, "my reader is too old for this file" is not.
  it("has no environment override", async () => {
    await seed(1, localZone(), { version: MIRROR_VERSION + 1 });
    await expect(
      casWrite(ctx({ CIRCAL_ALLOW_ZONE_MISMATCH: "1" }), () => ({
        result: snapshot(),
        summary: 1,
      })),
    ).rejects.toThrow(RefusalError);
  });

  it("writes a file of its own version, and one that named none", async () => {
    await seed(4);
    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    expect((await onDisk())?.rev).toBe(5);

    await seed(4, localZone(), { version: undefined });
    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    expect((await onDisk())?.rev).toBe(5);
  });
});

/* -------------------------------- the write ------------------------------- */

describe("casWrite", () => {
  it("writes rev + 1 and the events the mutation returned", async () => {
    await seed(7);
    const one = event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", title: "Standup" });
    const summary = await casWrite(ctx(), () => ({ result: snapshot([one]), summary: "done" }));

    expect(summary).toBe("done");
    const after = await onDisk();
    expect(after?.rev).toBe(8);
    expect(after?.events).toHaveLength(1);
    expect(after?.events[0]?.title).toBe("Standup");
  });

  it("keeps the file's own zone rather than restamping it", async () => {
    await seed(1, "");
    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    // A file that named no zone gets this server's, since it now has a writer
    // that can vouch for one.
    expect((await onDisk())?.zone).toBe(localZone());
  });

  it("refuses a file that is not a circal mirror", async () => {
    await writeFile(path, JSON.stringify({ app: "fantastical" }), "utf8");
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow(
      /not a circal mirror file/i,
    );
  });

  /**
   * `atomicWrite`'s observable half, and the limits of it are worth stating.
   *
   * The `fsync` cannot be seen from here at all — proving it needs the power
   * cut it exists for — so what is pinned is the rest of the promise: after a
   * write the file parses as a whole document (never a half-flushed one), and
   * the temp file it travelled through is gone. The cleanup on a *failed*
   * rename is likewise not reachable through this surface: every refusal this
   * layer can be made to produce happens before a temp file exists, which the
   * second case here is really asserting. Reaching the `rm` would mean forcing
   * a rename to fail, and every way to do that (a read-only directory, a
   * cross-device link) either needs root to be meaningful or is not something
   * a test can arrange portably.
   */
  it("leaves the file whole and no temp file beside it", async () => {
    await seed(1);
    const one = event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", title: "Standup" });
    await casWrite(ctx(), () => ({ result: snapshot([one]), summary: 1 }));

    // Parseable, not merely present: a truncated write is still a file.
    const after = await onDisk();
    expect(after).not.toBeNull();
    expect(after?.events).toHaveLength(1);
    expect((await readdir(dir)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("creates no temp file at all for a write it refuses", async () => {
    await seed(1, "Asia/Tokyo");
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.includes(".tmp"))).toEqual([]);
    // And the original is byte-for-byte untouched.
    expect((await onDisk())?.rev).toBe(1);
  });

  it("a refusal from the mutation is not retried and writes nothing", async () => {
    await seed(1);
    let calls = 0;
    await expect(
      casWrite(ctx(), () => {
        calls++;
        throw new RefusalError("that scope means nothing here");
      }),
    ).rejects.toThrow(RefusalError);
    expect(calls).toBe(1);
    expect((await onDisk())?.rev).toBe(1);
  });

  /**
   * The queue's whole reason. `rev` guards against a writer *outside* this
   * process and does nothing for two tool calls racing inside it: both would
   * read the same `before`, neither would see the other at the confirm-read,
   * and the second would bury the first. Serialised, the two revisions are
   * consecutive and both sets of events survive.
   */
  it("serialises its own concurrent writes instead of burying one", async () => {
    await seed(1);
    const a = event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", title: "First" });
    const b = event({ id: "b", calendarId: CAL, start: "2026-03-08 11:00", title: "Second" });

    await Promise.all([
      casWrite(ctx(), (contents) => ({
        result: { ...snapshot([...contents.events, a]), calendars: contents.calendars },
        summary: 1,
      })),
      casWrite(ctx(), (contents) => ({
        result: { ...snapshot([...contents.events, b]), calendars: contents.calendars },
        summary: 2,
      })),
    ]);

    const after = await onDisk();
    expect(after?.rev).toBe(3);
    expect(after?.events.map((e) => e.title).sort()).toEqual(["First", "Second"]);
  });

  // A failed write must not wedge every later one behind a poisoned queue.
  it("keeps taking writes after one has failed", async () => {
    await seed(1);
    await expect(
      casWrite(ctx(), () => {
        throw new RefusalError("no");
      }),
    ).rejects.toThrow();
    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    expect((await onDisk())?.rev).toBe(2);
  });
});

/* ------------------------------- the lock --------------------------------- */

/**
 * The advisory `.lock` beside the file. Against another lock-honouring writer
 * it is exclusion rather than detection — the window between the confirm-read
 * and the `atomicWrite` used to be merely honest, and this is what closed it.
 * What is observable here: the lock never outlives a write (success or
 * refusal), a stale one is broken rather than queued behind, and a live one
 * is waited out rather than ignored.
 */
describe("the advisory lock", () => {
  const lockPath = () => `${path}.lock`;

  it("is gone after a successful write", async () => {
    await seed(1);
    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    expect((await readdir(dir)).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("is gone after a refused write", async () => {
    await seed(1, "Asia/Tokyo");
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  it("breaks a stale lock instead of queueing behind a crashed writer", async () => {
    await seed(1);
    await writeFile(lockPath(), "99999 2026-01-01T00:00:00.000Z\n", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath(), old, old);

    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    expect((await onDisk())?.rev).toBe(2);
    expect((await readdir(dir)).filter((n) => n.endsWith(".lock"))).toEqual([]);
  });

  // Real timers, deliberately: what is under test is `acquireLock`'s own
  // polling of a real file on a real disk, and a fake clock cannot advance
  // another process's release. The margins are wide — 300ms against a 100ms
  // poll and a 10s stale threshold — so load moves the numbers, not the
  // verdict.
  it("waits for a live lock and writes once it is released", async () => {
    await seed(1);
    await writeFile(lockPath(), `${process.pid} live\n`, "utf8");
    const began = Date.now();
    const release = setTimeout(() => void rm(lockPath(), { force: true }), 300);

    await casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }));
    clearTimeout(release);
    // Well past the poll interval and well short of the stale threshold: the
    // write went through because the holder let go, not because the lock was
    // presumed dead.
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
    expect((await onDisk())?.rev).toBe(2);
  });

  // Real time again, ~2s of it: the deadline is the contract, and it is the
  // only branch that stands between a wedged foreign writer and a tool call
  // that never answers.
  it("refuses, naming the lock, when a live one is never released", async () => {
    await seed(1);
    await writeFile(lockPath(), `${process.pid} live\n`, "utf8");
    await expect(casWrite(ctx(), () => ({ result: snapshot(), summary: 1 }))).rejects.toThrow(
      /another writer holds/i,
    );
    // The original is untouched — a refusal to lock is a refusal to write.
    expect((await onDisk())?.rev).toBe(1);
  });
});
