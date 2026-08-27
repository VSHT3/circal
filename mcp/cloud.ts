/* ------------------------------------------------------------------ *
 * The cloud transport: the same one Supabase row the browser's cloud
 * sync writes, read and written here as a `Store`.
 *
 * The MCP server is client #3 of that row — a browser tab is #1 and #2
 * — and deliberately the *simplest* one: it holds no local document, so
 * there is nothing to merge and no plan to make. Every mutation is one
 * read-decrypt-mutate-seal-swap, compare-and-swapped on `rev` exactly
 * as `mcp/file.ts` CASes the file, and the browsers' own merge
 * machinery (`merge.ts`, stamps, graves) converges around whatever this
 * writer lands, because every mutation in `mcp/domain.ts` stamps like
 * the app's own.
 *
 * End-to-end encryption is preserved by *where* this runs, not by
 * anything here: the derived key lives in a file on the user's own
 * machine (Node has no IndexedDB to keep an opaque `CryptoKey` in — see
 * `deriveBits` in src/lib/vault.ts), plaintext exists only in this
 * process's memory, and Supabase still stores ciphertext it cannot
 * read. Running this server on hardware the user does not control
 * would break that promise; do not host it.
 * ------------------------------------------------------------------ */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { base64UrlToBytes, bytesToBase64Url } from "@/lib/base64";
import { LOCKED, readCloudRow, type CloudRow } from "@/lib/cloudLink";
import {
  MIRROR_VERSION,
  localZone,
  readMirrorFile,
  serialiseMirror,
  type MirrorContents,
} from "@/lib/mirror";
import {
  UnreadablePayload,
  WrongPassphrase,
  deriveBits,
  restoreKeyed,
  saltOf,
  vaultOf,
  type Vault,
} from "@/lib/vault";

import {
  RefusalError,
  assertVersionAllowsMutation,
  assertZoneAllowsMutation,
  zoneWarning,
} from "./file";
import type { Loaded, Mutator, Store } from "./store";

/* ------------------------------ the credentials ---------------------------- */

/**
 * What `circal-mcp login` leaves behind, and everything `--cloud` needs:
 * where the project is, who signed in, the derived key's bytes with the
 * salt they belong to, and the refresh token that keeps the session alive.
 *
 * The passphrase is never here — `deriveBits` is one-way — but the key
 * bytes open the calendar, so the file is written `0600` and lives beside
 * the app's own data, never in a repo. This is the browser's "stay
 * unlocked" record in Node clothes: same authority, same threat model
 * (whoever owns this disk owns the calendar), one honest step weaker in
 * that a file's bytes are readable where a non-extractable `CryptoKey`'s
 * are not, which is the price of a runtime with no IndexedDB.
 */
export interface CloudCredentials {
  url: string;
  key: string;
  email: string;
  user: string;
  /** base64url, 16 bytes — the salt the key was derived under. */
  salt: string;
  /** base64url, 32 bytes — the derived AES key. */
  aesKey: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. Refreshed lazily when within a minute of expiry. */
  expiresAt: number;
}

/** Where the record lives: the platform's own config home, `circal/cloud.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CIRCAL_CLOUD_CREDENTIALS) return env.CIRCAL_CLOUD_CREDENTIALS;
  const home = homedir();
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "circal", "cloud.json");
  if (process.platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "circal", "cloud.json");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "circal", "cloud.json");
}

export async function readCredentials(path: string): Promise<CloudCredentials | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<Record<keyof CloudCredentials, unknown>>;
  const strings = [
    "url",
    "key",
    "email",
    "user",
    "salt",
    "aesKey",
    "accessToken",
    "refreshToken",
  ] as const;
  for (const field of strings) if (typeof record[field] !== "string" || !record[field]) return null;
  if (typeof record.expiresAt !== "number") return null;
  return record as CloudCredentials;
}

export async function writeCredentials(path: string, creds: CloudCredentials): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // `mode` only applies on create; an existing file keeps its old bits.
  await chmod(path, 0o600);
}

/* -------------------------------- the session ------------------------------ */

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: string;
  email: string;
}

/** A GoTrue session response, read defensively — it is a network's word. */
function readSession(value: unknown): Session | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const user = body.user as Record<string, unknown> | undefined;
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") return null;
  if (typeof user?.id !== "string") return null;
  const expiresAt =
    typeof body.expires_at === "number"
      ? body.expires_at
      : Math.floor(Date.now() / 1000) +
        (typeof body.expires_in === "number" ? body.expires_in : 3600);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt,
    user: user.id,
    email: typeof user.email === "string" ? user.email : "",
  };
}

/** One error message out of whatever GoTrue or PostgREST answered with. */
async function apiError(response: Response, doing: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as Record<string, unknown>;
    detail = String(body.msg ?? body.message ?? body.error_description ?? body.error ?? "");
  } catch {
    // An empty or non-JSON body; the status line will have to do.
  }
  return new Error(`${doing} failed (${response.status})${detail ? `: ${detail}` : ""}`);
}

async function authRequest(
  url: string,
  key: string,
  path: string,
  body: Record<string, unknown>,
  doing: string,
): Promise<unknown> {
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiError(response, doing);
  return response.json();
}

export async function requestCode(url: string, key: string, email: string): Promise<void> {
  await authRequest(url, key, "otp", { email, create_user: true }, "requesting a sign-in code");
}

export async function verifyCode(
  url: string,
  key: string,
  email: string,
  token: string,
): Promise<Session> {
  const body = await authRequest(
    url,
    key,
    "verify",
    { type: "email", email, token },
    "verifying the code",
  );
  const session = readSession(body);
  if (!session) throw new Error("the sign-in answer did not carry a session");
  return session;
}

async function refreshSession(url: string, key: string, refreshToken: string): Promise<Session> {
  const body = await authRequest(
    url,
    key,
    "token?grant_type=refresh_token",
    { refresh_token: refreshToken },
    "refreshing the session",
  );
  const session = readSession(body);
  if (!session) throw new Error("the refresh answer did not carry a session");
  return session;
}

/* --------------------------------- the row --------------------------------- */

/** A minute of slack, so a token is never presented in its dying second. */
const EXPIRY_SLACK_S = 60;

class CloudClient {
  constructor(
    private creds: CloudCredentials,
    private path: string,
  ) {}

  get email(): string {
    return this.creds.email;
  }

  /**
   * A live access token, refreshed when near expiry. GoTrue *rotates*
   * refresh tokens, so a successful refresh is persisted immediately —
   * losing the rotation means the next launch's token is already spent
   * and the user is sent back through `login` for no crime of theirs.
   * The persistence itself is best-effort, `rememberRev`'s reason: the
   * refresh has already succeeded, and failing the user's actual request
   * over bookkeeping is the wrong way round.
   */
  private async token(): Promise<string> {
    if (this.creds.expiresAt - EXPIRY_SLACK_S > Date.now() / 1000) return this.creds.accessToken;
    const session = await refreshSession(this.creds.url, this.creds.key, this.creds.refreshToken);
    this.creds = {
      ...this.creds,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    };
    try {
      await writeCredentials(this.path, this.creds);
    } catch {
      // The session is live either way; only the next launch pays.
    }
    return this.creds.accessToken;
  }

  private async rest(path: string, init: RequestInit): Promise<Response> {
    const token = await this.token();
    return fetch(`${this.creds.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.creds.key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  /** The row, or `null` when the account has none yet. RLS scopes the select
   *  to the signed-in user's own row, so there is no filter to get wrong. */
  async fetchRow(): Promise<CloudRow | null> {
    const response = await this.rest("documents?select=rev,version,zone,payload", {
      method: "GET",
    });
    if (!response.ok) throw await apiError(response, "reading the cloud copy");
    const rows = (await response.json()) as unknown[];
    return readCloudRow(rows[0]);
  }

  /**
   * The compare-and-swap: `update … where rev = expected`, and the row count
   * answers whether we won. `Prefer: return=representation` is not decoration
   * — without it PostgREST returns nothing to count (the browser's `replace`
   * makes the same point with `.select()`). No insert branch on purpose: this
   * client never creates the row, so "no row" and "somebody moved it" can
   * share the miss without ambiguity — the caller re-reads either way.
   */
  async casReplace(
    expected: number,
    next: number,
    zone: string,
    payload: string,
  ): Promise<boolean> {
    const response = await this.rest(`documents?rev=eq.${expected}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ rev: next, version: MIRROR_VERSION, zone, payload }),
    });
    if (!response.ok) throw await apiError(response, "writing the cloud copy");
    const rows = (await response.json()) as unknown[];
    return rows.length === 1;
  }
}

/* -------------------------------- the store -------------------------------- */

const NO_ROW =
  "No cloud copy exists for this account yet. Open circal in a browser, sign in and turn " +
  "cloud sync on (Settings → Cloud copy), then retry.";

const RESEALED_HERE =
  "The cloud copy was re-sealed under a different passphrase since this machine signed in, " +
  "so the key it kept no longer opens it. Nothing was written. Run `circal-mcp login` again.";

const UNOPENABLE =
  "The stored key does not open the cloud copy, though the copy claims its salt. Nothing " +
  "was written. Run `circal-mcp login` again; if this repeats, the payload may be damaged.";

export interface CloudEnv {
  credentials: CloudCredentials;
  path: string;
  env: NodeJS.ProcessEnv;
}

export function cloudStore(ctx: CloudEnv): Store {
  const client = new CloudClient(ctx.credentials, ctx.path);
  const storedSalt = base64UrlToBytes(ctx.credentials.salt);
  const storedKey = base64UrlToBytes(ctx.credentials.aesKey);
  if (!storedSalt || !storedKey) {
    throw new Error(`${ctx.path} is damaged — run \`circal-mcp login\` to rewrite it.`);
  }
  const salt = storedSalt;
  const vaultReady: Promise<Vault> = restoreKeyed(storedKey, salt).then(vaultOf);

  /**
   * Open the row into a document, refusing with the *right* sentence for each
   * of the three ways it can fail — the vault's own two-refusals rule, plus
   * the salt check that turns "wrong key" into "re-sealed elsewhere" when
   * that is what actually happened.
   */
  async function openRow(row: CloudRow): Promise<MirrorContents> {
    const rowSalt = saltOf(row.payload);
    if (!rowSalt || rowSalt.length !== salt.length || !rowSalt.every((b, i) => b === salt[i])) {
      throw new RefusalError(RESEALED_HERE);
    }
    let text: string;
    try {
      text = await (await vaultReady).open(row.payload);
    } catch (error) {
      if (error instanceof WrongPassphrase) throw new RefusalError(UNOPENABLE);
      if (error instanceof UnreadablePayload)
        throw new RefusalError(
          "The cloud copy's payload is not a vault this build can read. Nothing was written.",
        );
      throw error;
    }
    const contents = readMirrorFile(text);
    if (!contents) {
      throw new Error("the cloud payload decrypted, but not into a circal document");
    }
    // The envelope columns are the writer's claim; the document inside is the
    // truth the guards run on. `rev` is the exception — the column is what the
    // CAS swaps on, so it is what the next write must count from.
    return { ...contents, rev: row.rev, zone: row.zone || contents.zone };
  }

  async function loadOnce(): Promise<Loaded> {
    const row = await client.fetchRow();
    if (!row) throw new RefusalError(NO_ROW);
    const contents = await openRow(row);
    return { contents, warning: zoneWarning(contents) };
  }

  /**
   * Read → decrypt → mutate → seal → swap on `rev`, re-run whole against a
   * fresh read when the swap misses — `casWriteOnce`'s loop with the CAS
   * moved into the transport, where it is atomic and needs no lock and no
   * confirm-read. One retry, then a refusal naming both revisions.
   */
  async function writeOnce<T>(mutate: Mutator<T>): Promise<T> {
    let firstRev: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await client.fetchRow();
      if (!row) throw new RefusalError(NO_ROW);
      const contents = await openRow(row);
      assertVersionAllowsMutation(contents);
      assertZoneAllowsMutation(contents, ctx.env);
      const { result, summary } = mutate(contents);
      // The row's zone is preserved, not claimed: a zone-mismatch override
      // writes the *content* across the divide, never re-homes the document —
      // `casWriteOnce`'s own `after.zone || localZone()`.
      const zone = row.zone || localZone();
      const next = row.rev + 1;
      const payload = await (await vaultReady).seal(serialiseMirror(result, next, zone));
      if (await client.casReplace(row.rev, next, zone, payload)) return summary;
      if (firstRev === null) firstRev = row.rev;
      else {
        throw new Error(
          `The cloud copy moved under this write: read at rev ${firstRev}, lost the swap ` +
            `again at rev ${row.rev}. Something else is writing it — try again.`,
        );
      }
    }
    throw new Error("unreachable");
  }

  /** The file half's process-wide queue, for the file half's reason: two tool
   *  calls racing inside this one process would read one `rev` and the second
   *  swap would always lose. Lining them up costs nothing and wastes no retry. */
  let writeQueue: Promise<unknown> = Promise.resolve();

  return {
    load: loadOnce,
    write<T>(mutate: Mutator<T>): Promise<T> {
      const run = writeQueue.then(() => writeOnce(mutate));
      writeQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/* --------------------------------- login ----------------------------------- */

/** A line from the terminal; `hidden` masks the echo — a passphrase is being
 *  typed. stdout is free here: `login` is its own invocation, never the
 *  serving process whose stdout is the protocol channel. */
function ask(question: string, hidden = false): Promise<string> {
  const muted = { current: false };
  const output = new Writable({
    write(chunk: Buffer, _enc, done) {
      if (!muted.current) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.question(question, (answer) => {
    muted.current = false;
    if (hidden) process.stdout.write("\n");
    rl.close();
    resolve(answer.trim());
  });
  muted.current = hidden;
  return promise;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Where a deployment answers "which Supabase project am I" — see
 *  `src/pages/mcp.json.ts`. circal's own site by default; a fork passes
 *  `--site https://their.domain`. */
const DEFAULT_SITE = "https://circal.day";

export interface Project {
  url: string;
  key: string;
}

/** The site's own answer, read defensively — it is a network's word, and a
 *  fork that never configured the cloud legitimately answers `null`s. */
export function readProject(value: unknown): Project | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.url !== "string" || !body.url) return null;
  if (typeof body.key !== "string" || !body.key) return null;
  return { url: body.url.replace(/\/+$/, ""), key: body.key };
}

/**
 * Which project to sign in against: an explicit flag or env pair wins, else
 * the site is asked at `/mcp.json` — the same values the site ships inside
 * its own bundle, now at an address a terminal can read. Nothing secret
 * travels: the publishable key is public by design (`.env.example`).
 */
export async function resolveProject(argv: string[], env: NodeJS.ProcessEnv): Promise<Project> {
  const url = (flagValue(argv, "--url") || env.PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = flagValue(argv, "--key") || env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  if (url && key) return { url, key };
  if (url || key) {
    throw new Error(
      "circal-mcp login was given half a project: --url and --key (or the two " +
        "PUBLIC_SUPABASE_* variables) travel together.",
    );
  }

  const site = (flagValue(argv, "--site") || DEFAULT_SITE).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${site}/mcp.json`);
  } catch (error) {
    throw new Error(`could not reach ${site} to ask which project it uses`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(
      `${site} did not answer /mcp.json (${response.status}) — an older deployment. ` +
        "Pass --url and --key instead (the publishable sb_publishable_… pair the site is built with).",
    );
  }
  const project = readProject(await response.json().catch(() => null));
  if (!project) {
    throw new Error(
      `${site} does not offer a cloud copy (its /mcp.json names no project). ` +
        "Pass --url and --key if you run your own.",
    );
  }
  return project;
}

/**
 * Sign in, verify the passphrase against the row's own box, and leave the
 * credentials record behind. Interactive on purpose — an OTP and a passphrase
 * both travel through a person — and hand-driven rather than tested, the
 * `mirrorLink.ts` rule: everything decidable is in the pure pieces above.
 *
 * The row must already exist: this client never mints a box (a first `seal`
 * is enrolment, and enrolment belongs to the app's own panel, where the
 * passphrase's meaning is explained before it is chosen).
 */
export async function runLogin(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { url, key } = await resolveProject(argv, env);

  const email = await ask("Email: ");
  if (!email) throw new Error("an email address is required");
  await requestCode(url, key, email);
  const code = await ask("Sign-in code (from the email): ");
  const session = await verifyCode(url, key, email, code);

  // The passphrase is proven against the row before anything is written:
  // a record that opens nothing helps nobody, and the row's own salt is the
  // only honest thing to derive against.
  const client = new CloudClient(
    {
      url,
      key,
      email,
      user: session.user,
      salt: "",
      aesKey: "",
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    },
    credentialsPath(env),
  );
  const row = await client.fetchRow();
  if (!row) throw new Error(NO_ROW);

  const foundSalt = saltOf(row.payload);
  if (!foundSalt) throw new Error("the cloud copy's payload is not a vault this build can read");
  // Copied off the payload's own bytes, `derive`'s reason: the salt must not
  // keep the whole ciphertext alive, and the copy pins the buffer type.
  const salt = new Uint8Array(foundSalt);
  const passphrase = await ask("Passphrase: ", true);
  const rawKey = await deriveBits(passphrase, salt);
  try {
    await vaultOf(await restoreKeyed(rawKey, salt)).open(row.payload);
  } catch (error) {
    if (error instanceof WrongPassphrase) throw new Error(LOCKED, { cause: error });
    throw error;
  }

  const path = credentialsPath(env);
  await writeCredentials(path, {
    url,
    key,
    email: session.email || email,
    user: session.user,
    salt: bytesToBase64Url(salt),
    aesKey: bytesToBase64Url(rawKey),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  });

  console.log(`\nSigned in as ${session.email || email}; the cloud copy opens.`);
  console.log(`Credentials written to ${path} (0600 — the derived key, never the passphrase).`);
  console.log(`\nServe it with:\n\n  circal-mcp --cloud\n`);
}

/** Withdraw this machine's authority now, not at the next launch — the
 *  browser's own reading of what switching "stay unlocked" off means. */
export async function runLogout(env: NodeJS.ProcessEnv): Promise<void> {
  const path = credentialsPath(env);
  await rm(path, { force: true });
  console.log(`Removed ${path}. This machine can no longer open the cloud copy.`);
}
