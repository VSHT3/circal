# audit

What is left to upgrade, improve, change or add. First explored 2026-08-12 against `8b8e8d5`; every
claim is grounded in the code or in a measurement, with the line. Eleven rounds have been worked
through since — the Tier 0 four; the mechanical bucket; the round that needed one call each; and the
eight below. **Everything finished has been deleted from this file rather than crossed out**: what a
decision was and why it went the way it did belongs in `AGENTS.md`, next to the code it constrains,
and a list of solved problems is a list nobody reads twice.

**Round four, for the record.** Timezones (Tier 0 item 1, the biggest real defect) are closed to the
line the audit itself drew; week start and working hours stopped being constants; and three Tier 5
additions landed — the year ring answers a search, the week strip takes a span drag, the tab title
counts down. Three things were found on the way, and all three are the same shape as the `variants`
bug the last round found: **a convention drifting quietly, with nothing in the type system to say
so.** `CommandPaletteProps` had grown to five `settings` fields under a comment claiming the fourth
would convert it; `YearView`'s `Ring` still documented a magnifier that "grows **inwards**", which it
has not done since the day it shipped; and the week strip's new hooks sat below an early return,
which only `eslint` noticed. The lesson holds: the parts that have been argued for in prose are
excellent, and the drift is in the prose.

**Round five, for the record.** The macOS shell (`mac/`, `APP.md`) is the first round that added a
platform rather than a feature, and the interesting part is what it _found_. Two defects had been in
the web build all along and were invisible there: a drag across the dial selected the hour numerals,
and `user-select: none` cannot fix it because `CSS.supports("user-select", "none")` is **false** in
WKWebView and Lightning CSS folds the `-webkit-` form back to the unprefixed one — so the utility was
doing nothing in the one place this app ships as an app. Three capabilities turned out to be absent
rather than merely awkward (`Notification` answers `denied`, `navigator.vibrate` is undefined, the
File System Access picker does not exist), which is why the shell has three bridges and no logic. The
lesson this time is narrower than round four's and worth as much: **a rule that lives only in CSS or
only in a browser API is a rule with no test**, and every one of these was caught by running the
thing, not by reading it.

**Round six, for the record.** Four commits, and the better lessons are about the numbers, not the
code. Week start now defaults to the reader's own locale (Tier 5), closing that line outright. The
lazy split (Tier 1) shipped and measured what it was actually worth: `Settings` and `EventEditor` off
the critical path bought 4,186 gzipped bytes, **−1.7%**, because the thing genuinely worth splitting —
`ui/marks.ts` + `ui/icons.tsx`, 118,143 gzipped bytes of it (a real gzip figure for the wrong thing:
that was the whole `icons.*` chunk, `motion` and shared UI included, credited to the two modules whose
name it happened to carry. The table's own share was ~44 KB, which is what the split then took off) —
was the one nobody had touched, and nobody had yet decided how to touch it. The cheap win was cheap
because it was small, not because it was wrong to take. On the way to measuring it, this file's own
opening figure turned out to have drifted too — 514/174 had quietly become 535/180 before anyone
remeasured it — which is round four's "the drift is in the prose" lesson, except the prose this time
was this file's own. And the macOS shell (`mac/`, Tier 6) closed every item its own table named
cheapest, plus a fourth nobody had written down: `<a download>` does nothing inside a `WKWebView` —
measured, the click resolves and nothing lands on disk, the app's own Export button dead since the day
it shipped — which is round five's lesson exactly repeating: a capability WebKit withholds that is
invisible from reading the code and was only ever going to be found by running the app.

A fourth commit the same night closed the rest of Tier 6's cheap table. Launch at login and menu-bar
mode read their own state live rather than caching it, because a login item can be removed in System
Settings without circal knowing, and the Dock policy is simply the running app's own answer, asked
fresh rather than assumed; notification actions kept Snooze entirely inside the shell rather than
letting it anywhere near `remind.ts`'s never-catch-up rule, which is exactly the rule a page-routed
snooze would have broken. Menu-bar mode's own cost is stated where it is paid, not hidden: in
`.accessory` there is no Dock tile, so the `.ics` drop this same round closed cannot land at all. And
round five's lesson held a third time — Snooze was verified by snoozing a real banner at 07:23:08 and
watching the identical one return, unprompted, ten minutes later, because what a
`UNNotificationCategory` actually does is not something reading the Swift tells you.

**Round seven, for the record.** Four commits closed Tier 1 outright and answered Tier 2's
data-safety bullet for the two browsers that had no answer, and the number worth writing down is the
pair: last round's cheap, obvious win — both modals off the critical path — measured **1.7%**, and
this round's expensive, deferred one — the 247-path icon table behind a `localStorage` path cache and
a five-path eager core — measured **18.1%**, 42,936 gzipped bytes. This file has been wrong about
which lever is which every time it has guessed, and in the same direction: it estimates by how
awkward a change looks rather than by what the change moves, so the thing nobody wanted to touch was
ten times the thing everybody agreed on. Measure first, and expect the ranking to be inverted. The
other half is a lesson this file has now recorded four times, and it earns the fourth: the mark
flicker that had kept the table on the critical path for months was neither found nor cleared by
reading — it took clearing storage and throttling the chunk to three seconds to see it at all, and
the same throttle is the only proof the eager core works, since at full speed the fault and the fix
render identically. Round five's rule holds with one word changed: a rule that lives only in a
browser's timing is a rule with no test.

**Round eight, for the record.** The travel notice landed, which closes the oldest item in this file —
Tier 0's own first sub-bullet, opened the day the audit was written and top of "if it were three
things" for four rounds — and empties Tier 5 for the first time since the file existed. The feature
itself argued out the way it should: cities rather than IANA keys, a worked example on the reader's
own clock instead of a description, two legitimate answers and no dismiss, because a dismiss would
leave the app knowing the device had moved and drawing the day as though it had not. The lesson is in
the follow-up commit, and it is a new one. `CalEvent.tzid` had exactly one writer for as long as it
has existed, `ics.ts`'s DTSTART reader; the travel notice made it two, and a settings row that walked
every event carrying a zone therefore reached into an imported `.ics` and flattened a colleague's
09:00 New York standup to floating — reintroducing, from the chrome, the precise defect
`startsBetweenIn` was built to prevent. Every rule in `AGENTS.md` about that field was correct and
none of them was violated: what changed was the number of writers, and nothing in the type system
says how many a field has. So this round's rule is about fields rather than prose or browsers: **a
field with two writers needs to record which one wrote it, or every consumer is guessing** — and the
fix records that narrowly, a list of the zones this app stamped with, rather than adding a provenance
field to every event to serve one settings row. The residue it leaves is stated in the caption where
the user can see it, which is the same trade the export's own lossiness is pinned by.

**Round nine, for the record.** Busy and free, one commit, and the interesting thing is how little of
it was new. `CalEvent.free` is `task`'s argument repeated — an explicit flag rather than one inferred
from a title or a zero-width end — and it walked the same checklist `task` walked, hydrator fast path
through `readEvent`, `duplicateOf`, `importIcs`, `feeds.ts` and `mcp/domain.ts`, where an omission
would have handed back a rebooked event whenever an assistant edited a free one's title. The drawing
argued itself out of the two cheaper encodings: alpha is already "past" at 0.42 and a dash already
reads as tentative, so free is the outline of the arc it would have filled, traced half a hairline
inside the filled silhouette so `capInset`'s promise about painted length survives untouched. Two
things are worth having in this file rather than only in `AGENTS.md`. The label would have shipped
broken and was caught by argument rather than by eye — `inkOn(color)` is black, and inside an outline
there is no pastel for black to sit on — which is the rare case of this project's own prose catching a
defect before a browser did. And the week-strip question was answered by measuring instead of by
adding a fallback: 0.625 css px of hairline against 3.75 of black at a desktop strip, 0.252 against
1.515 at `WEEK_MIN_FACE`, so the edges never merge at a size the strip will draw, and no small-face
encoding was written. **One encoding that degrades gracefully beat two that could disagree about what
the same event is** — the same instinct as one `weekStart` setting instead of three, arrived at from
pixels this time. The `.ics` side is the quieter reward: `TRANSP` round-trips, so Tier 2's export
bullet is one item shorter and the characterisation test that pinned the loss now pins the fix, which
is exactly what that bullet said would happen to it.

**Round ten, for the record.** Per-event reminder leads, and the lesson is not in the feature — the
feature is `colorOf`'s precedence rule applied to a number, with three states packed into one integer
because a lead only counts one way and `0` had to keep meaning "as it starts". The lesson is in the
commit that came after it. The first version had `ics.ts` importing `remind.ts`, which runs **up** a
tier of the dependency order `AGENTS.md` states: acyclic, so nothing failed, no lint fired, and no
test could have caught it, because a tier is not a type. It was first read as a stale document and it
was the exact opposite — the document was right and the code had drifted under it. That distinction is
the whole point: **a documented layering constraint is not a description of the imports, it is what
keeps the graph legible**, so the honest options on finding a violation are to move the code or to
change the constraint, and never to note the discrepancy in passing. This one moved, along the split
marks already use: `events.ts` says what a field legally is, the tier above says what it does, and
`leadOf` stays above precisely because its fallback is a setting. Two rounds ago the rule was that a
field with two writers must record which one wrote it; this one is its neighbour — a rule about a
_graph_ rather than about a field — and both are failures no test in this repo could have expressed,
which is worth noticing twice.

**Round eleven, for the record.** Invitation reading, and what it demonstrates is that a refusal
written down early is worth more than a feature. This file said in its first pass that the reply half
"needs a channel this product has refused" while reading one does not — and that sentence, not a
design session, is what the commit implements: three fields kept, four `PARTSTAT` states printed, and
no verb anywhere in the surface. The interesting decisions are all about declining to interpret.
`ROLE` and `RSVP` are read by nothing, because `RSVP=TRUE` on screen is a demand beside no way to meet
it. `DELEGATED` reads as the RFC's own default rather than as a yes or a no, since the delegate is
already on the list under their own name and only the relationship is unsayable — so the label is
"Invited", which is true of a delegation and a silent guest alike where "no reply" would be false of
the first. And `METHOD` is neither read nor written, because every reading of it pays off only in the
half that does not exist. Two smaller things worth keeping. The caps are the first time this app has
had to defend itself against a _stranger's_ field with no natural length, and `trimFeed` was no help:
it bounds a subscription by dropping whole events and cannot see one event that is itself megabytes of
addresses — a budget is not a bound. And `attendeeCount` is the shape of every honest truncation in
this codebase: keep the number that arrived, print the remainder against it, and the cap stops being a
silent edit of somebody else's data.

---

## Tier 0 — actually broken, or will bite

### 1. Timezones: the floor under the model, not the model

`CalEvent.tzid` exists now. A feed's `DTSTART;TZID=America/New_York` is kept, its rule is walked
over New York's own wall clock (`startsBetweenIn` in `recur.ts`, pivoting through `wallClockIn` /
`instantOfWall`), and `toIcs` writes the zone back out instead of flattening it to UTC. A weekly
09:00 New York standup read from Berlin now sits at 09:00 New York in every week of the year,
including the three where the two zones' transition dates disagree. The travel case is closed too: a
device that has moved asks once, in cities, and both answers are recorded — moving the events with
the traveller or stamping them with the zone they were written in (`AGENTS.md`, "Travel: the device
that moved"). What is left here is not about the model any more; it is about the platform underneath
it.

Two things are deliberately still open, in descending order of how much they matter:

- **A wall time inside the _viewer's_ own DST gap shifts by an hour.** `wallClockIn` goes through
  the local `Date` constructor, which normalises a nonexistent local time forward. A zoned event at
  02:30 on the morning the _reader's_ zone springs forward reads as 03:30 for that one instance.
  Closing it properly means walking the rule in UTC-based shadow fields, which is a rewrite of every
  getter in `recur.ts` — and the same class of drift already exists for a local event on the same
  morning, so this is not a regression, it is the floor the whole file stands on.
- **No `VTIMEZONE`.** Every mainstream consumer resolves an IANA `TZID` against its own database,
  and a synthesised component would either duplicate that database or lie about the DST rules.
  Documented in `ics.ts`; revisit only if a real consumer refuses the export.

### 2. The proxy still answers a client with no `Origin`

The residual named when the headers landed, and still the only real hole in `/api/feed`: curl and a
script send no `Origin` and are therefore indistinguishable from a same-origin page, so the CORS
tightening stops browsers rather than everybody. Closing it needs a rate limit or a token — the
first thing in this file that would put state in the Worker, which is why it has not been done
casually.

The CSP is still deliberately partial: `script-src` and `connect-src` want a nonce for the inline
service-worker registration and a decision about `feeds.ts`'s direct-fetch fallback. A build change,
not a header change.

---

## Tier 1 — closed

The tier asked whether the manifesto's argument about weight survived being turned on the product,
and it now has a number rather than an opinion. The critical path — the three chunks `client:only`
blocks first paint on — measures **193,796 gzipped bytes**, down from 240,807 when this tier was
opened: the two modals took 1.7% of it and the 247-path icon table took a further 18.1%, 42,936
bytes, once `ui/marks.ts` became a lazy chunk with no static importer and the first frame was made
safe by a `localStorage` path cache plus the seed's own five paths inlined (`AGENTS.md`, "Calendars
and marks"). The first-frame question this tier held open — what a mark looks like before its glyph
has arrived — is answered in the only way that was ever going to be acceptable: for a mark that has
been drawn here before, or one the seed itself names, it looks exactly as it will look, because the
path was already there.

What is left on that path is React, `motion`, and this app's own shell and dial, plus `sun.ts` at
14,154 for a rim the first frame draws. None of it is separable without changing what the first frame
is: the three view panels hand geometry to each other mid-transition and were argued out of splitting
on those grounds rather than on size, and dropping `motion` is a rewrite of every transition in the
product for bytes that are no longer the biggest number on the page. There is nothing here left to
argue about, so the tier is closed rather than kept open at a smaller scale.

---

## Tier 2 — is this an actual calendar

- **The reply half, and it is refused rather than unbuilt.** Reading an invitation is done: an emailed
  `.ics` keeps its organiser and its guests with whatever each of them answered, the editor shows them,
  and they go back out on export (`AGENTS.md`, "Invitations: read, never answered"). What is not here
  is accepting and declining, and that is a decision with nothing left to reconsider unless the
  product's own refusal changes: a reply is a message, and there is no account, no server and no
  outbound channel to send one down. `METHOD` is therefore neither read nor written — every reading of
  it only pays off in that missing half, and writing `REQUEST` would have this app claim to organise a
  meeting it merely read. Nothing to do here; kept because somebody will otherwise propose an Accept
  button and deserve the argument rather than a shrug.
- **Export fidelity, and what is left of it.** `STATUS` and `CATEGORIES` are still dropped, and a task
  still leaves as a zero-length VEVENT with `X-CIRCAL-` lines, so another app shows an instantaneous
  event and no ticks. Five properties have left that list in a week — `TZID`, `TRANSP`, `VALARM`,
  `ORGANIZER`, `ATTENDEE` — and every one of them left the same way, by the characterisation test that
  pinned the loss becoming the test that pins the fix. `tests/ics.test.ts`'s `what the round trip
drops` block now holds two rows on those terms, and the mechanism needs no further defending.

---

## Tier 3 — the phone

The structural work is done (drawer, measured breakpoints, coarse-pointer targets). What is left is
the interesting half, and it is a design question rather than a size to change: **the two best
interactions in the app — the year ring's magnifier and the life loupe — are hover-and-dwell.** A
finger has no hover and no dwell. Neither has an answer yet, and inventing a long-press for both
would be inventing it twice.

---

## Tier 4 — structure, if the building continues

`Face` is exported without `memo`, so the week strip re-diffs seven SVG subtrees every minute when
one of them uses the clock. **Attempted and abandoned**: the memo only bites if the six non-today
faces stop being handed the ticking `now` _and_ `WeekView`'s per-day `peek` callback stops being
minted inside the render's `map`. That is a restructure of a 500-line view for a reconciliation pass
that writes no DOM. Not worth it until the view is open for another reason.

---

## Tier 6 — the macOS app, now that there is one

`mac/` shipped (see `APP.md` for what it is and what was measured). It closed the six-shortcut
argument, gave the app reminders, trackpad haptics and the mirror file, and found three app bugs on
the way. What it opened:

### 1. Nobody but the author can install it

Settled, not open: the owner has refused to buy an Apple Developer account, and the subject does not
get raised again. `build.sh` ad-hoc signs, which is enough to launch a locally built app and nothing
more — an ad-hoc bundle handed to another Mac is refused outright, and macOS 15 removed the
right-click-Open escape hatch that used to survive it, so the recipient sees "circal is damaged",
indistinguishable from malware. There is no fix for that inside this repo; the only fix is a
certificate this project is not going to have.

`clone && pnpm mac` is the distribution — not a stopgap on the way to a real one, the actual one, and
this is a developers-only artefact by decision rather than by omission. `--universal` (both slices,
one `lipo`) and `CIRCAL_SIGN_ID` (switches `codesign` to hardened runtime, which notarisation would
need) stay wired anyway, not because signing is coming but so the decision is reversible by somebody
else without being re-argued here — the code asks nothing of whoever changes their mind except a
certificate. Nothing in the repo should pretend otherwise.

### 2. The list, cheapest first

| thing                                                                                    | cost      | verdict                                                                                                                   |
| ---------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| **The dial drawn live on the dock icon**                                                 | ~60 lines | a gimmick, and a good one                                                                                                 |
| **`circal://` URL scheme** so Shortcuts or Raycast can quick-add through `parseQuickAdd` | ~40 lines | only if the user lives in Shortcuts                                                                                       |
| **WidgetKit widget**                                                                     | days      | no. A SwiftUI target, an app group and the dial re-derived natively — the rewrite `APP.md` argues against, for a 2×2 tile |

There is no longer a clean "if it were one": the dock-icon dial is a gimmick worth doing but still a
gimmick, the URL scheme is a yes only for somebody who lives in Shortcuts, and WidgetKit is a no. The
table's cheap, uncontested work is spent — everything left here is waiting on somebody deciding they
want it, not on a certificate that was never going to arrive.

---

## If it were three things

1. Answer the phone's two hover-and-dwell interactions (Tier 3). The structural work is long done and
   this is the only tier left whose open item is a design question rather than a size — which is why
   it keeps being deferred, and the deferral is now much the oldest in the file.
2. Close the proxy's no-`Origin` hole and the partial CSP (Tier 0.2). The only thing in Tier 0 that is
   a hole rather than a floor, left alone because it is the first item here that would put state in the
   Worker — an argument to have, not a reason to keep not having it.
3. Finish the export's last two properties (Tier 2). `STATUS` and `CATEGORIES` are all that remain of
   a list that has lost five entries in a week, and a task still leaves as a zero-length VEVENT that
   another app draws as an instant — the smallest item on this list and the only one with a test
   already written to announce its own completion.

What is left is a design question, a security argument and a short errand, which is a different file
from the one that opened with a broken timezone model. Everything above finishes something already
started; nothing needs a new screen except onboarding, which was always known.
