/* ------------------------------------------------------------------ *
 * The decision half of five `store` actions, pulled out as pure
 * functions over an event list.
 *
 * An MCP server writing to the same file the app mirrors to has to mean
 * exactly what the app means by "this occurrence", "this and all future"
 * and "the whole series" — the same three-way question `ScopePrompt.tsx`
 * asks one layer up, and the same one `recur.ts`'s `splitRule` is the one
 * validator for. Two copies of that question drift into two vocabularies
 * the moment either side changes; one copy, called from both, cannot.
 *
 * No store, no React, no DOM — nothing here reads or writes `localStorage`,
 * so `store.ts` stays the only place a mutation becomes persisted state.
 * Imports only `./events` and `./recur`: reaching for `./store` would be a
 * cycle, which is why `applySplit` takes `mintId` as a parameter instead of
 * calling `newId` itself — and why every reducer takes `now` rather than
 * reading the clock. A reducer is pure over its arguments, and the stamp a
 * merge reads later is one of its outputs, so it arrives the same way the
 * ids do.
 * ------------------------------------------------------------------ */

import { toggleDoneKey, type CalEvent, type Grave } from "./events";
import { keyToInstant, splitRule } from "./recur";

/**
 * The events that survived a removal, and the graves it left behind.
 *
 * Two returns rather than one because the two are not separable: a caller
 * that took the events and dropped the graves would have deleted an id with
 * nothing left to say so, which is the whole defect graves exist to close.
 */
export interface Removal {
  events: CalEvent[];
  graves: Grave[];
}

/** Patches one event; every other event is the same object, untouched. The
 *  patched one is stamped, so a merge can tell this copy from the one the
 *  other machine is holding. */
export function applyUpdate(
  events: CalEvent[],
  id: string,
  patch: Partial<CalEvent>,
  now: number,
): CalEvent[] {
  return events.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: now } : e));
}

/**
 * Ticks one occurrence of a task off, or back on. By occurrence, not by
 * event: a weekly task ticked this Monday is not ticked every Monday, and
 * `doneKeys` is the list that says which.
 */
export function applyToggleDone(
  events: CalEvent[],
  id: string,
  at: Date | number,
  now: number,
): CalEvent[] {
  return events.map((e) =>
    e.id === id ? { ...e, doneKeys: toggleDoneKey(e.doneKeys, at), updatedAt: now } : e,
  );
}

/**
 * The event and every override that detached from it — deleting a series
 * cannot leave its exceptions behind, because an orphaned override is an
 * ordinary event on the day it replaced, with nothing left to explain it and
 * no surface that can find it.
 *
 * The graves cover exactly the set that was filtered, and that identity is
 * the point: a grave for the series alone lets a merge bring an orphaned
 * override back as an ordinary event on the day it used to replace, which is
 * precisely the state the paragraph above exists to prevent.
 */
export function applyRemove(events: CalEvent[], id: string, now: number): Removal {
  const buried = events.filter((e) => e.id === id || e.seriesId === id);
  return {
    events: events.filter((e) => e.id !== id && e.seriesId !== id),
    graves: buried.map((e) => ({ id: e.id, at: now })),
  };
}

/**
 * "This and all future events": the series stops the instant before `at` and
 * a new one starts there carrying `tail`. `created` is `null` when `id` is
 * not there — the caller must not commit in that case, the same as the
 * current `splitSeries` returning `null` and writing nothing.
 *
 * An override past the cut is re-pointed at the new series rather than
 * dropped. Its `seriesKey` still names the instant it replaces; leaving it on
 * the head means nothing suppresses that occurrence any more, so the day
 * shows the override *and* the new series' own arc.
 */
export function applySplit(
  events: CalEvent[],
  id: string,
  at: number,
  tail: Omit<CalEvent, "id">,
  mintId: () => string,
  now: number,
): { events: CalEvent[]; created: CalEvent | null } {
  const original = events.find((e) => e.id === id);
  if (!original) return { events, created: null };
  const split = splitRule(original, original.start, at);
  const created: CalEvent = {
    ...tail,
    ...split.tail,
    seriesId: "",
    seriesKey: "",
    id: mintId(),
    updatedAt: now,
  };
  const seed = new Date(original.start);
  const detached = (e: CalEvent) =>
    e.seriesId === id && (keyToInstant(e.seriesKey, seed) ?? -Infinity) >= at;
  return {
    events: [
      // The head, the tail and every re-pointed override are the three things
      // this touches, so they are the three it stamps. An override before the
      // cut is handed back as the same object and keeps the stamp it had.
      ...events.map((e) =>
        e.id === id
          ? { ...e, ...split.head, updatedAt: now }
          : detached(e)
            ? { ...e, seriesId: created.id, updatedAt: now }
            : e,
      ),
      created,
    ],
    created,
  };
}

/** "Delete this and all future events": the same cut with nothing on the far
 *  side of it, so the overrides past it go rather than move — and are graved,
 *  since an override this drops is a record the other machine still has.
 *  Nothing changes and nothing is buried when `id` is not there. */
export function applyTruncate(events: CalEvent[], id: string, at: number, now: number): Removal {
  const original = events.find((e) => e.id === id);
  if (!original) return { events, graves: [] };
  const split = splitRule(original, original.start, at);
  const seed = new Date(original.start);
  const past = (e: CalEvent) =>
    e.seriesId === id && (keyToInstant(e.seriesKey, seed) ?? -Infinity) >= at;
  return {
    events: events
      .filter((e) => !past(e))
      .map((e) => (e.id === id ? { ...e, ...split.head, updatedAt: now } : e)),
    // Only what is past the cut: the head survives the truncation, so a grave
    // for it would delete the series a merge is meant to keep.
    graves: events.filter(past).map((e) => ({ id: e.id, at: now })),
  };
}
