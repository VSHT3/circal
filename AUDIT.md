# audit

What is left to upgrade, improve, change or add. First explored 2026-08-12 against `8b8e8d5`; every
claim is grounded in the code or in a measurement, with the line. Six rounds have been worked
through since — the Tier 0 four; the mechanical bucket; the round that needed one call each; and the
three below. **Everything finished has been deleted from this file rather than crossed out**: what a
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

## Tier 1 — the manifesto's own argument, turned on the product

The island's own chunk had drifted before anyone remeasured it: this file's opening figure of 514 KB
raw / 174 KB gzipped for `App` alone had become 535,377 / 180,043 by the time Round six looked, not
because anything grew but because nobody had checked. That number was never the build's total output
— `client` and `react-dom` sit beside it on the same critical path, the three chunks `client:only`
blocks first paint on — which together measured 727,799 raw / 240,807 gzipped, the figure the split
below is measured against.

`Settings` and `EventEditor` are split now (`AGENTS.md`, "Shell, sidebar, top bar, focus"):
`React.lazy` behind their overlays, `Suspense fallback={null}`, `Settings` warmed the moment `Shell`
first commits and `EventEditor` warmed on an idle callback. `LifeView`, `YearView` and `WeekView`
correctly did not follow — they hold both panels mounted and hand geometry between them mid-
transition, so splitting them is a harder problem than the modals were, not the free lever this tier
once hoped it might be. `App` itself is now 40,661 gzipped bytes, with the rest of what used to be
inline with it extracted into shared chunks beside it — `ui/marks.ts` + `ui/icons.tsx` (118,108),
`sun.ts` (14,154), `ScopePrompt` (2,934) — a consequence of the dynamic import boundary, not a
decision anyone made about those modules. Measured on an isolated worktree at the split alone:
critical path 240,807 → 236,621 gzipped, **−1.7%** (727,799 raw → 700,720, **−3.7%**); `Settings`
(6,083) and `EventEditor` (4,794) moved off it entirely.

That number is the honest headline, not a disappointment: `ui/marks.ts` + `ui/icons.tsx` are
**118,108 gzipped bytes**, most of what is still on that path, eagerly required by `Dial`, `Face` and
`Sidebar` so that a mark can render on a cold load. The question left is singular now, and it is the
one the icons module's own comment already named — **what does the first frame draw**. That is a
design decision, not a technical one: a dot that pops into an icon half a second later is worse than
never having tried, and nobody has decided what a mark looks like before its own glyph has arrived.
Left open.

---

## Tier 2 — is this an actual calendar

- **No invite path.** Someone emails an `.ics`; today it becomes a whole new calendar. No `METHOD`,
  `ORGANIZER`, `ATTENDEE`, accept or decline — none of those strings appear in `src/lib`. The most
  common inbound calendar action there is. The reply half needs a channel this product has refused;
  **reading** an invite and showing who is coming does not.
- **Data safety is closed for macOS app users, still one wrong click from zero everywhere else.**
  `localStorage` is the only copy and nothing ever prompts a backup. On the Mac the mirror answers it
  outright: `MirrorFile` in `mac/main.swift` mints and adopts `~/Library/Application Support/circal/`
  `calendar.json` on first launch with no gesture at all (`AGENTS.md`, "The mirror file, and the thing
  that reads it"), so "I cleared site data" stops being fatal for an app user who did nothing to
  arrange it. In a browser with the File System Access API the picker is still there but still
  opt-in. In a browser without it at all (Safari, Firefox) there is still no answer: the nudge this
  bullet originally asked for — a prompt when the last export was N days ago — has never been built,
  and it is the one route left for exactly those two browsers.
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

The blocker is a certificate, not code. `build.sh` ad-hoc signs, and an ad-hoc bundle on another Mac
is refused outright — macOS 15 removed the right-click-Open escape hatch, so the recipient sees
"circal is damaged", which is indistinguishable from malware. The path is known and half-wired
(`--universal` builds both slices, `CIRCAL_SIGN_ID` switches `codesign` to hardened runtime):

1. Apple Developer account, $99/year → `Developer ID Application` certificate. **This machine has no
   signing identity at all** (`security find-identity -v -p codesigning` → 0 valid identities), so
   this step cannot be done from the repo.
2. `notarytool submit` + `stapler staple`, about two minutes per build.
3. A `.dmg` or the stapled zip on GitHub Releases; a Homebrew cask on top is a formula, a URL and a
   SHA.
4. An updater only after all of that, and `brew upgrade` may be answer enough — a 1.3 MB download is
   not worth Sparkle.

Until step 1, the only honest distribution is `clone && pnpm mac`, which is developers only. Nothing
in the repo should pretend otherwise.

### 2. The list, cheapest first

| thing                                                                                    | cost       | verdict                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| **The dial drawn live on the dock icon**                                                 | ~60 lines  | a gimmick, and a good one                                                                                                 |
| **`circal://` URL scheme** so Shortcuts or Raycast can quick-add through `parseQuickAdd` | ~40 lines  | only if the user lives in Shortcuts                                                                                       |
| **Sparkle updater**                                                                      | half a day | after distribution exists, not before                                                                                     |
| **WidgetKit widget**                                                                     | days       | no. A SwiftUI target, an app group and the dial re-derived natively — the rewrite `APP.md` argues against, for a 2×2 tile |

There is no longer a clean "if it were one": the dock-icon dial is a gimmick worth doing but still a
gimmick, the URL scheme is a yes only for somebody who lives in Shortcuts, Sparkle is blocked on
distribution existing at all, and WidgetKit is a no. The table's cheap, uncontested work is spent —
everything left here is either downstream of item 1's certificate or waiting on somebody deciding
they want it.

---

## If it were three things

1. Ask the timezone question the model can now hold — the travel notice. Still the best-value thing
   left in this file; nothing this round touched it.
2. Answer what the first frame draws, then split `ui/marks.ts` + `ui/icons.tsx` behind it — the one
   lever left on the critical path, and 118 KB gzipped of it.
3. Build the export nudge for the two browsers with no other answer. Safari and Firefox have no File
   System Access API and therefore no mirror; the Mac and the Chromium browsers both close "one wrong
   click from zero" now, and these two still do not.

Everything above finishes something already started. Nothing needs a new screen except onboarding,
which was already known — and one certificate, which needs a credit card rather than a decision.
