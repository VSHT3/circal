# audit

What is left to upgrade, improve, change or add. Explored 2026-08-12 against `8b8e8d5`; every claim
is grounded in the code or in a measurement, with the line.

**Status:** the four items marked _done_ below were built and verified the same day. Everything
else is still open, and the two biggest — the timezone model and the bundle — are open because
they need a decision rather than an afternoon.

**Headline: the parts that have been obsessed over are excellent and no bug was found in them.**
Geometry, recurrence, the cues, the transitions — clean. Everything worth doing sits at the edges
that never got a rationale written for them: **timezones, delivery weight, and the fact that
nothing enforces the gate.**

---

## Tier 0 — actually broken, or will bite

### 1. Events have no timezone, and the ICS round trip loses it

The biggest real defect. `fromIcs` reads `DTSTART;TZID=America/New_York:…090000` correctly into an
instant (`ics.ts:358-364`), but the model stores only epoch milliseconds — and `toIcs` writes every
timed event back as UTC (`ics.ts:240,245`). Two consequences.

Export is lossy: the wall-clock intent is gone. Worse, a subscribed recurring event **expands in
the browser's zone rather than its own**. A weekly 09:00 New York standup read from Berlin sits an
hour wrong for the three weeks a year when the US and EU transition dates disagree, and again for
every US-only transition.

The same fact is the travel bug: `CalEvent` carries no zone field at all, so a laptop that moves
re-reads every instant against a new local midnight.

Full support is genuinely large — an optional `tzid` on `CalEvent`, recurrence expanded in that
zone, an editor field, a backup validator. A cheap intermediate closes most of the damage: keep the
TZID on **feed** events only and expand those in the stated zone.

The suite could not see any of this: `tests/ics.test.ts` asserted what the model keeps and never
what it drops, so the loss was invisible to CI. **That half is now closed** — a
`what the round trip drops` block pins the TZID loss, the dropped collaboration and alarm
properties, and the task's lossy export. They are characterisation tests on purpose: the day the
model grows a zone, the test that says it is lossy fails, and that failure is how the fix
announces itself.

### 2. Feeds refresh only at launch — _done_

`refreshStaleFeeds` ran in one mount effect, with no interval and no `visibilitychange` re-pull, so
a tab left open all day quietly showed yesterday's calendar. Now `useFeedRefresh` (`hooks.ts`) makes
the same call three ways — on arrival, every `FEED_CHECK_MS`, and whenever the tab comes back to the
front. The check cadence is finer than `STALE_AFTER_MS` on purpose, so a tab that was hidden across
the boundary does not wait most of another half hour for the tick it slept through. The hook takes
no arguments and reads `store.snapshot()` at the moment of asking: every one of those callbacks
outlives the render that made it, and a pull writes a new `calendars` array. Verified in the
browser — a forced-stale subscription pulls on `visibilitychange`.

### 3. Nothing enforces `pnpm verify` — _done_

There was no `.github/` at all, and `deploy` never ran the gate. `.github/workflows/verify.yml` now
runs `pnpm verify` on every push to `main` and every pull request, with `--frozen-lockfile` — which
is half the point, since a mismatched lockfile is the one dependency problem a local install
silently repairs. Same single command a contributor runs, so the workflow cannot drift from it.

### 4. No error boundary — _done_

A single render throw gave true black, which is what this app looks like when it is working — and
to somebody whose only copy of a year lives in `localStorage`, indistinguishable from the calendar
having been eaten. `ErrorBoundary.tsx` now wraps the island: it says the events are untouched and
puts `Download backup` under it, reading `store.snapshot()` rather than a prop, because the tree
that held the snapshot is the tree that threw. `App` is the wrapper and `Shell` is the app —
a boundary cannot catch a throw from its own render. Verified by forcing one and screenshotting the
result.

### 5. No security headers, and the proxy is an open relay — _done, with one residual_

Three changes. **Headers**: `public/_headers` carries `Content-Security-Policy`,
`X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`, and `worker/index.ts` sets the
same list on what it serves itself. Both are needed and the reason is routing: with `assets.binding`
set and `run_worker_first` unset, a request matching a built asset never reaches the script at all,
while an unmatched path falls through to the Worker for the SPA fallback. Verified live on both
paths. The CSP is deliberately partial — `frame-ancestors`, `object-src` and `base-uri` are free on
a one-origin page that frames nothing; `script-src` and `connect-src` still need a nonce for the
inline SW registration and a decision about `feeds.ts`'s direct-fetch fallback, which is a build
change rather than a header.

**CORS**: `access-control-allow-origin: *` is gone. A same-origin `fetch` sends no `Origin` and
needs no answer, so the header is only ever echoed back to this site's own pages.

**Content**: any 2xx body used to be relabelled `text/calendar` and handed back, which launders a
login page or somebody's JSON through this origin. `looksLikeCalendar` requires the words in the
first kilobyte, leniently enough for a BOM and blank lines. It also turns the commonest
subscription mistake — pasting the page instead of its ICS link — into a sentence.

**The residual is real and named in the code**: a client that sends no `Origin` at all — curl, a
script — is indistinguishable from a same-origin page, so this stops browsers rather than everybody.
Closing it properly needs a rate limit or a token.

---

## Tier 1 — the manifesto's own argument, turned on the product

Measured from a real build. One chunk: **514 KB raw / 174 KB gzipped**, plus 57 KB gzipped of
React. Zero code splitting — Rolldown warns about it. `client:only` means the screen stays black
until all of it has downloaded _and_ parsed.

The manifesto says a page that ships React costs more to load than the product it describes. The
product currently ships all four views, both editors, the settings sheet and 43 KB gzipped of
Phosphor path data on the first byte, to draw a dial. Three splits, in order of return:

- **`icons.tsx` behind the mark picker.** Its own comment already prescribes exactly this — "a lazy
  chunk _plus_ an eager core" (`ui/icons.tsx:24-27`) — and it was never done. A quarter of the
  bundle, serving a control most people open once. Nothing in `src/components/react` uses `lazy`,
  `Suspense` or a dynamic `import(` today.
- **`LifeView` / `YearView` / `WeekView` lazy behind their view keys.** LifeView alone is 1,900
  lines and is nobody's default view.
- **`Settings` and `EventEditor` lazy behind their overlays.**

Free alongside it: both Geist families are `@import`ed with no `font-display` and no preload
(`global.css:15-16`), so first paint is a flash of nothing rather than a flash of fallback.

---

## Tier 2 — is this an actual calendar

Product gaps, not bugs. Some are fair to reject on thesis grounds; they are the wall a daily user
hits either way.

- **No invite path.** Someone emails an `.ics`; today it becomes a whole new calendar
  (`backup.ts` import routing). No `METHOD`, no `ORGANIZER`, no `ATTENDEE`, no accept or decline —
  none of those strings appear in `src/lib`. The most common inbound calendar action there is, and
  it does not exist. The reply half needs a channel this product has refused; **reading** an invite
  and showing who is coming does not.
- **Data safety is one wrong click from zero.** `localStorage` is the only copy and nothing ever
  prompts a backup. Two cheap and entirely on-thesis fixes: a nudge when the last export was N days
  ago, and the File System Access API keeping a rolling `.json` in a folder the user picks. No
  server, no account, and "I cleared site data" stops being fatal.
- **Export fidelity.** No `VTIMEZONE`, `VALARM`, `ATTENDEE`, `STATUS` or `CATEGORIES`. Tasks leave
  as zero-length VEVENTs with `X-CIRCAL-` lines, so any other app shows an instantaneous event and
  drops the ticks. At minimum the suite should assert **what is dropped**, so the loss is
  documented rather than discovered.
- **Missing everyday settings.** A default calendar for new events; a default duration
  (`DEFAULT_DURATION` is hard-coded, `quickadd.ts:44`); **week start is hard-wired to Monday**,
  which is wrong for much of the world and also silently defines the life grid's column arithmetic;
  working hours (`WAKING` is a constant).

---

## Tier 3 — the phone

The hard structural work is done — the drawer, the measured breakpoints — and then the controls are
sized for a mouse. `IconButton` 28px (`primitives.tsx:79`), `Segmented` items 24px (`:157`), the
position picker's cells 17px (`:269`), the colour swatch 18px (`:468`). All well under the 44px
touch minimum.

And the two most interesting interactions in the app — the year ring's magnifier and the life
loupe — are both hover-and-dwell, with no coarse-pointer branch anywhere in the codebase (no
`pointerType`, no `(pointer: coarse)`, no `@media (hover)` in any of the four faces). Padding hit
areas without growing the glyphs is mechanical. Deciding what the loupe means on a finger is a
design question worth actually answering.

Still open from `APP.md`: every `⌘` label lies to Windows and Linux visitors. Flagged as a live
bug, left as an open decision, still open.

_Checked and cleared:_ `prefers-reduced-motion` is handled properly — the blanket rule in
`global.css:271` plus `useReducedMotion` threaded through every animating component. Not a gap.

---

## Tier 4 — structure, if the building continues

Four files carry the app: `App.tsx` 1693, `LifeView.tsx` 1900, `Face.tsx` 1454, `YearView.tsx` 1146. Three extractions that change no behaviour:

- The **transition DSL** out of `App.tsx` (`:114-320`, ~200 lines of pure config, no shell state).
- The **canvas engine** out of `LifeView.tsx` (`:620-850+`, ~700 self-contained lines).
- **Recurrence-to-English** out of `EventEditor.tsx` (`:165-336`, ~170 lines of pure string logic).
  By the standing rule, moving it into `src/lib/` earns it a test file — which it cannot have where
  it sits.

One thing that breaks a rule written here on purpose: there are **three recurrence validators** —
`store.hydrateEvents`, `backup.readRecurrence`, `ics.readRecurrence` — with different behaviour
(backup clamps interval to 999, store does not). The second-convention smell, three times over.

Smaller:

- `Face` is exported without `memo` (`Face.tsx:270`), so the week strip re-diffs seven SVG subtrees
  every minute when one of them uses the clock. **Attempted and abandoned**: the memo only bites if
  the six non-today faces stop being handed the ticking `now` _and_ `WeekView`'s per-day `peek`
  callback stops being minted inside the render's `map`. That is a restructure of a 492-line view,
  and the payoff is a reconciliation pass that writes no DOM. Not worth it until the view is being
  opened for another reason.
- ~~`duplicateOf`'s cross-midnight key shifting and `trimFeed`'s recurring-first ordering have no
  tests~~ — **wrong, and worth recording as wrong.** Both are covered: `tests/store.test.ts` pins
  `duplicateOf`'s day-form key across a midnight-crossing shift, and the feed-budget cases assert
  that a recurring event survives a trim while the far-away dated ones do not. Read the suite before
  believing a report about it.
- `readEvent`'s id fallback is `Math.random` (`backup.ts:~305`) where `ics.ts` derives a stable
  FNV uid for the same problem — so a backup imported twice cannot be de-duplicated.
- Feed-load and migration failures are swallowed silently (`store.ts` `readFeeds`, `migrateFeeds`);
  only the main blob write notifies.

---

## Tier 5 — additions worth arguing for

Not defects. Ideas that fit the product's own grammar.

- **The document title as the reminder that survives a backgrounded tab.** Push needs a server. The
  tab title does not, and `· 14m · Standup` works whenever the browser is open — which is the
  honest maximum this product can reach. The closed-tab gap closed as far as it goes.
- **Search the year ring.** The life grid lights every matching day; the ring does not. Same
  `scoreEvent` call one face over, and the year is the scale where "when in the year do I do this"
  has a shape.
- **Timezone travel as a moment, not a corruption.** Short of per-event TZID: notice the device
  zone changed since last launch and ask, once, in a `BirthPrompt`-shaped screen. Cheap, honest,
  and it turns a silent wrong answer into a decision somebody made.
- **A drag across the week strip.** Not editing — press, drag, release across faces making a
  multi-day event, which is the gesture the year ring and the life grid already have. The one scale
  missing from a grammar applied everywhere else, and it costs one handler.

---

## If it were five things

1. ~~Refresh feeds on an interval and on tab focus.~~ **Done.**
2. ~~CI running `pnpm verify`, and gate the deploy on it.~~ **Done.**
3. Code-split the icon table and the three non-default views. _(a day, and the one users feel)_
4. ~~An error boundary that names the backup button.~~ **Done.**
5. Decide the timezone question — even if the answer is "feeds only, expanded in their stated
   zone". _(the real work)_

Three of the five are done, and the two left are the two that were never an afternoon's work. Both
are blocked on a decision rather than on effort, and both are worth taking slowly.

**Why (3) was not just done.** It is mechanical-looking and it is not. `ui/icons.tsx` prescribes
its own split — "a lazy chunk plus an eager core" — precisely because a mark has to render on the
first frame, and a dot that pops into an icon half a second later is the failure that comment
already rejects; the split needs the 247-path table separated from `CalendarMark` first. And the
view chunks cannot be lazy naively: the day ⇄ life zoom and the year ⇄ life unroll hold both panels
mounted and hand geometry between them, so a view that arrives one frame late arrives during a
transition that has already started. Both are real work with a real design question in front of
them, which is exactly the kind of thing that should not be done autonomously.

Everything above finishes something already started. Nothing needs a new screen except onboarding,
which was already known.
