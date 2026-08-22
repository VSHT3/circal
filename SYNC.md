# sync

What it took for circal to hold one calendar on two machines without losing a day of work.

**All three phases have shipped, and everything below describes something that runs.** Phases 0 and
1 — stamps, graves and `src/lib/merge.ts` — went in as one change and turned the mirror file from
last-writer-wins into a merge. Phase 2 followed and is live: `circal.day` holds one encrypted row
per user in a hosted Supabase project, people sign in with a code mailed to their address, and two
devices on one account converge. Nothing here is a proposal. Where the design was wrong, the
correction sits next to what it corrects rather than over it, because a named wrong turn is the part
of a design document a reader cannot get anywhere else.

This supersedes `TODO.md`'s **"No accounts, and no second API route"** in one direction only, and
the argument there was half right, so it is restated rather than deleted. That entry refused _a
relay_: anonymous storage keyed by a memorable passphrase, which is offline-brute-forceable against
a stored ciphertext unless it runs a real PAKE. That refusal stands, and nothing that shipped
weakened it — access to the row is gated by an authenticated session, so the ciphertext is not
fetchable by anyone holding a guess, and the passphrase stops being the only thing between a
stranger and a calendar. That `TODO.md` entry has since been edited to say which of the two it
still forbids: it now reads **"No anonymous relay, and still no second API route"**, and names the
relay as the half that did not ship.

Phases 0 and 1 need no account, no server and no network, and they shipped as one change rather than
in sequence: Phase 0 on its own adds three fields no reader consumes, changes nothing a user could
observe, and is pure cost until the merge that consumes them exists. Phase 2 was deferred behind
them on purpose, and stayed deferred until the file half had been run in anger — which is what the
head of that section used to argue. What it argues now is what the cloud copy cost.

---

## The problem, precisely

This is the state Phase 0 started from, and it is written in the present tense because the argument
only works read forwards. The `claim()` comment quoted below no longer exists: that branch merges
now. Everything else here is still true of the file half.

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

**The reason it could not do better was `applyRemove`.** It filtered the event and its overrides out
of the array and left nothing behind. So given two documents that disagree about an id's existence,
there is no way to tell _deleted here_ from _not yet seen here_, and any merge by id resurrects
every deletion — the same tombstone problem `duplicateOf` documents from the other side when it
refuses to carry `doneKeys`.

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

Graves also need a validator, because they arrive from a file. The repo's standing shape is one
validator per format with many readers — `readRecurrence`, `readRemindLead`, `readMark`, `readGuests`
— so graves get **`readGraves`** and a **`GRAVE_MAX`**, in `src/lib/events.ts` beside the other
format owners rather than in `backup.ts`, which reads formats but owns none. The threat is
`ATTENDEE_MAX`'s exactly: an array with no natural length arriving from a hostile or merely broken
file into the ~5MB origin quota that `FEED_BUDGET` already carves 2M characters out of. The cap is
what makes the TTL below a policy rather than the only thing standing between a bad file and a full
quota.

### `updatedAt`

`CalEvent.updatedAt: number` and `Calendar.updatedAt: number`, epoch ms. It is a _field of the
record_, so `mutate.ts`'s five reducers stamp what they touch and nothing else — and each of them
takes `now: number` as a parameter rather than reading the clock itself:

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

`now` arrives as a parameter for the same reason `mintId` does, and that file's own header already
makes the argument: reaching for `store` from `mutate` is a cycle, and a reducer that calls
`Date.now()` is a reducer no test can pin to an instant. The alternative considered was stamping at
commit time in `store.ts` instead — one place, no signature churn, and wrong. `commit` sees whole
arrays and cannot tell which elements moved, so it either restamps every event on every save, which
makes `updatedAt` mean "when this device last wrote anything" and hands every merge to whichever
machine saved last, or it diffs the arrays to find out what changed, which is the merge again, in the
wrong module.

Two reducers change their return type: `applyRemove` and `applyTruncate` stop returning a bare
`CalEvent[]` and return the survivors together with the graves they emitted, because a grave computed
inside the reducer and recomputed by the caller is the deletion rule written twice, in two files, to
drift. That is a signature break, and it lands on `mcp/domain.ts` as well as `store.ts` — both call
these directly.

Settings do not merge field by field in any way a user would recognise, so they get one stamp:
**`Snapshot.settingsAt: number`**, and the whole object is last-writer-wins under it.

One settings write deliberately does not stamp it, and the exception is load-bearing.
`store.setDeviceZone` records the zone this browser is in on first launch, having asked nothing, and
a stamp there would make a browser holding nothing but seed data into a document the merge is
willing to union into somebody's real calendar — eight demo events nobody wrote, on both machines.
It is the only write in that file that is not a _choice_: the app is recording where it is, and
`merge.ts` compares choices.

### Undo is a mutation

This document said nothing about undo, and the silence loses data. `store.undo`, `redo`, `restore`
and `adopt` put back a _recorded copy_ of the event arrays, and a recorded copy carries the
`updatedAt` it had when it was recorded. So an undo produces a document that is, by every stamp in
it, older than the one the other machine is holding: it loses on the very next merge and reverts
itself, leaving nothing the user could act on. The one action whose whole promise is "that did not
happen" is the one a merge would quietly undo.

So **an undo or a redo counts as a fresh mutation**: what it changes is restamped at the moment it
runs, and what it removes emits a grave, exactly as the forward mutation would have. Undo is not a
time machine here, it is a compensating edit, and stamping it is what says so.

`merge.ts`'s `restamped` is what does it, for `undo`, `redo` and `restore` alike: everything the step
changes is stamped at the moment it runs, and everything it takes away is buried. It compares records
by _content_ rather than by reference, because an undo step and the live snapshot hold the same
objects only until another tab writes and the blob is re-hydrated, after which a reference test would
restamp the whole document. Graves are never wound back either — undoing a deletion is answered by
the stamp outrunning the grave, and dropping the grave instead would let the other machine's copy of
that deletion come back as an event on the next merge.

`restore` and `adopt` then split on the same question in opposite directions, and the asymmetry is
deliberate. `restore` is a user importing a backup on purpose, so it restamps — they mean this file
to be the answer. `adopt` does not, and must not: restamping a document that just arrived from the
other machine would mark every record in it as freshly edited _here_, and this machine would win
every subsequent merge wholesale. That is the last-writer-wins defect this document exists to
remove, reintroduced by the one line that looks like consistency.

### Migration

No `SCHEMA` bump. A bump resets settings, and nothing stored changes _meaning_ — this is the
`hydrateEvents` fill-in precedent (`AGENTS.md`: "No `SCHEMA` bump: nothing stored changed meaning").
`hydrateEvents`' shape fast-path gains three questions; a blob predating the fields gets
`updatedAt = 0`, `graves = []`, `settingsAt = 0`.

`0` is honest and it is load-bearing: it means _this record predates stamping_, which is exactly what
the merge needs to know to decline to merge. See `MIRROR_VERSION` below. Stamping old records with
the migration time instead would make the machine that upgraded last win wholesale, which is the bug
being fixed wearing a different hat.

Feed events pick up `updatedAt = 0` through the same fill-in, since `hydrateEvents` cannot tell a
subscription's payload from the user's own array. That is accepted rather than overlooked: rule 6
below has `feeds` never merging and re-pulled wholesale, so the stamp is never read by anything, and
a special case to avoid it would be code defending nothing.

### Pruning

`GRAVE_TTL` = **90 days**. A grave older than that is dropped on hydrate. The consequence is stated
rather than hidden: **a machine offline longer than the TTL resurrects what it deleted.** Ninety days
is chosen against the alternative of unbounded growth in a ~5MB origin quota that `FEED_BUDGET`
already carves 2M characters out of. A grave is two fields, so a thousand deletions is a few tens of
kilobytes — the TTL is about the decade, not the year.

`pruneGraves` lives in `merge.ts` and both the merge and `store.hydrate` call it, so the two cannot
come to disagree about how long a deletion is remembered. It also collapses a list to one grave per
id, and that was learned rather than designed: `remove`, `truncateSeries`, `removeCalendar` and
`restamped` all append, so a deletion the user undid and made again left two graves for one id.
Every reader collapses them, which made the store's list and the mirrored copy of it two different
arrays describing one document, and the machine that had done the deleting was told about its own
deletion on every pass thereafter. `commit` prunes for that reason, and `GRAVE_MAX` bounds the
result at 5,000, newest first.

### Files touched

`src/lib/events.ts` (both interfaces, `Grave`, `readGraves`, `readStamp`, `GRAVE_TTL`, `GRAVE_MAX`),
`src/lib/mutate.ts` (five reducers, two of them returning graves alongside the survivors),
`src/lib/store.ts` (`Snapshot`, `Persisted`, `hydrate`, `commit`, `remove`, `removeCalendar`,
`undo`, `redo`, `restore`, `adopt`, `sane`), `src/lib/backup.ts` (`readEvent`, `readCalendar`,
`readBackup`, `exportBackup`), `src/lib/mirror.ts` (`Mirrored`, `mirrorDigest`), `mcp/domain.ts`
(its patch path round-trips whole documents, so a field it does not know is a field it silently
drops — the `circal-mcp@0.1.0` lesson, measured at nine keys).

---

## Phase 1 — the merge

New module **`src/lib/merge.ts`**, at `mutate.ts`'s tier: pure over event lists, imports `./events`
and nothing else. `store.ts`, `mirror.ts`/`mirrorLink.ts` and `cloudLink.ts` all call it, which is
what stops "what does a conflict mean" from having three answers — the same argument that put the
scope reducers in one file.

```ts
export function mergeDocuments<S>(
  mine: Mergeable<S>,
  theirs: Mergeable<S>,
  now: number,
): Mergeable<S>;
```

`Settings` is a type _parameter_ rather than an import, since `store.ts` sits above this tier and a
merge needs no field of it. Four more exports came out of the same file rather than being spelled a
second time elsewhere: `stamped`, which answers whether a document may be merged at all;
`pruneGraves`, shared with the store; `canonicalJson`, which is the tie-break's whole definition and
the digest's as well; and `restamped`, which is what an undo owes the merge — the section above.

Rules, in order:

1. **Union by id**, across `events` and `calendars` independently, and the survivors are sorted **by
   id**. That order is part of the contract rather than an implementation detail: two machines have
   to reach the same document, and the only key both of them agree on is the id. Insertion order
   makes `merge(a, b)` and `merge(b, a)` two different arrays of the same events, which the
   transport then writes back and forth for ever — see the digest below, which learned this from the
   other end.
2. **A grave wins over a record** when `grave.at > record.updatedAt`. Otherwise the record survives
   and the grave is discarded — an event edited after it was deleted elsewhere is a resurrection the
   user performed, which is different from one a merge invented.
3. **Greater `updatedAt` wins.** Equal stamps break on a **canonical serialisation** of the two
   records — keys sorted, then stringified — keeping the lexicographically smaller. This rule
   previously read "the lower `id`", which is empty: rule 1 is a union _by id_, so the two candidates
   for a slot have the same id by construction and there is no lower one. Saying so is not
   bookkeeping — a reader who sees only the replacement will reach for the id again, because it is
   the obvious thing to reach for. Canonical is the load-bearing word: a record built by a spread and
   the same record round-tripped through `backup.readEvent` enumerate their keys in different orders,
   so a tie-break over raw `JSON.stringify` is a tie-break two machines can disagree about, which is
   exactly what commutativity forbids — and one the commutativity test would only catch on the day a
   fixture happened to differ in key order. Two devices genuinely editing one event in the same
   millisecond is not a case worth a vector clock; it is a case worth a rule that cannot answer
   twice.
4. **Graves union**, then prune past `GRAVE_TTL` measured from `now`, then drop any grave whose
   record survived rule 2. A grave the union has already overruled is one that would have to be
   overruled again on every subsequent merge, and it is a grave both machines would keep writing at
   each other.
5. **Settings**: whole-object, greater `settingsAt`. Equal stamps take the same canonical tie-break
   the records take, for the same reason — two machines that changed a setting inside one
   millisecond would otherwise each keep their own and write over each other for ever.
6. **`feeds` never merges.** It is a read model assembled from `circal.feed.*` keys and is the one
   `Snapshot` field `write()` never serialises. Each machine pulls its own.

Merging is **element-wise, so it is commutative and idempotent** — `merge(a, b) === merge(b, a)`, and
`merge(a, a) === a`. Both are tests, not remarks: they are what make a merge safe to run on every
poll rather than once at a handshake.

### `MIRROR_VERSION` is 2, and `mirrorMerges` is the gate

`2` means _every record in this document carries a stamp, and deletions are tombstoned_.
`mirrorMerges(contents, mine)` is the one place the question is asked, and it asks three things: that
the envelope is at least 2, that their document is `stamped`, and that ours is. Both transports call
it, so a merge refused over a file is refused identically over a row.

- **v2 both sides, both stamped** → merge.
- **v1 file, or either side unstamped** → the old behaviour exactly. `mirrorVerdict`, `adopt`,
  `stale`, no merge. An unstamped document cannot be merged without guessing, and adopting is the
  correct answer for it.
- **v2 file, v1 reader** → already refused. `assertVersionAllowsMutation` exists for this, and
  `cloudPlan` makes the same refusal from the row's `version` column before it decrypts anything:
  a reader that round-trips a document through validators it is too old for silently drops the
  fields it does not know.

**`stamped` was `settingsAt > 0`, and that was measured wrong on the real transport.** Two fresh
installs signed into one account are both unstamped, so neither may merge, so each adopts the
other's document whole — and adopting an unstamped document leaves you unstamped, so the pair never
grows out of it. A user's first event on their new laptop was adopted away by the machine that
synced next, which is exactly what somebody sets up a second machine to avoid. Recoverable
(`store.adopt` records an undo step and toasts) and still not shippable. No suite would have found
it either: every fixture is built stamped, and the predicate's own table asserted a false that was
true for the wrong reason. Two real browsers against the real row found it in one pass.

The predicate now asks whether the document carries stamps **at all** — a settings stamp, or any
record or grave with a real instant on it — which is what its name always claimed and what the
protection was actually for. What it protects is **demo data, not settings**: `seed()`'s events,
`DEFAULT_CALENDARS` and `duplicateOf` all carry `updatedAt: 0` on purpose, so a browser holding
nothing but its demo day still cannot win a merge or publish eight events nobody wrote. The moment
one real thing happens — an event created, a calendar added, a deletion buried, a setting changed —
the document is stamped and merging begins, which is the earliest instant at which there is anything
to defend. A pre-Phase-0 blob is unaffected: every record in it reads `0` through `hydrateEvents`'
fill-in, so it is still a document the merge declines rather than one whose every event loses.

### What the mirror got out of it

`claim()`'s "adopt, do not merge" branch is now "merge, then write the merged document at
`max(fileRev, localRev) + 1`". Two machines on one synced folder stopped being last-writer-wins,
with no account, no server and no network. That is the whole of the sync most people asking for sync
actually want, and it was reachable from where the file already was.

`absorb()` still goes through `store.adopt`, so a merge is one undoable commit with a toast. The
merge cannot lose data the way an adopt could, but it can still surprise, and the undo step is what
makes a surprise recoverable.

**An absorb that changes nothing locally has to be silent, and that is the ordinary case rather than
an edge.** The write-back is inherent to convergence — both machines must end up at the file, or at
the row — so the machine that wrote first always sees its own edit return as the other one's
`rev + 1`, merges it, and produces exactly what it already had. Adopting that tells a machine its
own work is news and pushes a commit that changes nothing onto the undo stack, so ⌘Z appears to do
nothing. The silence cannot come from a flag saying "this pass was ours", because the second pass
happens either way: it has to come from comparing documents. `mirrorLink.absorb` compares the
contents against the store, keeps every piece of the bookkeeping and skips only the toast — dropping
`localRev` or `lastDigest` with it merely trades a spurious toast for a spurious write on the next
pass. `cloudLink` splits the same decision one step earlier, into `absorb` and `settle`, because
`cloudTake` is a pure function and the comparison had somewhere better to live.

**`mirrorDigest` was wrong twice, and both times the symptom was traffic.** It is the guard that
tells "the calendar changed" from "a feed re-pulled", so a merge that changed nothing must digest
equal. First it was **key order**: a merged document holds records from both sides, and an event
this browser stored enumerates its keys in a different order from the same event rebuilt by
`readEvent` on the way out of the file, so insertion-order `JSON.stringify` called two identical
events different. Both machines wrote back, each read the other's write as news, one write every
poll for ever. `canonicalJson` closed that, and then **record order** did the same thing from the
other end: the store keeps events in creation order while `mergeDocuments` unites them in id order,
so the digest read the reordering as a change and the machine that wrote first was told its own edit
was news. `mirrorDigest` now sorts each list by id before serialising it. Array order is no more
part of this document than key order is, and a machine that cannot tell either from a real change
cannot tell a sync from a loop.

### Tests

`tests/merge.test.ts` owns the module: commutativity, idempotence, the grave-versus-edit precedence
in both directions, the canonical tie-break, TTL pruning, the v1 refusal, and two machines
converging. Table-driven with `it.each` and `expect.soft`, per the suite's convention.

`tests/mutate.test.ts` carries the grave sets: a series deletion graves its overrides, a truncate
graves only what is past the cut.

`tests/mirror.test.ts` carries the version gate: a v1 file adopts, a v2 file merges, a v2 file in a
disagreeing zone is refused before either.

`tests/cloud.test.ts` carries the pure half of the cloud transport, and deliberately also the
two-fresh-installs scenario — the shape that passed every case in `merge`, `mirror` and `cloud`
while quietly adopting a user's first edit away. `stamped`'s table fails seven ways on the old
predicate, which is what a case driven by hand is worth once it is written down.

**No `tests/west/` case.** Every comparison here is epoch-ms arithmetic — no `dayKey`, no
`startOfDay`, no `addDays`. That is worth stating because the standing rule is the opposite, and a
reader should be able to see the exemption was reasoned rather than forgotten.

---

## Phase 2 — the cloud copy, optional

Off unless signed in, and the app is byte-identical for somebody who never does: `supabase-js` is
fetched only when sync is switched on, so a reader who never opens the Cloud card downloads none of
it.

**Built, and running.** `circal.day` syncs through one Postgres row per user in a hosted Supabase
project. Signing in is an address and a code mailed to it; the row is opened with a passphrase the
user sets once and types again on every new device. Two machines on one account converge, and the
design below is what they converge through.

It cost more than the sketch it was written as, and the cost belongs in one place:

- **`src/lib/vault.ts`**, the locked box: AES-GCM under PBKDF2-SHA256, a versioned envelope, and two
  distinct failures — `WrongPassphrase` and `UnreadablePayload` — because a caller that cannot tell
  them apart tells a user their passphrase is wrong when their data is damaged, or the reverse.
- **`src/lib/cloudLink.ts`**, longer than `mirrorLink.ts`: an auth session, a websocket, a poll, a
  compare-and-swap, a remembered key in IndexedDB, and one written sentence for every way each of
  those fails.
- **`supabase/migrations/20260820121500_documents.sql`**, plus the two auth email templates in
  `supabase/templates/`, which exist as files because a template living only in a dashboard form is
  one nobody can review, nobody can diff and a rebuilt project loses.
- **The Cloud card in `src/components/react/Settings.tsx`**: a sign-in asked in three steps, a
  passphrase field that returns on every new device, a switch, a delete behind a confirmation, and a
  caption per failure.
- **A second surface that can hold a user's whole calendar**, which is the real price. Every failure
  in it had to be given an answer that loses nothing, and one of them — a payload that will not
  open — is the sharpest thing in the app.

Two things arrived that this document never anticipated, both from using it rather than designing it.
**"Stay unlocked"** keeps the derived key in IndexedDB so a device stops asking for the passphrase on
every reload; the caption carries what a user would otherwise have to work out, which is that the
passphrase is not what is kept and what is kept holds write authority over every device on the
account. **"Delete cloud copy"** is the other: a feature that puts a calendar on a server owes a way
to take it off again, and that is a different intention from signing out, so it is a different press.

**The mirror file remains a complete answer for anybody who does not want an account.** Two machines
pointed at one file in a folder Syncthing keeps in step is sync with no server, no passphrase to lose
and nothing anyone could breach, and Phase 1 is what made it a merge rather than a race. It was the
reason to defer this section and it is not the reason to skip it: the panel holds both and enforces
one live copy at a time.

### Why Supabase fits, in facts rather than preference

All four held once it was built, which is worth recording: this is the part of a design document most
likely to be optimism.

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
- **Hosted free tier, not self-hosted.** The payload is client-encrypted, so the server holds a
  locked box either way: self-hosting buys no privacy that is not already there. What it does buy is
  five or six containers, a Postgres to keep backed up and an ops burden that never ends, all to hold
  one row per user.

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

The shipped migration is `supabase/migrations/20260820121500_documents.sql`, and it carries two
things this sketch did not. `updated_at` means "when the row last moved", and a client-supplied
timestamp is a client that can be wrong about that, so a `touch_document` trigger owns it. And the
table joins the `supabase_realtime` publication in the same migration, because a table absent from
it emits nothing and no error: the fallback poll below would be the only path, and nobody would find
out from a log.

### Encrypted on the client

`payload` is AES-GCM ciphertext under a key derived from a passphrase the user sets once —
PBKDF2-SHA256 at `PBKDF2_ITERATIONS` = 600,000, which WebCrypto has natively (Argon2id would want
wasm, and this is not the PAKE case the `TODO.md` entry refuses). The box is
`version(1) || salt(16) || iv(12) || ciphertext-with-tag`, base64url, and the salt travels in the
header of every box it seals, so a key held without its salt could open what it was handed and
produce nothing. The server holds a locked box and a row id. RLS stops being the only thing between
two users' calendars, and the obligation of holding strangers' medical appointments in plaintext
never arises.

Costs, all three real: no server-side query capability, which nothing here wants; a lost passphrase
loses the cloud copy, with `localStorage` and the mirror file still holding copies; and 600,000
rounds is a visible fraction of a second on every unlock, which is why the panel disables its own
button while one is in flight rather than deriving the key twice. Supabase Auth still knows the email
of everyone who signs in, and no client-side encryption changes that — the panel says so out loud
rather than implying otherwise.

**A payload that will not open stops everything, and that is the sharpest failure in the feature.**
It is either the wrong passphrase or a damaged box, and in both cases the one thing the link must
never do is seal local state over it. That write is not a lost edit and not an adopt an undo step
covers: it is the other machine's work, ciphertext, gone, with no copy anywhere. `cloudTake` answers
`stop` and a sentence carrying both halves a person needs — what to try, and that nothing has been
lost yet. A future reader will notice the local document is perfectly good and think writing it is
the helpful thing to do; it is the opposite, because the row is the only copy of whatever the other
machine has done since it last merged.

### `src/lib/cloudLink.ts`

`mirrorLink.ts`'s shape, one transport over: the same status vocabulary (`off` / `prompt` / `live` /
`error`), the same claim → absorb → write cycle, the same `lastDigest` guard so a feed re-pull costs
no round trip, the same 400 ms `SETTLE_MS`. `mirror.ts` stays the sole owner of the format, and
`serialiseMirror` and `readMirrorFile` are untouched — the plaintext sealed into `payload` _is_ the
file's contents, byte for byte, so there is no second envelope for `readMirrorFile` to disagree with.

Four places the transport genuinely differs from a file, each decided rather than inherited:

1. **The compare-and-swap is real.** `update … where rev = $expected` is atomic, so there is no
   `.lock` sibling and no Web Locks dance here; two tabs of this origin need nothing beyond the
   in-tab `writing` chain, since exactly one `UPDATE` matches and the other is told it lost in the
   same round trip.
2. **Realtime replaces the poll and is never required.** A subscription on this user's row, with a
   15 s poll whenever the socket is not subscribed and only while the tab is visible, so somebody
   behind a proxy that kills websockets still syncs, slower.
3. **A paused project is a link that is down**, surfaced as `error` carrying a sentence that names
   the dashboard rather than merely reporting failure. Open question 4, unchanged by contact with
   reality.
4. **A box that will not open stops everything**, above.

The revision this browser last wrote is kept under `circal.cloud`, because a reload that forgot it
would read the row as ahead of itself and adopt its own bytes back. The derived key is kept only if
the user asks for it, and a key that no longer opens the row — the copy was re-sealed on another
device — is discarded with its own sentence rather than the generic one, since "wrong passphrase"
would be a lie about the one thing a user can act on.

`readCloudRow`, `cloudPlan` and `cloudTake` are the pure halves and `tests/cloud.test.ts` owns them.
The transport around them is hand-driven for `mirrorLink.ts`'s reason: it is a network client, an
auth session, a websocket and a debounce, and a test that mocked a Postgres client would be
asserting the mock. It is verified by driving two browsers at one project, which is also how the two
bugs recorded under Phase 1 were found.

### Both links at once

Two links can run together in principle, each keeping its own `rev` against its own transport, with a
merge on either side converging. What shipped is **one at a time**, and the panel is where that is
enforced rather than the transport: each side's _advancing_ verbs go dead while the other is engaged
while its retreating ones never do, so a reader who arrives holding both — a session from before the
file was picked — can still let one go. Two writers each debouncing at 400 ms into a document the
other is also merging is a state worth reaching deliberately, and nothing has asked for it yet.

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
- **No second Worker route**, at any phase, and none of the three needed one: `worker/index.ts`
  serves `/api/feed` and answers 404 to every other `/api/` path. If something ever seems to need a
  second, that is the signal to stop and re-read this line.

---

## Open questions

All four are settled, and the two that were settled by building rather than by argument say which.

1. **Does the mirror get merging before any of this, and ship alone? — resolved, yes.** Phases 0 and
   1 make an existing feature strictly better, need no account, and are provable with the file and
   the suite. They shipped as one change rather than in sequence, because Phase 0 alone is three
   fields nothing reads. Phase 2 followed once the file half had been run in anger, which is the
   order this question asked for.
2. **Passphrase-or-nothing, or a "let the server hold it in the clear" option? — resolved:
   passphrase only, and that is what shipped.** The plaintext option is simpler to recover from and
   is what every other calendar does; it is also the version that makes a breach somebody else's
   appointments, and it would have made the sentence `AGENTS.md` opens with untrue. There is no
   opt-out and no plaintext path in the code — `cloudLink` cannot write a row it did not seal, and
   a payload it cannot open stops it rather than replacing it. The cost is charged to the user who
   loses a passphrase, which is why the panel states it beside the field instead of in a help page.
   Settling this before Phase 2 existed would have been settling it without the thing it was about
   in front of us; having built it, the answer is the one the recommendation gave.
3. **Grave TTL at 90 days — resolved as proposed, and shipped at 90.** The argument in the Pruning
   section carries it on its own: the storage cost is bounded and already budgeted, and the failure
   it admits is a machine left offline for a quarter, stated rather than hidden. It remains the one
   number here picked by judgement, which is why it stays written down next to what it costs.
4. **Free-tier pausing — resolved: acceptable, and it has happened.** Supabase pauses an idle
   project on the free plan, so sync stops until somebody unpauses it. It surfaces as the `error`
   state `mirrorLink.ts` already had for "this link is not working", carrying `cloudLink`'s own
   sentence, which names the dashboard and says the calendar is whole on this device meanwhile — a
   paused project is a link that is down, and an error that only reports failure leaves a user with
   nothing to do about it. Paying a monthly fee to avoid an error message is not a product decision
   worth making.
