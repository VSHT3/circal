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
import { mergeDocuments, type Mergeable } from "./merge";
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
import { UnreadablePayload, WrongPassphrase, unlock as unlockVault, type Vault } from "./vault";
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
 * `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`, or `null`.
 *
 * `null` means the feature is **absent**, not broken: nothing fetches, nothing
 * renders, no error is reported, and a fork or a self-hoster who never sets
 * them gets the app they had before this file existed. `SYNC.md` opens Phase 2
 * with "the app must be byte-identical for somebody who never signs in", and
 * somebody who never configured it is the same person a step earlier.
 *
 * The anon key belongs in the client bundle and is not a leaked secret: it
 * names the project and carries the `anon` role, and row level security is
 * what keeps one user's row out of another's reach (see the migration). Hiding
 * it would need a Worker route to proxy through, which is the one thing this
 * app refuses to grow. Do not "fix" this by moving it server-side.
 */
function config(): CloudConfig | null {
  const { PUBLIC_SUPABASE_URL: url, PUBLIC_SUPABASE_ANON_KEY: key } = import.meta.env;
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
 * `detectSessionInUrl: false` because auth here is a six-digit code, never a
 * magic link: nothing arrives in the URL, and this app already reads `?d=` and
 * `?v=` from it (`App.tsx`'s `go`), so a client that rewrites the location on
 * load is a client that can lose the day the user was looking at.
 */
async function connected(): Promise<SupabaseClient | null> {
  const settings = config();
  if (!settings) return null;
  if (client) return client;
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(settings.url, settings.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
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
  | { do: "write"; rev: number }
  | { do: "open"; row: CloudRow }
  | { do: "stop"; message: string };

export function cloudPlan(found: CloudRow | null, localRev: number, zone: string): CloudPlan {
  // Nothing there. Not "somebody deleted it", not "we are ahead" — an empty
  // slot, which the next write fills, the same non-event as the empty file the
  // picker has just made.
  if (!found) return { do: "write", rev: localRev + 1 };

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
 * `merging: false` is the first link of a browser that has never synced, and
 * it keeps `connect`'s promise on this transport too: a row that already holds
 * a calendar is *adopted*. The gesture is a person signing in, not a person
 * publishing what this browser happens to hold — on a browser still on its
 * seed day with one setting changed, that would push eight demo events to
 * every machine on the account.
 */
export type CloudTake =
  | { take: "merge"; document: MirrorContents; changed: boolean }
  | { take: "adopt"; document: MirrorContents }
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

  if (!merging || !mirrorMerges(contents, mine)) return { take: "adopt", document: contents };

  const document: MirrorContents = { ...contents, ...mergeDocuments(mine, contents, now) };
  return { take: "merge", document, changed: mirrorDigest(document) !== mirrorDigest(contents) };
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

let vault: Vault | null = null;
let userId = "";
let localRev = 0;
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
  rememberRev();
  setStatus({ state: "live", message: "", at: Date.now() });
  notify("Calendar updated from the cloud copy — ⌘Z to undo");
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
  const plan = cloudPlan(found, localRev, localZone());

  if (plan.do === "stop") {
    fail(plan.message);
    return null;
  }
  if (plan.do === "keep") return { rev: localRev + 1, expected: found?.rev ?? null };
  if (plan.do === "write") return { rev: plan.rev, expected: found?.rev ?? null };

  // Ahead of us, so it has to be opened before it is replaced.
  const taken = await take(plan.row, true);
  if (taken.take === "stop") {
    fail(taken.message);
    return null;
  }
  await absorb(taken.document);
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
  if (!db || !userId || !vault) return;

  let found: CloudRow | null;
  try {
    found = await fetchRow(db);
  } catch (error: unknown) {
    fail(describe(error));
    return;
  }

  const plan = cloudPlan(found, localRev, localZone());
  if (plan.do === "stop") {
    fail(plan.message);
    return;
  }
  if (plan.do === "keep") {
    setStatus({ state: "live", message: "", at: Date.now() });
    return;
  }
  if (plan.do === "write") {
    await write();
    return;
  }

  const taken = await take(plan.row, merging);
  if (taken.take === "stop") {
    fail(taken.message);
    return;
  }
  await absorb(taken.document);
  // The merged document has to go back, or the other machine never learns what
  // this one was holding — and only when it differs from what is already
  // there, because a pass that answered every read with a write is the
  // permanent loop.
  if (taken.take === "merge" && taken.changed) await write();
}

/** The store moved. Write, unless what moved is not in the document. */
function onStoreChange() {
  if (!client || !userId || !vault || status.state === "error") return;
  if (mirrorDigest(store.snapshot()) === lastDigest) return;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => void write(), SETTLE_MS);
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
  channel = db
    .channel(`documents:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "documents", filter: `user_id=eq.${userId}` },
      () => void poll(),
    )
    .subscribe((state) => {
      if (state === "SUBSCRIBED") stopPolling();
      else startPolling();
    });
}

async function hush(db: SupabaseClient) {
  stopPolling();
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

export const cloud = {
  /**
   * Send a six-digit code to `email`.
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
      message: `A six-digit code is on its way to ${email}`,
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
      vault = await unlockVault(passphrase, found?.payload);
    } catch (error: unknown) {
      // `unlock` throws only on a payload it cannot parse; a wrong passphrase
      // is silent here and surfaces at the first `open`, which is `cloudTake`'s
      // `null` and the branch that refuses to write.
      fail(error instanceof UnreadablePayload ? LOCKED : describe(error));
      return;
    }

    const returning = rememberedRev();
    localRev = returning;
    lastDigest = "";
    setStatus({ state: "live", name: who.email, message: "", at: 0 });
    await poll(returning > 0);
    listen(db);
  },

  /** A pass on demand, for the panel's own button. */
  async syncNow(): Promise<void> {
    await poll();
  },

  /**
   * Stop, and forget everything but the calendar.
   *
   * Signing out is what "off" means here: the session is the whole of the
   * opt-in, so leaving one behind would have the next launch offering to
   * resume a link the user just let go of — `mirror.declined`'s lesson in
   * `mac/main.swift`, one transport over. The row is left exactly as it is;
   * deleting a user's other machines' calendar is not what a disconnect on
   * this machine means.
   */
  async disconnect(): Promise<void> {
    const db = client;
    clearTimeout(settleTimer);
    vault = null;
    userId = "";
    localRev = 0;
    lastDigest = "";
    try {
      localStorage.removeItem(REV_KEY);
    } catch {
      // Same trade as `rememberRev`: bookkeeping, never a failure.
    }
    if (db) {
      await hush(db);
      await db.auth.signOut();
    }
    setStatus(OFF);
  },
};

/* -------------------------------- lifetime -------------------------------- */

/**
 * Called once from the island root, and the first thing it does is answer
 * "is this configured at all" — an unconfigured build takes the branch that
 * fetches nothing, subscribes to nothing and leaves the status `off`, so the
 * feature is absent rather than broken.
 *
 * A remembered session restores to `prompt`, never to `live`: the passphrase
 * is not stored anywhere and deriving it needs the person. That is the same
 * `prompt` the file half shows for a lapsed permission — the state that means
 * a gesture is what this link is waiting for.
 */
export function startCloud(): () => void {
  if (!cloudSupported()) return () => {};

  let live = true;
  void connected()
    .then(async (db) => {
      if (!db || !live) return;
      const who = await account(db);
      if (!who || !live) return;
      userId = who.id;
      setStatus({
        state: "prompt",
        name: who.email,
        at: 0,
        message: "Enter your passphrase to open the cloud copy",
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
  };
}
