/* ------------------------------------------------------------------ *
 * The mirror file: circal's store as a file on disk.
 *
 * One mechanism, two reasons to want it.
 *
 * The first is the one `AUDIT.md` has been asking for: `localStorage` is the
 * only copy of a user's calendar and "Clear site data" is one menu away with
 * no warning and no undo. A live `.json` in a folder the user picked is a
 * backup nobody has to remember to take.
 *
 * The second is that a file is the one interface something outside this
 * browser can hold. An assistant reading and writing this file can answer
 * about today and write next Tuesday without circal growing an account, a
 * sync service, or a second Worker route — and, because the file outlives the
 * tab, without the tab being open. A localhost bridge was the other candidate
 * and it fails exactly there.
 *
 * The format is deliberately not new: a mirror file **is** a `.json` backup,
 * with a zone and a revision on it. Same shape, same validators, so a mirror
 * can be handed to Import and a backup can be handed to the mirror, and there
 * is one answer to what a legal event is rather than two.
 * ------------------------------------------------------------------ */

import { readBackup } from "./backup";
import { canonicalJson, stamped, type Mergeable } from "./merge";
import { localZone } from "./time";
import type { Calendar } from "./events";
import type { Settings, Snapshot } from "./store";

export { localZone };

/** Bumped only when the *file's* own envelope changes meaning. The events,
 *  calendars and settings inside it are versioned by the backup format. */
export const MIRROR_VERSION = 2;

/**
 * What a snapshot contributes to the file — the same fields a backup carries.
 *
 * `graves` and `settingsAt` joined the three at `MIRROR_VERSION` 2, which is
 * what that number means: *every record in this document carries a stamp, and
 * deletions are tombstoned*. A file without them cannot be merged, only
 * adopted — see `mirrorMerges`.
 */
type Mirrored = Pick<Snapshot, "events" | "calendars" | "settings" | "settingsAt" | "graves">;

export interface MirrorFile extends Mirrored {
  app: "circal";
  version: number;
  exportedAt: string;
  /**
   * The IANA zone the writer was in.
   *
   * Not decoration: every day boundary in this app is deliberately local
   * (`dayKey`, `startOfDay`, the whole of `tests/west/`), so a reader in
   * another zone would put events on the wrong day and be perfectly confident
   * about it. Recorded so the reader can refuse rather than guess.
   */
  zone: string;
  /**
   * Monotonic, and the whole of the concurrency story. A writer reads the
   * file, checks this is still what it read, and writes `rev + 1`. A reader
   * that finds a `rev` it did not write knows somebody else did.
   */
  rev: number;
}

export interface MirrorContents extends Mirrored {
  rev: number;
  zone: string;
  /**
   * The envelope version the file claims, defaulting to this build's own when
   * it claims none — a plain `.json` backup handed to the mirror, which is a
   * case the format exists to allow.
   *
   * Read so a writer can refuse a file it does not fully understand. An older
   * reader round-tripping a newer file drops every field it has no name for,
   * silently, on a write it thought was a patch: that is measured rather than
   * feared — a stale published bundle lost nine keys per document that way.
   * Refusing is `assertZoneAllowsMutation`'s answer to the same shape of
   * question, one field over.
   */
  version: number;
}

/**
 * A subscription's pull state, zeroed.
 *
 * The same normalisation `exportBackup` does, for a sharper reason here: the
 * mirror writes on every store change, and a feed pull stamps `fetchedAt` on
 * its calendar. Left in, every subscription refresh would rewrite the file
 * and look to a watcher like the calendar having changed.
 */
function settled(calendars: Calendar[]): Calendar[] {
  return calendars.map((c) =>
    c.feed ? { ...c, feed: { ...c.feed, fetchedAt: 0, error: "" } } : c,
  );
}

/**
 * The records of one array in id order, for the digest and nothing else.
 *
 * The store keeps events in the order they were made (`create` appends) while
 * `mergeDocuments` unites them in **id** order, on purpose, so that two
 * machines reach the same array whichever way round they merge. Those two
 * orders are almost never the same one, and a digest that reads the
 * difference as a change makes the machine that wrote first see its own edit
 * come back as news — the array holds the same calendar either way. Array
 * order is no more part of this document than key order is.
 */
function ordered<T extends { id: string }>(records: T[]): T[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The part of a snapshot the file is actually about, as a string.
 *
 * `baseSignature`'s trick, for the same job one layer out: it lets the writer
 * tell "the calendar changed" from "the clock ticked and a feed re-pulled",
 * and skip a write for the second. Excludes `exportedAt` and `rev`, which
 * move on every write by construction and would make every comparison differ.
 */
export function mirrorDigest(s: Mirrored): string {
  // The graves and the settings stamp are in here because they are part of the
  // document a reader has to end up with: a merge that only changed them —
  // this machine learning about the other one's deletion — must still reach
  // the file. The cost is one extra write on the day a grave passes its TTL on
  // one machine before the other, which is what a ninety-day bound is worth.
  //
  // `canonicalJson` rather than `JSON.stringify`, and this one is measured: a
  // merged document holds records from both sides, and an event this browser
  // stored enumerates its keys in a different order from the same event
  // rebuilt by `readEvent` on the way out of the file. Insertion-order
  // stringify calls those two different, so the digest said "changed" for a
  // merge that changed nothing, both machines wrote back, and each read the
  // other's write as news — one write every poll, for ever. The digest's whole
  // claim is telling a real change from a re-read, and neither key order nor
  // record order is one.
  return canonicalJson([
    ordered(s.events),
    ordered(settled(s.calendars)),
    s.settings,
    s.settingsAt,
    ordered(s.graves),
  ]);
}

export function serialiseMirror(s: Mirrored, rev: number, zone = localZone()): string {
  const file: MirrorFile = {
    app: "circal",
    version: MIRROR_VERSION,
    exportedAt: new Date().toISOString(),
    zone,
    rev,
    events: s.events,
    calendars: settled(s.calendars),
    settings: s.settings,
    settingsAt: s.settingsAt,
    graves: s.graves,
  };
  // Indented, because this file is the one part of circal a human is expected
  // to be able to open, read and hand to something else.
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * A file's contents, validated, or `null` for anything that is not one.
 *
 * Everything inside goes through `readBackup`, which is the boundary that
 * already assumes hostile input — and an agent writing this file is exactly
 * that, however well meant. A malformed `rev` reads as `0` rather than
 * failing the file: the revision is this module's own bookkeeping, and losing
 * a calendar over it would be the wrong trade.
 */
export function readMirrorFile(text: string): MirrorContents | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const read = readBackup(parsed);
  if (!read.ok) return null;
  const envelope = parsed as Partial<MirrorFile>;
  return {
    events: read.events,
    calendars: read.calendars,
    settings: read.settings,
    // Both through `readBackup`, which is the boundary that already assumes
    // hostile input. A file that carries neither reads as a document that
    // predates stamping, and `mirrorMerges` declines to merge it.
    settingsAt: read.settingsAt,
    graves: read.graves,
    rev: typeof envelope.rev === "number" && Number.isFinite(envelope.rev) ? envelope.rev : 0,
    // A plain `.json` backup has no zone. Absent means "written by something
    // that did not say", which the reader treats as agreeing with it — the
    // alternative is refusing to open every backup ever exported.
    zone: typeof envelope.zone === "string" ? envelope.zone : "",
    // Absent reads as this build's own, for the reason `zone` does: a plain
    // `.json` backup handed to the mirror is a case the shared format exists
    // to allow, and refusing every export ever taken would be the wrong trade.
    version:
      typeof envelope.version === "number" && Number.isFinite(envelope.version)
        ? envelope.version
        : MIRROR_VERSION,
  };
}

/**
 * Whether two zones may be trusted to mean the same days. An empty zone is a
 * file that did not say (a hand-written one, or a backup predating the
 * field), and is taken at its word rather than refused.
 */
export function zonesAgree(fileZone: string, readerZone: string): boolean {
  return fileZone === "" || fileZone === readerZone;
}

/** What a reader should do about the revision it just found on disk. */
export type MirrorVerdict = "ours" | "adopt" | "stale";

/**
 * `ours` — this writer produced it, so adopting it would be a loop.
 * `adopt` — somebody else moved it on, so take what they wrote.
 * `stale` — the file is *behind* us: an older copy restored underneath the
 * tab, or a file recreated from scratch. The browser re-asserts rather than
 * adopting, because winding a calendar backwards is the one outcome nothing
 * undoes, and `localStorage` still holds the newer truth.
 */
export function mirrorVerdict(fileRev: number, localRev: number): MirrorVerdict {
  if (fileRev === localRev) return "ours";
  return fileRev > localRev ? "adopt" : "stale";
}

/**
 * Whether a file ahead of us may be *merged* rather than adopted whole. The
 * three-way gate, and it is what stops a regression:
 *
 * - **v2 file, v2 store** → merge. Both documents carry stamps, so the
 *   element-wise answer is available and it is strictly better than either
 *   document winning.
 * - **v1 file, or either side unstamped** → today's behaviour exactly:
 *   `mirrorVerdict`, adopt, stale, no merge. An unstamped document cannot be
 *   merged without guessing which of two undated copies of an event is newer,
 *   and adopting is the right answer for it — including the case that matters
 *   most, a browser holding nothing but its demo day. `stamped` is what
 *   answers that, and it asks about the records rather than only the settings
 *   stamp: two fresh installs that had each changed nothing adopted each other
 *   for ever, and the first real edit on either is the instant there is
 *   something to defend. See its own comment.
 * - **v2 file, v1 reader** → already refused, one layer over:
 *   `assertVersionAllowsMutation` exists for exactly this, because a reader
 *   that round-trips a document through validators it is too old for silently
 *   drops every field it has no name for.
 *
 * A plain `.json` backup handed to the mirror carries `BACKUP_VERSION`, which
 * is 1, so it adopts rather than merges. That is the conservative answer and
 * the correct one: a backup is a document somebody chose, not a peer.
 */
export function mirrorMerges(contents: MirrorContents, mine: Mergeable<Settings>): boolean {
  return contents.version >= MIRROR_VERSION && stamped(contents) && stamped(mine);
}
