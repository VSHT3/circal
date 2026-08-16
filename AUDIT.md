# audit

What is left to upgrade, improve, change or add. First explored 2026-08-12 against `8b8e8d5`; every
claim is grounded in the code or in a measurement, with the line. Four rounds have been worked
through since — the Tier 0 four; the mechanical bucket; the round that needed one call each; and the
round below. **Everything finished has been deleted from this file rather than crossed out**: what a
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

One chunk: **514 KB raw / 174 KB gzipped**, plus 57 KB gzipped of React, no code splitting.
`client:only` means the screen stays black until all of it has downloaded _and_ parsed, to draw a
dial. Two splits, and both have a real design question in front of them, which is exactly why they
are still here:

- **`icons.tsx` behind the mark picker.** Its own comment prescribes "a lazy chunk _plus_ an eager
  core", and the 247-path table is now its own module (`ui/marks.ts`), which was the prerequisite.
  What it still needs is the answer to **what the first frame draws**: a mark has to render on a cold
  load, and a dot that pops into an icon half a second later is the failure that comment already
  rejects.
- **`LifeView` / `YearView` / `WeekView` behind their view keys.** Not naive: the day ⇄ life zoom,
  the day ⇄ week zoom and the year ⇄ life unroll all hold both panels mounted and hand geometry
  between them, so a view arriving one frame late arrives _during_ a transition that has already
  started. `Settings` and `EventEditor` behind their overlays have no such problem and are the
  cheapest first move.

---

## Tier 2 — is this an actual calendar

- **No invite path.** Someone emails an `.ics`; today it becomes a whole new calendar. No `METHOD`,
  `ORGANIZER`, `ATTENDEE`, accept or decline — none of those strings appear in `src/lib`. The most
  common inbound calendar action there is. The reply half needs a channel this product has refused;
  **reading** an invite and showing who is coming does not.
- **Data safety is one wrong click from zero.** `localStorage` is the only copy and nothing ever
  prompts a backup. Two cheap, on-thesis fixes: a nudge when the last export was N days ago, and the
  File System Access API keeping a rolling `.json` in a folder the user picks. No server, no account,
  and "I cleared site data" stops being fatal. **Half-answered**: the mirror is that rolling file, and
  it works in the macOS app now that the shell provides the picker WKWebView lacks — but it is
  opt-in and the app makes the user choose a path for no reason, which is Tier 6 item 2. In a browser
  without the API (Safari, Firefox) the nudge is still the only available answer.
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
- **A week start the platform already knows.** `Intl.Locale.prototype.getWeekInfo` gives the
  reader's own first day; the setting could default to it rather than to Monday. One line, one
  feature-detection branch, and a stored value must still win — which is the whole reason it is not
  done blind.

---

## Tier 6 — the macOS app, now that there is one

`mac/` shipped (see `APP.md` for what it is and what was measured). It closed the six-shortcut
argument, gave the app reminders, trackpad haptics and the mirror file, and found two app bugs on the
way. What it opened:

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

### 2. The mirror asks the app user to pick a file, which is ceremony

The mirror is **not** how the app stores anything — events live in this origin's `localStorage`
exactly as on the web — and it is only ever needed by an outside process, which today means the MCP
server. In a browser the picker is unavoidable: a page may not choose a path. A shell may, and
`AGENTS.md`'s standing complaint that "circal cannot tell a user where their own mirror file lives"
stops being true the moment the shell owns it.

So: default it to `~/Library/Application Support/circal/calendar.json`, connected on first launch,
with the picker still there for somebody who wants it in iCloud Drive or a repo. Two consequences
worth having — `circal-mcp --find` finds it without anybody knowing a path, and Tier 2's "data safety
is one wrong click from zero" is closed for app users, because the rolling `.json` that bullet asks
for is then always on.

### 3. The list, cheapest first

| thing                                                                                    | cost       | verdict                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wake-from-sleep refresh.** `NSWorkspace.didWakeNotification` → nudge the page          | ~10 lines  | **the one actual defect**: after a lid close the minute tick is stale until it next fires, so the hand and every countdown are wrong for up to a minute |
| **Drop a `.ics` on the dock icon** → import through `fromIcs`                            | ~20 lines  | yes. It is how a person moves a calendar in, and the parser is already there                                                                            |
| **Default mirror path** (item 2 above)                                                   | ~20 lines  | yes                                                                                                                                                     |
| **Launch at login** (`SMAppService`) and a menu-bar-only mode                            | ~30 lines  | yes for something that keeps a countdown and fires reminders                                                                                            |
| **Notification actions** — Snooze 10m / Open on the banner, via `UNNotificationAction`   | ~30 lines  | real, and the tag already routes a tap back to the page                                                                                                 |
| **The dial drawn live on the dock icon**                                                 | ~60 lines  | a gimmick, and a good one                                                                                                                               |
| **`circal://` URL scheme** so Shortcuts or Raycast can quick-add through `parseQuickAdd` | ~40 lines  | only if the user lives in Shortcuts                                                                                                                     |
| **Sparkle updater**                                                                      | half a day | after distribution exists, not before                                                                                                                   |
| **WidgetKit widget**                                                                     | days       | no. A SwiftUI target, an app group and the dial re-derived natively — the rewrite `APP.md` argues against, for a 2×2 tile                               |

If it were one: the wake refresh, because it is wrong rather than missing.

---

## If it were three things

1. Ask the timezone question the model can now hold — the travel notice.
2. Split `Settings` and `EventEditor` off the first byte, then answer the first-frame question for
   the marks.
3. Make losing the browser's storage survivable: a nudge, or a rolling file — and on the Mac that is
   Tier 6 item 2, which is twenty lines and turns the mirror on by default.

Everything above finishes something already started. Nothing needs a new screen except onboarding,
which was already known — and one certificate, which needs a credit card rather than a decision.
