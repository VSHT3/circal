/* ------------------------------------------------------------------ *
 * Two whole documents into one.
 *
 * The mirror file already replicates a calendar and already has a
 * compare-and-swap over it, and until this module existed the loser of a
 * disagreement lost its whole document: the laptop edits on Tuesday, the PC
 * on Wednesday, and whichever opens second adopts the other's copy and
 * discards its own day. The undo step landed on the machine that lost, which
 * is the machine nobody is sitting at.
 *
 * What made that unavoidable was `applyRemove`: it filtered an event out and
 * left nothing behind, so given two documents that disagree about an id there
 * was no way to tell *deleted here* from *not seen here*, and a merge by id
 * resurrects every deletion. `Grave` is the missing half; this is the other.
 *
 * `mutate.ts`'s tier: pure over lists, imports `./events` and nothing else.
 * `store.ts` and `mirror.ts`/`mirrorLink.ts` both call it, which is what stops
 * "what does a conflict mean" from having two answers — the same argument that
 * put the five scope reducers in one file rather than two.
 *
 * `Settings` is a type parameter rather than an import for that reason: it
 * lives in `store.ts`, which sits *above* this tier, and a merge does not need
 * to know one field of it. Whole-object last-writer-wins under `settingsAt` is
 * the whole rule.
 * ------------------------------------------------------------------ */

import { GRAVE_MAX, GRAVE_TTL, type CalEvent, type Calendar, type Grave } from "./events";

/** The three lists a merge is about. `feeds` is deliberately absent: it is a
 *  read model assembled from the `circal.feed.*` keys, the one `Snapshot`
 *  field `write()` never serialises, and each machine pulls its own. */
export interface Records {
  events: CalEvent[];
  calendars: Calendar[];
  graves: Grave[];
}

export interface Mergeable<S = unknown> extends Records {
  settings: S;
  /** Epoch ms of the last settings change; `0` predates stamping. */
  settingsAt: number;
}

/**
 * A value as a string that two machines cannot disagree about.
 *
 * `JSON.stringify` walks a record in *insertion* order, so the same event
 * built by a spread in `mutate.ts` and rebuilt field by field by
 * `backup.readEvent` serialise differently while being the same event. Keys
 * are sorted at every depth to take that out; arrays keep their order, which
 * is data here — `attendees`, `exdates` and `byDay` all mean something by it.
 *
 * Exported because it is the tie-break's whole definition, and a tie-break
 * two builds spell differently is worse than none.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = sorted(record[key]);
  return out;
}

/**
 * Whether a document carries stamps at all — a settings stamp, or any record
 * or grave with a real instant on it.
 *
 * It read `settingsAt > 0` alone, and that was measured wrong on the real
 * transport: two fresh installs signed into one account are both unstamped, so
 * neither may merge, so each adopts the other's document whole — and adopting
 * an unstamped document leaves you unstamped, so they never grow out of it. A
 * user's first edit on their new laptop was adopted away by the machine that
 * synced next, which is exactly what somebody sets up a second machine to
 * avoid. Recoverable (`store.adopt` records an undo step and toasts) and still
 * not shippable.
 *
 * What the predicate is protecting is **demo data, not settings**, which is
 * what its own name says and what `freshInstall()` meant by withholding the
 * stamp: `seed()`'s events, `DEFAULT_CALENDARS` and `duplicateOf` all carry
 * `updatedAt: 0` on purpose, so a browser holding nothing but its demo day
 * still answers `false` here and still cannot win a merge or publish eight
 * events nobody wrote. The moment one real thing happens — an event created, a
 * calendar added, a deletion buried, a setting changed — the document is
 * stamped and merging begins, which is the earliest instant at which there is
 * anything to defend.
 *
 * A pre-Phase-0 blob is unchanged: every record in it reads `0` through
 * `hydrateEvents`' fill-in, `settingsAt` is `0`, so it is still a document the
 * merge declines rather than one whose every event loses.
 */
export function stamped(document: Records & Pick<Mergeable, "settingsAt">): boolean {
  if (document.settingsAt > 0) return true;
  return (
    document.events.some((e) => e.updatedAt > 0) ||
    document.calendars.some((c) => c.updatedAt > 0) ||
    // A grave is a stamp: it is the record of a deletion, and the machine that
    // made it must be able to merge rather than adopt, or the deletion is the
    // thing that gets adopted away.
    document.graves.some((g) => g.at > 0)
  );
}

/**
 * Graves united, expired ones dropped, and the list bounded.
 *
 * Called by every merge and by the store on hydrate, so the two cannot
 * disagree about how long a deletion is remembered. Later instant wins for
 * one id: a delete-resurrect-delete is one grave carrying the last of them.
 */
export function pruneGraves(graves: Grave[], now: number): Grave[] {
  const latest = new Map<string, number>();
  for (const grave of graves) {
    if (now - grave.at > GRAVE_TTL) continue;
    latest.set(grave.id, Math.max(latest.get(grave.id) ?? 0, grave.at));
  }
  return [...latest]
    .map(([id, at]) => ({ id, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, GRAVE_MAX);
}

/** A record without its own stamp, canonically — what "the same record" means
 *  when the only difference is when it was last written. */
function body(record: CalEvent | Calendar): string {
  const { updatedAt: _stamp, ...rest } = record;
  return canonicalJson(rest);
}

/**
 * Which of two copies of one record survives.
 *
 * Greater `updatedAt` wins. Equal stamps are broken on the canonical
 * serialisation, keeping the lexicographically smaller — and the reason it is
 * not `SYNC.md`'s "the lower id wins" is worth stating, because a reader will
 * otherwise correct it back: this merge is a union *by id*, so both candidates
 * for a slot have the same id by construction and there is no tie there to
 * break. The content is the only thing left that both machines can compare
 * without talking, which is the property that matters — two devices editing
 * one event in the same millisecond is not a case worth a vector clock, but it
 * is very much a case worth converging on.
 */
function later<T extends CalEvent | Calendar>(mine: T, theirs: T): T {
  if (mine.updatedAt !== theirs.updatedAt) return mine.updatedAt > theirs.updatedAt ? mine : theirs;
  return canonicalJson(mine) <= canonicalJson(theirs) ? mine : theirs;
}

/**
 * Union by id, in id order.
 *
 * The order is part of the contract rather than an implementation detail: two
 * machines have to reach the *same* document, and the only key both of them
 * agree on is the id. Insertion order would make `merge(a, b)` and
 * `merge(b, a)` two arrays of the same events, which is a difference the
 * mirror file would then write back and forth for ever.
 */
function unite<T extends CalEvent | Calendar>(mine: T[], theirs: T[]): T[] {
  const byId = new Map<string, T>();
  for (const record of mine) byId.set(record.id, record);
  for (const record of theirs) {
    const seen = byId.get(record.id);
    byId.set(record.id, seen ? later(seen, record) : record);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Two documents into one, element-wise, so the result is the same whichever
 * way round the arguments come and merging a document with itself changes
 * nothing. Both are tests rather than remarks: they are what make a merge safe
 * to run on every poll instead of once at a handshake.
 *
 * The rules, in order:
 *
 * 1. Union by id, across `events` and `calendars` independently.
 * 2. A grave wins over a record when `grave.at > record.updatedAt`. Otherwise
 *    the record survives and the grave is discarded — an event edited after it
 *    was deleted elsewhere is a resurrection the *user* performed, which is a
 *    different thing from one a merge invented.
 * 3. Greater `updatedAt` wins; equal stamps break on the canonical form.
 * 4. Graves union, then prune past `GRAVE_TTL` measured from `now`.
 * 5. Settings are whole-object under the greater `settingsAt`. Nobody would
 *    recognise a per-field merge of them: a dial half in one machine's
 *    preferences is a dial neither person chose.
 * 6. `feeds` never merges, which is why it is not in `Records` at all.
 *
 * It does **not** ask whether the two documents may be merged. That is
 * `stamped` plus the caller's own version gate (`mirrorMerges`), because the
 * envelope version lives one tier up.
 */
export function mergeDocuments<S>(
  mine: Mergeable<S>,
  theirs: Mergeable<S>,
  now: number,
): Mergeable<S> {
  const graves = pruneGraves([...mine.graves, ...theirs.graves], now);
  const buried = new Map(graves.map((grave) => [grave.id, grave.at]));
  const alive = (record: CalEvent | Calendar) =>
    (buried.get(record.id) ?? -Infinity) <= record.updatedAt;

  const events = unite(mine.events, theirs.events).filter(alive);
  const calendars = unite(mine.calendars, theirs.calendars).filter(alive);
  const survived = new Set([...events, ...calendars].map((record) => record.id));

  return {
    events,
    calendars,
    graves: graves.filter((grave) => !survived.has(grave.id)),
    // Equal stamps take the same tie-break the records take, for the same
    // reason: without it two machines that changed a setting in one
    // millisecond would each keep their own and write over each other for ever.
    settings:
      mine.settingsAt === theirs.settingsAt
        ? canonicalJson(mine.settings) <= canonicalJson(theirs.settings)
          ? mine.settings
          : theirs.settings
        : mine.settingsAt > theirs.settingsAt
          ? mine.settings
          : theirs.settings,
    settingsAt: Math.max(mine.settingsAt, theirs.settingsAt),
  };
}

/**
 * `next` as a fresh mutation: everything it changes stamped at `now`, and a
 * grave for everything it takes away.
 *
 * This is what an undo owes the merge, and `SYNC.md` does not mention it —
 * which was a real hole in the plan. `undo`, `redo` and `restore` put back a
 * recorded copy of the event list carrying its *old* stamps, so on the next
 * merge the other machine's newer stamps win and the undo silently reverts,
 * with nothing on screen to say so. An undo is a change the user just made, so
 * it is stamped like one, and undoing a creation buries the id rather than
 * merely dropping it.
 *
 * `store.adopt` deliberately does **not** come through here, and the asymmetry
 * is the point: adopt takes a document from outside this browser (a merge, or
 * an agent's write), and restamping it would make the adopting machine's copy
 * win every subsequent merge wholesale — the exact bug this work exists to
 * fix, wearing a different hat. `restore` does come through here, because a
 * user importing a backup file has asked for that file to win.
 *
 * Records are compared by content rather than by reference: an undo step and
 * the live snapshot hold the same objects only until another tab writes and
 * the blob is re-hydrated, and after that a reference test would restamp the
 * whole document.
 */
export function restamped(next: Records, current: Records, now: number): Records {
  const before = new Map<string, string>();
  for (const record of [...current.events, ...current.calendars]) {
    before.set(record.id, body(record));
  }
  const held = new Set([...next.events, ...next.calendars].map((record) => record.id));
  const gone = [...current.events, ...current.calendars].filter((record) => !held.has(record.id));

  return {
    events: next.events.map((e) => (before.get(e.id) === body(e) ? e : { ...e, updatedAt: now })),
    calendars: next.calendars.map((c) =>
      before.get(c.id) === body(c) ? c : { ...c, updatedAt: now },
    ),
    // Graves are never wound back, and both sides' are kept: a deletion is a
    // thing that happened, and undoing one is answered by the stamp above
    // outrunning the grave rather than by forgetting it. Dropping them here
    // would let the *other* machine's copy of a deletion come back as an
    // event on the next merge. `next`'s own are in there for `restore`, whose
    // `next` is a backup file carrying deletions this browser never saw.
    graves: [...current.graves, ...next.graves, ...gone.map((r) => ({ id: r.id, at: now }))],
  };
}
