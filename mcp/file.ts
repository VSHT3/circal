/* ------------------------------------------------------------------ *
 * The mirror file on disk: path resolution, atomic writes, and the
 * compare-and-swap loop every mutation goes through.
 *
 * The file may be the only copy of a year of somebody's calendar, so a
 * crash mid-write must never be able to truncate it (temp file plus
 * rename) and a second writer must never be able to land underneath
 * this one unnoticed (the `rev` check). Both rules live here, once, so
 * every tool in `tools.ts` gets them for free rather than each
 * re-deriving them.
 * ------------------------------------------------------------------ */

import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  MIRROR_VERSION,
  localZone,
  readMirrorFile,
  serialiseMirror,
  type MirrorContents,
} from "@/lib/mirror";

/**
 * Refused by design, not by accident: a zone mismatch, a subscription
 * calendar, a repeating event with no scope. Never retried by `casWrite` —
 * retrying would just ask the file the same untrue question again.
 */
export class RefusalError extends Error {}

/** What every tool needs to reach the file and to know whether an override
 *  has been granted — threaded through rather than read from `process` at
 *  every call site, so a test can hand over its own. */
export interface MirrorEnv {
  path: string;
  env: NodeJS.ProcessEnv;
}

/** `CIRCAL_FILE`, or `--file <path>` in argv — never a guessed default,
 *  because guessing wrong here means writing over the wrong year. */
export function resolveFilePath(argv: string[], env: NodeJS.ProcessEnv): string {
  const flagIndex = argv.indexOf("--file");
  const flagValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const path = flagValue || env.CIRCAL_FILE;
  if (!path) {
    throw new Error(
      "circal-mcp needs a mirror file to read and write. Set the CIRCAL_FILE environment " +
        "variable or pass --file <path> on the command line. Neither was given.",
    );
  }
  return path;
}

async function readMirror(path: string): Promise<MirrorContents> {
  const text = await readFile(path, "utf8");
  const contents = readMirrorFile(text);
  if (!contents) {
    throw new Error(`${path} is not a circal mirror file (or a circal .json backup).`);
  }
  return contents;
}

/**
 * Publish `body` at `path` so that no interruption can leave less than the
 * whole of it there: write a sibling temp file, force it to the disk, then
 * rename over the target. This file may be the only copy of the user's year.
 *
 * The `fsync` is the half that was missing, and its absence made the sentence
 * above only two-thirds true. A temp file plus a rename survives a crash of
 * *this process* — the rename is atomic, so a reader sees the old file or the
 * new one. It does not survive a power loss or a kernel panic: `writeFile`
 * returns once the bytes are in the page cache, and the rename is a metadata
 * operation that can reach the platter before they do, leaving the new name
 * pointing at a short or empty file where a complete one used to be.
 *
 * The directory sync is best-effort on purpose. Not every platform will open a
 * directory for it, and failing a write whose bytes are already durable
 * because a durability *nicety* was refused is the wrong way round — the same
 * trade `mirrorLink.ts` makes when remembering a handle fails after the
 * calendar is safely on disk.
 *
 * The temp file is removed if anything after its creation throws. A stray
 * `.circal-mcp-*.tmp` beside somebody's calendar is untidy rather than
 * dangerous, but it is litter this function made and should take away.
 */
async function atomicWrite(path: string, body: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.circal-mcp-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const file = await open(tmp, "w");
    try {
      await file.writeFile(body, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  try {
    const entry = await open(dir, "r");
    try {
      await entry.sync();
    } finally {
      await entry.close();
    }
  } catch {
    // Platform would not sync the directory. The file's own bytes are already
    // durable; only the new name's arrival is left to the filesystem.
  }
}

/** Whether the reader's own zone agrees with the file's. `null` when they do
 *  (or the file never said), so a caller can splice this straight into a
 *  response only when it is non-null. */
export function zoneWarning(contents: MirrorContents): string | null {
  const here = localZone();
  if (contents.zone === "" || contents.zone === here) return null;
  return (
    `Warning: this file was last written from ${contents.zone}, this server is running in ` +
    `${here}. Day boundaries may disagree.`
  );
}

/** Every day boundary in circal is local time, so a mismatched zone is not
 *  cosmetic: a write meant for "today" could land on the file's yesterday or
 *  tomorrow. Reads are let through with a warning; only a write is refused,
 *  and only unless the operator has said, by setting the env var, that they
 *  know what they are doing. */
function assertZoneAllowsMutation(contents: MirrorContents, env: NodeJS.ProcessEnv): void {
  const here = localZone();
  if (contents.zone === "" || contents.zone === here) return;
  if (env.CIRCAL_ALLOW_ZONE_MISMATCH === "1") return;
  throw new RefusalError(
    `Refusing to write: the file's zone (${contents.zone}) does not match this server's ` +
      `(${here}) — a write here could land on the wrong day there. Set ` +
      `CIRCAL_ALLOW_ZONE_MISMATCH=1 to write anyway.`,
  );
}

/**
 * Refuse to write a file whose envelope this build does not fully understand.
 *
 * A write here is never a patch — every mutation round-trips the whole
 * document through `readEvent`, which keeps the fields it has names for and
 * drops the rest. So an older reader writing a newer file is silent data loss
 * of exactly the fields it was too old to know about, and that is measured
 * rather than feared: a published bundle built before `free`, `remindLead`,
 * `organizer` and the guest pair landed dropped nine keys per document on
 * every write, and nothing anywhere said so.
 *
 * A read is still allowed, for `assertZoneAllowsMutation`'s reason: reading
 * cannot damage the file, and refusing to *look* at a calendar because its
 * envelope is one ahead would be worse than saying what is missing. There is
 * deliberately no override env var — a zone mismatch is something an operator
 * can reason about and be right, and "my reader is too old for this file" is
 * not.
 */
function assertVersionAllowsMutation(contents: MirrorContents): void {
  if (contents.version <= MIRROR_VERSION) return;
  throw new RefusalError(
    `Refusing to write: the file's format is version ${contents.version} and this server ` +
      `understands ${MIRROR_VERSION}. Writing it would drop every field this build has no ` +
      `name for. Rebuild circal-mcp from the matching source (pnpm build:mcp) and retry.`,
  );
}

/** Read the file for a read-only tool. Reads are always allowed, even across
 *  a zone mismatch — only a write can put an event on the wrong day. */
export async function loadForRead(
  ctx: MirrorEnv,
): Promise<{ contents: MirrorContents; warning: string | null }> {
  const contents = await readMirror(ctx.path);
  return { contents, warning: zoneWarning(contents) };
}

export type Mutated = Pick<MirrorContents, "events" | "calendars" | "settings">;

/**
 * Read → mutate → confirm the file has not moved → write `rev + 1`,
 * atomically. `mutate` runs against a fresh read every attempt, so a rev
 * mismatch really does redo the whole read-modify-write rather than
 * patching a stale result onto new data. One retry, then a refusal naming
 * both revisions — never a silent overwrite of whatever showed up in
 * between. A `RefusalError` thrown from `mutate` (a bad scope, a
 * subscription calendar, a zone mismatch) is not a concurrency problem and
 * is never retried.
 *
 * Exported as `casWrite` below, wrapped in the process-wide write queue —
 * this is the retry loop alone.
 */
async function casWriteOnce<T>(
  ctx: MirrorEnv,
  mutate: (contents: MirrorContents) => { result: Mutated; summary: T },
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await readMirror(ctx.path);
    assertVersionAllowsMutation(before);
    assertZoneAllowsMutation(before, ctx.env);
    const { result, summary } = mutate(before);
    const after = await readMirror(ctx.path);
    if (after.rev !== before.rev) {
      if (attempt === 1) {
        throw new Error(
          `The file moved under this write: read at rev ${before.rev}, still found rev ` +
            `${after.rev} after retrying once. Something else is writing it — try again.`,
        );
      }
      continue;
    }
    await atomicWrite(ctx.path, serialiseMirror(result, after.rev + 1, after.zone || localZone()));
    return summary;
  }
  // The loop above always returns or throws; this satisfies the compiler.
  throw new Error("unreachable");
}

/**
 * Every call this process makes, one at a time. `rev` only guards against a
 * writer *outside* this process — the browser tab across the same file —
 * and does nothing for two tool calls racing inside this one: both would
 * read the same `before`, neither would see the other's write yet at the
 * confirm-read, and the second write would silently bury the first. A
 * process-wide queue is the whole fix, and a cheap one: this server talks to
 * one file, so nothing is lost by making its own writes line up.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function casWrite<T>(
  ctx: MirrorEnv,
  mutate: (contents: MirrorContents) => { result: Mutated; summary: T },
): Promise<T> {
  const run = writeQueue.then(() => casWriteOnce(ctx, mutate));
  // Chained past its own rejection, so one failed write does not wedge every
  // write behind it — the queue's only job is ordering, not error handling.
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
