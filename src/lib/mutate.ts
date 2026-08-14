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
 * calling `newId` itself.
 * ------------------------------------------------------------------ */

import { toggleDoneKey, type CalEvent } from "./events";
import { keyToInstant, splitRule } from "./recur";

/** Patches one event; every other event is the same object, untouched. */
export function applyUpdate(events: CalEvent[], id: string, patch: Partial<CalEvent>): CalEvent[] {
  return events.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

/**
 * Ticks one occurrence of a task off, or back on. By occurrence, not by
 * event: a weekly task ticked this Monday is not ticked every Monday, and
 * `doneKeys` is the list that says which.
 */
export function applyToggleDone(events: CalEvent[], id: string, at: Date | number): CalEvent[] {
  return events.map((e) => (e.id === id ? { ...e, doneKeys: toggleDoneKey(e.doneKeys, at) } : e));
}

/**
 * The event and every override that detached from it — deleting a series
 * cannot leave its exceptions behind, because an orphaned override is an
 * ordinary event on the day it replaced, with nothing left to explain it and
 * no surface that can find it.
 */
export function applyRemove(events: CalEvent[], id: string): CalEvent[] {
  return events.filter((e) => e.id !== id && e.seriesId !== id);
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
): { events: CalEvent[]; created: CalEvent | null } {
  const original = events.find((e) => e.id === id);
  if (!original) return { events, created: null };
  const split = splitRule(original, original.start, at);
  const created: CalEvent = { ...tail, ...split.tail, seriesId: "", seriesKey: "", id: mintId() };
  const seed = new Date(original.start);
  const detached = (e: CalEvent) =>
    e.seriesId === id && (keyToInstant(e.seriesKey, seed) ?? -Infinity) >= at;
  return {
    events: [
      ...events.map((e) =>
        e.id === id ? { ...e, ...split.head } : detached(e) ? { ...e, seriesId: created.id } : e,
      ),
      created,
    ],
    created,
  };
}

/** "Delete this and all future events": the same cut with nothing on the far
 *  side of it, so the overrides past it go rather than move. Events unchanged
 *  when `id` is not there. */
export function applyTruncate(events: CalEvent[], id: string, at: number): CalEvent[] {
  const original = events.find((e) => e.id === id);
  if (!original) return events;
  const split = splitRule(original, original.start, at);
  const seed = new Date(original.start);
  return events
    .filter((e) => !(e.seriesId === id && (keyToInstant(e.seriesKey, seed) ?? -Infinity) >= at))
    .map((e) => (e.id === id ? { ...e, ...split.head } : e));
}
