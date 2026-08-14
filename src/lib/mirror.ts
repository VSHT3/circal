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
import { localZone } from "./time";
import type { Calendar } from "./events";
import type { Snapshot } from "./store";

export { localZone };

/** Bumped only when the *file's* own envelope changes meaning. The events,
 *  calendars and settings inside it are versioned by the backup format. */
export const MIRROR_VERSION = 1;

/** What a snapshot contributes to the file — the three fields a backup carries. */
type Mirrored = Pick<Snapshot, "events" | "calendars" | "settings">;

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
 * The part of a snapshot the file is actually about, as a string.
 *
 * `baseSignature`'s trick, for the same job one layer out: it lets the writer
 * tell "the calendar changed" from "the clock ticked and a feed re-pulled",
 * and skip a write for the second. Excludes `exportedAt` and `rev`, which
 * move on every write by construction and would make every comparison differ.
 */
export function mirrorDigest(s: Mirrored): string {
  return JSON.stringify([s.events, settled(s.calendars), s.settings]);
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
    rev: typeof envelope.rev === "number" && Number.isFinite(envelope.rev) ? envelope.rev : 0,
    // A plain `.json` backup has no zone. Absent means "written by something
    // that did not say", which the reader treats as agreeing with it — the
    // alternative is refusing to open every backup ever exported.
    zone: typeof envelope.zone === "string" ? envelope.zone : "",
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
