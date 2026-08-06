# Repository Guidelines

## Project Overview

**circal** = calendar where day view is single dial — web recreation of Raycast macOS app _Radical_. One revolution = one day, clockwise 0.25°/minute. Events = arcs, elapsed day = ramp of light around rim, hand = current minute.

Three views, one idea at three scales: **dial** (`⌘D`) = one day, **year grid** (`⌘Y`) = twelve months of it, **life grid** (`⌘L`) = every day you get — one dot each, birth date to expectancy, one viewport. Day ⇄ life = _zoom_, only pair where same thing drawn at two scales: dial collapses onto dot of day it showing, grid wave radiates out from it. Other pairs crossfade — year grid not magnified anything.

`Clock` setting picks only what face _called_, never geometry: `12h` puts noon top, labels `12 · 1…11` twice with AM/PM captions; `24h` puts midnight top, labels `00 · 1…23`. Switch = 180° rotation plus relabel, so event arc has same length and sweep either face. Also governs **every printed time** — readout, agenda, sidebar, palette, editor — so `splitTime` / `formatTime` / `formatTimeShort` all take `Clock` and any surface printing one must thread it.

No account, no sync, no server-side state. User events live in
`localStorage` under `circal.v1`. Ships as Cloudflare Worker serving
static assets plus **exactly one route** — `/api/feed`, CORS proxy for ICS
subscriptions, because no calendar host sends CORS headers. Adding second
route? Stop: that different product.

`README.md` covers user-facing keyboard table and feature tour — this file covers parts you need to _edit_ code safely.

## Architecture & Data Flow

```
src/pages/index.astro   static HTML shell
  └─ <App client:only="react" />        ← the ONLY island in the project
       ├─ useStore()   → { events, calendars, feeds, settings }   (persisted)
       ├─ useState ×5  → location{day,view}, sidebar, editor, palette, settings
       ├─ useNow()     → ticking Date, second-aligned
       └─ actions: ShellActions (one useMemo object)
            ├─ TopBar / Sidebar / CommandPalette / Settings  receive `actions` whole
            └─ Dial / EventEditor / YearView / LifeView      receive narrow callbacks

  Settings travel as one `settings: Settings` prop, never field by field.
```

- **`src/lib/` = domain layer**, mostly pure. Dependency direction one-way: `time.ts` (base, imports nothing) ← `dial.ts`, `events.ts`, `sun.ts`, `ics.ts` ← `life.ts`, `store.ts` ← `feeds.ts`, `backup.ts`. Components import via `@/lib/*`, never reimplement geometry or date maths locally. **Every module here already has a test file** — `tests/<module>.test.ts`; change one, add the case there.
- **Store = only source of truth for persisted data.** `App.tsx` holds _view_ state only. Mutations go through `store.*` — never `setState` copy of event. Settings-only mutations (`setSecondZone`, `setPlace`, `addFeed`, `removeCalendar`) called straight from `Settings.tsx`, not routed through `ShellActions`, because shell has nothing to update for them.
- **Two event lists.** `snapshot.events` = what user wrote; `snapshot.feeds[calendarId]` = what subscription mirrored. `App.tsx` concatenates into `visible` for rendering, and _only_ that. Nothing writes to `feeds` except `lib/feeds.ts`, nothing exports it, event whose calendar has `feed` opens read-only.
- **`dayAgenda(events, calendars, day)`** = single read path onto a day: expands recurrence, clips to day, packs overlapping events onto concentric lanes. `Dial`, `CenterPanel`, `Sidebar` all render from its output.
- **Units.** Everything inside dial = _minutes since local midnight_ (`0…1440`). `CalEvent.start`/`end` = **epoch milliseconds**, `end` **exclusive**. Nothing downstream of `dayAgenda` reasons about `Date`.
- **Day and view = URL.** `?d=YYYY-MM-DD&v=year|life`, written through `go()` in `App.tsx`: `push` for deliberate jump, `replace` for arrow stepping. `go` reads current location from ref, not from render closure — two `go` calls in one tick would clobber each other. `v` omitted for day view, validated against `VIEWS` on way in.
- **Panels take `settings` whole, not one prop per field.** `Dial` reads thirteen, `Settings` fifteen; threaded individually, adding one boolean meant editing six files — `Settings` interface, panel's prop interface in `types.ts`, `App.tsx` forwarding, panel's destructure, `backup.ts`. Object = same bargain already struck for `actions`: one prop, shell has nothing to forward. Panels destructure on first line of body, so bodies read exactly as before. `zonePlace` = one exception, stays own prop — shell derives it from `settings.secondZone` via `placeForZone`, so not a setting.

## Key Directories

| Path                                     | Purpose                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/dial.ts`                        | Polar geometry: `DIAL` radius table, `angleAt` / `polar` / `arcPath` / `minutesAtPoint` / `capInset` / `arcLabel`                                     |
| `src/lib/life.ts`                        | Life grid: `lifeSpan` / `lifeCellAt` / `lifeDensity` / `lifeStats`, `dim` (`lifeLayout` / `lifeCell` internal)                                        |
| `src/lib/time.ts`                        | `Clock` type, day arithmetic, formatting voice (`formatTime`, `parseClock`, `dayKey`), zone maths (`zonedToUtc`)                                      |
| `src/lib/recur.ts`                       | RFC 5545 recurrence: `Recurrence`, `startsBetween`, `countedUntil`, `instantKey`. The whole BY\* cascade                                              |
| `src/lib/events.ts`                      | `CalEvent` / `Calendar` / `Occurrence`, `occurrencesOn`, `dayAgenda`, `freeGaps` (`packLanes` internal)                                               |
| `src/lib/sun.ts`                         | `Place`, `sunTimes` — NOAA solar position, minutes since local midnight                                                                               |
| `src/lib/places.ts`                      | `PickedPlace`, `placeForZone`, `PLACE_OPTIONS` — IANA `zone.tab` coordinate table                                                                     |
| `src/lib/ics.ts`                         | `toIcs` / `fromIcs`. RFC 5545 incl. full RRULE, EXDATE, RDATE, RECURRENCE-ID. Hand-rolled, no dependency                                              |
| `src/lib/store.ts`                       | `useSyncExternalStore` over `localStorage`, `draftEvent`, seed data, undo history, `SCHEMA` version                                                   |
| `src/lib/feeds.ts`                       | Subscription pulls, through `/api/feed` then direct                                                                                                   |
| `src/lib/backup.ts`                      | Export/import, only place validating external input. `readEvent`/`readSettings`/`readCalendar`/`importBackup` exported so the validators are testable |
| `src/lib/notify.ts`                      | Toast channel. Own store on purpose — four-second message not persisted state                                                                         |
| `src/lib/feedback.ts`                    | Dial's five cues: 3 ms noise impulse through bandpass resonators. Owns shared `AudioContext`                                                          |
| `src/lib/keys.ts`                        | Keyboard: every key a sum of damped sinusoids. No asset, no fetch                                                                                     |
| `worker/index.ts`                        | Assets + `/api/feed` proxy. `followChecked` re-runs the SSRF guard on every redirect hop; `ssrfBlockReason` exported for its table                    |
| `public/sw.js`                           | Offline cache. Runtime-only: Astro content-hashes filenames, so nothing to precache                                                                   |
| `public/favicon.svg`                     | Mark: black disc, one thin white circumference. `icon.svg` = same ring full-bleed for maskable crop                                                   |
| `src/components/react/`                  | Island. `App.tsx` shell, `Dial.tsx` instrument, panels                                                                                                |
| `src/components/react/ui/primitives.tsx` | Ten shared controls all chrome built from                                                                                                             |
| `src/components/react/types.ts`          | **Every panel prop interface.** Edit shapes here                                                                                                      |
| `src/styles/global.css`                  | Design tokens, `@theme inline` colour mappings, five component classes                                                                                |
| `tests/`                                 | **The suite — 602 cases.** `helpers.ts` = fixtures + matchers; one `*.test.ts` per module; `west/` = TZ re-runs                                       |

## Development Commands

```sh
pnpm install
pnpm dev        # astro dev — http://localhost:4321. NO /api/feed here
pnpm dev:worker # astro build && wrangler dev — the only way to exercise /api/feed
pnpm test       # vitest run — two TZ-pinned projects
pnpm test:watch # vitest
pnpm verify     # THE gate: format:check && lint && check && test && build
pnpm format     # prettier --write . (run this, never hand-format)
pnpm deploy     # astro build && wrangler deploy
```

`pnpm verify` = only quality gate; run before declaring work done. Individual steps: `pnpm format:check`, `pnpm lint` (eslint), `pnpm check` (astro check / tsc), `pnpm test` (vitest), `pnpm build`.

## Git & Commits

Commit **regularly** — one commit per coherent change, not one per session. Commit
touching dial geometry, store schema, and a doc in same breath cannot be
reverted, bisected, or reviewed.

- **Conventional Commits**: `<type>(<scope>): <imperative summary>`, scope
  optional. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`,
  `build`, `ci`, `style`, `revert`.
- Subject ≤ 50 chars where fits, hard cap 72. Imperative mood, lowercase
  after colon, no trailing period.
- Scope = area, not filename: `dial`, `center-panel`, `store`,
  `events`, `time`, `sidebar`, `palette`, `editor`, `styles`.
- **Body only when _why_ not obvious** from diff — rendering
  artefact worked around, schema bump, reverted decision. Wrap at
  72, bullets `-`, issue refs last (`Closes #42`).
- Never: AI attribution trailers, "this commit does X", emoji, restating
  filename scope already names.
- Run `pnpm verify` before committing. Gate is per-commit, not per-branch.

## Code Conventions & Common Patterns

**Imports** — always `@/*` alias (`@/lib/events`, `@/components/react/types`), never deep relative paths out of directory.

**Formatting** — Prettier, `printWidth: 100`. `prettier-plugin-tailwindcss` sorts Tailwind classes automatically, including inside `cn()` and `cva()`. **Never hand-sort class strings**; run `pnpm format`.

**Styling** — Tailwind v4, config-less; theme lives in `src/styles/global.css`. Use token utilities, not raw hex:

| Utility                          | Token                             | Use                                     |
| -------------------------------- | --------------------------------- | --------------------------------------- |
| `bg-void`                        | `#000000`                         | canvas, true black                      |
| `bg-surface` / `bg-surface-2`    | `#131315` / `#1d1d20`             | popovers & cards / controls inside them |
| `border-hairline`                | `rgba(255,255,255,.08)`           | every divider                           |
| `text-ink`                       | `#ffffff`                         | only pure white                         |
| `text-ink-2` / `ink-3` / `ink-4` | `#8e8e93` / `#5c5c60` / `#2e2e31` | secondary / numerals / ticks & disabled |
| `text-accent`                    | `#a3d9e4`                         | default calendar colour                 |
| `text-danger`                    | `#ff5a5a`                         | destructive only                        |

`fill-*` and `stroke-*` variants exist too, used in SVG. Component classes: `.label` (uppercase 11px mono, app's label voice), `.kbd`, `.fade-y` (mask both ends of scroll area), `.fade-b` (bottom only, proportional — for short list whose first row must stay crisp), `.no-scrollbar` — pair fade with `.no-scrollbar` on every scroll region, apply fade **only when list actually overflows**; permanent fade on list that fits reads as rendering fault. Chrome greyscale by rule: **colour belongs to events**. Never read `calendar.color` or `event.color` directly — call `colorOf(event, calendars)`, resolves event's own override first, falls back to its calendar. Presets live in `PALETTE` (`src/lib/events.ts`): ten digital pastels, high value and moderate saturation so two can share a dial at 14-unit stroke.

**New chrome must reuse `ui/primitives.tsx`** — `Kbd`, `FieldRow`, `IconButton`, `ActionPill`, `Segmented`, `Switch`, `Toggle`, `Select`, `DateField`, `NumberField`. Do not hand-roll a button. `FieldRow` = modal row grid shared by event editor and settings panel; two modals with two row grids = two products. `Toggle` = `Switch` plus own text label, for settings sitting two and three to a row. `DateField` = native `input[type=date]` under face of your choosing — `openDatePicker` lives beside it, because clicking field of date input opens nothing in Chrome or Safari.

**State sync — hard convention.** `react-hooks/set-state-in-effect` active, rejects effect copying props into state. When new props must reset local state, use React render-phase adjustment pattern (three existing sites: `Sidebar.tsx:41`, `EventEditor.tsx:201`, `CommandPalette.tsx:201`):

```tsx
const [seeded, setSeeded] = useState(day);
if (seeded !== day) {
  setSeeded(day);
  setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
}
```

**Effects for external systems only** — `window` listeners, `ResizeObserver`, timers.

**Hotkeys** — `useHotkeys({ "mod+k": fn })`. Combo format: optional `mod+` (⌘ or Ctrl), optional `shift+`, then lowercased `e.key` (`k`, `escape`, `arrowleft`, `t`). `shift+` part of combo whenever Shift held, printable keys included — without it `⇧⌘Z` and `⌘Z` same string and redo becomes undo. Handlers skipped while user typing in input unless combo carries `mod` or is `Escape`.

**TypeScript** — `strict`, no `any`. Prefix intentionally unused bindings with `_`.

**Comments** explain _why_, never _what_. Most non-obvious decisions here already carry one; read before changing line.

## Important Files

| File                                | Why it matters                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`             | Only route. Mounts `<App client:only="react" />` — `client:only` because live clock plus `localStorage` makes any SSR markup wrong on hydrate                                                            |
| `src/components/react/App.tsx`      | Island root; owns view state and URL, builds `actions`, registers global hotkeys                                                                                                                         |
| `src/components/react/Dial.tsx`     | Instrument. Draw order: glow → your lightcycle band → second zone's band → zone numerals → elapsed ring → ticks → numerals → drag annulus → event arcs (body → label → hit zones) → ghost arc → now-hand |
| `src/components/react/LifeView.tsx` | Life grid. Offscreen canvas for field, masked one for reveal, SVG overlay for everything following pointer, birth prompt as own empty state                                                              |
| `src/components/react/types.ts`     | All panel prop contracts (`DialProps` and `CenterPanelProps` = two deliberate exceptions, declared locally)                                                                                              |
| `astro.config.mjs`                  | `devToolbar: false` (floats over dial), `trailingSlash: "always"`                                                                                                                                        |
| `eslint.config.js`                  | Flat config; `jsx-a11y/no-autofocus` off for exactly `CommandPalette.tsx` and `EventEditor.tsx` (modals must take focus)                                                                                 |
| `wrangler.jsonc`                    | `main` + `assets.binding` — Worker exists for `/api/feed` and nothing else                                                                                                                               |
| `vitest.config.ts`                  | Two projects, `local` and `west`, each with its own pinned `TZ`. The pinning is not optional — see Testing                                                                                               |
| `tests/helpers.ts`                  | **Fixtures and the three instant matchers.** Read before writing any test; extend here rather than re-declaring builders in a test file                                                                  |

## Runtime/Tooling Preferences

- **Node ≥ 22.12.0**, **pnpm 11.2.2** (pinned via `packageManager`). Not Bun, not npm — `pnpm-lock.yaml` and `pnpm-workspace.yaml` authoritative.
- `pnpm-workspace.yaml` **not** monorepo marker; holds `allowBuilds` whitelist for native deps (`esbuild`, `@tailwindcss/oxide`, `lightningcss`, `sharp`, `workerd`). Add to it if new dep needs build script.
- Animation = **`motion`**, not `framer-motion` — `import { motion, useReducedMotion } from "motion/react"`, always honour `useReducedMotion`.
- Icons = `lucide-react` at `size={14}`–`15`, `strokeWidth={1.75}`.
- **No state-management library**, no UI-component library; `clsx` + `tailwind-merge` back `cn()` in `src/lib/utils.ts`.
- Fonts self-hosted via Fontsource (Geist / Geist Mono). No external requests at runtime.

## Testing & QA

**There IS a suite. Read it before writing one.** Vitest, `tests/`, 602 cases, ~450 ms, wired into `verify`. Adding coverage = adding cases to the file below that already owns the module. Never scaffold a second harness, never a second fixture style, never a `*.spec.ts`.

| test file                    | covers                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `tests/helpers.ts`           | **not a test** — fixtures, builders, matchers. Extend, never fork           |
| `tests/time.test.ts`         | `time.ts` — day arithmetic, DST, `parseClock`, `zonedToUtc`                 |
| `tests/dial.test.ts`         | `dial.ts` — `angleAt` ↔ `minutesAtPoint`, `arcPath`, `capInset`, `arcLabel` |
| `tests/recur.test.ts`        | `recur.ts` — RFC 5545 §3.8.5.3 worked examples, BY\* , BYSETPOS             |
| `tests/events.test.ts`       | `events.ts` — clipping, lanes, overrides, `freeGaps`, `colorOf`, `inkOn`    |
| `tests/ics.test.ts`          | `ics.ts` — round-trip, folding, escaping, malformed feeds                   |
| `tests/store.test.ts`        | `store.ts` — write/delete/move, undo, cross-tab, `sane`, seeding            |
| `tests/backup.test.ts`       | `backup.ts` — hostile input, orphan reparenting                             |
| `tests/feeds.test.ts`        | `feeds.ts` — id stability, errors, cross-tab undo                           |
| `tests/life.test.ts`         | `life.ts` — `lifeCellAt` inverse, splits, density policy                    |
| `tests/sun.test.ts`          | `sun.ts` — NOAA references, polar cases, no clipping                        |
| `tests/worker.test.ts`       | `ssrfBlockReason` — the hostname table                                      |
| `tests/worker-proxy.test.ts` | `/api/feed` — routing, redirect chain, caps                                 |
| `tests/west/*.test.ts`       | zone-sensitive invariants, re-run west of UTC                               |

**Two projects, and the split is load-bearing.** `local` runs `tests/**` at `TZ=Europe/Berlin`; `west` runs `tests/west/**` at `TZ=America/Los_Angeles`, own process. Nearly every date function here deliberately local-time, so unpinned suite passes in one zone and fails in other. Own process because TZ change after Node started not reliably observed. **Touching `dayKey`, `zonedToUtc`, `startOfDay`, `addDays` or anything day-keyed? Add the case to `tests/west/` too.**

**`tests/helpers.ts` = the shared floor.** Import it in every test file — that import registers the matchers.

| helper                                   | use                                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `at("2026-03-08 09:30")`                 | local `Date`. **Never `new Date("2026-01-01")`** — parses as UTC |
| `ms(stamp)` / `day("2026-03-08")`        | epoch ms / local midnight                                        |
| `event({ start: "…", title: "…" })`      | full `CalEvent`, all 16 recurrence fields defaulted              |
| `calendar()` / `rule()` / `byDay("1FR")` | `Calendar` / `Recurrence` / `WeekdayRule[]`                      |
| `MemoryStorage`                          | `Storage` stand-in; `.quota = 0` makes `setItem` throw           |
| `show(dateOrMs)`                         | `2026-03-08 09:30 Sun` — the one way an instant is printed       |

**Three matchers, and instants MUST use them** — they print aligned actual/expected columns with `(missing)` / `(unexpected)` / `(out of order)`, because a 40-instance RRULE diff as raw epoch integers is not a diff:

```ts
expect(instants).toBeInstants(["2026-03-08 09:00", "2026-03-15 09:00"]);
expect(instants).toOccurOn(["2026-03-08", "2026-03-15"]); // days only
expect(occ.start).toBeSameInstantAs("2026-03-08 09:00");
```

**Scope = domain layer only** — `src/lib/*` plus worker's pure guards. No DOM, no jsdom, no component tests. Snapshot of SVG path = change-detector failing on every legitimate geometry tweak; dial verified by eye. `feedback.ts` / `keys.ts` need real `AudioContext`, tuned by offline measurement, not asserted. Four open items in `TODO.md`'s correctness table are DOM-shaped for exactly this reason.

**Store and feeds tests need `vi.resetModules()` + `await import(…)`.** `snapshot`, `lastRaw`, `hydrated`, `past`, `future` are module-level and deliberately survive a page reload — which is what a static import would share between tests. That dynamic import = sanctioned exception to static-import rule; `tests/store.test.ts`'s `freshStore()` is the pattern, copy it. `store.subscribe` is exported so the cross-tab and seeding paths can run without React; `withWindow()` there stubs the one `addEventListener` it needs.

**Test the invariant a `why` comment already names.** Most non-obvious lines in `src/lib/` carry one; that comment is the contract worth pinning. Every test must be able to fail on a plausible bug — never plumbing, source text, or a default equalling itself. Table-driven: `it.each` with `$name` templating so a failure names the case, `expect.soft` so every row reports.

**`pnpm verify` still proves nothing about how it _looks_.** Visual change verified by driving it: `pnpm dev`, exercise the path (create event, drag ring, ⌘P, switch face, step days), screenshot. Anything touching `/api/feed`, service worker, or manifest needs `pnpm dev:worker` — `astro dev` serves neither Worker route nor PROD build.

## Gotchas

- **`dayKey()` deliberately local-time.** `toISOString()` shifts day west of UTC, exactly where day-keyed store breaks. Never swap it in.
- **`angleAt` and `minutesAtPoint` exact inverses** and must stay so. Both take `Clock`, differ only by `origin()` — minute sitting at top (720 for `12h`, 0 for `24h`).
- **`arcPath` draws full turn as two half-arcs**, because single elliptical arc whose endpoints coincide renders nothing. Removing branch makes whole-day arc vanish.
- **Gradient built from overlapping strokes must be opaque.** Elapsed ring = chain of arcs, translucent ones compound alpha wherever they overlap — every join paints bright bead, trail reads as row of tick marks. On true-black canvas opaque grey identical to translucent white, so `Dial.tsx` ramps _colour_ (`grey(level)`), uses butt caps between segments, rounds only two ends of whole run.
- **Now-hand stops at `DIAL.HAND_INNER` (205).** Hand through centre crosses readout and agenda — lot of ink spent on time readout already prints. It a spoke: pip on track at exact minute, fading out along `userSpaceOnUse` gradient before centre panel. If panel grows, `HAND_INNER` must clear its furthest corner — with totals line on, lowest thing sits ~135 units below centre and 113 out from it, so corner = 176 and 29 units in hand.
- **Centre = one display with four moods, ordered.** `CenterPanel.tsx` resolves `span` first — range being dragged, else arc under pointer — then today's time, then date. Drag and hover print _same_ thing because same question, so share branch rather than each growing one. Size change = CSS `font-size` transition at 140 ms on `var(--ease)`, matched to arc's own stroke-width transition: arc thickening and clock shrinking into its span = one movement, splitting the two curves makes it read as two events.
- **Headline row = first _timed_, non-past occurrence, only on today.** All-day event = context, never next thing, never `running` either — `Now … ends in 10h 4m` = countdown to midnight dressed as appointment. Headline drops start time (ring is where start time lives), spends width on name and wait, also why `untilText` rounds _down_: countdown overstating time you have is worse than no countdown. Under `IMMINENT_MS` dot takes ring rather than pulse — pulse already means "running", one signal cannot mean two things.
- **Hovered occurrence added back to card even when ended.** Today's card filters to `occ.end > now`, so without exception, pointing at morning arc printed span with no name beside it. Costs one row of shift while pointer on past arc — honest position for it.
- **`totals` measured against two different windows on purpose.** Booked = whole revolution — six o'clock run is time spent — while free is only `WAKING`, because "nineteen hours free" not an offer. They do not sum to anything, nobody adds them. `WAKING` lives in `events.ts` beside `freeGaps`; palette's slot search and this line must mean same thing by the word.
- **`totalsAt` places line against _stage_, not dial.** `center` = only one rendered inside panel's column, under card; other eight = `flex` layer at `inset-0` with `p-4`, so corner = _window's_ corner — black a circle in landscape window never reaches. `CORNERS` in `CenterPanel.tsx` maps them, deliberately has no `center` key: that position not corner of anything.
- **Ring drag accumulates sweep; never measures from grab.** `Draw` holds `{ from, at, sweep }` and `onRingMove` sums `wrapDelta` per pointer event, exactly as arc's drag does. Measuring from grab caps new event at twelve hours and turns range inside out past that, because `wrapDelta` takes short way. Sweep clamped to `[-from, 1440 - from]` — clamping _sweep_ rather than resulting instant makes range stop dead at midnight and follow pointer back moment it turns, instead of unwinding overshoot first (same reason as `clampDelta`).
- **Full revolution = all-day event, `draftEvent` decides that.** Any span of `MINUTES_PER_DAY` or more becomes `allDay` with instants snapped to day's two midnights, so ⌘N, palette, ring gesture all agree. `CenterPanel` prints `All day` in readout while such drag live, because gesture should say what it about to make — note arc vanishes on release, since `EventArc` draws nothing for all-day event.
- **Whole turn drawn closed — second rule from same fact.** `capInset` shortens arc by half a stroke at each end so painted length = duration — but once two ends meet, that inset = notch at midnight, and circle with notch reads as rendering fault. `GhostArc` returns `<circle>` for full-day range, `EventArc` drops inset at `to - from >= 360` (timed event running through whole day = any multi-day event's middle).
- **Arc labels live _inside_ the stroke, and that is geometry, not taste.** `LANE_STEP - ARC_WIDTH` = 13 units of black between two lanes, and the hour numerals come down to 333 just outside the first, so a label _beside_ an arc works on the outermost lane and nowhere else. Inside the 14-unit stroke it is 11px of mono with 3.1 units of arc either side of it, identically on every lane, and it costs no radius — which is the "do not add a ring" rule again. It is also `inkOn(color)`, black on the event's own pastel at ~10:1, the strongest pairing this face has; grey on black beside the arc would be the weakest.
- **The label's budget is glyphs measured against the _paint_, never minutes and never the centre line.** `arcLabel` takes the arc's painted ends — the span less any seam a neighbour claimed — because the round caps put half a stroke back past `head`/`tail`, and a label handed the `capInset`-shortened span forfeits 14 units on every arc, which is every half-hour event on the face going anonymous (it did). Mono means the width is arithmetic: no `getComputedTextLength`, so no layout read per arc per frame of a drag. Where the gate lands in minutes is a _consequence_ — a word from about 45 minutes, a stub from about 30 out at the rim, nothing on the inner lanes — so a duration threshold would label an event at the rim and crop the same event two lanes in.
- **A glyph takes its up-vector from the path's direction, so the bottom half is drawn backwards.** `arcPath` grew a `back` flag: the same arc traced anticlockwise from `to` to `from`, which is invisible on a stroke and the whole difference between a readable label and an upside-down one. `arcLabel` reverses whenever the arc's midpoint is between 90° and 270°; the flip has to land somewhere and at three and nine o'clock the text is vertical either way. Derived from the _drawn_ angle, so both faces get it for free.
- **The label keeps full alpha on a dimmed arc.** Ink here is the _absence_ of light, so dimming it alongside the body takes both towards the black behind them and the name disappears at ~1.5:1. Left alone it softens from about 10:1 to 4.8:1 as the arc recedes, which is the hierarchy the dimming was asking for. In `hover` mode it is mounted at `opacity: 0` rather than mounted on hover: it arrives in the same beat the stroke grows by 3, and text popping in on a growing arc reads as a wobble.
- **`Escape` abandons gesture in flight**, from `useHotkeys` inside `Dial` rather than shell's: `setDraw(null)` and `setAdjust(null)`. Drag = one thing here you can start by accident, and before this only way out was to let go, which committed it. Pointer stays captured on purpose — both move and up handlers bail on missing gesture, so release that follows does nothing, no cue because nothing happened.
- **Lane packing face-independent.** `dayAgenda` takes no `Clock`: both faces put one day on one revolution, so two events collide on screen exactly when they collide in time.
- **`CalEvent.color` = override, not the colour.** Empty string means "follow the calendar", default every event should stay on, so recolouring calendar still moves them. Only `colorOf` knows precedence.
- **`Settings` schema-versioned.** `SCHEMA` in `src/lib/store.ts` bumped when stored value changes _meaning_ rather than shape (went to `2` when `clock: "24h"` stopped meaning noon-at-top face). Stale schema resets settings to defaults, keeps events.
- **Store hydration lazy, at first `subscribe`**, not module scope; `load()` and `write()` swallow `localStorage` errors on purpose (private mode / quota must not brick app) — but `write()` also calls `notify(…, "error")`, because silent failed save indistinguishable from successful one and that how a day's events disappear.
- **Every action derives from `fresh()`, never from module's `snapshot`.** `fresh()` re-reads blob when another tab wrote since we last looked. Deriving from in-memory snapshot loses other tab's events wholesale in window before its `storage` event arrives.
- **Undo in-memory and session-scoped**, cleared on an inbound `storage` event _only when the base actually moved_: undoing onto a base another tab moved past would resurrect what it just deleted, but a background tab's **feed pull** writes the same key and used to cost the foreground tab all sixty steps — a loss the user cannot attribute to anything they did. `baseSignature()` is the comparison (events + calendars minus their `feed` + settings); `undo`/`redo` also carry today's `feeds` across rather than restoring the recorded ones, because a feed is a live mirror and never part of an undo step. `commit(next, false)` opts a change out of history — settings and feed pulls do.
- **`seed()` only runs when no stored blob exists**, anchors on today's local midnight.
- **A VEVENT with no UID gets a _derived_ one, never a generated one.** `derivedUid()` in `ics.ts` is FNV-1a over DTSTART/DTEND/SUMMARY/LOCATION/RECURRENCE-ID, formatted `<base36>@circal.local`. It was `crypto.randomUUID()`, which meant a new id on every parse: `feeds.ts` builds each event's key from the uid, so every pull remounted every arc and hover, selection and the arc under the pointer all dropped. UID is required by RFC 5545, so this only fires on a feed nobody can fix.
- **`zonedToUtc` brackets the wall time with two candidate offsets** — the one in force a day before and a day after — and takes the pre-transition one when neither or both read back. That resolves a spring-forward gap to the instant _after_ it and a fall-back ambiguity to the _first_ of the two, in every zone. The earlier two-pass version converged from the naive UTC reading, so which side of a gap it landed on depended on the sign of the offset: Berlin was right and Los Angeles was an hour early.
- **The all-day toggle remembers the times it had.** `timedSpan` in `EventEditor.tsx` is a ref holding `{ startMin, durationMs }`, captured on the way into all-day and restored on the way out; without it, off → on → off reset every event to 9–10am and silently discarded a duration the user had set.
- **`<input type="time">` banned here** — renders in _browser's_ UI locale, not app's. Use `TimeField` in `EventEditor.tsx`, backed by `parseClock` (accepts `10:45 AM`, `10:45am`, `1045`, `9p`, `13:00`).
- **No `backdrop-filter` on element also carrying `.fade-y`** — Chromium paints blur over box far larger than element, appears as grey rectangle mid-dial (see comment in `CenterPanel.tsx`).
- **Your lightcycle band replaces elapsed ring; does not join it.** Both live on `DIAL.TRACK` at `DIAL.TRACK_WIDTH`, and `elapsedSegments` returns `[]` whenever band has half left to draw (`place && (daylight || moonlight)`, computed once as `band`). Second band on own radius _next to_ track was first attempt, read as one line accidentally doubled. Deliberately no `DIAL.SUN`.
- **Second zone's band = different place, so it does get own rim.** `DIAL.ZONE_BAND` (424) sits 21 units outside track, 13 inside zone numerals it belongs to, and `SunBand` takes `radius` for exactly this. Halves = `zoneDaylight` / `zoneMoonlight` — independent of yours, because point of ring is comparing two places, comparing them half-drawn not a comparison. Coordinates come from `placeForZone(secondZone)`, resolved in `App.tsx`; `null` (`UTC`, aliases like `Asia/Calcutta`) means no band, no switches offered.
- **Lightcycle bands = one sanctioned break in "chrome is greyscale".** They data about the day, not chrome, so warm-but-desaturated for day, dim violet for night, neither may compete with event arc. Use same opaque-segment technique as ring they replace, same alpha-compounding reason.
- **`light(m)` in `SunBand` must stay continuous through zero.** Returns signed light — positive sun, negative night — and civil-twilight shoulders reach exactly `0` at horizon so warm band and violet band meet without either starting on step. Every discontinuity in that function = visible edge on rim; shoulders used to begin at `0.04` and band began with hard line. 288 segments (five minutes each, eight-unit chord) makes ramp stop looking stepped.
- **Two halves = draw-time filter, not argument to `light`.** Curve computed for whole day either way, segment loop drops half switched off, so half that stays keeps exact shape it had beside other. Yours default on, because band _is_ track; with both off elapsed ring comes back rather than leaving rim empty. Second zone's default off — caption annotates ring already there, band is another ring. `night` = old name for `moonlight`: `migrateSettings()` in `store.ts` carries stored one across, `readSettings()` in `backup.ts` does same for backup.
- **`DIAL.ZONE` (446) fixes `PAD` (30).** Crop leaves 470 units of radius; 15-unit numeral centred on `ZONE` reaches 453, caption beside topmost one runs up to 131 units further right — eight units short of crop at worst anchor angle. Anything further out gets cropped: move `PAD` before you move `ZONE`, keep `ZONE_BAND` _inside_ `ZONE`, because caption runs horizontally outwards from numeral and would otherwise cross band.
- **Zone caption hangs off topmost of four marks**, to its right, never beneath. Beneath, collided with hour numeral below it and ran off viewBox at three o'clock. Four marks 90° apart, so one always within 45° of top, where horizontal room is.
- **Zone ring measured against viewer, never against UTC.** `delta = zoneOffset(now, zone) + now.getTimezoneOffset()` — caption reads `Tokyo +7`, because you are origin of this dial and "GMT+9" makes reader do subtraction. Also only form staying right in weeks when one of two zones changed for DST and other has not.
- **Read-only events = `disabled` fieldset**, not prop threaded through every control. Cascades to swatch buttons and `Select`s nested two components deep, which nothing else would reach. Title input sits outside it, carries own `disabled`.
- **`sun.ts` returns minutes since local midnight, does not clip.** Place far from viewer legitimately produces negative sunrise or sunset past 1440; `Dial.tsx` samples inside `[0, 1440]`, lets rest fall off face.
- **Place chosen by city, never typed.** `settings.place` carries IANA zone it was picked by, and `placeForZone` = only thing turning zone into coordinates — so picker can always show what band is drawing. `store.parse()` drops stored place with no `zone`: band settings panel says is off is worse than no band. Coordinates come from `zone.tab`, so they name zone's principal city; couple of minutes of sunrise error at worst, finer than band draws.
- **Icons and `og.png` = only unhashed assets, so `CACHE` in `sw.js` ships them.** Everything Astro builds content-hashed; `public/` not. Worker serves `public/` stale-while-revalidate, so installed client gets _old_ icon one more time after change unless `CACHE` bumped. Bump it in same commit touching an icon.
- **`icon-192.png`, `icon-512.png`, `apple-touch-icon.png` rasterised from `icon.svg`** — `rsvg-convert -w N -h N public/icon.svg -o public/icon-N.png` — and `public/og.png` (1200×630) rendered in browser, because it sets type in Geist and Geist Mono and no rasteriser here has them: mark at icon's own stroke proportion, `circal` at 104px/500 and `-0.035em`, tagline in mono at 22px/500 uppercase and `0.2em` tracking on `--ink-2`. No build step for any of them; edit SVG, re-render, bump `CACHE`.
- **Favicon's `r=11` / `stroke-width=2.4` chosen at 16px, not by ratio.** That radius puts both stroke edges on whole pixels where circle otherwise smeared across three, and anything thinner antialiases to grey instead of white. Re-render at 16px before changing either.
- **Wordmark in `TopBar` disappears below 1180px.** Date readout absolutely centred on bar, not on space two button groups leave, so lockup's 108px comes straight out of readout's clearance; threshold = where they still clear with longest header `formatDayHeader` produces. Was 1080 until view switch grew third segment. Anything added to left group has to re-measure it. `Segmented` also drops ⌘ chips below 900px, which keeps three segments, stepper, and three pills on phone-width bar.
- **`lib/feedback.ts` builds its `AudioContext` inside `onPointerDown`, never at module load.** Context made outside user gesture starts `suspended` and stays there, so first drag of session would be silent; also re-`resume()`s on every cue, because backgrounded tab comes back asleep.
- **Every cue = one mechanism: 3 ms noise impulse struck through bandpass resonators, one impulse per hit time.** `SOUNDS` in `feedback.ts` = whole instrument — `step`/`slide` = single hits, `opened`/`created`/`deleted` = same thing hit two or three times 50–100 ms apart, pitch _order_ carrying meaning (up finished, down removed). Earlier draft used oscillators for long cues and they sounded like another app's notification; do not reintroduce tone here. Each hit gets own contact transient scaled by how hard it lands — without one, later hits read as hiss with resonance on it.
- **`level` = gain _into_ narrow resonance, not peak.** Most of 3 ms impulse's energy never gets through, why multi-hit cues carry levels above 1. Offline peaks: `step` 0.27, `slide` 0.10, `opened` 0.22, `created` 0.22, `deleted` 0.26. Retune by rendering into `OfflineAudioContext` and measuring, not by ear alone — keep family within sight of each other.
- **Only `gated` cues rate-limited.** `step` and `slide` can fire dozens of times a second, share `MIN_GAP_MS`; one-shot cues bypass it deliberately, since `opened` lands within milliseconds of drag's last click, exactly the gap that limit exists to swallow.
- **Keyboard = second instrument, in `lib/keys.ts`, one mechanism all way down: every key = sum of damped sinusoids, no noise anywhere.** That the point — recorded switch = broadband hiss with resonance on it, and screenful of that = fatigue. Voice = `Synth` (`layers`, `length`, `peak`); `render` sums layers and scales _sum_ to `peak`, because two partials add to somewhere between 1.0 and 1.5 depending where phases land and guessing that is how one key ends up twice its neighbours. **No asset, no fetch**: eight buffers rendered on first keystroke of session, at device's own sample rate, in well under a millisecond.
- **Two letter clicks = Radical's, refitted from its bundle** — 2600 → 200 Hz over 8 ms, and steady 2325 Hz, both with 1.4 ms time constant, nothing above 3.5 kHz in either, fitted to spectral correlation of 0.96 against originals. Parameters rather than asset on purpose: exact at any device sample rate, and free. Do not "improve" one by adding noise transient — that precisely the difference between this and a clack.
- **All three big keys were recordings first (Everglide Oreo board) and all three lost.** Space = 1820 → 140 Hz at τ 2.0 ms, letter click lower and longer; it was click over 145 Hz partial ringing 14 ms first, on theory bar needs tail to sound like bar, and tail read as boom next to clicks this dry. Delete starts at 1500 rather than 2600 and glides less far, so reads as duller than letter rather than brighter — taking character away should not sound like typing one; recorded one's _release_ measured 1.8× its press (0.115 against 0.064), exactly why it sounded like key that could not make up its mind. Return lands twice, and once layer could start late that clunk was reachable from parameters, which took last asset out of app.
- **Late layer = how key lands twice, belongs in buffer — never in caller.** `Layer.at` (seconds) offsets contact inside one voice: `render` measures that layer's glide, decay, 0.2 ms attack from its _own_ start. One buffer per voice keeps keystroke one `start()`, and only way gap between two contacts scales with `playbackRate` — scheduled separately, jitter would move pitch and leave gap behind. Return's contacts 9 ms apart; 14 ms was first draft, read as two separate keys.
- **`CLICKS` alternates strictly; never picked at random.** Two-item bag chosen randomly repeats about half the time, and repeated keystroke = one artefact alternation exists to prevent. Radical itself picks randomly, gets away with it only because ±8% of `playbackRate` hides repeat; both kept here, jitter _and_ strict alternation.
- **Levels = one family across both instruments, every key a multiple of `LETTER_PEAK` (0.24)** — just under dial detent's measured 0.27, because typing happens hundreds of times to drag's once. Space and Return 1.1×, delete 0.92×; letter release 0.275× its press, space 0.32×, delete 0.30×, Return 0.42× because its let-go is sound of thing having happened. Nothing baked anywhere, so `LETTER_PEAK` moves whole keyboard and keeps every ratio.
- **`useTypingSound` listens on `window`, reads `e.code`, not `e.key`.** "Anything being typed" = property of document, not of component, so one pair of listeners covers palette, editor, settings panel, anything added later — no field knows about sound. Physical key makes the noise, so shifted `2` and `@` = one key. Bare modifiers, `⌘`/`Ctrl`/`Alt` combos, `date`/`range`/`checkbox`/`radio` inputs and `SELECT` all silent: select arrowed through rather than typed into, combo = command, which panels announce for themselves. Held-key map cleared on `blur`, because field losing focus mid-hold never sees its `keyup` and stale entry would fire on that key's next press.
- **Auto-repeat makes no sound: `if (e.repeat) return`.** One press = one sound however long finger stays down, both what keyboard physically does and only thing that actually fixes held arrow machine-gunning. Rate-limiting repeats instead was first attempt, failed — 30 ms repeat interval clears any floor short enough to pass fast typist's digraphs, and `MIN_GAP_MS` (18) exists only for those. Verified with 40 trusted `autoRepeat` events: two sounds, press and release.
- **Panel arriving says `opened`, from effect keyed on panel's own flag** (`paletteOpen`, `settingsOpen` in `App.tsx`), not from cue at each call site — four call sites between ⌘P, top bar, and palette handing over to settings, and they would drift. Audio = external system, which is what effect is for. Channels come from ref updated in its own effect, so flipping Sound while panel open does not re-announce it, and `actions` need not depend on them. Refs never written during render in this repo.
- **`onRingMove` and `onArcMove` bail when snapped minute has not changed.** That makes clicks countable — one per fifteen-minute step rather than one per pointer event — and drops re-render `pointermove` would otherwise cause. `cue()` has own 22 ms floor for same reason, since fast flick crosses steps faster than ear separates them.
- **Arc's drag accumulates `wrapDelta` per pointer event; never measures from grab.** Two ring positions do not say which way round circle pointer went, so delta measured from grab flips sign moment drag passes twelve hours. Summing short hops instead lets drag cross midnight as many times as it likes.
- **Minimum duration clamped on `delta`, not on resulting instant** (`clampDelta` in `Dial.tsx`). Clamp end and overshoot banked: arc then lags by however far pointer ran past limit before it starts following back. Clamp delta and it stops dead, releases instantly — and since sound fires only when delta changes, clamped arc goes quiet, which is feedback saying "this is as short as it gets".
- **Press on arc that never changed delta = click.** `onArcUp` opens editor when `delta === 0`, also whole implementation of read-only arcs: subscription's occurrence gets `grip: "none"`, `clampDelta` pins it to zero, press falls through to opening. No separate `onClick`.
- **Dragging arc writes to event's instants, so recurring event moves as series.** Per-occurrence changes are a separate thing entirely — the editor's "Skip this one" (an EXDATE) and "Only this one" (an override event). `App.adjustOccurrence` notifies when event lands off day on screen, because arc vanishing from face otherwise reads as deletion.
- **`src/lib/recur.ts` is somebody else's specification, not this app's idea.** It is RFC 5545 §3.3.10 read down the expand/limit table: a period is expanded into candidate days by the BY\* parts, given a clock, narrowed by BYSETPOS, then bounded. Verified against every worked example in §3.8.5.3. Do not "simplify" a branch without checking that suite again — most of them exist for exactly one example.
- **The seed is an instance only when the rule generates it.** RFC calls DTSTART the first instance but also requires it to be synchronised with the rule; the two readings differ only for a rule that contradicts its own seed. This editor can _write_ that contradiction (deselect the weekday the event is on), and an event that then refuses to leave that day is a bug the user cannot fix. A synchronised rule generates its seed anyway.
- **A rule naming a date some months lack simply does not fire there.** The 31st, 29 February, a fifth Friday — §3.3.10's invalid-instance rule, and the only answer that does not invent a date the sender never wrote.
- **COUNT is walked into `until` on the way in; the model stores one bound.** `countedUntil` in `recur.ts`, called from `ics.ts`. Counting is by the _rule_, before EXDATE — RFC subtracts exceptions from the generated set, so an excluded day still spends one of the count. A count past `WALK_CAP` is read as unbounded on purpose: over-running a bound shows occurrences that should have stopped, guessing one too early deletes them, and only the second loses data.
- **`exdates` and `rdates` are local keys in two forms** — `YYYY-MM-DD` for a whole day, `YYYY-MM-DDTHH:mm:ss` for one instant — which are exactly EXDATE's own two RFC value types. Local, because every other day-identity here is (see `dayKey`).
- **Every entry point is capped.** `MAX_INSTANTS` (512) per call, `WALK_CAP` (2000) periods per COUNT walk. A `SECONDLY` rule names 86,400 instants a day and a feed is not obliged to be reasonable; truncating is visible in a way a frozen tab is not.
- **EXDATE and RDATE are the properties collected as lists.** Both legitimately appear on several lines of one VEVENT, and a flat prop map keeps only the last — a series quietly gaining back every occurrence it was told to skip. Hence `Block { props, exdates, rdates }` in `ics.ts`.
- **RECURRENCE-ID is an override _event_, not a patch on the series.** `seriesId` + `seriesKey` on `CalEvent`; `occurrencesOn` builds the index once per query and skips any generated occurrence an override claims. A separate event because that is what it is — its own time, title, place and colour, possibly on a different day from the one it replaces. `feeds.ts` must give it an id including the recurrence-id, since it shares its parent's UID. `RANGE=THISANDFUTURE` is not modelled; only the single instant is replaced.
- **An `Occurrence.key` is `${event.id}@${instantKey(start)}`.** An event can appear more than once on a day now (an hourly rule, a BYHOUR list), so the day alone no longer identifies one.
- **The full recurrence shape is filled in at `store.parse`, not guarded for at every read.** A blob written before it has no `interval`, and `undefined` reaches the maths as `NaN` — a series that fires on no day at all. `hydrateEvents` covers `events` _and_ every `feeds` array, and returns the same object when nothing is missing, because `parse` runs again on every cross-tab write. No `SCHEMA` bump: nothing stored changed meaning.
- **The editor refuses to flatten a rule it cannot spell.** `isExpressible` in `EventEditor.tsx` gates the controls; `describeRule` prints a sentence instead. Snapping BYSETPOS or BYWEEKNO onto the nearest checkbox is how an import quietly becomes a different meeting.
- **Editor's Date row must call `showPicker()` itself.** Row = transparent `input[type=date]` stretched over label, and Chrome and Safari open calendar only from indicator that input is hiding — clicking field opens nothing. `openDatePicker()` in `EventEditor.tsx` wraps call, because it throws outside user gesture and does not exist in every browser rendering the field.
- **Life grid = canvas, and that not an optimisation.** Thirty thousand dots = thirty thousand DOM nodes: mount alone costs best part of a second and nothing can be animated afterwards. `drawField` in `LifeView.tsx` batches field into one `Path2D` per distinct colour, issues one `fill` each, walks one `Date` per year with `setMonth(0, 1 + doy)` — which rolls over, so day 59 = Feb 29 or Mar 1 as that year decides.
- **Field drawn once, into offscreen canvas; visible one only blits it.** That makes reveal affordable: frame of wave = one `drawImage`, one radial gradient in `destination-in`, one arc, about 4 ms, rather than thirty thousand arcs. Both canvases sized by `devicePixelRatio` and drawn in CSS pixels — at half coordinates a two-pixel dot is grey smear. Offscreen canvas filled _before_ handed to its ref, because `react-hooks/immutability` rejects mutating value already living in one.
- **Nothing following pointer drawn on that canvas.** Hover, selection, today's halo, death mark = SVG circles in overlay; hover repaint of field would cost every dot. Field rebuilt only for new box, span, density, or _day_ — why `LifeView` derives `todayKey` and memoises `today` from it, rather than passing ticking `now` into anything but percentage readout.
- **Today's dot takes its event's colour when it has one.** Drawn outside colour batch (only dot with different radius), and skipping density lookup there was real bug: every event on today — including all-day one, obvious thing to try — was invisible. What marks day as today = accent halo in overlay, not fill.
- **`lifeLayout` picks how many lines a year gets, per box.** Year on one line = 372 columns wide, and in landscape window that makes cell twice as wide as tall: dots merge sideways into dashes. `SPLITS` in `lib/life.ts` tried in order, one leaving biggest dot wins — desktop lands on two lines of 27 weeks, phone on four or six, neither ends up with dots it cannot see. Splits always whole weeks, so week group never cut in half.
- **Row of life grid = calendar year, columns = real Monday-to-Sunday weeks.** Column = `jan1Offset(year) + dayOfYear`, so year starts as many blank slots in as its 1 January is deep into its week. That makes any seven adjacent columns a week — also why months cannot be a gap: month not whole number of weeks, so it a tonal band drifting along row instead (`TONE` in `LifeView.tsx`).
- **`lifeCellAt` = exact inverse of `lifeDotX`/`lifeDotY`** and must stay so, including week gaps and line split. Snaps to nearest dot rather than requiring hit inside one: at four pixels a dot smaller than pointer's own uncertainty.
- **`lifeDensity` counts dated events and yearly repeats, nothing else.** Daily or weekly rule has no end date and fires more often than grid can distinguish, so would paint every remaining day of a life one colour and say nothing. Hover tip = exception, uses `occurrencesOn`, because that a question about one day.
- **Life grid's box measured by shell, not by view.** `App.tsx` observes `main` and resolves `lifeStage(...)` from it, because zoom needs day's dot in screen coordinates _before_ grid exists — dial has to know where it going. Also why `LIFE_META_H` = constant and readout strip given exactly that height in CSS: shell subtracts it to find field's origin, and strip growing by two pixels would land dial two pixels off every dot.
- **Day ⇄ life = zoom; every other pair = crossfade.** `PANEL` in `App.tsx` holds both as dynamic variants, `AnimatePresence` keys one panel per view. Dial scales down onto dot of day it showing (`transformOrigin` = _style_, so already right on frozen render of panel that leaving) while grid's wave leaves that same dot; back other way, wave collapses onto it and dial grows out of it. Exiting panel gives up pointer events at once — for best part of a second it still on top of incoming one, and click landing on view you just left = bug you cannot see.
- **Zoom's scale keyframes geometric, not linear.** Apparent size linear in scale, so plain `1 → 0.008` tween hangs at full size then disappears in three frames. `ZOOM_STEPS` = five keyframes each a third of last, on `ease: "linear"`, with uneven `times` so smallest step gets longest slice — that the settle. Wave's own curve near-linear for same reason in reverse: every ease-out crossed window in 120 ms then crept.
- **Leaving element cannot read new view from its props**, because frozen at its last render. `ViewFlow` therefore a _ref_ (`flow` in `App.tsx`, `{ from, to, day }`, written by `go()` and by popstate handler): motion resolves dynamic `exit` variant when exit starts, and `usePresence` fires then too, so both read `.current` and get truth. `usePresence` also holds life view mounted until its wave collapsed — `safeToRemove()` called by animation's `onComplete`, and immediately when no wave to run.
- **Life span = two settings, both can be stored wrong rather than merely missing.** `sane()` in `store.ts` = one clamp — `birth` not `YYYY-MM-DD` becomes `""` (shows prompt again) and `lifeExpectancy` pinned inside `LIFE_EXPECTANCY_RANGE` — and runs on `parse`, on `store.setLife`, and on `restore`, because `readSettings` in `backup.ts` only guarantees types.
