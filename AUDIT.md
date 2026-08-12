# audit

What is left to upgrade, improve, change or add. Explored 2026-08-12 against `8b8e8d5`; every claim
is grounded in the code or in a measurement, with the line.

**Status:** every item marked _done_ below was built and verified the same day. Three rounds so far
— the Tier 0 four; the mechanical bucket (three extractions, the backup id, the font preload, the
coarse-pointer targets, the icon table's separation); and the round that needed one call each (the
single recurrence validator, the modifier label, the two silent catches, and the first two everyday
settings). What is left is left because it needs a decision rather than an afternoon: timezones,
the lazy chunks, week start, and what the loupe means on a finger.

**Headline, as first written: the parts that have been obsessed over are excellent and no bug was
found in them.** That held for geometry, recurrence and the cues, and it was **wrong about the
transitions** — moving the table out of `App.tsx` found that every panel's `exit` had resolved to
nothing since `4333b66`, because the `variants` prop it was a label for had been dropped. A silent
failure with no type error and no lint, in the one part of the app that is verified by eye. The
rest still stands: what is worth doing sits at the edges that never got a rationale written for
them — **timezones and delivery weight**.

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
  chunk _plus_ an eager core" — and the table it describes is now its own module (`ui/marks.ts`),
  which was the part that had to happen first: the data and the component that must draw on the
  first frame could not be moved apart by a bundler while they were one file. **The split itself is
  still open**, and still wants the design call about what renders for the frame before the chunk
  lands. Nothing in `src/components/react` uses `lazy`, `Suspense` or a dynamic `import(` today.
- **`LifeView` / `YearView` / `WeekView` lazy behind their view keys.** LifeView is 1,637 lines
  after the canvas engine came out of it, and is nobody's default view.
- **`Settings` and `EventEditor` lazy behind their overlays.**

~~Free alongside it: both Geist families are `@import`ed with no `font-display` and no preload.~~
**Half wrong, and now done.** Fontsource ships `font-display: swap` on every face, so first paint
was always a fallback rather than nothing — the real cost was discovery, one round trip behind the
stylesheet. `Base.astro` preloads the two latin subsets through Vite, so the `href` is the same
hashed file the CSS asks for.

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
- **Missing everyday settings.** ~~A default calendar for new events; a default duration~~ —
  **both done**, in a `New event` card: the length is one number for ⌘N and quick-add alike, and
  the calendar is an id resolved at the moment of use rather than clamped on load. Still open, and
  both bigger than they look: **week start is hard-wired to Monday**, which is wrong for much of
  the world and also silently defines the life grid's column arithmetic and the loupe's transpose;
  and working hours (`WAKING` is a constant that `freeGaps` and the palette's slot search must keep
  meaning the same thing by).

---

## Tier 3 — the phone

The hard structural work is done — the drawer, the measured breakpoints — and then the controls
were sized for a mouse. `IconButton` 28px, `Segmented` items 24px, the position picker's cells
17px, the colour swatch 18px, all well under the 44px touch minimum. **Done**: each grows under
`pointer-coarse`, which is the first coarse-pointer branch in the codebase — 40px for the icon
button and the pill, 36 for a segment, 34 for a picker cell, 30 for a swatch, and a real 44px
pseudo-element for the `Switch`, whose knob sits at hardcoded offsets so the track cannot move.
Grown rather than padded everywhere else on purpose: these sit two and three to a group at a 2–3px
gap, so a hit area wider than the pitch reaches past its neighbour's centre and DOM order decides
the tap. Mouse layout is untouched; no overflow at 360, 390, 430 or 768.

Still open, and the interesting half: the two best interactions in the app — the year ring's
magnifier and the life loupe — are hover-and-dwell, and what they mean on a finger is a design
question worth actually answering rather than a size to change.

~~Still open from `APP.md`: every `⌘` label lies to Windows and Linux visitors.~~ **Done.**
`useHotkeys` always accepted `metaKey || ctrlKey`, so the chips were the only Mac-only part of the
app. One `MOD` constant, read from the platform at module scope — the island is `client:only`, so
nothing can disagree with it — across the top bar, the palette, both editors and five toasts. Only
⌘ is translated: ⇧, ↵ and ⌫ are printed on the keys themselves. `Ctrl` is 40px against ⌘'s 18, so
the two measured thresholds move with the spelling (readout 1220/1450, wordmark 1430/1660), swept
360 → 1700 on both spellings with the Mac numbers unchanged.

_Checked and cleared:_ `prefers-reduced-motion` is handled properly — the blanket rule in
`global.css:271` plus `useReducedMotion` threaded through every animating component. Not a gap.

---

## Tier 4 — structure, if the building continues

Four files carried the app. Three extractions that changed no behaviour, all **done**:

- The **transition DSL** out of `App.tsx` → `components/react/transitions.ts`. App.tsx 1711 → 1501.
- The **canvas engine** out of `LifeView.tsx` → `components/react/lifeCanvas.ts`. 1900 → 1637.
- **Recurrence-to-English** out of `EventEditor.tsx` → `lib/describe.ts`, which earns it the test
  file it could not have where it sat: `tests/describe.test.ts`, 35 cases over `isExpressible`'s
  gate, `describeRule`'s clause order and BYSETPOS read as an adjective.

**And the transition DSL was half dead when it was moved.** `4333b66` took `initial`/`active` off
variant labels to fix a leaving panel that re-resolved the arriving one's animation — correctly —
but dropped the `variants` prop with them while `exit="exit"` stayed a label. So for two months
every panel exit resolved to nothing: the dial popped out instead of shrinking onto its dot on ⌘L
and onto its face on ⌘E, and an ordinary crossfade lost its fade-out. Objects passed to
`initial`/`animate` outrank the table, so handing `PANEL` over whole restores the exit and keeps
the frozen-props fix. The lesson is the general one: **a variant label with no table to resolve
against fails silently**, and nothing in the type system or the linter says so.

~~One thing that breaks a rule written here on purpose: there are three recurrence validators.~~
**Done.** The RFC ranges are one table in `recur.ts` and `readRecurrence` is the one
unknown-to-`Recurrence` reader; the three keep their different jobs — validate untrusted JSON, fill
fields a blob predates, parse RRULE strings — and share the rules. It found a loss on the way:
backup's reader returned a bare `NEVER` for a rule of `never`, so an RDATE-only series lost every
date a producer had named explicitly through a `.json` round trip. The dates are read before the
frequency now, which is what `ics.ts` already did and what `repeats()` has always claimed.

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
- ~~`readEvent`'s id fallback is `Math.random`~~ — **done.** It derives from the record's own
  content now, through the FNV-1a `ics.ts` already used for a UID-less VEVENT and now exports as
  `fnv1a`. A backup imported twice is the same events twice, not two copies of each.
- ~~Feed-load and migration failures are swallowed silently~~ — **done, in the half that was
  wrong.** A corrupt blob started the app empty and said nothing, which is indistinguishable from a
  first run, and the feed migration's own blob write swallowed a quota refusal that repeats every
  launch; both notify now. `readFeeds` keeps its silence, which is deliberate and documented: a
  corrupt payload is a cache miss the next pull replaces.

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
3. Code-split the icon table and the three non-default views. _(the table is now a module of its
   own, `ui/marks.ts`, which was the prerequisite; the lazy chunk itself is still open)_
4. ~~An error boundary that names the backup button.~~ **Done.**
5. Decide the timezone question — even if the answer is "feeds only, expanded in their stated
   zone". _(the real work)_

Three of the five are done, and the two left are the two that were never an afternoon's work. Both
are blocked on a decision rather than on effort, and both are worth taking slowly.

**Why (3) is still not done.** It is mechanical-looking and it is not. `ui/icons.tsx` prescribes
its own split — "a lazy chunk plus an eager core" — precisely because a mark has to render on the
first frame, and a dot that pops into an icon half a second later is the failure that comment
already rejects. The 247-path table has now been separated from `CalendarMark`, so the split is
reachable; what it still needs is the answer to what the first frame draws. And the view chunks
cannot be lazy naively: the day ⇄ life zoom and the year ⇄ life unroll hold both panels mounted and
hand geometry between them, so a view that arrives one frame late arrives during a transition that
has already started. Both are real work with a real design question in front of them, which is
exactly the kind of thing that should not be done autonomously.

Everything above finishes something already started. Nothing needs a new screen except onboarding,
which was already known.
