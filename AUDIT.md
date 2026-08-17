# audit

What is left to upgrade, improve, change or add. First explored 2026-08-12 against `8b8e8d5`; every
claim is grounded in the code or in a measurement, with the line. Seven rounds have been worked
through since — the Tier 0 four; the mechanical bucket; the round that needed one call each; and the
four below. **Everything finished has been deleted from this file rather than crossed out**: what a
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
`ui/marks.ts` + `ui/icons.tsx`, 118,108 gzipped bytes of it — is the one nobody touched, and it is
still the one nobody has decided how to touch. The cheap win was cheap because it was small, not
because it was wrong to take. On the way to measuring it, this file's own opening figure turned out to
have drifted too — 514/174 had quietly become 535/180 before anyone remeasured it — which is round
four's "the drift is in the prose" lesson, except the prose this time was this file's own. And the
macOS shell (`mac/`, Tier 6) closed every item its own table named cheapest, plus a fourth nobody had
written down: `<a download>` does nothing inside a `WKWebView` — measured, the click resolves and
nothing lands on disk, the app's own Export button dead since the day it shipped — which is round
five's lesson exactly repeating: a capability WebKit withholds that is invisible from reading the
code and was only ever going to be found by running the app.

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

---

## Tier 0 — actually broken, or will bite

### 1. Timezones: the model has one, the user cannot set one

`CalEvent.tzid` exists now. A feed's `DTSTART;TZID=America/New_York` is kept, its rule is walked
over New York's own wall clock (`startsBetweenIn` in `recur.ts`, pivoting through `wallClockIn` /
`instantOfWall`), and `toIcs` writes the zone back out instead of flattening it to UTC. A weekly
09:00 New York standup read from Berlin now sits at 09:00 New York in every week of the year,
including the three where the two zones' transition dates disagree.

Three things are deliberately still open, in descending order of how much they matter:

- **The travel case.** A user's own event is floating (`tzid: ""`) and is read against whatever
  midnight the browser is having, so a laptop that moves re-reads every instant. That is the right
  default — an event dragged onto this dial means the hours it was dragged onto — and the honest fix
  is not a zone picker on every event but Tier 5's **notice that the device zone changed**, which is
  now much cheaper than it was: the field to write is already there.
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

- **No invite path.** Someone emails an `.ics`; today it becomes a whole new calendar. No `METHOD`,
  `ORGANIZER`, `ATTENDEE`, accept or decline — none of those strings appear in `src/lib`. The most
  common inbound calendar action there is. The reply half needs a channel this product has refused;
  **reading** an invite and showing who is coming does not.
- **Export fidelity, minus the zone.** `VALARM`, `ATTENDEE`, `STATUS` and `CATEGORIES` are still
  dropped, and a task still leaves as a zero-length VEVENT with `X-CIRCAL-` lines, so another app
  shows an instantaneous event and no ticks. `tests/ics.test.ts`'s `what the round trip drops` block
  pins each loss as a characterisation test: the day one is fixed, the test that says it is lossy
  fails, and that failure is how the fix announces itself.

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

## Tier 5 — additions worth arguing for

- **Timezone travel as a moment, not a corruption.** Notice the device zone changed since last
  launch and ask, once, in a `BirthPrompt`-shaped screen. Cheap now that `tzid` exists, honest, and
  it turns a silent wrong answer into a decision somebody made. The best-value thing left in this
  file.

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

1. Ask the timezone question the model can now hold — the travel notice (Tier 5, and Tier 0.1's own
   first sub-bullet). Two rounds have now gone past it while cheaper things were taken, and it is
   still the only item here that turns a silent wrong answer into a decision somebody made.
2. Read an inbound invite (Tier 2). It is the most common calendar action this app cannot perform,
   the reply half is refused on purpose so the scope is bounded, and `ics.ts` already parses
   everything an invite carries except the four strings that say what it is.
3. Answer the phone's two hover-and-dwell interactions (Tier 3). The structural work is long done and
   this is the only tier left whose open item is a design question rather than a size — which is also
   why it keeps being deferred, and the deferral is now the oldest one in the file.

What changed about this list is what is not on it: the two size items are measured and closed, and
data safety has an answer on every browser this app runs in. Everything above finishes something
already started. Nothing needs a new screen except onboarding, which was already known.
