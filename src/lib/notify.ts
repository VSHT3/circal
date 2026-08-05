/* ------------------------------------------------------------------ *
 * Transient notices.
 *
 * Its own tiny external store rather than a field on the snapshot: the
 * snapshot is serialised to localStorage on every mutation, and a message
 * that is true for four seconds has no business being persisted. It is also
 * what `store.commit` reaches for when a write *fails* — a store that cannot
 * announce its own failure is how you lose a day's events silently.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";

export type NoticeTone = "info" | "error";

export interface Notice {
  /** Bumped per notice so the same text twice still re-animates. */
  seq: number;
  text: string;
  tone: NoticeTone;
}

let current: Notice | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** One at a time. A second notice replaces the first rather than stacking —
 *  this app has one modal surface and nothing here is worth a queue. */
export function notify(text: string, tone: NoticeTone = "info") {
  seq += 1;
  current = { seq, text, tone };
  emit();
}

export function dismissNotice() {
  if (!current) return;
  current = null;
  emit();
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
