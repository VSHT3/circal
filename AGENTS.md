# Repository Guidelines

## Project Overview

**circal** = calendar, day view = one dial. One revolution = one day, clockwise 0.25°/minute. Events = arcs; elapsed day = light ramp round rim; hand = current minute.

Four views, one idea at four scales: **dial** (`⌘D`) = one day · **week strip** (`⌘E`) = seven such faces at one rotation · **year ring** (`⌘Y`) = one revolution per year, one mark per day · **life grid** (`⌘L`) = every day you get, one dot each, birth date to expectancy, one viewport. All draw days in day order ⇒ moves between them = geometry, not decoration. Day ⇄ life = _zoom_: dial collapses onto that day's dot, grid wave radiates out. Day ⇄ week = _zoom_ one step less far: strip face for that day **is** the dial ~4× smaller ⇒ dial scales, translates onto it. Year ⇄ life = _unroll_: a year in day order round a circle **is** a life-grid row rolled up ⇒ ring straightens onto that row, back. Other pairs crossfade (day = neither magnified nor rolled-up year; week neither).

`Clock` sets only what the face is _called_, never geometry. `12h`: noon top, labels `12 · 1…11` twice, AM/PM captions. `24h`: midnight top, labels `00 · 1…23`. Switch = 180° rotation + relabel ⇒ arc keeps length, sweep on either face. Governs **every printed time** (readout, agenda, sidebar, palette, editor) ⇒ `splitTime` / `formatTime` / `formatTimeShort` take `Clock`; any surface printing one MUST thread it.

No account, no sync **unless a user asks for one**, no readable server-side state: user events in `localStorage` under `circal.v1`; optional cloud copy = one Postgres row per user, AES-GCM ciphertext sealed in browser by `vault.ts` (`cloudLink.ts`, `SYNC.md` Phase 2). No sign-in ⇒ app runs exactly as described, byte for byte; `supabase-js` fetched only when sync on. Ships as Cloudflare Worker: static assets + **exactly one route**, `/api/feed`, CORS proxy for ICS subscriptions, since no calendar host sends CORS headers. `supabase-js` talks straight to `*.supabase.co`, so that route stays the Worker's only one, rule intact: second route = different product; stop.

`README.md` = user keyboard table + feature tour. This file = how to _edit_ code safely.

## Architecture & Data Flow

```
src/pages/index.astro   static HTML shell  (src/pages/manifesto.astro = prose, no island)
  └─ <App client:only="react" />        ← the ONLY island in the project
       ├─ useStore()   → { events, calendars, feeds, settings }   (persisted)
       ├─ useState ×5  → location{day,view}, sidebar, editor, palette, settings
       ├─ useNow()     → ticking Date, minute-aligned
       ├─ useReminders() → the minute tick → `Notification`, when switched on
       ├─ useTitleCountdown() → the same tick → `document.title`, only while hidden
       └─ actions: ShellActions (one useMemo object)
            ├─ TopBar / Sidebar / CommandPalette / Settings  receive `actions` whole
            └─ Dial / EventEditor / YearView / LifeView      receive narrow callbacks

  Settings travel as one `settings: Settings` prop, never field by field.
```

- **`src/lib/` = domain layer**, mostly pure. One-way deps: `time.ts`, `fuzzy.ts`, `base64.ts`, `theme.ts` (base, import nothing) ← `vault.ts` ← `recur.ts` ← `dial.ts`, `events.ts`, `sun.ts`, `moon.ts`, `ics.ts`, `quickadd.ts` ← `describe.ts`, `life.ts`, `remind.ts`, `travel.ts`, `merge.ts`, `store.ts` ← `feeds.ts`, `backup.ts` ← `share.ts`, then `mirrorLink.ts` / `cloudLink.ts` last, one per transport. `merge.ts` beside `mutate.ts`, `mutate.ts`'s own reason: pure over lists, imports only `./events`, takes `Settings` as _type parameter_ not import — `store.ts` above it, merge needs no field of it. `base64.ts` carved from `share.ts`, not respelled in `vault.ts`: alphabet swap written twice = two chances for payload ends to disagree; box nobody can open has no undo step. `vault.ts` one step above, imports nothing else — passphrase + WebCrypto; no event, no day, no zone. `cloudLink.ts` at `mirrorLink.ts`'s tier, composing `store.ts`, `merge.ts`, `mirror.ts`, `vault.ts`, `notify.ts`; **the two links do not depend on each other at all**: only reference to `mirrorLink.ts` = `import type { MirrorStatus }`, compile-time erased ⇒ shared status vocabulary, no runtime edge, no drifting copy. Components import via `@/lib/*`; never reimplement geometry or date maths locally. `share.ts` last on purpose, not beside `travel.ts` where its subject fits: reads stranger payload via `backup.readEvent` rather than judging event legality itself; taking a validator from a tier = sitting below it. **Every module here has a test file** `tests/<module>.test.ts`; change one, add the case there.
- **Dependency order = _constraint_, not description — the distinction is binding.** Violated exactly once, instructively: per-event reminder leads shipped with `ics.ts` importing `remind.ts` for three lead states. Acyclic ⇒ nothing failed, no lint fired, no test could have — tier is not a type. Reader seeing imports and sentence disagree has two honest options, **move the code or change the constraint**; noting it is neither: ordering makes the graph legible, unpredictable graph = next import chosen by what compiles. Fixed by moving, along splits marks already use — see lead vocabulary under "Reminders".
- **Store = only source of truth for persisted data.** `App.tsx` holds _view_ state only. Mutations via `store.*`, never a `setState` copy of an event. Settings-only mutations (`setSecondZone`, `setPlace`, `addFeed`) called straight from `Settings.tsx`, not `ShellActions` — shell has nothing to update. `removeCalendar` = exception, also called there: calendar action, and removing a subscription is the one way a calendar leaves the settings panel.
- **Two event lists, two _keys_.** `snapshot.events` = user-written; `snapshot.feeds[calendarId]` = subscription-mirrored. `App.tsx` concatenates into `visible` for rendering, _only_ that. Only `lib/feeds.ts` writes `feeds`; nothing exports it; event whose calendar has `feed` opens read-only. `feeds` = **read model**: built from one `circal.feed.<id>` key per subscription, the one `Snapshot` field `write()` never serialises.
- **`dayAgenda(events, calendars, day)`** = single read path onto a day: expands recurrence, clips to day, packs overlaps onto concentric lanes. `Dial`, `CenterPanel` render its output; sidebar reads `occurrencesOn` directly, mini-month dots only.
- **Units.** In the dial everything = _minutes since local midnight_ (`0…1440`). `CalEvent.start`/`end` = **epoch ms**, `end` **exclusive**. Nothing below `dayAgenda` reasons about `Date`.
- **Day and view = URL.** `?d=YYYY-MM-DD&v=year|life`, written via `go()` in `App.tsx`: `push` for deliberate jump, `replace` for arrow stepping. `go` reads location from a ref, not the render closure — two `go` calls in one tick would clobber each other. `v` omitted for day view, validated against `VIEWS` inbound.
- **Panels take `settings` whole, not one prop per field.** `Dial` reads twenty-two; `Settings` thirty-seven of the interface's thirty-eight (`deviceZone` = shell's business, not panel's). Threaded individually, one new boolean meant editing six files (`Settings` interface, panel prop interface in `types.ts`, `App.tsx` forwarding, panel destructure, `backup.ts`). Counts make it rule, not preference: at twenty-two the forwarding is the file, and the four settings backup nudge + travel notice added cost the panel one line each, not six files each. Same bargain as `actions`: one prop, shell forwards nothing. Panels destructure on body's first line ⇒ bodies read as before. `LifeView` = last holdout at four fields, converted when it wanted a sixth. `zonePlace` = the one exception, own prop: shell derives it from `settings.secondZone` via `placeForZone`, so not a setting.

## Layout

- `src/lib/` — domain layer, pure; every module has `tests/<module>.test.ts`
- `src/components/react/` — the island: `App.tsx` shell, `Face.tsx` drawing, `Dial.tsx` instrument, panels; `types.ts` = every panel prop interface; `ui/primitives.tsx` = the thirteen shared controls
- `src/pages/` — `index.astro` (the app), `manifesto.astro` + `assistant.astro` (static prose, no island)
- `src/styles/global.css` — design tokens, three theme presets, five component classes
- `worker/index.ts` — assets + `/api/feed` proxy, the Worker's only route
- `mcp/` — MCP server, two transports; nothing in `src/` may import it (see `mcp/README.md`)
- `mac/` — macOS shell, `main.swift`; no domain logic (see `APP.md`)
- `supabase/migrations/` — the whole server side, in SQL
- `tests/` — 2,104 cases over 34 files; `helpers.ts` = fixtures + matchers; `west/` = TZ re-runs

Full per-file map with exported symbols: `docs/agent/map.md`.

## Topic Docs — read before touching an area

Deep doctrine (invariants, measured decisions, bug postmortems) lives in `docs/agent/`, one file per area, loaded on demand. When a task touches an area, read its doc first — the rules there are binding, not commentary.

| Doc                     | Read when touching                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/agent/dial.md`    | `Face`/`Dial`, dial geometry, drag gestures, arc labels, busy/free, tasks, `CenterPanel`, sun/moon/zone bands     |
| `docs/agent/views.md`   | `LifeView`, loupe, `YearView`, `WeekView`, view transitions, intro animation                                      |
| `docs/agent/editor.md`  | `EventEditor`, `EditScope`, calendars, marks, `MarkPicker`, `CommandPalette`, `quickadd.ts`                       |
| `docs/agent/store.md`   | `store.ts`, `feeds.ts`, `backup.ts`, undo, `SCHEMA`, `recur.ts`                                                   |
| `docs/agent/sync.md`    | `mirror*.ts`, `merge.ts`, `vault.ts`, `cloudLink.ts`, `mcp/`, Supabase                                            |
| `docs/agent/sharing.md` | `share.ts`, ICS invitations, `remind.ts`, `travel.ts`, `tzid`                                                     |
| `docs/agent/shell.md`   | `App.tsx` shell state, sidebar, `TopBar`, focus traps, `Settings` panel, `feedback.ts`/`keys.ts`, `sw.js`, assets |
| `docs/agent/testing.md` | any test work beyond adding a case in an existing file                                                            |
| `docs/agent/map.md`     | anything unfamiliar — the full per-file map                                                                       |

## Development Commands

```sh
pnpm install
pnpm dev        # astro dev — http://localhost:4321. NO /api/feed here
pnpm dev:worker # astro build && wrangler dev — the only way to exercise /api/feed
pnpm build:mcp  # esbuild → mcp/dist/circal-mcp.mjs, the MCP server's single-file bundle
pnpm build:mac  # astro build && mac/build.sh → mac/build/circal.app (1.3M)
pnpm mac        # the same, then opens it. `bash mac/build.sh --universal` for both arches
pnpm test       # vitest run — two TZ-pinned projects
pnpm test:watch # vitest
pnpm verify     # THE gate: format:check && lint && check && test && build
pnpm format     # prettier --write . (run this, never hand-format)
pnpm deploy     # astro build && wrangler deploy
```

`pnpm verify` = only gate; run before declaring done. Steps: `pnpm format:check`, `pnpm lint` (eslint), `pnpm check` (astro check / tsc), `pnpm test` (vitest), `pnpm build:mcp` (esbuild), `pnpm build`. Format and lint carry `--cache` → `node_modules/.cache/` (~25s cold, ~8s repeat); caches key config content, so a changed rule re-checks every file.

## Git & Commits

One commit per feature or work session, committed when the work is done and `pnpm verify` passes — do not split a feature across commits.

- **Conventional Commits**: `<type>(<scope>): <imperative summary>`, scope optional. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`.
- Subject ≤ 50 chars where it fits, hard cap 72. Imperative, lowercase after colon, no trailing period.
- Scope = area, not filename: `dial`, `center-panel`, `store`, `events`, `time`, `sidebar`, `palette`, `editor`, `styles`.
- Body only when _why_ is not obvious from the diff. Wrap 72, bullets `-`, issue refs last (`Closes #42`).
- Never: AI attribution trailers, "this commit does X", emoji, restating the filename the scope already names.

## Code Conventions & Common Patterns

**Imports** — always `@/*` alias (`@/lib/events`, `@/components/react/types`), never deep relative paths leaving a directory.

**Formatting** — Prettier, `printWidth: 100`. `prettier-plugin-tailwindcss` sorts Tailwind classes automatically, incl. inside `cn()` and `cva()`. **Never hand-sort class strings**; run `pnpm format`.

**Styling** — Tailwind v4, config-less; theme in `src/styles/global.css`. Token utilities, not raw hex (hexes below = **midnight**'s, the default preset):

| Utility                          | Token                             | Use                                     |
| -------------------------------- | --------------------------------- | --------------------------------------- |
| `bg-void`                        | `#000000`                         | canvas, true black                      |
| `bg-surface` / `bg-surface-2`    | `#131315` / `#1d1d20`             | popovers & cards / controls inside them |
| `border-hairline`                | `rgba(255,255,255,.08)`           | every divider                           |
| `text-ink`                       | `#ffffff`                         | only pure white                         |
| `text-ink-2` / `ink-3` / `ink-4` | `#8e8e93` / `#5c5c60` / `#2e2e31` | secondary / numerals / ticks & disabled |
| `text-accent`                    | `#a3d9e4`                         | default calendar colour                 |
| `text-danger`                    | `#ff5a5a`                         | destructive only                        |

**Every token is one of three greyscale presets** — `settings.theme`, `midnight | ember | paper`, written onto `<html data-theme>` by one `App` effect; `global.css` holds a token block per preset, the bare-`:root` selector doubling for midnight so pre-hydration paint is the default install. Enumerated and `sane()`-pinned, never a theme editor: a slider is a thousand faces nobody tested. Two consequences. **White-alpha is banned in class strings** — `bg-white/10` is invisible on paper; the ladder of `--veil-05…20` (+ `--ring-40`, `--chip`, `--on-accent`, `--scrim-a/b`) exists per preset with the direction flipped, used as `bg-(--veil-10)`. **A canvas or computed SVG colour never spells white or black** — `fillStyle` cannot read a token, so `lib/theme.ts` carries `THEME_PALETTES[theme]` (ink, tick, numerals, accent, empty mark…) and `wash`/`washHex`, a lerp from the theme's own void that on a black void is byte-identical to the multiply it replaced (pinned in `tests/theme.test.ts`, with the contrast floors: ink ≥ 7:1 on void, ink-2 ≥ 4.5:1 on surface, accent ≥ 4.5:1 as small text). `Face`, `Ring`, `drawField`, the loupe and the moon all take `theme` for exactly this.

`fill-*` / `stroke-*` variants exist for SVG. Component classes: `.label` (uppercase 11px mono, label voice), `.caption` (12px sans `ink-2`, prose voice — anything reading as sentence), `.kbd`, `.fade-y` (masks both ends of scroll area), `.fade-b` (bottom only, proportional — short list, first row stays crisp), `.no-scrollbar`. Pair fade with `.no-scrollbar` on every scroll region; fade **only when the list actually overflows** — permanent fade on fitting list reads as rendering fault. Chrome greyscale by rule: **colour belongs to events.** Never read `calendar.color` or `event.color` directly — call `colorOf(event, calendars)`: event override first, else its calendar. Presets in `PALETTE` (`src/lib/events.ts`): ten digital pastels, high value, moderate saturation so two share a dial at 14-unit stroke. **`text-danger` is destructive only, and a link being down is not destructive** — mirror and cloud error sentences skip it: calendar whole in `localStorage` either way, red spends "emergency" on a socket. `feedMetaClass` = documented exception: stalled subscription shows days quietly wrong, the one chrome failure earning colour.

**New chrome MUST reuse `ui/primitives.tsx`** — `Kbd`, `FieldRow`, `IconButton`, `ActionPill`, `Segmented`, `Switch`, `Toggle`, `Select`, `DateField`, `NumberField`, `TimeField`, `TextField`, `ColorPicker`. Never hand-roll a button. `FieldRow` = modal row grid shared by event editor, calendar card, settings panel; three modals with three row grids is three products. `Toggle` = `Switch` + own text label, for settings two and three to a row. `DateField` = native `input[type=date]` under any face; `openDatePicker` sits beside it — clicking date input's field opens nothing in Chrome/Safari. `TimeField` = app's own clock input; `input[type=time]` banned, renders in _browser's_ locale, not this app's — moved here when settings panel became second caller beside event editor. `TextField` = one line of typed text at settings row's shape, taking **`onEnter` rather than living in a `<form>`**: fields sit in dialog with live Escape and ⌘-combos; form's implicit submit = second Enter handler dialog cannot see. Arrived when cloud panel wanted three (address, code, passphrase); feed URL's bare `<input>` = fourth caller — rule working: fourth hand-rolled input is where convention forms by accident. `type` = closed set on purpose: `password` = what passphrase field _is_; `email`/`url` put right keyboard under thumb; nothing else is text field's business. `ColorPicker` takes optional `fallback`: pass for an _event_, where `""` = "follow the calendar"; omit for a calendar — nothing above to inherit.

**Touch targets grow, they are not padded.** Every mouse-sized control in `primitives.tsx` carries `pointer-coarse:` variant sized for fingers — 40px `IconButton`/`ActionPill`, 36 a `Segmented` item, 34 a position cell, 30 a swatch. Grown, not given invisible 44px hit area: these sit two and three to a group at 2–3px gap, so box wider than pitch reaches past neighbour's centre and DOM order decides tap — worse than small target honest about its edge. `Switch` = lone exception, takes 44px `::before`: knob at hardcoded offsets, track cannot move. Mouse layout MUST come out byte-identical; check new control at 360, 390, 430 and 768 for overflow.

**`ColorPicker` is a 5 × 2 grid, not a wrap.** `PALETTE` = one walk round hue wheel (aqua 174° through mint 150°); ten in two rows of five reads that walk as text reads, wheel closing where row two ends and row one begins. Two swatches that are _not_ a colour — inherit-the-calendar, any-colour — own column beside it behind one divider: column is one or two cells by turns, block of ten must never change shape. Wrap divided eleven or twelve cells by whatever column was, landing six and five. On `pointer-coarse` column takes `w-full`, drops to own line, divider hidden: 34px cells leave no room beside five-wide block; line break = separation divider drew.

**State sync — hard convention.** `react-hooks/set-state-in-effect` active: effect copying props into state rejected. New props must reset local state → use React render-phase adjustment (three sites: `Sidebar.tsx`, `EventEditor.tsx`, `CommandPalette.tsx`):

```tsx
const [seeded, setSeeded] = useState(day);
if (seeded !== day) {
  setSeeded(day);
  setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
}
```

**Effects for external systems only** — `window` listeners, `ResizeObserver`, timers.

**Hotkeys** — `useHotkeys({ "mod+k": fn }, enabled?)`. Combo: optional `mod+` (⌘ or Ctrl), optional `shift+`, then lowercased `e.key` (`k`, `escape`, `arrowleft`, `t`). `shift+` belongs to combo whenever Shift held, printable keys included — without it `⇧⌘Z` and `⌘Z` are one string, redo becomes undo. Handlers skipped while typing in input unless combo carries `mod` or is `Escape`. `enabled` = how modal switches shell off (see gotchas).

**Modals** — `const dialog = useFocusTrap<HTMLDivElement>(open)` on `role="dialog"` element. Three dialogs, one hook, no `<Modal>` wrapper: palette = combobox, editor = form, settings = sheet; share this behaviour, nothing else.

**TypeScript** — `strict`, no `any`. Prefix intentionally unused bindings with `_`.

**Comments** explain _why_, never _what_. Most non-obvious decisions carry one; read before changing a line.

## Runtime/Tooling Preferences

- **Node ≥ 22.22.3**, **pnpm 11.2.2** (pinned, `packageManager`). Not Bun, not npm — `pnpm-lock.yaml`, `pnpm-workspace.yaml` authoritative. Floor `22.22.3` not `22.12.0`: `astro-eslint-parser` + `eslint-plugin-astro` require it by `engines`; below it, install prints two unsupported-engine warnings.
- `pnpm-workspace.yaml` **not** monorepo marker; holds `allowBuilds` whitelist for native deps (`esbuild`, `@tailwindcss/oxide`, `lightningcss`, `sharp`, `workerd`). Add when new dep needs build script. **`@supabase/supabase-js` needs no entry** — pure JavaScript, no install script; entry would whitelist nonexistent build, telling next reader this dep compiles something.
- Animation = **`motion`**, not `framer-motion` — `import { motion, useReducedMotion } from "motion/react"`; always honour `useReducedMotion`.
- Chrome icons = `lucide-react`, `size={14}`–`15`, `strokeWidth={1.75}`. **Calendar marks = separate vocabulary**: 247 Phosphor `bold` paths vendored as data in `ui/marks.ts`, no dependency, lazy chunk, no static importer — see "Calendars and marks" before importing anywhere. Two vocabularies, two jobs: lucide = app talking, Phosphor = user choosing. Nothing in `ui/icons.tsx` may use lucide; no chrome may use a mark.
- **No state-management library**, no UI-component library; `clsx` + `tailwind-merge` back `cn()` in `src/lib/utils.ts`.
- Fonts self-hosted, Fontsource (Geist / Geist Mono). No runtime external requests.

## Testing Essentials

Full doctrine: `docs/agent/testing.md`. The always-true core:

- **The suite exists — extend it, never fork it.** One `tests/<module>.test.ts` per `src/lib/` module; change a module, add the case there. No second harness, no second fixture style, no `*.spec.ts`.
- **`tests/helpers.ts` is the shared floor.** Import it in every test file (the import registers the matchers): `at("2026-03-08 09:30")` for local Dates — **never `new Date("2026-01-01")`**, it parses as UTC — plus `ms` / `day` / `event` / `calendar` / `rule` / `MemoryStorage` / `show`.
- **Instants MUST use the three matchers**: `toBeInstants`, `toOccurOn`, `toBeSameInstantAs`.
- **Two TZ-pinned projects**: `local` (`Europe/Berlin`) and `west` (`America/Los_Angeles`). Touching `dayKey`, `zonedToUtc`, `startOfDay`, `addDays`, or anything day-keyed? Add a case under `tests/west/` too.
- **Scope = pure layers, not DOM.** No jsdom, no component tests, no SVG path snapshots. Store/feeds tests need `vi.resetModules()` + dynamic import — copy `freshStore()` from `tests/store.test.ts`.
- **`pnpm verify` proves nothing about how it looks.** Drive `pnpm dev`, exercise the changed path, screenshot. `/api/feed`, service worker, and manifest need `pnpm dev:worker`.

## Cross-Cutting Landmines

- **`dayKey()` / `startOfDay()` are deliberately local-time.** `toISOString()` shifts the day west of UTC, where day-keyed storage breaks. Never swap it in.
- **Colour belongs to events; chrome is greyscale.** Never read `calendar.color` or `event.color` directly — call `colorOf(event, calendars)`.
- **One validator, many readers.** Each stored format has exactly one validator (`readRecurrence`, `readEvent`, `readMark`, `readRemindLead`, `readGuests`, `isZone`…). Extend the validator; never re-spell its checks at a call site.
- **Day arithmetic uses `addDays`, never `n × 1440` minutes** — a day is not always 1440 minutes long (DST).
- **Every `id` inside an SVG face comes from `useSvgId`** — a hardcoded gradient id is right for one face on screen and silently wrong with more.

## Prose & Voice

Applies to everything a human reads: comments, docs, commit messages, UI copy, README/manifesto edits.

- State the claim directly; do not build to a turn of phrase. No punchy fragments for drama.
- Banned model tics: "load-bearing" (figurative), "isn't just X — it's Y" and other antithesis reveals, "worth stating plainly", "full stop" as emphasis, "the trap", "here's the thing", performed candor ("honestly", "to be honest").
- Prefer commas, parentheses, or a new sentence over an em dash; long-form user-facing prose bans em dashes outright (pinned in `tests/life.test.ts`).
- Comments explain _why_, in one line. Write no documentation unless asked.
- Full inventory with fixes: `BANNED - THE DEFINITIVE GUIDE.md` (Parts 3–4 for docs and comments; all parts for user-facing copy).
