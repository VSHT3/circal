# sync

What it would take for circal to hold one calendar on two machines without losing a day of work.

This supersedes `TODO.md`'s **"No accounts, and no second API route"** in one direction only, and the
argument there is still half right, so it is worth restating rather than deleting. That entry refuses
_a relay_: anonymous storage keyed by a memorable passphrase, which is offline-brute-forceable
against a stored ciphertext unless it runs a real PAKE. That refusal stands. What is proposed here is
not a relay — access is gated by an authenticated session, so the ciphertext is not fetchable by
anyone holding a guess, and the passphrase stops being the only thing between a stranger and a
calendar. If Phase 2 is accepted, that `TODO.md` entry needs editing to say which of the two it
still forbids.

Phases 0 and 1 need no account, no server and no network. They are worth doing on their own terms.

---

## The problem, precisely

circal already replicates. `src/lib/mirror.ts` is a whole-document format with a monotonic `rev`;
`src/lib/mirrorLink.ts` is a compare-and-swap writer over it. `claim()` re-reads the file
immediately before replacing it and answers with `Math.max(fileRev, localRev) + 1`, or hands over to
`absorb()` when the file is ahead. `mirrorVerdict` names the three outcomes: `ours`, `adopt`,
`stale`. Two machines pointed at one file in a synced folder is a working sync today, which is what
`TODO.md`'s "make the mirror file findable" item is about.

It is working sync with one defect, and `claim()`'s own comment states it:

> It abandons the write rather than merging, and that is a decision. There is no diff here, only two
> whole documents, so a merge would have to guess — and guessing by id resurrects anything deleted
> locally.

That trade is correct for one machine. The loser is a local edit, it is seconds old, and
`store.adopt` records an undo step and toasts. It is wrong across two machines: the laptop edits on
Tuesday, the PC on Wednesday, and whichever opens second adopts the other's whole document and
discards its own day. The undo step lands on the machine that lost, which is the machine nobody is
sitting at.

**The reason it cannot do better is `applyRemove`.** `src/lib/mutate.ts:42` filters the event and its
overrides out of the array. Nothing is left behind. So given two documents that disagree about an
id's existence, there is no way to tell _deleted here_ from _not yet seen here_, and any merge
by id resurrects every deletion — the same tombstone problem `duplicateOf` documents from the other
side when it refuses to carry `doneKeys`.

This is a model problem. It does not change if the transport is a file, a Postgres row, or a folder
somebody else syncs.

---

## Phase 0 — deletions leave a mark

No network. No new module dependencies outward. Three fields.

### `Grave`

```ts
/** An id that was deleted, and when. Kept so a merge can tell a deletion from
 *  an absence — see the note on `applyRemove` above. */
export interface Grave {
  id: string;
  at: number; // epoch ms
}
```

Graves live in **`Snapshot.graves`**, a sibling of `events`, and deliberately not as a `deletedAt`
field on `CalEvent`. A tombstone inside `events` would make every reader of that array wrong until
it learned to filter — `dayAgenda`, `occurrencesOn`, `lifeDensity`, `scoreEvent`, the palette, the
year ring's tallies, `mcp/domain.ts`. A sibling list means **no reader changes at all**: `events`
still holds exactly the events that exist. Only `store.ts`, `mutate.ts`, `backup.ts`, `mirror.ts` and
the new merge know graves exist.

### `updatedAt`

`CalEvent.updatedAt: number` and `Calendar.updatedAt: number`, epoch ms, stamped by `store.ts` on
every mutation that commits. It is a _field of the record_, so `mutate.ts`'s five reducers stamp what
they touch and nothing else:

| reducer           | stamps                                                     |
| ----------------- | ---------------------------------------------------------- |
| `applyUpdate`     | the patched event                                          |
| `applyToggleDone` | the ticked event                                           |
| `applyRemove`     | nothing — emits graves for the event **and** its overrides |
| `applySplit`      | the head, the minted tail, and every override it re-points |
| `applyTruncate`   | the head; graves for the overrides past the cut            |

`applyRemove` already filters `e.seriesId === id` alongside `e.id === id`; the graves it emits must
cover the same set, or a merge brings an orphaned override back as an ordinary event on the day it
used to replace — which is precisely the state that reducer's comment exists to prevent.

Settings do not merge field by field in any way a user would recognise, so they get one stamp:
**`Snapshot.settingsAt: number`**, and the whole object is last-writer-wins under it.

### Migration

No `SCHEMA` bump. A bump resets settings, and nothing stored changes _meaning_ — this is the
`hydrateEvents` fill-in precedent (`AGENTS.md`: "No `SCHEMA` bump: nothing stored changed meaning").
`hydrateEvents`' shape fast-path gains three questions; a blob predating the fields gets
`updatedAt = 0`, `graves = []`, `settingsAt = 0`.

`0` is honest and it is load-bearing: it means _this record predates stamping_, which is exactly what
the merge needs to know to decline to merge. See `MIRROR_VERSION` below. Stamping old records with
the migration time instead would make the machine that upgraded last win wholesale, which is the bug
being fixed wearing a different hat.

### Pruning

`GRAVE_TTL` = **90 days**. A grave older than that is dropped on hydrate. The consequence is stated
rather than hidden: **a machine offline longer than the TTL resurrects what it deleted.** Ninety days
is chosen against the alternative of unbounded growth in a ~5MB origin quota that `FEED_BUDGET`
already carves 2M characters out of. A grave is two fields, so a thousand deletions is a few tens of
kilobytes — the TTL is about the decade, not the year.

### Files touched

`src/lib/events.ts` (both interfaces, `Grave`), `src/lib/mutate.ts` (five reducers), `src/lib/store.ts`
(`Snapshot`, `Persisted`, `hydrate`, `commit`, `remove`, `removeCalendar`, `restore`, `adopt`,
`sane`), `src/lib/backup.ts` (`readEvent`, `readCalendar`, `readBackup`, `exportBackup`),
`src/lib/mirror.ts` (`Mirrored`, `mirrorDigest`), `mcp/domain.ts` (its patch path round-trips whole
documents, so a field it does not know is a field it silently drops — the `circal-mcp@0.1.0` lesson,
measured at nine keys).

---

## Phase 1 — the merge

New module **`src/lib/merge.ts`**, at `mutate.ts`'s tier: pure over event lists, imports `./events`
and nothing else. `store.ts` and `mirror.ts` both call it, which is what stops "what does a conflict
mean" from having two answers — the same argument that put the scope reducers in one file.

```ts
export function mergeDocuments(mine: Mergeable, theirs: Mergeable, now: number): Mergeable;
```

Rules, in order:

1. **Union by id**, across `events` and `calendars` independently.
2. **A grave wins over a record** when `grave.at > record.updatedAt`. Otherwise the record survives
   and the grave is discarded — an event edited after it was deleted elsewhere is a resurrection the
   user performed, which is different from one a merge invented.
3. **Greater `updatedAt` wins.** Equal stamps break on the lower `id`, so both machines reach the
   same answer without talking. Two devices genuinely editing one event in the same millisecond is
   not a case worth a vector clock.
4. **Graves union**, then prune past `GRAVE_TTL` measured from `now`.
5. **Settings**: whole-object, greater `settingsAt`.
6. **`feeds` never merges.** It is a read model assembled from `circal.feed.*` keys and is the one
   `Snapshot` field `write()` never serialises. Each machine pulls its own.

Merging is **element-wise, so it is commutative and idempotent** — `merge(a, b) === merge(b, a)`, and
`merge(a, a) === a`. Both are tests, not remarks: they are what make a merge safe to run on every
poll rather than once at a handshake.

### `MIRROR_VERSION` goes to 2

`2` means _every record in this document carries a stamp, and deletions are tombstoned_. The version
gate is what stops a regression:

- **v2 file, v2 store** → merge.
- **v1 file (or any document with `settingsAt === 0`)** → today's behaviour exactly. `mirrorVerdict`,
  `adopt`, `stale`, no merge. An unstamped document cannot be merged without guessing, and today's
  answer is the correct one for it.
- **v2 file, v1 reader** → already refused. `assertVersionAllowsMutation` exists for this, and its
  reason is the same: a reader that round-trips a document through validators it is too old for
  silently drops the fields it does not know.

### What this buys the mirror on its own

`claim()`'s "adopt, do not merge" branch becomes "merge, then write the merged document at
`max(fileRev, localRev) + 1`". Two machines on one synced folder stop being last-writer-wins, with
no account, no server, and no network. That is the whole of the sync most people asking for sync
actually want, and it is reachable from here.

`absorb()` keeps calling `store.adopt`, so a merge is still one undoable commit with a toast. The
merge cannot lose data the way an adopt could, but it can still surprise, and the undo step is what
makes a surprise recoverable.

### Tests

`tests/merge.test.ts` — new file, owns the module. Commutativity, idempotence, the grave-versus-edit
precedence in both directions, the tie-break, TTL pruning, and the v1 refusal. Table-driven with
`it.each` and `expect.soft`, per the suite's convention.

`tests/mutate.test.ts` gains the grave sets: a series deletion graves its overrides, a truncate
graves only what is past the cut.

`tests/mirror.test.ts` gains the version gate: a v1 file adopts, a v2 file merges, a v2 file in a
disagreeing zone is still refused before either.

**No `tests/west/` case.** Every comparison here is epoch-ms arithmetic — no `dayKey`, no
`startOfDay`, no `addDays`. That is worth stating because the standing rule is the opposite, and a
reader should be able to see the exemption was reasoned rather than forgotten.

---

## Phase 2 — the cloud copy, optional

Off unless signed in. The app must be byte-identical for somebody who never does.

### Why Supabase fits, in facts rather than preference

- **It adds no route.** `supabase-js` talks directly to `*.supabase.co`, so `/api/feed` remains the
  only route the Worker serves. `wrangler.jsonc` is untouched. The "second route = a different
  product" rule survives.
- **It adds no header work.** `worker/index.ts:49` ships `frame-ancestors`, `object-src` and
  `base-uri` and deliberately no `connect-src` — `feeds.ts` falls back to fetching a feed directly,
  which `connect-src 'self'` would forbid. There is nothing to widen. (`public/_headers` carries the
  same list and needs the same nothing.)
- **Postgres is the compare-and-swap.** `mirrorLink.ts` needed a `.lock` sibling on the server side
  and Web Locks on the browser side because a file has no atomic read-modify-write. A conditional
  `UPDATE` is one.

### Schema

```sql
create table documents (
  user_id    uuid primary key references auth.users on delete cascade,
  rev        integer     not null default 0,
  version    integer     not null,
  zone       text        not null default '',
  payload    text        not null,   -- ciphertext, base64url
  updated_at timestamptz not null default now()
);

alter table documents enable row level security;

create policy own_document on documents
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

One row per user, holding the same envelope `serialiseMirror` writes. The compare-and-swap is
`update documents set rev = $next, payload = $p, version = $v where user_id = auth.uid() and rev =
$expected`; zero rows affected means somebody moved it, which is `claim()`'s `adopt` branch by
another name.

`zone` stays outside the ciphertext, because `zonesAgree` has to be answerable before decrypting —
the same reason `rev` and `version` are in the envelope rather than the payload.

### Encrypted on the client

`payload` is AES-GCM ciphertext under a key derived from a passphrase the user sets once — PBKDF2-
SHA256, which WebCrypto has natively (Argon2id would want wasm, and this is not the PAKE case the
`TODO.md` entry refuses). The server holds a locked box and a row id. RLS stops being the only thing
between two users' calendars, and the obligation of holding strangers' medical appointments in
plaintext never arises.

Costs, both real: no server-side query capability, which nothing here wants; and a lost passphrase
loses the cloud copy, with `localStorage` and the mirror file still holding copies. Supabase Auth
still knows the email of everyone who signs in, and no client-side encryption changes that — it is
worth saying out loud in the UI rather than implying otherwise.

### `src/lib/cloudLink.ts`

`mirrorLink.ts`'s shape, one transport over: the same `MirrorState` (`off` / `prompt` / `live` /
`error`), the same `claim` → `absorb` → write cycle, the same `lastDigest` guard so a feed re-pull
does not cost a round trip, the same `SETTLE_MS` debounce. `POLL_MS` becomes a Realtime subscription
on the row, with a poll as the fallback when the socket is down.

`mirror.ts` stays the sole owner of the format. `serialiseMirror` and `readMirrorFile` are unchanged
— the payload _is_ the file's contents.

### Both links at once

With Phase 1 in place two links can run together, each keeping its own `rev` against its own
transport, and a merge on either side converges. The first cut should still be **one at a time**,
because two writers each debouncing at 400ms into a document the other is also merging is a state
worth reaching deliberately rather than by default. Revisit once Phase 1 has run in anger.

---

## Non-goals

- **No CRDT.** Per-record last-writer-wins is what a calendar's grain supports: two people do not
  co-edit the title of one meeting. A CRDT is a different product's data model and it does not
  survive the `.ics` round trip either way.
- **No per-field merge.** An event edited on two machines takes one machine's version whole. Merging
  a title from one and a time from the other manufactures a meeting neither person wrote.
- **No shared or multi-user calendars.** One user, several devices. Sharing needs an invitation
  channel, and `AGENTS.md` refuses that for the reason the invitation reader already documents:
  circal reads an invitation and cannot answer one.
- **No server-side calendar logic.** Nothing in `src/lib/` moves to the server. The row is opaque
  bytes.
- **No push notifications.** Reminders stay `Notification` off the minute tick, and the tab title
  stays the answer for a backgrounded tab.
- **No second Worker route**, at any phase. If a phase ever seems to need one, that is the signal to
  stop and re-read this line.

---

## Open questions

1. **Does the mirror get merging before any of this, and ship alone?** It is the recommendation:
   Phases 0 and 1 make an existing feature strictly better, need no account, and are provable with
   the file and the suite. Phase 2 is then the easy half.
2. **Passphrase-or-nothing, or a "let the server hold it in the clear" option?** The second is
   simpler to recover from and is what every other calendar does. It is also the version that makes
   a breach somebody else's appointments. Recommendation: passphrase only, no opt-out.
3. **Grave TTL at 90 days.** Longer is safer against a laptop in a drawer and costs storage that is
   already budgeted. This is the one number here picked by judgement rather than derived, and it
   should be argued before it is committed to.
4. **Free-tier pausing.** Supabase pauses an idle project on the free plan, which for a calendar
   means sync silently stopping. Either that is acceptable and surfaced as `MirrorState.error`, or
   this needs a paid plan, and that is a product decision rather than a technical one.
