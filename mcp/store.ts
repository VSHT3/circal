/* ------------------------------------------------------------------ *
 * The seam between the tool table and wherever the document lives.
 *
 * Two transports implement it: `fileStore` (mcp/file.ts) over the mirror
 * file on disk, and `cloudStore` (mcp/cloud.ts) over the one Supabase row
 * the browser's cloud sync writes. The tool table sees neither — it asks
 * for the document, mutates it whole, and hands it back, and everything
 * transport-specific (locks, CAS, sealing) stays behind this interface so
 * a third copy of a guard can never drift from the first two.
 * ------------------------------------------------------------------ */

import type { MirrorContents } from "@/lib/mirror";

/**
 * Everything a write carries — the whole document minus the envelope
 * (`rev`, `zone`, `version`), which is the transport's own business.
 * A mutation round-trips all five fields or silently drops what it
 * forgets; see `carried` in mcp/domain.ts for the measured version of
 * that warning.
 */
export type Mutated = Pick<
  MirrorContents,
  "events" | "calendars" | "settings" | "settingsAt" | "graves"
>;

export interface Loaded {
  contents: MirrorContents;
  warning: string | null;
}

export type Mutator<T> = (contents: MirrorContents) => { result: Mutated; summary: T };

export interface Store {
  /** The document for a read-only tool. Always answers, even across a zone
   *  mismatch — reading cannot put an event on the wrong day. */
  load(): Promise<Loaded>;
  /** Read → mutate → write, atomically for the transport's own meaning of
   *  the word, with `mutate` re-run against a fresh read whenever the
   *  document moved underneath. A `RefusalError` from `mutate` is never
   *  retried — it is a decision, not a concurrency problem. */
  write<T>(mutate: Mutator<T>): Promise<T>;
}
