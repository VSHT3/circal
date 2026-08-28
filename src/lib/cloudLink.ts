/* ------------------------------------------------------------------ *
 * The cloud copy: one Postgres row, a compare-and-swap and a socket.
 *
 * `mirrorLink.ts`'s shape, one transport over — the same `MirrorState`
 * vocabulary, the same claim-then-write cycle, the same `lastDigest` guard so
 * a feed re-pull costs no round trip, the same `SETTLE_MS` debounce, and its
 * own tiny external store for the same reason: the snapshot is written to
 * `localStorage` on every mutation and now to a row as well, so putting this
 * link's status inside it would make the status a thing the link syncs.
 *
 * It calls `mergeDocuments` through the `mirrorMerges` gate exactly as the
 * file half does, so "what does a conflict mean" keeps having one answer, and
 * `mirror.ts` stays the sole owner of the document format: the plaintext
 * sealed into `payload` **is** the mirror file's own contents, byte for byte.
 * There is no second envelope, and inventing one would be inventing a second
 * format for `readMirrorFile` to disagree with.
 *
 * Four places the transport genuinely differs from a file, each decided rather
 * than inherited:
 *
 * 1. **The compare-and-swap is real.** `update … where rev = $expected` is
 *    atomic, so there is no `.lock` sibling and no Web Locks dance here. Two
 *    tabs of this origin need nothing more than the in-tab `writing` chain:
 *    if both claim revision N, exactly one `UPDATE` matches and the other is
 *    told, in the same round trip, that it lost.
 * 2. **Realtime replaces the poll, and is never required.** A subscription on
 *    this user's row, with polling as the fallback whenever the socket is not
 *    subscribed. Somebody behind a proxy that kills websockets still syncs,
 *    slower.
 * 3. **A paused project is a link that is down.** The free tier pauses an idle
 *    project (`SYNC.md` open question 4, resolved: acceptable), which surfaces
 *    as `error` carrying a sentence naming what to do about it. The calendar is
 *    whole in `localStorage` and in the mirror file meanwhile.
 * 4. **A box that will not open stops everything.** See `cloudTake`. It is the
 *    sharpest failure in this feature and the only one that is unrecoverable.
 *
 * Hand-driven, deliberately, for `mirrorLink.ts`'s reason: this half is a
 * network client, an auth session, a websocket and a debounce, and a test that
 * mocked a Postgres client would be asserting the mock. What *can* be pinned
 * is pulled out as pure functions — `readCloudRow`, `cloudPlan`, `cloudTake` —
 * and `tests/cloud.test.ts` owns those. The transport around them is verified
 * by driving two browsers at one project.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { notify } from "./notify";
import { mergeDocuments, stamped, type Mergeable } from "./merge";
import { store, subscribe, type Settings } from "./store";
import {
  MIRROR_VERSION,
  localZone,
  mirrorDigest,
  mirrorMerges,
  mirrorVerdict,
  readMirrorFile,
  serialiseMirror,
  type MirrorContents,
  zonesAgree,
} from "./mirror";
import {
  UnreadablePayload,
  WrongPassphrase,
  derive,
  saltOf,
  vaultOf,
  type Keyed,
  type Vault,
} from "./vault";
// Type-only, and erased: the two links print through one panel, so the status
// vocabulary has one declaration rather than a copy that drifts. Nothing of
// the file half's IndexedDB or File System Access reaches this chunk.
import type { MirrorStatus } from "./mirrorLink";

/* -------------------------------- the config ------------------------------ */

interface CloudConfig {
  url: string;
  key: string;
}

/**
 * `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, or `null`.
 *
 * `null` means the feature is **absent**, not broken: nothing fetches, nothing
 * renders, no error is reported, and a fork or a self-hoster who never sets
 * them gets the app they had before this file existed. `SYNC.md` opens Phase 2
 * with "the app must be byte-identical for somebody who never signs in", and
 * somebody who never configured it is the same person a step earlier.
 *
 * The publishable key belongs in the client bundle and is not a leaked secret:
 * it names the project and reaches the database with no more authority than an
 * unauthenticated visitor, and row level security is what keeps one user's row
 * out of another's reach (see the migration). Hiding it would need a Worker
 * route to proxy through, which is the one thing this app refuses to grow. Do
 * not "fix" this by moving it server-side.
 *
 * Named for what Supabase now issues. The `sb_publishable_…` key is not a JWT,
 * which is the whole reason the old name had to go: a variable called
 * `ANON_KEY` holding one invites the next reader to decode it, and the two
 * things on that dashboard page differ by one word — `sb_secret_…` carries
 * full authority, bypasses RLS, and must never reach a browser or this file.
 */
function config(): CloudConfig | null {
  const { PUBLIC_SUPABASE_URL: url, PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = import.meta.env;
  if (typeof url !== "string" || typeof key !== "string" || !url || !key) return null;
  return { url, key };
}

export function cloudSupported(): boolean {
  return config() !== null;
}

/* -------------------------------- the client ------------------------------ */

// Type-only import, so `supabase-js` contributes no byte to any chunk that
// merely mentions its types. The library plus Realtime is the largest thing
// that would ever have been added to this bundle — the marks table's own
// argument, one order of magnitude up — and the fetch below is the only way in.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * The client, fetched on demand and kept for the session.
 *
 * **This import must stay dynamic.** Nothing in `src/` may import
 * `@supabase/supabase-js` statically: it is fetched when a signed-in user
 * actually turns sync on, exactly as `ui/marks.ts` is fetched when the picker
 * opens, and for exactly the same measured reason. A static import anywhere
 * puts the whole library and its websocket stack on the first paint of a
 * calendar that mostly never signs in.
 *
 * `detectSessionInUrl: false` because auth here is a code typed by hand, never
 * a magic link: nothing arrives in the URL, and this app already reads `?d=` and
 * `?v=` from it (`App.tsx`'s `go`), so a client that rewrites the location on
 * load is a client that can lose the day the user was looking at.
 */
async function connected(): Promise<SupabaseClient | null> {
  const settings = config();
  if (!settings) return null;
  if (client) return client;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    client = createClient(settings.url, settings.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  } catch {
    // The chunk itself failed to arrive — offline at first sign-in, a CDN
    // error. The link is down, not broken: `startCloud` already catches this
    // throw, and answering `null` here is what keeps the panel's own verbs
    // from ever needing to.
    fail(DOWN);
    return null;
  }
  return client;
}

/* --------------------------------- the row -------------------------------- */

/**
 * The envelope, which is everything about the document that is readable
 * without the passphrase. `rev`, `version` and `zone` are columns rather than
 * fields inside the ciphertext precisely so this much can be decided first.
 */
export interface CloudRow {
  rev: number;
  version: number;
  zone: string;
  payload: string;
}

/**
 * A row as it arrives, validated, or `null` for anything that is not one.
 *
 * The same readings `readMirrorFile` makes of the same three fields, because
 * they mean the same things: a malformed `rev` reads as `0` rather than
 * failing the document, an absent `zone` is a writer that did not say, and an
 * absent `version` is this build's own. A row with no `payload` is no row —
 * there is nothing to open, and nothing to lose by writing over it.
 */
export function readCloudRow(value: unknown): CloudRow | null {
  if (typeof value !== "object" || value === null) return null;
  // Named rather than read through an inline cast, and every field below is
  // `typeof`-checked before it is used — `readMirrorFile`'s own treatment of
  // the same envelope, which is where these three readings come from.
  const row: Partial<Record<keyof CloudRow, unknown>> = value;
  if (typeof row.payload !== "string" || row.payload === "") return null;
  return {
    payload: row.payload,
    rev: typeof row.rev === "number" && Number.isFinite(row.rev) ? row.rev : 0,
    zone: typeof row.zone === "string" ? row.zone : "",
    version:
      typeof row.version === "number" && Number.isFinite(row.version)
        ? row.version
        : MIRROR_VERSION,
  };
}

/* --------------------------------- status --------------------------------- */

const OFF: MirrorStatus = { state: "off", name: "", at: 0, message: "" };

let status: MirrorStatus = OFF;
const listeners = new Set<() => void>();

function setStatus(next: Partial<MirrorStatus>) {
  status = { ...status, ...next };
  for (const listener of listeners) listener();
}

function fail(message: string) {
  setStatus({ state: "error", message });
  // An error must not strand the link. `onStoreChange` writes nothing while a
  // pass is failing, and with a healthy socket the fallback poll was never
  // armed either — so one transient 503 used to stop outbound sync in a
  // continuously visible tab until a remote write happened to arrive. The
  // poll clears the error on its next good pass and stands itself down.
  if (vault) startPolling();
}

/** `name` is the signed-in email here, where the file half prints a file name:
 *  the link's subject, which is what the panel prints either way. */
export function useCloud(): MirrorStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
    () => OFF,
  );
}

/* ------------------------------ the decisions ----------------------------- */

/**
 * What to do about the row that was just read, decided from the envelope
 * alone — before anything is decrypted, which is the whole reason `rev`,
 * `version` and `zone` are columns.
 *
 * `keep` — the row is where we left it. Nothing to do, and *nothing to write*:
 * a pass that answered every read with a write is two machines writing at each
 * other for ever, which is the permanent loop Phase 1 found the hard way.
 * `write` — the row is absent, or *behind* us. An older copy restored
 * underneath the tab winds a calendar backwards, which is the one outcome
 * nothing undoes, so this re-asserts. `mirrorVerdict`'s `stale`, unchanged.
 * `open` — somebody moved it on. That is the case the payload has to be opened
 * for.
 * `stop` — refuse, and do not write. Two of them:
 *
 * The **version** gate is unconditional, and deliberately stricter than the
 * file half. A newer envelope is a document this build would round-trip
 * through validators too old for it, dropping every field it has no name for —
 * measured at nine keys per record, not feared — and that is as true of a row
 * we are about to re-assert over as of one we are about to adopt.
 * `assertVersionAllowsMutation` makes the same refusal one tier up.
 *
 * The **zone** gate applies only where the row is ahead of us, exactly as
 * `mirrorLink` applies it: every day boundary in this app is local, so days
 * arriving from another zone land on the wrong day and are confident about it.
 * A row we are re-asserting over teaches us nothing, so there is nothing to be
 * wrong about.
 */
export type CloudPlan =
  | { do: "keep" }
  /** Nothing there and nothing of ours worth publishing: a first-run document
   *  must not seed an account. See the gate in the function. */
  | { do: "hold" }
  | { do: "write"; rev: number }
  | { do: "open"; row: CloudRow }
  | { do: "stop"; message: string };

export function cloudPlan(
  found: CloudRow | null,
  localRev: number,
  zone: string,
  localStamped: boolean,
): CloudPlan {
  // Nothing there. Not "somebody deleted it", not "we are ahead" — an empty
  // slot, which the next write fills, the same non-event as the empty file the
  // picker has just made. Unless this browser holds nothing worth publishing:
  // an unstamped document is a first run's demo day (`stamped`'s own
  // argument), and a demo day seeded into an empty account is adopted whole
  // by the user's real machine at its first link — the two-fresh-installs bug
  // wearing the publish path as a hat. `hold` writes nothing and waits; the
  // first real edit stamps the document and the next pass publishes it. The
  // one calendar that pays is a pre-Phase-0 blob nobody has edited since
  // stamping shipped — real events, stamps all `0` — whose first publish
  // waits for its first edit rather than being lost: delayed, never dropped.
  if (!found) return localStamped ? { do: "write", rev: localRev + 1 } : { do: "hold" };

  if (found.version > MIRROR_VERSION) {
    return {
      do: "stop",
      message: `That cloud copy was written by a newer circal (envelope ${found.version}); this one would drop fields it has no name for`,
    };
  }

  const verdict = mirrorVerdict(found.rev, localRev);
  if (verdict === "ours") return { do: "keep" };
  // `localRev + 1` and deliberately not `max(found.rev, localRev) + 1`: this
  // branch is only reached where the row is *behind* us, so our own revision
  // is the larger of the two by construction and a `max` here would be
  // arithmetic dressed up as care. The row's own number does matter one branch
  // down, where it is ahead — `claim` takes it from the document it just
  // absorbed rather than from anything worked out earlier.
  if (verdict === "stale") return { do: "write", rev: localRev + 1 };

  if (!zonesAgree(found.zone, zone)) {
    return {
      do: "stop",
      message: `That cloud copy was written in ${found.zone}, this browser is in ${zone}`,
    };
  }
  // The row travels with the answer rather than being fished back out of the
  // caller's own variable: `open` is the one branch that has a row by
  // construction, and saying so in the type is what keeps the caller from
  // asserting it.
  return { do: "open", row: found };
}

/**
 * A box that will not open, in one sentence the user can act on. Both halves
 * of it matter: what to try, and that nothing has been lost yet.
 */
export const LOCKED =
  "That passphrase does not open the cloud copy. Nothing was written — this device's calendar is untouched.";

/**
 * A delete that may or may not have happened, in one sentence that does not
 * guess. `LOCKED`'s shape: what to do, and what has *not* been lost.
 *
 * It cannot say "deleted" and it must not say "not deleted" — a `DELETE` that
 * commits and then loses its response is indistinguishable here from one that
 * never arrived. Signing out is what makes the sentence safe to print either
 * way: nothing on this device will republish the row while the user decides.
 */
export const UNSURE =
  "circal could not confirm the cloud copy was deleted, so it may still be there. You are signed out — sign in and try again. This device's calendar is untouched.";

/**
 * What to do with the payload once it has been opened — or refused.
 *
 * **`text === null` is the sharpest failure in this whole feature, and the
 * answer is `stop`.** A payload that will not open is either the wrong
 * passphrase or a damaged box, and in both cases the one thing this link must
 * never do is seal local state over it. That write is not a lost edit and not
 * an adopt that an undo step covers: it is the other machine's work,
 * ciphertext, gone, with no copy anywhere and nothing to restore from. Every
 * other failure here costs a round trip. This one costs a calendar. A future
 * reader will notice that the local document is perfectly good and think
 * writing it is the helpful thing to do; it is the opposite, because the row
 * is the *only* copy of whatever the other machine has done since it last
 * merged. Stop, say so, and let a person answer.
 *
 * The rest is the file half's `merged()`, unchanged in substance: a document
 * both sides have stamped is merged, anything else is adopted whole through
 * `store.adopt`, which records an undo step and toasts.
 *
 * `changed` is `lastDigest`'s trick measured against the row rather than the
 * store, and it is load-bearing: a merge that changed nothing must not be
 * written back, or two machines answer each other's reads with writes for
 * ever. `mirrorDigest` is canonical, which is what makes that comparison mean
 * "the document differs" rather than "the keys are in a different order".
 *
 * `learned` is that same comparison run against the **store**, and it answers
 * a toast that told a machine about its own edit. The write-back above is not
 * optional — both machines have to converge on the row — so the machine that
 * wrote first always sees its own bytes come back as the other one's
 * `rev + 1`, merges them, and produces exactly what it already had. There is
 * nothing to adopt there and nothing to say. The two flags are deliberately
 * separate questions and neither implies the other: `changed` asks whether the
 * *row* needs our bytes, `learned` whether the *store* needs theirs, and a
 * pass can easily want a write with nothing to announce.
 *
 * Both digests are taken over the `Mirrored` part only, so a revision is never
 * the difference. `mine` is a store snapshot and a row is written from one, so
 * an unchanged document compares equal; anything written by hand and not yet
 * normalised reads as learned and toasts, which is the safe direction.
 *
 * `merging: false` is the first link of a browser that has never synced, and
 * it keeps `connect`'s promise on this transport too: a row that already holds
 * a calendar is *adopted*. The gesture is a person signing in, not a person
 * publishing what this browser happens to hold — on a browser still on its
 * seed day with one setting changed, that would push eight demo events to
 * every machine on the account.
 */
export type CloudTake =
  | { take: "merge"; document: MirrorContents; changed: boolean; learned: boolean }
  | { take: "adopt"; document: MirrorContents; learned: boolean }
  | { take: "stop"; message: string };

export function cloudTake(
  text: string | null,
  mine: Mergeable<Settings>,
  now: number,
  merging = true,
): CloudTake {
  if (text === null) return { take: "stop", message: LOCKED };

  const contents = readMirrorFile(text);
  // Opened, and not a circal document. Not ours to replace either: whatever it
  // is, somebody's bytes are in there and this build cannot read them.
  if (!contents) return { take: "stop", message: "That cloud copy is not a circal calendar" };

  const merges = merging && mirrorMerges(contents, mine);
  const document: MirrorContents = merges
    ? { ...contents, ...mergeDocuments(mine, contents, now) }
    : contents;

  const digest = mirrorDigest(document);
  const changed = digest !== mirrorDigest(contents);
  const learned = digest !== mirrorDigest(mine);
  return merges
    ? { take: "merge", document, changed, learned }
    : { take: "adopt", document, learned };
}

/* ------------------------------- the session ------------------------------ */

/**
 * The fallback poll, and it is only a fallback: Realtime carries the row
 * normally and this runs when the socket is not subscribed. Far slower than
 * the file half's 2s because that was a local `stat` and this is a request
 * against somebody else's rate-limited API — a link that is down should cost
 * four requests a minute, not thirty.
 */
const POLL_MS = 15_000;

/** The file half's number, for the file half's reason: an editor's Save and
 *  the toast that follows are two commits in a frame, and the row should see
 *  one of them. */
const SETTLE_MS = 400;

/**
 * Where the revision this browser last wrote survives a reload. It has to: a
 * session that started from zero would read its own last write as somebody
 * else's, adopt it and toast about it — harmless exactly once, and a round
 * trip plus a toast every reload after that.
 *
 * Its own key rather than a `Snapshot` field, for `notify.ts`'s reason: this
 * is bookkeeping about the link, not persisted calendar data, and a field in
 * the snapshot would be a field the link syncs to the other machine.
 */
const REV_KEY = "circal.cloud";

/* --------------------------- the remembered key --------------------------- */

/**
 * Where a derived key survives a reload, when the user asked it to.
 *
 * **IndexedDB and not a fifth `localStorage` key**, and not a `Settings` field
 * either, for two separate reasons. `Settings` is part of the synced document,
 * so "remember on *this* device" living there would arm itself on every other
 * device the moment it was switched on here — a setting that contradicts its
 * own name. And `localStorage` holds strings: a `CryptoKey` survives
 * `structuredClone` as an opaque handle, which is the whole point, and
 * stringifying it is impossible by design.
 *
 * `AGENTS.md` asks a new key outside the blob to argue for itself the way
 * `circal.intro`, `circal.marks`, `circal.backup` and `circal.cloud` do. This
 * one is per-device authority over an account, which is the strongest reason
 * yet for a store the synced document cannot reach.
 *
 * The record *is* the switch: there is no separate flag, because a remembered
 * key and the intention to remember one are the same fact, and two facts would
 * be two things to keep in step. It carries `user` so signing out and in as
 * somebody else cannot resume a stranger's key — one record ever, discarded
 * rather than trusted when the id does not match.
 */
const DB_NAME = "circal.cloudkey";
const DB_STORE = "key";
const DB_KEY = "current";

interface StoredKey extends Keyed {
  /** The `auth.users` id this key was derived for. */
  user: string;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

/** The stored key, or `null` — including when this browser refuses IndexedDB,
 *  which is a browser that cannot remember rather than a browser in trouble. */
async function storedKey(): Promise<StoredKey | null> {
  try {
    return (await withStore("readonly", (s) => s.get(DB_KEY) as IDBRequest<StoredKey>)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Keep, or forget. Silent on failure for `rememberRev`'s reason: this is
 * bookkeeping about convenience, and a link that works must not report itself
 * broken because a note about it would not stick. Forgetting is the one half
 * worth a thought — a delete that failed leaves a key behind — and there is
 * nothing more this code can do about it than say so, which it cannot usefully
 * do either, since the user is looking at a switch they have just turned off.
 */
async function keep(keyed: Keyed): Promise<void> {
  try {
    const stored: StoredKey = { user: userId, key: keyed.key, salt: keyed.salt };
    await withStore("readwrite", (s) => s.put(stored, DB_KEY));
  } catch {
    // Private mode, or storage refused.
  }
}

async function forget(): Promise<void> {
  try {
    await withStore("readwrite", (s) => s.delete(DB_KEY));
  } catch {
    // Same trade.
  }
}

/**
 * Whether a remembered key still matches the box it would have to open.
 *
 * The salt is per-payload and every `seal` writes it, so a row re-sealed under
 * a different one — another device enrolling against an empty row, a passphrase
 * changed elsewhere — leaves a key that opens nothing. Left to the ordinary
 * path that key reaches `open`, throws `WrongPassphrase`, and arrives at
 * `cloudTake`'s `null` as `LOCKED`: *that passphrase does not open the cloud
 * copy*, in front of a user who typed no passphrase at all. Which is the third
 * time this feature would have blamed a person for a machine's bookkeeping.
 *
 * `null` payload is nothing to compare rather than a mismatch: an account whose
 * row is still empty has no salt to disagree with, and enrolment's own salt is
 * committed by the first `seal`. An unreadable payload is also nothing to
 * compare — a damaged box is not a stale key, and saying so here would send the
 * user to a passphrase prompt that cannot help.
 */
export function cloudResume(salt: Uint8Array, payload: string | null): "open" | "stale" {
  if (payload === null) return "open";
  const sealed = saltOf(payload);
  if (!sealed) return "open";
  if (sealed.length !== salt.length) return "stale";
  return sealed.every((byte, i) => byte === salt[i]) ? "open" : "stale";
}

/**
 * Why a remembered key stopped working, which is the sentence `LOCKED` would
 * otherwise have told them instead. It names the cause, and it says what to do.
 */
export const RESEALED =
  "The cloud copy was re-sealed on another device, so the key this browser remembered no longer opens it. Enter your passphrase to open it again.";

/* ------------------------------- the session ------------------------------ */

let vault: Vault | null = null;
/** The pair the vault was built from, kept so the switch can persist it
 *  without asking for the passphrase a second time. Dropped by `disconnect`
 *  with everything else. */
let keyed: Keyed | null = null;
let userId = "";
let localRev = 0;
/**
 * Whether a remembered key was discarded this session because the row had been
 * re-sealed under another salt. It outlives the pass that found out, so a
 * remount cannot replace the explanation with the sentence for somebody who
 * simply has not typed their passphrase yet.
 */
let resealed = false;
/** The last document written or absorbed, so a change that is not a change —
 *  a feed re-pull, a settings toggle that set the same value — costs no round
 *  trip. */
let lastDigest = "";
let writing: Promise<void> = Promise.resolve();
let channel: RealtimeChannel | null = null;
/** `window.setTimeout`, not the bare global: with `@types/node` in the project
 *  the bare one is typed as Node's `Timeout`, and this file is browser only. */
let settleTimer = 0;
let pollTimer = 0;
/** Whether the Realtime channel is currently delivering rows — what lets the
 *  error-armed fallback poll stand itself down once a pass has recovered. */
let subscribed = false;
/**
 * Whether any pass this session found the account's slot *empty*. The auth
 * layer cannot refuse a mistyped address — any email silently mints a fresh
 * account, which is an enumeration oracle refused, not an oversight — so the
 * one visible symptom of signing in under the wrong address is a cloud copy
 * that starts from nothing. This is that fact, kept for the session so the
 * panel can say it; `release` drops it with the session it describes. Never
 * cleared when the slot fills: this browser's own first write is what fills
 * it, and "expected events? another address may hold them" stays the right
 * diagnosis afterwards.
 */
let startedEmpty = false;

/**
 * Read and write the remembered revision, and never fail a sync over either.
 * `mirrorLink.remember`'s argument exactly: losing this costs the next session
 * one adopt, where the write it follows has already put the calendar in the
 * row. A browser with storage refused is precisely this shape.
 */
function rememberRev() {
  try {
    localStorage.setItem(REV_KEY, JSON.stringify({ rev: localRev }));
  } catch {
    // Deliberately silent: the sync worked.
  }
}

function rememberedRev(): number {
  try {
    const raw = localStorage.getItem(REV_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("rev" in parsed)) return 0;
    const rev = parsed.rev;
    return typeof rev === "number" && Number.isFinite(rev) ? rev : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------- the failures ----------------------------- */

/**
 * Supabase pauses a free project after a week idle, and `SYNC.md` open
 * question 4 resolves that as acceptable: a paused project is a link that is
 * down, and the answer is a sentence a human can act on rather than a retry
 * loop. Read from a failed request rather than asked for, because there is no
 * API that answers "are you paused" — a paused project simply refuses the
 * connection, which is indistinguishable from a dropped network and wants the
 * same sentence either way.
 */
const DOWN =
  "circal could not reach the cloud copy. A free Supabase project is paused after a week idle — resume it in the dashboard. Your calendar is whole on this device meanwhile.";

const UNREACHABLE =
  /failed to fetch|networkerror|network request failed|load failed|econn|503|504|unavailable|timeout/i;

/**
 * Anything thrown or returned as an error, as a sentence. A message this file
 * does not recognise is passed through — Supabase's own wording about an
 * expired code or a rate limit is more use than a paraphrase of it — and
 * anything that reads as an unreachable project becomes `DOWN`.
 */
function describe(error: unknown): string {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  return !message || UNREACHABLE.test(message) ? DOWN : message;
}

/* --------------------------------- the row -------------------------------- */

async function fetchRow(db: SupabaseClient): Promise<CloudRow | null> {
  const { data, error } = await db
    .from("documents")
    .select("rev, version, zone, payload")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(describe(error));
  return readCloudRow(data);
}

/**
 * The compare-and-swap itself, and `false` means somebody moved the row
 * between the claim and the write.
 *
 * `expected === null` is the first write, which has to be an `insert`: an
 * `update … where rev = 0` matches nothing when there is no row at all, and
 * "no row" and "somebody moved it" would then be one answer. The unique
 * violation an insert loses on is the same signal from the other side —
 * another device got there first.
 *
 * `.select()` is not decoration. Without it PostgREST returns no
 * representation and there are no affected rows to count, which is the entire
 * mechanism.
 */
async function replace(
  db: SupabaseClient,
  next: number,
  expected: number | null,
  payload: string,
): Promise<boolean> {
  const document = { rev: next, version: MIRROR_VERSION, zone: localZone(), payload };

  if (expected === null) {
    const { error } = await db.from("documents").insert({ user_id: userId, ...document });
    // 23505 = unique violation: the row exists now, written by another device
    // in the time this one spent sealing its own.
    if (error?.code === "23505") return false;
    if (error) throw new Error(describe(error));
    return true;
  }

  const { data, error } = await db
    .from("documents")
    .update(document)
    .eq("user_id", userId)
    .eq("rev", expected)
    .select("rev");
  if (error) throw new Error(describe(error));
  return (data?.length ?? 0) === 1;
}

/* ------------------------------- the exchange ----------------------------- */

/**
 * Open the payload and decide. The two vault failures collapse into one
 * answer on purpose: `WrongPassphrase` and `UnreadablePayload` are the same
 * situation from the user's side — this passphrase does not open this box —
 * and both must reach `cloudTake`'s `null`, which is the branch that refuses
 * to write.
 */
async function take(row: CloudRow, merging: boolean): Promise<CloudTake> {
  let text: string | null;
  try {
    text = (await vault?.open(row.payload)) ?? null;
  } catch (error: unknown) {
    if (!(error instanceof WrongPassphrase || error instanceof UnreadablePayload)) throw error;
    text = null;
  }
  return cloudTake(text, store.snapshot(), Date.now(), merging);
}

/**
 * Take what the other machine wrote — the merge, or their document whole.
 * `mirrorLink.absorb`, field for field, including the digest: `adopt`
 * normalises on the way in (`sane` clamps, feeds are swept), so digesting the
 * document rather than what the store made of it answers every absorb with
 * one extra write that says nothing.
 */
async function absorb(document: MirrorContents): Promise<void> {
  localRev = document.rev;
  store.adopt(document);
  lastDigest = mirrorDigest(store.snapshot());
  // `store.adopt` emitted synchronously, and `onStoreChange` ran against the
  // digest this adopt was about to replace — the settle timer it armed would
  // write the adopted document straight back at rev + 1, an echo the timer's
  // own re-check would also catch. Cleared here so a disarmed callback that
  // still fires is not a thing anybody has to reason about.
  clearTimeout(settleTimer);
  rememberRev();
  setStatus({ state: "live", message: "", at: Date.now() });
  notify("Calendar updated from the cloud copy");
}

/**
 * The revision moved and the document did not: record where the row is, and
 * say nothing.
 *
 * This is the ordinary second half of a sync rather than an edge case. The
 * write-back in `poll` is not optional — both machines must converge on the
 * row — so the machine that wrote first always sees its own edit return as the
 * other one's `rev + 1`. `absorb`ing that would tell a machine its own work is
 * news, and `store.adopt` would push a commit that changes nothing onto the
 * undo stack, so ⌘Z would appear to do nothing.
 *
 * The bookkeeping is `absorb`'s, all of it, and skipping any of it swaps a
 * spurious toast for a spurious write every `POLL_MS`: without `localRev` the
 * next pass reads the row as ahead again, and without `lastDigest` the next
 * `onStoreChange` sees a change that is not one.
 */
function settle(document: MirrorContents): void {
  localRev = document.rev;
  lastDigest = mirrorDigest(store.snapshot());
  rememberRev();
  setStatus({ state: "live", message: "", at: Date.now() });
}

interface Claim {
  /** The revision to write. */
  rev: number;
  /** The revision to swap against, or `null` to insert. */
  expected: number | null;
}

/**
 * Take the row's own word for where it is, immediately before replacing it,
 * and answer with what to write — or `null` to not write at all.
 *
 * The re-read is the same one `mirrorLink.claim` does and it is still needed
 * with a real CAS, for a different reason: the CAS makes a *lost* write
 * impossible to miss, but only a re-read can tell us what the row now holds so
 * the document we write carries it. A conditional update that merely failed
 * would be a compare-and-hope.
 */
async function claim(db: SupabaseClient): Promise<Claim | null> {
  const found = await fetchRow(db);
  // The vault can be stood down while the read was in the air — a disconnect,
  // a delete, the re-seal below — and everything past this line writes.
  if (!vault || !keyed) return null;
  // A row sealed under another salt is a box this key was not cut for. The
  // dangerous branch is `stale`: re-asserting would overwrite a document this
  // machine cannot even open — a fresh enrolment after a delete, a passphrase
  // changed elsewhere — so the link stands down to the passphrase instead,
  // with the sentence that names the cause.
  if (found && cloudResume(keyed.salt, found.payload) === "stale") {
    await standDownResealed();
    return null;
  }
  const plan = cloudPlan(found, localRev, localZone(), stamped(store.snapshot()));

  if (plan.do === "stop") {
    fail(plan.message);
    return null;
  }
  // Nothing worth publishing yet; the first real edit will be.
  if (plan.do === "hold") return null;
  if (plan.do === "keep") return { rev: localRev + 1, expected: found?.rev ?? null };
  if (plan.do === "write") return { rev: plan.rev, expected: found?.rev ?? null };

  // Ahead of us, so it has to be opened before it is replaced.
  const taken = await take(plan.row, true);
  if (!vault) return null;
  if (taken.take === "stop") {
    fail(taken.message);
    return null;
  }
  // `poll`'s own branch, for `poll`'s own reason: a row that is ahead but
  // content-identical — a reload that lost `REV_KEY` — is bookkeeping, not
  // news, and absorbing it would toast a machine about its own bytes and
  // push a no-op onto the undo stack.
  if (taken.learned) await absorb(taken.document);
  else settle(taken.document);
  // An unmergeable document is adopted and the write abandoned, exactly as the
  // file half abandons it: what arrived is now the store's own state, and
  // writing over it would be this machine deciding it had won after all.
  if (taken.take === "adopt") return null;
  return { rev: taken.document.rev + 1, expected: taken.document.rev };
}

/**
 * Claim, seal, swap. Serialised behind `writing` — two cycles in one tab share
 * `localRev` and `lastDigest`, and the second's arithmetic would be older than
 * the first's write.
 *
 * Cross-tab needs nothing further, and that is the transport's own doing: two
 * tabs claiming revision N both send `where rev = N`, exactly one matches, and
 * the loser is told so in the same round trip. This is where `mirrorLink`'s
 * Web Locks dance and the server's `.lock` sibling both go away — do not
 * reintroduce either, they exist because a file has no atomic swap.
 *
 * A lost swap is not retried here. The row has moved, so the next pass reads
 * it, merges it and writes the union back — and a retry loop inside a write is
 * how two machines come to write at each other for ever. Realtime delivers
 * that pass within a breath; the fallback poll delivers it within `POLL_MS`.
 *
 * The failure is swallowed into the chain rather than left on it: a rejected
 * `writing` poisons every later `.then`, which would stop the link for the
 * rest of the session over one refused request.
 */
function write(): Promise<void> {
  const done = writing
    .then(async () => {
      const db = client;
      if (!db || !userId || !vault) return;
      const claimed = await claim(db);
      if (claimed === null) return;

      const snapshot = store.snapshot();
      // The plaintext is the mirror file, whole and unchanged — same
      // `serialiseMirror`, same validators, so a payload could be handed to
      // Import if it were ever decrypted by hand.
      const payload = await vault.seal(serialiseMirror(snapshot, claimed.rev));
      if (!(await replace(db, claimed.rev, claimed.expected, payload))) {
        setStatus({ state: "live", message: "", at: Date.now() });
        return;
      }

      localRev = claimed.rev;
      lastDigest = mirrorDigest(snapshot);
      rememberRev();
      setStatus({ state: "live", message: "", at: Date.now() });
    })
    .catch((error: unknown) => {
      fail(describe(error));
    });
  writing = done;
  return done;
}

/**
 * One pass over the row.
 *
 * `await writing` first, and it is not tidiness: Realtime delivers this
 * machine's *own* update, and a pass that ran before the write's tail had
 * recorded the revision would read our own bytes as somebody else's, merge
 * against them and toast about it. The write chain is the ordering.
 *
 * `merging: false` is the first link of this browser's, and only that.
 */
async function poll(merging = true): Promise<void> {
  await writing;
  const db = client;
  if (!db || !userId || !vault || !keyed) return;

  let found: CloudRow | null;
  try {
    found = await fetchRow(db);
  } catch (error: unknown) {
    fail(describe(error));
    return;
  }
  if (found === null) startedEmpty = true;
  if (!vault) return;
  // `claim`'s own guard, for `claim`'s own reason — and it catches the read
  // side too: a row re-sealed elsewhere used to surface as `LOCKED`, telling
  // somebody who typed no passphrase that their passphrase was wrong.
  if (found && cloudResume(keyed.salt, found.payload) === "stale") {
    await standDownResealed();
    return;
  }

  const plan = cloudPlan(found, localRev, localZone(), stamped(store.snapshot()));
  if (plan.do === "stop") {
    fail(plan.message);
    return;
  }
  // An empty slot and an unstamped document: nothing to publish, nothing to
  // adopt. Live, and waiting for the first real edit.
  if (plan.do === "hold") {
    setStatus({ state: "live", message: "", at: Date.now() });
    return;
  }
  if (plan.do === "keep") {
    // A session's first pass over a row this browser wrote last. The digest is
    // still unset, so the first store emit of the session — any emit — would
    // seal and write an identical document back at rev + 1. The row is in
    // hand: read the digest off it. And if the store has moved since last
    // session — edits made while signed-out or offline — deliver them now
    // rather than have them ride the next unrelated emit.
    if (lastDigest === "" && found) {
      try {
        const contents = readMirrorFile(await vault.open(found.payload));
        if (contents) lastDigest = mirrorDigest(contents);
      } catch {
        // A wrong key surfaces on the open path with its own sentence; an
        // unset digest merely keeps the old behaviour of one echo write.
      }
      if (lastDigest !== "" && mirrorDigest(store.snapshot()) !== lastDigest) {
        await write();
        return;
      }
    }
    setStatus({ state: "live", message: "", at: Date.now() });
    return;
  }
  if (plan.do === "write") {
    await write();
    return;
  }

  const taken = await take(plan.row, merging);
  if (!vault) return;
  if (taken.take === "stop") {
    fail(taken.message);
    return;
  }
  // Adopting is for a document this machine did not already have; anything
  // else is bookkeeping and silence. `learned` is the only question here, and
  // deliberately not "who wrote it" or "is this tab focused" — a genuinely
  // remote change arriving in the focused tab should still say so.
  if (taken.learned) await absorb(taken.document);
  else settle(taken.document);
  // The merged document has to go back, or the other machine never learns what
  // this one was holding — and only when it differs from what is already
  // there, because a pass that answered every read with a write is the
  // permanent loop. Independent of `learned`: a row behind this machine needs
  // our bytes whether or not we took anything from it.
  if (taken.take === "merge" && taken.changed) await write();
}

/** The store moved. Write, unless what moved is not in the document. The
 *  digest is re-checked when the timer fires: an adopt that armed this during
 *  its own emit, or a change that settled meanwhile, must not earn a write.
 *  Deliberately no `error` gate — a failing pass must not swallow edits, and
 *  `write` fails into the same sentence the pass did. */
function onStoreChange() {
  if (!client || !userId || !vault) return;
  if (mirrorDigest(store.snapshot()) === lastDigest) return;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    if (mirrorDigest(store.snapshot()) !== lastDigest) void write();
  }, SETTLE_MS);
}

/* -------------------------------- the socket ------------------------------ */

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = 0;
}

/** Only while visible, for the file half's reason: a background tab racing
 *  another device for the same row is contention nobody asked for. */
function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    // Armed by an error while the socket stayed healthy: once a pass has
    // cleared the error, the socket carries the row again and this interval
    // has nothing left to do. A stood-down link stops it outright.
    if (!vault || (subscribed && status.state === "live")) {
      stopPolling();
      return;
    }
    if (document.visibilityState === "visible") void poll();
  }, POLL_MS);
}

/**
 * Realtime on this user's row, with the poll as the fallback whenever the
 * socket is not subscribed.
 *
 * Realtime is deliberately **not** a requirement. A user behind a proxy that
 * kills websockets, or a project whose Realtime is off, still syncs — slower.
 * That is why the fallback is armed off the subscription's own status rather
 * than off a timeout somebody has to tune, and why it is disarmed only on
 * `SUBSCRIBED`: every other status, including the silent `CLOSED` a suspended
 * background tab produces, is a socket that is not delivering rows.
 *
 * The filter is this user's row, and it is not the security boundary — row
 * level security is, on the server, where a client cannot argue with it.
 */
function listen(db: SupabaseClient) {
  // A channel may already be up — a StrictMode remount, an unlock after a
  // stand-down — and a second subscription would double every delivery.
  if (channel) void db.removeChannel(channel);
  channel = db
    .channel(`documents:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "documents", filter: `user_id=eq.${userId}` },
      () => void poll(),
    )
    .subscribe((state) => {
      subscribed = state === "SUBSCRIBED";
      if (subscribed) stopPolling();
      else startPolling();
    });
}

async function hush(db: SupabaseClient) {
  stopPolling();
  subscribed = false;
  if (!channel) return;
  await db.removeChannel(channel);
  channel = null;
}

/* ------------------------------- the actions ------------------------------ */

interface Account {
  id: string;
  email: string;
}

async function account(db: SupabaseClient): Promise<Account | null> {
  const { data } = await db.auth.getSession();
  const user = data.session?.user;
  return user ? { id: user.id, email: user.email ?? "" } : null;
}

/**
 * The most characters a sign-in code field may hold — a guard against a paste
 * of something that is not a code at all, and deliberately not a description
 * of the code.
 *
 * How many digits Supabase mails is a dashboard setting on the identity
 * provider's side, and this client is in no position to know it. It once
 * thought it did: the field was `maxLength={6}` against a project issuing
 * eight, so the input silently kept the first six and `verifyOtp` was handed a
 * prefix. See the bullet in `AGENTS.md`. Wide enough that no plausible
 * setting can be truncated, narrow enough to stay a code field.
 */
export const CODE_MAX = 32;

/* ------------------------------ standing down ----------------------------- */

/**
 * Stop everything on this device that could write, and wait for whatever was
 * already in flight.
 *
 * `vault = null` is the load-bearing line rather than the timers: `write`,
 * `poll` and `onStoreChange` each open by refusing when it is null, so one
 * assignment disarms the settle timer's callback, the fallback poll, the
 * Realtime handler and the visibility tick together. The timers are cleared
 * anyway, because a disarmed callback that still fires is a callback somebody
 * will later have to reason about.
 *
 * `await writing` is last and it is not tidiness: a write already past its own
 * guard is a request in the air, and a caller about to delete the row needs it
 * to land first. Reversible on purpose — `deleteCopy` puts the vault back if
 * the delete fails — so nothing here touches the session or storage.
 */
async function quiesce(db: SupabaseClient | null): Promise<void> {
  clearTimeout(settleTimer);
  vault = null;
  if (db) await hush(db);
  await writing;
}

/**
 * The row was re-sealed under another salt — a fresh enrolment against an
 * emptied account, a passphrase changed elsewhere — so the key in memory
 * opens nothing, and worse: `mirrorVerdict`'s `stale` branch would re-assert
 * over the new box without ever opening it, which is the clobber that verdict
 * exists to prevent, turned around. So the link stands down to the
 * passphrase, with the sentence that names the cause rather than `LOCKED`'s
 * accusation of a passphrase nobody typed.
 *
 * The rev bookkeeping goes too: it counted a row that no longer exists, and
 * carrying it forward would read the new box as "behind us" for ever. The
 * next unlock derives from the new box's own salt and adopts it whole —
 * undoable and toasted, `store.adopt`'s contract — which is the safe
 * direction when the two documents no longer share a history.
 */
async function standDownResealed(): Promise<void> {
  clearTimeout(settleTimer);
  vault = null;
  keyed = null;
  resealed = true;
  await forget();
  localRev = 0;
  lastDigest = "";
  try {
    localStorage.removeItem(REV_KEY);
  } catch {
    // `rememberRev`'s trade: bookkeeping, never a failure.
  }
  setStatus({ state: "prompt", message: RESEALED, at: 0 });
}

/**
 * Let the link go: the key, the revision, the session, the status.
 *
 * `forget` before `userId` is cleared, because the record is scoped to it.
 */
async function release(db: SupabaseClient | null): Promise<void> {
  keyed = null;
  localRev = 0;
  lastDigest = "";
  startedEmpty = false;
  await forget();
  userId = "";
  try {
    localStorage.removeItem(REV_KEY);
  } catch {
    // Same trade as `rememberRev`: bookkeeping, never a failure.
  }
  if (db) await db.auth.signOut();
  setStatus(OFF);
}

/** Whether this session's sign-in found no cloud copy at all — the panel's
 *  one honest clue that the address may be the wrong one. Read at render;
 *  every pass that could set it also moves the status the panel subscribes to. */
export function cloudStartedEmpty(): boolean {
  return startedEmpty;
}

export const cloud = {
  /**
   * Send a sign-in code to `email`.
   *
   * A code and deliberately not a magic link: a link needs registered redirect
   * URLs, and this app is a static bundle that also runs inside a `WKWebView`
   * (`mac/`), where there is no URL for a mail client to hand back. The code
   * travels through the person instead of through the platform.
   */
  async requestCode(email: string): Promise<void> {
    const db = await connected();
    if (!db) return;
    const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) {
      fail(describe(error));
      return;
    }
    setStatus({
      state: "prompt",
      name: email,
      at: 0,
      message: `A sign-in code is on its way to ${email}`,
    });
  },

  /**
   * Answer with the code. A session, and then a passphrase — signing in is
   * only half of the gesture, because the row is a locked box and this build
   * cannot open it with an account.
   */
  async submitCode(email: string, code: string): Promise<void> {
    const db = await connected();
    if (!db) return;
    const { error } = await db.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) {
      fail(describe(error));
      return;
    }
    setStatus({
      state: "prompt",
      name: email,
      at: 0,
      message: "Enter your passphrase to open the cloud copy",
    });
  },

  /**
   * Derive the key and start syncing.
   *
   * Expensive by design — 600k PBKDF2 rounds, hundreds of milliseconds — so it
   * happens once a session and the `Vault` it returns is kept. Never per write.
   *
   * The salt comes off the row's own payload, which is what lets a second
   * machine and a second session derive the *same* key from the same
   * passphrase. An empty account has no payload to read one from, so enrolment
   * mints a fresh salt and the first `seal` commits it.
   *
   * The first link of a browser adopts rather than merges. See `cloudTake`.
   */
  async unlock(passphrase: string): Promise<void> {
    const db = await connected();
    if (!db) return;
    const who = await account(db);
    if (!who) {
      setStatus(OFF);
      return;
    }
    userId = who.id;

    let found: CloudRow | null;
    try {
      found = await fetchRow(db);
    } catch (error: unknown) {
      fail(describe(error));
      return;
    }

    try {
      keyed = await derive(passphrase, found?.payload);
      vault = vaultOf(keyed);
    } catch (error: unknown) {
      // `derive` throws only on a payload it cannot parse; a wrong passphrase
      // is silent here and surfaces at the first `open`, which is `cloudTake`'s
      // `null` and the branch that refuses to write.
      fail(error instanceof UnreadablePayload ? LOCKED : describe(error));
      return;
    }

    // The explanation has been acted on, so it stops being owed.
    resealed = false;
    const returning = rememberedRev();
    localRev = returning;
    lastDigest = "";
    setStatus({ state: "live", name: who.email, message: "", at: 0 });
    await poll(returning > 0);
    // Re-keep rather than keep: this only writes where a record already says
    // the user asked to be remembered, and it has to, because the salt it was
    // derived under may not be the salt this one was. After the first pass
    // and never before: a mistyped passphrase must not overwrite a good
    // remembered key with one that opens nothing — the pass above is where a
    // wrong key surfaces, as `LOCKED`. A record discarded as stale is
    // deliberately *not* rewritten here — being sent back to the passphrase
    // once is the honest outcome of a re-seal elsewhere, and re-arming is the
    // switch the user already knows about.
    if (keyed && status.state !== "error" && (await storedKey()) !== null) await keep(keyed);
    listen(db);
  },

  /** A pass on demand, for the panel's own button. */
  async syncNow(): Promise<void> {
    await poll();
  },

  /** Whether this browser is holding a key for the signed-in user. The record
   *  is the switch, so this is the switch's state. */
  async remembering(): Promise<boolean> {
    const stored = await storedKey();
    return stored !== null && stored.user === userId;
  },

  /**
   * Keep the derived key on this device, or delete it.
   *
   * Off deletes now rather than stopping at the next launch: a user turning
   * this off is withdrawing the authority, and "it will not be used again"
   * is not what that gesture means while the key is still on the disk.
   */
  async remember(on: boolean): Promise<void> {
    if (!on) {
      await forget();
      return;
    }
    if (keyed) await keep(keyed);
  },

  /**
   * Stop, and forget everything but the calendar.
   *
   * Signing out is what "off" means here: the session is the whole of the
   * opt-in, so leaving one behind would have the next launch offering to
   * resume a link the user just let go of — `mirror.declined`'s lesson in
   * `mac/main.swift`, one transport over. The row is left exactly as it is;
   * deleting a user's other machines' calendar is not what a disconnect on
   * this machine means. `deleteCopy` is the other intention, and it is a
   * separate press for exactly that reason.
   */
  async disconnect(): Promise<void> {
    const db = client;
    const wasLive = status.state !== "off";
    await quiesce(db);
    await release(db);
    // The one-live-copy rule makes this switch silent structurally — nothing
    // else changes on screen — so the moment a copy stops being written is
    // said out loud. The Batoni lesson: a write into a copy nobody reads
    // looks exactly like a write that worked.
    if (wasLive) notify("Signed out. The cloud copy stops updating; edits stay in this browser");
  },

  /**
   * Take the data back off the server.
   *
   * **The row is the whole of the user's data, and it is all this can reach.**
   * Deleting the auth user needs the service key, which cannot be in a browser
   * and would want the server component `SYNC.md` rules out, so what survives
   * is an email address in an auth table with nothing attached to it. The panel
   * says so; a button that implied account erasure would be lying about which
   * of those two things it did.
   *
   * The `DELETE` is scoped by `user_id` and the `own_document` policy is
   * `for all` over `user_id = auth.uid()`, so the row is the only one this
   * request can reach even if the filter were wrong.
   *
   * **The order is the feature.** `cloudPlan` answers a missing row with
   * `write` — correctly, since an empty slot is the state a first link is in —
   * so any pass that runs after the delete puts the calendar straight back, and
   * the user's press would have achieved nothing. Every writer here guards on
   * `vault`, so `quiesce` nulling it is what disarms the settle timer, the
   * poll, the socket callback and the visibility tick in one move; `hush`
   * closes the socket so the delete is not delivered back as a change; and
   * `await writing` lets anything already past its own guard land *before* the
   * row goes rather than after. Only then the delete, and only then the
   * sign-out — which also clears `REV_KEY`, or a later session would start at
   * a revision it remembers, read the empty slot and refill it.
   *
   * **A failed delete stands the link down too, and that is the interesting
   * decision.** The first version restored the vault and re-listened, on the
   * reasoning that nothing was deleted so nothing should change — and driving it
   * showed what that costs. A `DELETE` can commit on the server and still fail
   * on the way back, and a restored link answers the very next pass by finding
   * an empty slot and *refilling it*: measured, `DELETE` then `GET GET POST`,
   * the calendar back on the server at a fresh revision seconds after somebody
   * asked for it to be gone. So the ambiguous case decides this branch, because
   * it is the only one where the two behaviours differ and it is the one that
   * matters: never put back what a person asked to remove. A clear failure
   * costs them a sign-in they did not need, which is an annoyance; the other
   * way round costs them the thing they pressed the button for.
   */
  async deleteCopy(): Promise<void> {
    const db = client;
    if (!db || !userId) return;
    await quiesce(db);

    const { error } = await db.from("documents").delete().eq("user_id", userId);
    await release(db);
    if (error) {
      fail(UNSURE);
      return;
    }
    notify("Cloud copy deleted. This browser's calendar is untouched");
  },
};

/**
 * Come back live on a key this browser kept, or answer `false` and let the
 * caller ask for the passphrase.
 *
 * The row is fetched before the key is trusted, and only to read its salt:
 * `cloudResume` decides whether the box this key was cut for is the box that is
 * there. A network failure answers `false` rather than throwing, because a
 * passphrase prompt is a working link's worst case and an error screen is not.
 *
 * The stale branch answers `false` like every other refusal and leaves the
 * sentence to `resealed`, so there is exactly one place that sets `prompt`.
 * Setting it here as well cost the explanation the first time this was driven:
 * `startCloud` runs from a `useEffect`, StrictMode mounts twice, and the second
 * pass found the record already discarded, took the ordinary `false` branch and
 * wrote the generic sentence over it. Any remount does that, not only
 * StrictMode.
 *
 * The tail is `unlock`'s, deliberately identical — remembering a key changes
 * how the key arrives and nothing about what happens next.
 */
async function resume(db: SupabaseClient, who: Account): Promise<boolean> {
  const stored = await storedKey();
  if (!stored) return false;
  if (stored.user !== who.id) {
    // Somebody else is signed in now. Not ours to keep, and not ours to use.
    await forget();
    return false;
  }

  let found: CloudRow | null;
  try {
    found = await fetchRow(db);
  } catch {
    return false;
  }

  if (cloudResume(stored.salt, found?.payload ?? null) === "stale") {
    await forget();
    resealed = true;
    return false;
  }

  keyed = { key: stored.key, salt: stored.salt };
  vault = vaultOf(keyed);
  const returning = rememberedRev();
  localRev = returning;
  lastDigest = "";
  setStatus({ state: "live", name: who.email, message: "", at: 0 });
  await poll(returning > 0);
  listen(db);
  return true;
}

/* -------------------------------- lifetime -------------------------------- */

/**
 * Called once from the island root, and the first thing it does is answer
 * "is this configured at all" — an unconfigured build takes the branch that
 * fetches nothing, subscribes to nothing and leaves the status `off`, so the
 * feature is absent rather than broken.
 *
 * A remembered session restores to `prompt` unless this browser is holding a
 * key, which is the one thing that can carry a reload: the passphrase is
 * stored nowhere and deriving it needs the person. That `prompt` is the same
 * one the file half shows for a lapsed permission — the state that means a
 * gesture is what this link is waiting for.
 */
export function startCloud(): () => void {
  if (!cloudSupported()) return () => {};

  let live = true;
  let watching: { unsubscribe: () => void } | null = null;
  void connected()
    .then(async (db) => {
      if (!db || !live) return;
      // The session's own lifecycle. Supabase emits `SIGNED_OUT` when a token
      // refresh finally fails as well as on a sign-out, and a link left
      // `live` over a dead session answers every pass with an auth error
      // whose "Try again" cannot succeed. Standing down is idempotent — our
      // own `release` clears `userId` before it signs out, so the echo of a
      // deliberate disconnect finds nothing to do. The remembered key stays:
      // it is passphrase authority, not session authority, and the next
      // signed-in launch resumes on it.
      watching = db.auth.onAuthStateChange((event) => {
        if (event !== "SIGNED_OUT" || !userId) return;
        void (async () => {
          await quiesce(client);
          keyed = null;
          userId = "";
          localRev = 0;
          lastDigest = "";
          setStatus(OFF);
          notify("Cloud sync signed out. The session expired; sign in again to resume");
        })();
      }).data.subscription;
      const who = await account(db);
      if (!who || !live) return;
      userId = who.id;
      if (await resume(db, who)) return;
      if (!live) return;
      setStatus({
        state: "prompt",
        name: who.email,
        at: 0,
        message: resealed ? RESEALED : "Enter your passphrase to open the cloud copy",
      });
    })
    .catch(() => setStatus(OFF));

  const unsubscribe = subscribe(onStoreChange);

  // A tab coming back may have missed rows while its socket was suspended.
  const tick = () => {
    if (document.visibilityState === "visible" && vault) void poll();
  };
  document.addEventListener("visibilitychange", tick);

  return () => {
    live = false;
    unsubscribe();
    document.removeEventListener("visibilitychange", tick);
    stopPolling();
    clearTimeout(settleTimer);
    watching?.unsubscribe();
    // The socket does not survive the shell: a leaked channel keeps firing
    // polls for a component that is gone, and a remount subscribes its own.
    if (client && channel) {
      void client.removeChannel(channel);
      channel = null;
      subscribed = false;
    }
  };
}
