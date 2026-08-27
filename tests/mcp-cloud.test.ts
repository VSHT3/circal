import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendar, event } from "./helpers";
import { bytesToBase64Url } from "@/lib/base64";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { MIRROR_VERSION, localZone, readMirrorFile, serialiseMirror } from "@/lib/mirror";
import { derive, deriveBits, vaultOf, type Keyed, type Vault } from "@/lib/vault";
import type { CalEvent } from "@/lib/events";
import { RefusalError, type Mutated } from "../mcp/file";
import {
  cloudStore,
  credentialsPath,
  readCredentials,
  readProject,
  resolveProject,
  writeCredentials,
  type CloudCredentials,
} from "../mcp/cloud";

/**
 * The cloud transport, driven against a fake GoTrue + PostgREST: an in-memory
 * row and a `fetch` stub that honours exactly the contract the real services
 * do — `rev=eq.N` matches or it does not, `Prefer: return=representation`
 * answers with the rows it touched. The vault is real: every case seals and
 * opens with the same WebCrypto the browser uses, so a fixture that would not
 * decrypt in production does not decrypt here either.
 *
 * What is pinned is what this layer alone decides: that a mutation lands
 * whole at `rev + 1`, that a lost swap re-runs the mutation against the fresh
 * read rather than patching a stale result on, that every refusal (no row,
 * re-sealed salt, foreign zone, newer version) is the *right* refusal, and
 * that a rotated refresh token is persisted rather than spent. The login flow
 * is interactive and hand-driven, `mirrorLink.ts`'s rule.
 */

const PASSPHRASE = "correct horse battery staple";
const CAL = "work";

let keyed: Keyed;
let vault: Vault;
/** A second enrolment — another passphrase, another salt — for the re-seal case. */
let foreign: Vault;

beforeAll(async () => {
  keyed = await derive(PASSPHRASE);
  vault = vaultOf(keyed);
  foreign = vaultOf(await derive("someone changed it"));
});

const snapshot = (events: CalEvent[] = []): Mutated => ({
  events,
  calendars: [calendar({ id: CAL })],
  settings: DEFAULT_SETTINGS,
  settingsAt: 0,
  graves: [],
});

/* ------------------------------- the fake ---------------------------------- */

interface FakeRow {
  rev: number;
  version: number;
  zone: string;
  payload: string;
}

/** The row and the counters, plus one hook: `onFetchRow` runs after a GET has
 *  taken its snapshot, which is how a case moves the row between a read and
 *  its swap. */
class FakeSupabase {
  row: FakeRow | null = null;
  gets = 0;
  patches = 0;
  refreshes = 0;
  onFetchRow: (() => void | Promise<void>) | null = null;

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/auth/v1/token")) {
      this.refreshes += 1;
      return Response.json({
        access_token: `access-${this.refreshes}`,
        refresh_token: `refresh-${this.refreshes}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: "user-1", email: "g@example.com" },
      });
    }
    if (url.includes("/rest/v1/documents")) {
      if ((init?.method ?? "GET") === "GET") {
        this.gets += 1;
        // Snapshot first, hook second: the hook is "another writer landing
        // between this read and its swap", so the reader gets the stale row.
        const rows = this.row ? [{ ...this.row }] : [];
        await this.onFetchRow?.();
        return Response.json(rows);
      }
      if (init?.method === "PATCH") {
        this.patches += 1;
        const match = /rev=eq\.(\d+)/.exec(url);
        const expected = Number(match?.[1]);
        if (!this.row || this.row.rev !== expected) return Response.json([]);
        this.row = { ...this.row, ...(JSON.parse(String(init.body)) as Partial<FakeRow>) };
        return Response.json([{ rev: this.row.rev }]);
      }
    }
    return new Response("unexpected request in test: " + url, { status: 500 });
  };
}

let fake: FakeSupabase;
let dir = "";
let credsPath = "";

const creds = async (overrides: Partial<CloudCredentials> = {}): Promise<CloudCredentials> => ({
  url: "https://project.supabase.co",
  key: "sb_publishable_test",
  email: "g@example.com",
  user: "user-1",
  salt: bytesToBase64Url(keyed.salt),
  aesKey: bytesToBase64Url(await deriveBits(PASSPHRASE, keyed.salt)),
  accessToken: "access-0",
  refreshToken: "refresh-0",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});

const store = async (env: NodeJS.ProcessEnv = {}, overrides: Partial<CloudCredentials> = {}) =>
  cloudStore({ credentials: await creds(overrides), path: credsPath, env });

/** Put a sealed document in the row, bypassing the writer. */
async function seedRow(
  rev: number,
  zone = localZone(),
  events: CalEvent[] = [],
  through: Vault = vault,
): Promise<void> {
  fake.row = {
    rev,
    version: MIRROR_VERSION,
    zone,
    payload: await through.seal(serialiseMirror(snapshot(events), rev, zone)),
  };
}

/** What the row now holds, decrypted — the only honest way to assert a write. */
async function onRow() {
  const contents = readMirrorFile(await vault.open(fake.row!.payload));
  if (!contents) throw new Error("the row's payload did not decrypt to a document");
  return contents;
}

const addEvent = (title: string) => (contents: { events: CalEvent[] }) => {
  const created = event({ start: "2026-08-26 18:30", end: "2026-08-26 19:30", title });
  return {
    result: { ...snapshot([...contents.events, { ...created, calendarId: CAL }]) },
    summary: title,
  };
};

beforeEach(async () => {
  fake = new FakeSupabase();
  vi.stubGlobal("fetch", fake.handle);
  dir = await mkdtemp(join(tmpdir(), "circal-mcp-cloud-"));
  credsPath = join(dir, "cloud.json");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/* ------------------------------ credentials -------------------------------- */

describe("resolveProject — which project login signs into", () => {
  it("takes the flag pair whole, and refuses half of one", async () => {
    await expect(
      resolveProject(["--url", "https://p.supabase.co/", "--key", "sb_publishable_x"], {}),
    ).resolves.toEqual({ url: "https://p.supabase.co", key: "sb_publishable_x" });
    await expect(resolveProject(["--url", "https://p.supabase.co"], {})).rejects.toThrow(
      /travel together/,
    );
  });

  it("asks the site's /mcp.json when nothing names a project", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://circal.day/mcp.json");
      return Response.json({ url: "https://site.supabase.co", key: "sb_publishable_site" });
    });
    await expect(resolveProject([], {})).resolves.toEqual({
      url: "https://site.supabase.co",
      key: "sb_publishable_site",
    });
  });

  it("says 'this site offers no cloud copy' for a fork's nulls, not a parse error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ url: null, key: null }));
    await expect(resolveProject(["--site", "https://fork.example"], {})).rejects.toThrow(
      /does not offer a cloud copy/,
    );
  });

  it.each([
    { name: "nulls", value: { url: null, key: null } },
    { name: "missing key", value: { url: "https://x.supabase.co" } },
    { name: "not an object", value: "nope" },
  ])("readProject answers null for $name", ({ value }) => {
    expect(readProject(value)).toBeNull();
  });
});

describe("the credentials record", () => {
  it("round-trips, and the env override names the path", async () => {
    const record = await creds();
    await writeCredentials(credsPath, record);
    expect(await readCredentials(credsPath)).toEqual(record);
    expect(credentialsPath({ CIRCAL_CLOUD_CREDENTIALS: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it.each([
    { name: "absent file", write: async () => {} },
    { name: "not json", write: async () => writeCredentials(credsPath, "nope" as never) },
    {
      name: "a field missing",
      write: async () => writeCredentials(credsPath, { url: "https://x" } as never),
    },
  ])("answers null for $name rather than serving a broken record", async ({ write }) => {
    await write();
    expect(await readCredentials(credsPath)).toBeNull();
  });
});

/* --------------------------------- reads ----------------------------------- */

describe("load", () => {
  it("decrypts the row into the document, no warning in the row's own zone", async () => {
    await seedRow(3, localZone(), [
      { ...event({ start: "2026-08-26 09:00", title: "Standup" }), calendarId: CAL },
    ]);
    const { contents, warning } = await (await store()).load();
    expect(warning).toBeNull();
    expect(contents.rev).toBe(3);
    expect(contents.events.map((e) => e.title)).toEqual(["Standup"]);
  });

  it("warns across a zone divide, but answers — reading cannot land on a wrong day", async () => {
    await seedRow(1, "America/New_York");
    const { warning } = await (await store()).load();
    expect(warning).toContain("America/New_York");
  });

  it("refuses an account with no row yet, naming the enrolment step", async () => {
    await expect((await store()).load()).rejects.toThrow(/turn cloud sync on/i);
  });
});

/* --------------------------------- writes ---------------------------------- */

describe("write — the CAS", () => {
  it("lands the mutation whole at rev + 1, preserving the row's zone", async () => {
    await seedRow(4, "America/New_York");
    const summary = await (
      await store({ CIRCAL_ALLOW_ZONE_MISMATCH: "1" })
    ).write(addEvent("Dinner"));
    expect(summary).toBe("Dinner");
    expect(fake.row!.rev).toBe(5);
    expect(fake.row!.version).toBe(MIRROR_VERSION);
    // The write crosses the divide; it does not re-home the document.
    expect(fake.row!.zone).toBe("America/New_York");
    const contents = await onRow();
    expect(contents.rev).toBe(5);
    expect(contents.zone).toBe("America/New_York");
    expect(contents.events.map((e) => e.title)).toEqual(["Dinner"]);
  });

  it("re-runs the mutation against a fresh read when the swap is lost", async () => {
    await seedRow(1);
    let moved = false;
    fake.onFetchRow = async () => {
      // After the first read, another writer lands rev 2 with an event of its
      // own — before this writer's PATCH arrives.
      if (moved) return;
      moved = true;
      await seedRow(2, localZone(), [
        { ...event({ start: "2026-08-26 08:00", title: "Theirs" }), calendarId: CAL },
      ]);
    };
    await (await store()).write(addEvent("Mine"));
    // Not patched onto the stale read: the retry saw "Theirs" and kept it.
    expect(fake.row!.rev).toBe(3);
    expect((await onRow()).events.map((e) => e.title).sort()).toEqual(["Mine", "Theirs"]);
    expect(fake.patches).toBe(2);
  });

  it("gives up after losing the swap twice, naming both revisions", async () => {
    await seedRow(1);
    fake.onFetchRow = async () => {
      await seedRow(fake.row!.rev + 10);
    };
    // Both reads answered *before* the mover landed, so the writer read 1,
    // then 11, and lost the swap both times.
    await expect((await store()).write(addEvent("Never"))).rejects.toThrow(/rev 1.*rev 11/s);
  });

  it("never retries a refusal from the mutation itself", async () => {
    await seedRow(1);
    await expect(
      (await store()).write(() => {
        throw new RefusalError("a bad scope");
      }),
    ).rejects.toThrow("a bad scope");
    expect(fake.gets).toBe(1);
    expect(fake.patches).toBe(0);
  });

  it("queues concurrent writes in-process, so neither buries the other", async () => {
    await seedRow(1);
    const s = await store();
    const [a, b] = await Promise.all([s.write(addEvent("First")), s.write(addEvent("Second"))]);
    expect([a, b]).toEqual(["First", "Second"]);
    expect(fake.row!.rev).toBe(3);
    expect((await onRow()).events.map((e) => e.title).sort()).toEqual(["First", "Second"]);
  });

  it("refuses an account with no row rather than minting one", async () => {
    await expect((await store()).write(addEvent("Seed"))).rejects.toThrow(/turn cloud sync on/i);
    expect(fake.patches).toBe(0);
  });
});

/* -------------------------------- refusals --------------------------------- */

describe("the guards", () => {
  it("refuses a zone mismatch write, and the override opens it", async () => {
    await seedRow(1, "America/New_York");
    const here = await store();
    await expect(here.write(addEvent("Wrong day risk"))).rejects.toThrow(/America\/New_York/);
    expect(fake.patches).toBe(0);
    await (await store({ CIRCAL_ALLOW_ZONE_MISMATCH: "1" })).write(addEvent("Deliberate"));
    expect(fake.row!.rev).toBe(2);
  });

  it("refuses to write a document one version ahead, and still reads it", async () => {
    const zone = localZone();
    const ahead = JSON.parse(serialiseMirror(snapshot(), 1, zone)) as Record<string, unknown>;
    ahead.version = MIRROR_VERSION + 1;
    fake.row = {
      rev: 1,
      version: MIRROR_VERSION + 1,
      zone,
      payload: await vault.seal(JSON.stringify(ahead)),
    };
    const s = await store();
    await expect(s.load()).resolves.toBeTruthy();
    await expect(s.write(addEvent("Dropped fields"))).rejects.toThrow(/version/i);
    expect(fake.patches).toBe(0);
  });

  it("reads a re-sealed row as 'signed in against an older box', not a wrong key", async () => {
    // Another device deleted and re-enrolled: same account, new salt. The key
    // this machine kept cannot open it, and the sentence must send the user
    // to `login`, never claim their passphrase is wrong.
    await seedRow(2, localZone(), [], foreign);
    await expect((await store()).load()).rejects.toThrow(/login/);
    await expect((await store()).write(addEvent("Blind"))).rejects.toThrow(/re-sealed/i);
    expect(fake.patches).toBe(0);
  });
});

/* -------------------------------- the session ------------------------------ */

describe("the session", () => {
  it("refreshes a stale token once and persists the rotated pair", async () => {
    await seedRow(1);
    await writeCredentials(credsPath, await creds({ expiresAt: 1 }));
    const s = cloudStore({
      credentials: (await readCredentials(credsPath))!,
      path: credsPath,
      env: {},
    });
    await s.write(addEvent("After refresh"));
    expect(fake.refreshes).toBe(1);
    // GoTrue rotates refresh tokens: losing the rotation spends the next
    // launch's token before it is used.
    const kept = JSON.parse(await readFile(credsPath, "utf8")) as CloudCredentials;
    expect(kept.refreshToken).toBe("refresh-1");
    expect(kept.accessToken).toBe("access-1");
  });

  it("presents a live token untouched", async () => {
    await seedRow(1);
    await (await store()).load();
    expect(fake.refreshes).toBe(0);
  });
});
