# todo

Done work is not recorded here. The rationale that outlived it lives in `AGENTS.md`, next to the
code it constrains — so an item finishing means it leaves this file rather than gaining a strike.

The instrument is finished and the calendar under it is real: RFC 5545 in and out, four views of
one idea, a test suite in the gate. Nothing below adds a screen. What is below is four bugs, then a
short list of things that finish something already started.

## bugs — reproduced 2026-08-17

Found by driving the calendar through the MCP server rather than by reading the code, and the first
three are one defect three times: **a value that passed validation silently becomes a different
value, and nothing is raised where the damage happens.** Two of them lose data. The fourth is the
same shape one layer down — a guarantee stated in a comment that the code does not fully provide.

**1. An open tab erases the agent's writes.** Two events written through the MCP server vanished
mid-session, with no error on either side. `mirror.ts:51-56` states the contract in words — _"A
writer reads the file, checks this is still what it read, and writes `rev + 1`"_ — and the server
keeps it: `casWrite` (`mcp/file.ts:106-139`) reads, mutates, re-reads, compares `rev`, and only then
writes `rev + 1` through a temp file and a rename. The web app does not. `write()` in
`mirrorLink.ts:277-289` takes `store.snapshot()`, serialises the whole document at `next`, and calls
`handle.createWritable()` (283) without ever re-reading the file it is about to replace. It is a
blind truncate.

That opens two holes. **Lost update:** `onStoreChange` (`mirrorLink.ts:354-359`) debounces a write
for `SETTLE_MS` (400ms, line 228) at `localRev + 1`. An agent writing rev N+1 inside that window
does not move the tab's `localRev`, so the tab writes its own rev N+1 from memory a moment later.
The agent's events are gone, and because both writes carry the same number nothing downstream can
notice. **Stale re-assertion:** `mirrorVerdict` (`mirror.ts:157-160`) returns `stale` for any
`fileRev < localRev`, and `poll()` answers it with `write(localRev + 1)` (`mirrorLink.ts:328-330`) —
the tab's entire in-memory document over the file. As anti-rollback against a restored backup that
is right. Against a second writer that legitimately added events it is the loss. `POLL_MS` is 2s
(line 221) with adopt-on-newer, so the ordinary case works and the hole only opens under concurrent
writes, which is precisely when agents are driving.

A window inside `casWriteOnce` itself — between its confirm-read and its `atomicWrite` — was
examined separately and is **not** this bug. It is real, it is milliseconds wide, and closing it
needs an advisory lock. The missing re-read above is the defect; the window is a limit.

Fixes, in order of preference. (a) Make `write()` honour the documented contract: re-read and
compare `rev` immediately before `createWritable`, and on a mismatch adopt then reapply rather than
overwrite. (b) Narrow `stale` from a whole-document re-assert to a merge that adopts events whose
ids the tab has never seen. (c) Replace the 2s poll with a real file watch, so the adopt window is
shorter than the debounce window. (d) An advisory lock — a sibling `.lock`, or Web Locks plus a pid
file the server also reads — if belt and braces is wanted; heavier, and the only one that also
covers a second browser tab, and the only one that also closes the `casWriteOnce` window. Until then
the workaround is operational: close the tab, or disconnect the mirror in Settings, while agents are
writing.

**2. `ICON_MAX = 16` truncates shipped icon names into unrenderable junk.** `events.ts:56-62` caps a
mark at 16 UTF-16 units and says "every Phosphor name in the set is shorter than that anyway". Ten
of the 247 in `marks.ts` are not — re-counted off the table rather than trusted:
`currency-circle-dollar` (22), `globe-hemisphere-west` (21), `person-simple-tai-chi` (21),
`person-simple-walk`, `person-simple-swim`, `person-simple-bike`, `presentation-chart`,
`thermometer-simple` (18 each), `person-simple-run`, `dots-three-circle` (17). The cap is applied in
`backup.ts:350` (event) and `backup.ts:390` (calendar), on read and on persist — **after**
`isIconName` has approved the value. So a name that validates is stored as sixteen characters, which
then matches no path in `marks.ts` and draws as the plain colour dot.

It has already happened to a pre-existing user event: `person-simple-run` sits in the file as
`person-simple-ru`. And that name is one of the five `SEED_MARKS` — so this is not confined to
events somebody hand-picked a long mark for: **every new install carries a mark that corrupts on its
first backup round-trip.** `suitcase-rolling`, the other seed mark at risk, is exactly 16 and
survives, which is the sort of margin that says the cap was never measured against the table.

The cap is not the bug, the silence is: a validated value is replaced by an invalid one and nobody
is told. Reject over-long names at validation time, or raise the cap to fit the vocabulary actually
shipped, or store an index into the table instead of a string.

**3. The published npm bundle is stale and drops fields on every write.** `circal-mcp@0.1.0` was
built before the newest fields landed in `src/lib`; its `readEvent` ends at `doneKeys`
(`backup.ts:355`, with `free`, `remindLead`, `organizer` and the guest pair following at 359-373).
Every MCP write round-trips the whole document through that reader, so an unknown key is dropped on
read and never written back. Per event: `free`, `remindLead`, `organizer`, `attendees`,
`attendeeCount`. In settings: `backupNudge`, `backupInterval`, `deviceZone`, `stampedZones`. Nine
keys, measured rather than reasoned — same fixture, one operation, two bundles: the published one
loses all nine, one rebuilt from current `src` loses none.

Mitigated locally by `pnpm build:mcp` and pointing the registration at
`node <repo>/mcp/dist/circal-mcp.mjs` rather than `npx -y circal-mcp`, which is still what
`mcp/README.md:55` tells everybody else to run. **The package on npm is still stale.** Republish
from current src — and then the durable half: have the reader refuse to write a file whose schema is
newer than its own, which is exactly what `assertZoneAllowsMutation` (`mcp/file.ts:84-93`) already
does for a zone mismatch.

**4. `atomicWrite` is not durable, and its own comment says it is.** `mcp/file.ts:58-65` promises
that "a crash mid-write leaves the previous file intact rather than a truncated one", and the file's
header repeats it. True for a crash of _this process_ — the rename is what buys that. Not true for a
power loss or a kernel panic: `writeFile` returns once the bytes are in the page cache, and the
rename's metadata can reach the disk before them, leaving a short or empty file where a complete one
used to be. The module imports `readFile, rename, writeFile` and nothing else, so there is no
`fsync` anywhere in it. For a file this repo describes as possibly the only copy of a year, the fix
is small and belongs with the claim: `fsync` the temp file before the rename, and the containing
directory after it. A failed rename also leaves its `.circal-mcp-*.tmp` behind, which is untidy
rather than dangerous and is one `try`/`finally` in the same place.

**None of the four is fixed. The MCP server has no tests at all** — 1,572 lines across `domain.ts`,
`tools.ts`, `file.ts` and `find.ts`, none of them in the suite. Most of the _logic_ is covered,
because the server imports the app's own domain layer and `mutate.ts` and `mirror.ts` are both
tested; what is uncovered is exactly where these bugs live. `resolveFilePath`, the zone gate, the
CAS retry and the write queue are all pure or temp-dir-able, and `tests/mirror.test.ts` already sits
next door testing the format. `pnpm build:mcp` is also outside `pnpm verify`, so the bundle's
`--external` and `--alias` flags are never exercised by the gate.

## open

**Onboarding, and only its teaching half.** The intro animation shipped and answers a different
question — it says angle-is-time and says nothing about ⌘P, the four views, or the drag. The shape
this should take is `BirthPrompt`'s: one screen, at the moment it is needed, never again. Not a
four-step carousel over the dial.

**Make the mirror file findable.** The sync people ask for already exists — point two machines at
one file in a synced folder and `mirrorVerdict`'s `rev` handles both writers, `stale` refusing to
wind a calendar backwards. Nobody finds it. The evidence is as strong as it gets: the person who
built it went looking for temporary transfer instead. This is a discoverability item, not a feature
one, and it is the cheapest real win on the list.

**A whole calendar as a link — open question, not a decision.** Measured first: a thousand events
is ~32 KB gzipped, ~43 KB as base64url. That rules out the two carriers that make the one-event
link worth having (a chat message, a QR code — the latter caps at 2,953 bytes), and everything that
_can_ carry 43 KB of text can carry the `.json` file just as easily, so as it stands the encoding
adds a step rather than removing one. Two things would have to be answered before building it: what
carries it, and what stops a truncated paste. The second is not hypothetical — `shareCheck` exists
because a link cut on a base64 boundary decodes into a _plausible_ event with one field silently
wrong, and at this size being cut short is the common case rather than the edge one.

**Settings alone as a link is a separate, cheaper item.** ~842 characters of JSON, ~192 packed the
way `share.ts` already packs, against a `SHARE_MAX` of 1,600 — small enough to QR off one screen
and scan with the other machine. Three fields must not travel, by the rule `share.ts` and
`duplicateOf` already state: `deviceZone` (it is the only "before" the travel notice has),
`stampedZones` (what _this_ browser's answer stamped) and `defaultCalendar` (an id that does not
exist over there).

**Ended events on today are still pointer-only.** The keyboard half of this landed — focus peeks
the arc, and a row can no longer unmount from under its own focus ring — but an event that ended
_before_ you arrived is filtered out of today's card and the face is `aria-hidden`, so there is
nothing to tab to. Reaching one needs the dial's own `sr-only` listbox, the answer the year ring and
the life grid both already have. That is a real item, not a line: 365 marks and 30,000 dots each
needed one, and a day's arcs would be the third.

**Improve the all-day drag.** A full revolution makes an all-day event, but sweep is clamped to
`[-from, 1440 - from]`, so the only place a whole turn is reachable is a drag starting at exactly
00:00. It should be startable from anywhere on the ring. The clamp is load-bearing for the ordinary
case — clamping sweep rather than the resulting instant is what makes a range stop dead at midnight
instead of unwinding overshoot — so this needs a way to say "a whole day" that does not fight it.

**Week strip: show the run while it is being drawn.** The gesture commits correctly and the shared
readout prints `formatDayRange` plus a count, but the faces themselves show nothing, so the only
feedback for a five-day drag is a sentence under it.

**Typical-weekday ghost.** Past instances of the viewed weekday drawn faint behind the real arcs,
on the same lanes so it costs no radius. The one idea here that would tell you something the
calendar does not already contain — what a Tuesday is usually like, rather than what this Tuesday
holds.

**Settings cleanup.** Thirty-eight fields across the panel's balanced columns. Worth a pass for
grouping and for rows that have drifted from the section they sit in.

**Moon: position and text.** The sidebar's moon has no controls beyond on/off. Where it sits and
whether it names the phase are both reasonable asks.

**Marks: pinning, and more of them.** 247 Phosphor glyphs, searchable, and no way to keep the six
you actually use at the top. Pinning is the cheaper half. Growing the set is allowed at ~180 gzipped
bytes an icon and may **not** grow back onto the first frame — `ui/marks.ts` has no static importer
and that is what took 42,936 bytes off the critical path.

## undecided

**A map for `location`.** Would need a tile provider, which is a network request to somebody else
on every event with an address — against "nothing leaves this browser". A link out to a map is the
version that costs nothing, and it is not obvious it is worth a row.

**Pomodoro / timer.** A timer is not a calendar, and the dial is a clock face rather than a
stopwatch. Filed because it keeps coming back, not because it has an argument yet.

## what not to do

- **No seven-column grid.** The circle is the argument and a grid concedes it. Seven _dials_ do not,
  which is what ⌘E is.
- **No accounts, and no second API route.** "Nothing leaves this browser" is the product. A relay
  for calendar transfer needs storage, a TTL, size caps, rate limits and somebody answering abuse
  mail — and a passphrase short enough to be memorable is offline-brute-forceable against a stored
  ciphertext unless it runs a real PAKE, which is not something to hand-roll here.
- **Do not add a ring to the dial.** Every radius costs `PAD` and legibility, and that face carries
  four plus two bands. The room is in the interior. Anything that is not a fact about the _day_ goes
  to the sidebar, which is where the moon went.
- **Do not put a year-scale summary in the year ring's middle.** Busiest month, longest empty run —
  computable, and nobody opens a year to be told which month was busy. `settings.yearQuote` is a
  line the user writes, and it shows only at rest.
- **Do not bring back the hour detent.** It measured 1.3 dB in a stream against a click-to-click
  spread of 0.1 dB, went unnoticed for months, and retuning it to a real 4 dB proved the point
  rather than fixing it: the readout prints the whole span for the length of the drag, so an audible
  accent is a second answer to an answered question. If a drag ever needs a second signal, the
  readout is the one that already works.
- **Do not add a second search.** `scoreEvent` is the whole of "does this match" for the palette and
  for both lit faces. A second matcher means a day can light for a query the list would not find.
- **Do not rank the palette by recency.** The tiebreak it would replace is nearness to the day you
  are standing on, in an app whose thesis is that where you are in time is the organising fact.
