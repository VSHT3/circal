# Repository Guidelines

## Project Overview

**circal** is a calendar whose day view is a single dial — a web recreation of Raycast's macOS app _Radical_. One revolution is always one day, clockwise at 0.25° per minute. Events are arcs, the elapsed day is a ramp of light around the rim, the hand is the current minute.

The `Clock` setting picks only what the face is _called_, never its geometry: `12h` puts noon at the top and labels `12 · 1…11` twice with AM/PM captions; `24h` puts midnight at the top and labels `00 · 1…23`. Switching is a 180° rotation plus a relabel, so an event's arc has the same length and sweep on either face. It also governs **every printed time** — readout, agenda, sidebar, palette, editor — so `splitTime` / `formatTime` / `formatTimeShort` all take a `Clock` and any surface that prints one must thread it.

No account, no sync, no server-side state. The user's events live in
`localStorage` under `circal.v1`. Shipped as a Cloudflare Worker that serves
static assets plus **exactly one route** — `/api/feed`, a CORS proxy for ICS
subscriptions, because no calendar host sends CORS headers. If you find
yourself adding a second route, stop: that is a different product.

`README.md` covers the user-facing keyboard table and feature tour — this file covers the parts you need in order to _edit_ the code safely.

## Architecture & Data Flow

```
src/pages/index.astro   static HTML shell
  └─ <App client:only="react" />        ← the ONLY island in the project
       ├─ useStore()   → { events, calendars, feeds, settings }   (persisted)
       ├─ useState ×5  → location{day,view}, sidebar, editor, palette, settings
       ├─ useNow()     → ticking Date, second-aligned
       └─ actions: ShellActions (one useMemo object)
            ├─ TopBar / Sidebar / CommandPalette / Settings  receive `actions` whole
            └─ Dial / EventEditor / YearView                 receive narrow callbacks
```

- **`src/lib/` is the domain layer**, mostly pure. Dependency direction is one-way: `time.ts` (base, imports nothing) ← `dial.ts`, `events.ts`, `sun.ts`, `ics.ts` ← `store.ts` ← `feeds.ts`, `backup.ts`. Components import it via `@/lib/*` and never reimplement geometry or date maths locally.
- **The store is the only source of truth for persisted data.** `App.tsx` holds _view_ state only. Mutations go through `store.*` — never `setState` a copy of an event. Settings-only mutations (`setSecondZone`, `setPlace`, `addFeed`, `removeCalendar`) are called straight from `Settings.tsx` rather than routed through `ShellActions`, because the shell has nothing to update for them.
- **Two event lists.** `snapshot.events` is what the user wrote; `snapshot.feeds[calendarId]` is what a subscription mirrored. `App.tsx` concatenates them into `visible` for rendering, and _only_ that. Nothing writes to `feeds` except `lib/feeds.ts`, nothing exports it, and an event whose calendar has a `feed` opens read-only.
- **`dayAgenda(events, calendars, day)`** is the single read path onto a day: it expands recurrence, clips to the day, and packs overlapping events onto concentric lanes. `Dial`, `CenterPanel` and `Sidebar` all render from its output.
- **Units.** Everything inside the dial is _minutes since local midnight_ (`0…1440`). `CalEvent.start`/`end` are **epoch milliseconds**, and `end` is **exclusive**. Nothing downstream of `dayAgenda` reasons about a `Date`.
- **The day and view are the URL.** `?d=YYYY-MM-DD&v=year`, written through `go()` in `App.tsx`: `push` for a deliberate jump, `replace` for arrow stepping. `go` reads the current location from a ref, not from its render closure — two `go` calls in one tick would otherwise clobber each other.

## Key Directories

| Path                                     | Purpose                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/dial.ts`                        | Polar geometry: the `DIAL` radius table, `angleAt` / `polar` / `arcPath` / `minutesAtPoint` / `capInset`                     |
| `src/lib/time.ts`                        | The `Clock` type, day arithmetic, the formatting voice (`formatTime`, `parseClock`, `dayKey`), and zone maths (`zonedToUtc`) |
| `src/lib/events.ts`                      | `CalEvent` / `Calendar` / `Occurrence`, recurrence expansion, `packLanes`, `dayAgenda`, `freeGaps`                           |
| `src/lib/sun.ts`                         | `Place`, `sunTimes` — NOAA solar position, in minutes since local midnight                                                   |
| `src/lib/places.ts`                      | `PickedPlace`, `placeForZone`, `PLACE_OPTIONS` — the IANA `zone.tab` coordinate table                                        |
| `src/lib/ics.ts`                         | `toIcs` / `fromIcs`. RFC 5545, hand-rolled, no dependency                                                                    |
| `src/lib/store.ts`                       | `useSyncExternalStore` over `localStorage`, `draftEvent`, seed data, undo history, the `SCHEMA` version                      |
| `src/lib/feeds.ts`                       | Subscription pulls, through `/api/feed` then direct                                                                          |
| `src/lib/backup.ts`                      | Export/import, and the only place that validates external input                                                              |
| `src/lib/notify.ts`                      | The toast channel. Its own store on purpose — a four-second message is not persisted state                                   |
| `worker/index.ts`                        | Assets + the `/api/feed` proxy and its SSRF guards                                                                           |
| `public/sw.js`                           | Offline cache. Runtime-only: Astro content-hashes filenames, so there is nothing to precache                                 |
| `public/favicon.svg`                     | The mark: a black disc and one thin white circumference. `icon.svg` is the same ring full-bleed for the maskable crop        |
| `src/components/react/`                  | The island. `App.tsx` shell, `Dial.tsx` instrument, panels                                                                   |
| `src/components/react/ui/primitives.tsx` | The eight shared controls all chrome is built from                                                                           |
| `src/components/react/types.ts`          | **Every panel prop interface.** Edit shapes here                                                                             |
| `src/styles/global.css`                  | Design tokens, `@theme inline` colour mappings, five component classes                                                       |

## Development Commands

```sh
pnpm install
pnpm dev        # astro dev — http://localhost:4321. NO /api/feed here
pnpm dev:worker # astro build && wrangler dev — the only way to exercise /api/feed
pnpm verify     # THE gate: format:check && lint && check && build
pnpm format     # prettier --write . (run this, never hand-format)
pnpm deploy     # astro build && wrangler deploy
```

`pnpm verify` is the only quality gate; run it before declaring work done. Individual steps: `pnpm format:check`, `pnpm lint` (eslint), `pnpm check` (astro check / tsc), `pnpm build`.

## Git & Commits

Commit **regularly** — one commit per coherent change, not one per session. A
commit that touches the dial's geometry, the store's schema and a doc in the
same breath cannot be reverted, bisected or reviewed.

- **Conventional Commits**: `<type>(<scope>): <imperative summary>`, scope
  optional. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`,
  `build`, `ci`, `style`, `revert`.
- Subject ≤ 50 chars where it fits, hard cap 72. Imperative mood, lowercase
  after the colon, no trailing period.
- Scope is the area, not the filename: `dial`, `center-panel`, `store`,
  `events`, `time`, `sidebar`, `palette`, `editor`, `styles`.
- **Body only when the _why_ is not obvious** from the diff — a rendering
  artefact being worked around, a schema bump, a reverted decision. Wrap at
  72, bullets `-`, issue refs last (`Closes #42`).
- Never: AI attribution trailers, "this commit does X", emoji, restating the
  filename the scope already names.
- Run `pnpm verify` before committing. The gate is per-commit, not per-branch.

## Code Conventions & Common Patterns

**Imports** — always the `@/*` alias (`@/lib/events`, `@/components/react/types`), never deep relative paths out of a directory.

**Formatting** — Prettier, `printWidth: 100`. `prettier-plugin-tailwindcss` sorts Tailwind classes automatically, including inside `cn()` and `cva()`. **Never hand-sort class strings**; run `pnpm format`.

**Styling** — Tailwind v4, config-less; the theme lives in `src/styles/global.css`. Use the token utilities, not raw hex:

| Utility                          | Token                             | Use                                     |
| -------------------------------- | --------------------------------- | --------------------------------------- |
| `bg-void`                        | `#000000`                         | the canvas, true black                  |
| `bg-surface` / `bg-surface-2`    | `#131315` / `#1d1d20`             | popovers & cards / controls inside them |
| `border-hairline`                | `rgba(255,255,255,.08)`           | every divider                           |
| `text-ink`                       | `#ffffff`                         | the only pure white                     |
| `text-ink-2` / `ink-3` / `ink-4` | `#8e8e93` / `#5c5c60` / `#2e2e31` | secondary / numerals / ticks & disabled |
| `text-accent`                    | `#a3d9e4`                         | default calendar colour                 |
| `text-danger`                    | `#ff5a5a`                         | destructive only                        |

`fill-*` and `stroke-*` variants exist too and are used in SVG. Component classes: `.label` (uppercase 11px mono, the app's label voice), `.kbd`, `.fade-y` (mask both ends of a scroll area), `.fade-b` (bottom only, proportional — for a short list whose first row must stay crisp), `.no-scrollbar` — pair a fade with `.no-scrollbar` on every scroll region, and apply the fade **only when the list actually overflows**; a permanent fade on a list that fits reads as a rendering fault. Chrome is greyscale by rule: **colour belongs to events**. Never read `calendar.color` or `event.color` directly — call `colorOf(event, calendars)`, which resolves the event's own override first and falls back to its calendar. The presets live in `PALETTE` (`src/lib/events.ts`): ten digital pastels, high value and moderate saturation so two can share a dial at a 14-unit stroke.

**New chrome must reuse `ui/primitives.tsx`** — `Kbd`, `FieldRow`, `IconButton`, `ActionPill`, `Segmented`, `Switch`, `Toggle`, `Select`. Do not hand-roll a button. `FieldRow` is the modal row grid shared by the event editor and the settings panel; two modals with two row grids is two products. `Toggle` is `Switch` plus its own text label, for the settings that sit two and three to a row.

**State sync — hard convention.** `react-hooks/set-state-in-effect` is active and will reject an effect that copies props into state. When new props must reset local state, use React's render-phase adjustment pattern (three existing sites: `Sidebar.tsx:41`, `EventEditor.tsx:201`, `CommandPalette.tsx:201`):

```tsx
const [seeded, setSeeded] = useState(day);
if (seeded !== day) {
  setSeeded(day);
  setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
}
```

**Effects are for external systems only** — `window` listeners, `ResizeObserver`, timers.

**Hotkeys** — `useHotkeys({ "mod+k": fn })`. Combo format is optional `mod+` (⌘ or Ctrl), optional `shift+`, then the lowercased `e.key` (`k`, `escape`, `arrowleft`, `t`). `shift+` is part of the combo whenever Shift is held, printable keys included — without it `⇧⌘Z` and `⌘Z` are the same string and redo becomes undo. Handlers are skipped while the user is typing in an input unless the combo carries `mod` or is `Escape`.

**TypeScript** — `strict`, no `any`. Prefix intentionally unused bindings with `_`.

**Comments** explain _why_, never _what_. Most non-obvious decisions in this repo already carry one; read it before changing the line.

## Important Files

| File                            | Why it matters                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`         | The only route. Mounts `<App client:only="react" />` — `client:only` because a live clock plus `localStorage` makes any SSR markup wrong on hydrate                                   |
| `src/components/react/App.tsx`  | Island root; owns view state and the URL, builds `actions`, registers the global hotkeys                                                                                              |
| `src/components/react/Dial.tsx` | The instrument. Draw order: glow → your lightcycle band → the second zone's band → zone numerals → elapsed ring → ticks → numerals → drag annulus → event arcs → ghost arc → now-hand |
| `src/components/react/types.ts` | All panel prop contracts (`DialProps` and `CenterPanelProps` are the two deliberate exceptions, declared locally)                                                                     |
| `astro.config.mjs`              | `devToolbar: false` (it floats over the dial), `trailingSlash: "always"`                                                                                                              |
| `eslint.config.js`              | Flat config; `jsx-a11y/no-autofocus` is off for exactly `CommandPalette.tsx` and `EventEditor.tsx` (modals must take focus)                                                           |
| `wrangler.jsonc`                | `main` + `assets.binding` — the Worker exists for `/api/feed` and nothing else                                                                                                        |

## Runtime/Tooling Preferences

- **Node ≥ 22.12.0**, **pnpm 11.2.2** (pinned via `packageManager`). Not Bun, not npm — `pnpm-lock.yaml` and `pnpm-workspace.yaml` are authoritative.
- `pnpm-workspace.yaml` is **not** a monorepo marker; it holds the `allowBuilds` whitelist for native deps (`esbuild`, `@tailwindcss/oxide`, `lightningcss`, `sharp`, `workerd`). Add to it if a new dep needs a build script.
- Animation is **`motion`**, not `framer-motion` — `import { motion, useReducedMotion } from "motion/react"`, and always honour `useReducedMotion`.
- Icons are `lucide-react` at `size={14}`–`15`, `strokeWidth={1.75}`.
- There is **no state-management library** and no UI-component library; `clsx` + `tailwind-merge` back `cn()` in `src/lib/utils.ts`.
- Fonts are self-hosted via Fontsource (Geist / Geist Mono). No external requests at runtime.

## Testing & QA

**There is no test framework in this repo** — no vitest, jest or playwright, no `*.test.*` / `*.spec.*` files, no `test` script. Do not claim tests pass.

The honest verification path is:

1. `pnpm verify` — proves it formats, lints, typechecks and builds. It proves nothing about behaviour.
2. **Drive the change in a browser.** `pnpm dev`, then exercise the specific path: create an event, drag the ring, open ⌘P, switch the dial mode, step days. The dial is a visual instrument; a screenshot of the changed state is the proof.
3. **Anything touching `/api/feed`, the service worker or the manifest needs `pnpm dev:worker`.** `astro dev` serves neither the Worker route nor a PROD build, so a subscription cannot be added and the service worker never registers.

If you add a test framework, wire it into `verify` in `package.json` so the gate stays single.

## Gotchas

- **`dayKey()` is deliberately local-time.** `toISOString()` shifts the day west of UTC, which is exactly where a day-keyed store breaks. Never swap it in.
- **`angleAt` and `minutesAtPoint` are exact inverses** and must stay so. Both take a `Clock` and differ only by `origin()` — the minute that sits at the top (720 for `12h`, 0 for `24h`).
- **`arcPath` draws a full turn as two half-arcs**, because a single elliptical arc whose endpoints coincide renders nothing. Removing that branch makes a whole-day arc vanish.
- **A gradient built from overlapping strokes must be opaque.** The elapsed ring is a chain of arcs, and translucent ones compound their alpha wherever they overlap — every join paints a bright bead and the trail reads as a row of tick marks. On a true-black canvas an opaque grey is identical to translucent white, so `Dial.tsx` ramps the _colour_ (`grey(level)`), uses butt caps between segments and rounds only the two ends of the whole run.
- **The now-hand stops at `DIAL.HAND_INNER` (205).** A hand through the centre crosses the readout and the agenda, which is a lot of ink spent on a time the readout already prints. It is a spoke: a pip on the track at the exact minute, fading out along a `userSpaceOnUse` gradient before the centre panel. If the panel grows, `HAND_INNER` must clear its furthest corner.
- **Lane packing is face-independent.** `dayAgenda` takes no `Clock`: both faces put one day on one revolution, so two events collide on screen exactly when they collide in time.
- **`CalEvent.color` is an override, not the colour.** Empty string means "follow the calendar" and is the default every event should stay on, so recolouring a calendar still moves them. Only `colorOf` knows the precedence.
- **`Settings` is schema-versioned.** `SCHEMA` in `src/lib/store.ts` is bumped when a stored value changes _meaning_ rather than shape (it went to `2` when `clock: "24h"` stopped meaning the noon-at-top face). A stale schema resets settings to defaults and keeps events.
- **Store hydration is lazy, at first `subscribe`**, not module scope; `load()` and `write()` swallow `localStorage` errors on purpose (private mode / quota must not brick the app) — but `write()` also calls `notify(…, "error")`, because a silent failed save is indistinguishable from a successful one and that is how a day's events disappear.
- **Every action derives from `fresh()`, never from the module's `snapshot`.** `fresh()` re-reads the blob when another tab has written since we last looked. Deriving from the in-memory snapshot loses the other tab's events wholesale in the window before its `storage` event arrives.
- **Undo is in-memory and session-scoped**, and it is cleared on an inbound `storage` event: undoing onto a base another tab has moved past would resurrect what it just deleted. `commit(next, false)` opts a change out of the history — settings and feed pulls do.
- **`seed()` only runs when no stored blob exists** and anchors on today's local midnight.
- **`<input type="time">` is banned here** — it renders in the _browser's_ UI locale, not the app's. Use the `TimeField` in `EventEditor.tsx`, backed by `parseClock` (accepts `10:45 AM`, `10:45am`, `1045`, `9p`, `13:00`).
- **No `backdrop-filter` on an element that also carries `.fade-y`** — Chromium paints the blur over a box far larger than the element, appearing as a grey rectangle mid-dial (see the comment in `CenterPanel.tsx`).
- **Your lightcycle band replaces the elapsed ring; it does not join it.** Both live on `DIAL.TRACK` at `DIAL.TRACK_WIDTH`, and `elapsedSegments` returns `[]` whenever the band has a half left to draw (`place && (daylight || moonlight)`, computed once as `band`). A second band on its own radius _next to_ the track was the first attempt and read as one line accidentally doubled. There is deliberately no `DIAL.SUN`.
- **The second zone's band is a different place, so it does get its own rim.** `DIAL.ZONE_BAND` (424) sits 21 units outside the track and 13 inside the zone numerals it belongs to, and `SunBand` takes a `radius` for exactly this. Its halves are `zoneDaylight` / `zoneMoonlight` — independent of yours, because the point of the ring is comparing two places, and comparing them half-drawn is not a comparison. Its coordinates come from `placeForZone(secondZone)`, resolved in `App.tsx`; `null` (`UTC`, aliases like `Asia/Calcutta`) means no band and no switches offered.
- **The lightcycle bands are the one sanctioned break in "chrome is greyscale".** They are data about the day, not chrome, so they are warm-but-desaturated for day and a dim violet for night, and neither may compete with an event arc. They use the same opaque-segment technique as the ring they replace, for the same alpha-compounding reason.
- **`light(m)` in `SunBand` must stay continuous through zero.** It returns signed light — positive sun, negative night — and the civil-twilight shoulders reach exactly `0` at the horizon so the warm band and the violet band meet without either starting on a step. Every discontinuity in that function is a visible edge on the rim; the shoulders used to begin at `0.04` and the band began with a hard line. 288 segments (five minutes each, an eight-unit chord) is what makes the ramp stop looking stepped.
- **The two halves are a draw-time filter, not an argument to `light`.** The curve is computed for the whole day either way and the segment loop drops the half that is switched off, so the half that stays keeps the exact shape it had beside the other. Yours default on, because the band _is_ the track; with both off the elapsed ring comes back rather than leaving the rim empty. The second zone's default off — a caption annotates a ring that is already there, a band is another ring. `night` was the old name for `moonlight`: `migrateSettings()` in `store.ts` carries a stored one across, and `readSettings()` in `backup.ts` does the same for a backup.
- **`DIAL.ZONE` (446) is what fixes `PAD` (30).** The crop leaves 470 units of radius; a 15-unit numeral centred on `ZONE` reaches 453, and the caption beside the topmost one runs up to 131 units further right — eight units short of the crop at the worst anchor angle. Anything further out gets cropped: move `PAD` before you move `ZONE`, and keep `ZONE_BAND` _inside_ `ZONE`, because the caption runs horizontally outwards from a numeral and would otherwise cross the band.
- **The zone caption hangs off the topmost of the four marks**, to its right, never beneath. Beneath, it collided with the hour numeral below it and ran off the viewBox at three o'clock. The four marks are 90° apart, so one is always within 45° of the top, which is where the horizontal room is.
- **The zone ring is measured against the viewer, never against UTC.** `delta = zoneOffset(now, zone) + now.getTimezoneOffset()` — the caption reads `Tokyo +7`, because you are the origin of this dial and "GMT+9" makes the reader do the subtraction. It is also the only form that stays right in the weeks when one of the two zones has changed for DST and the other has not.
- **Read-only events are a `disabled` fieldset**, not a prop threaded through every control. It cascades to the swatch buttons and the `Select`s nested two components deep, which nothing else would reach. The title input sits outside it and carries its own `disabled`.
- **`sun.ts` returns minutes since local midnight and does not clip.** A place far from the viewer legitimately produces a negative sunrise or a sunset past 1440; `Dial.tsx` samples inside `[0, 1440]` and lets the rest fall off the face.
- **A place is chosen by city, never typed.** `settings.place` carries the IANA zone it was picked by, and `placeForZone` is the only thing that turns a zone into coordinates — so the picker can always show what the band is drawing. `store.parse()` drops a stored place with no `zone`: a band the settings panel says is off is worse than no band. Coordinates come from `zone.tab`, so they name the zone's principal city; that is a couple of minutes of sunrise error at worst, finer than the band draws.
- **The icons and `og.png` are the only unhashed assets, so `CACHE` in `sw.js` ships them.** Everything Astro builds is content-hashed; `public/` is not. The worker serves `public/` stale-while-revalidate, so an installed client gets the _old_ icon one more time after a change unless `CACHE` is bumped. Bump it in the same commit that touches an icon.
- **`icon-192.png`, `icon-512.png` and `apple-touch-icon.png` are rasterised from `icon.svg`** — `rsvg-convert -w N -h N public/icon.svg -o public/icon-N.png` — and `public/og.png` (1200×630) is rendered in a browser, because it sets type in Geist and Geist Mono and no rasteriser here has them: the mark at the icon's own stroke proportion, `circal` at 104px/500 and `-0.035em`, the tagline in mono at 22px/500 uppercase and `0.2em` tracking on `--ink-2`. There is no build step for any of them; edit the SVG, re-render, bump `CACHE`.
- **The favicon's `r=11` / `stroke-width=2.4` were chosen at 16px, not by ratio.** That radius puts both stroke edges on whole pixels where a circle is otherwise smeared across three, and anything thinner antialiases to grey instead of white. Re-render at 16px before changing either.
- **The wordmark in `TopBar` disappears below 1080px.** The date readout is absolutely centred on the bar, not on the space the two button groups leave, so the lockup's 108px comes straight out of the readout's clearance; 1080 is where they still clear with the longest header `formatDayHeader` produces. Anything added to the left group has to re-check that number.
- **The detent click's `AudioContext` is built inside `onPointerDown`, never at module load.** `lib/feedback.ts` constructs it on first `detent()` — a context made outside a user gesture starts `suspended` and stays there, so the first drag of the session would be silent. It also re-`resume()`s on every click, because a backgrounded tab comes back asleep. `LEVEL` (0.9) is gain _into_ two narrow bandpass filters, not the peak: a three-millisecond noise impulse loses most of its energy in them and the graph renders at a peak of about 0.25. Retune by rendering it in an `OfflineAudioContext`, not by ear alone.
- **`detent()` is noise, `chime()` is pitched, and only the detents are rate-limited.** The two chimes (`opened` on releasing a create-drag, `created` on saving a _new_ event — an edit stays silent) are one-shot oscillator figures that land straight after a drag's last click, which is exactly the 22 ms window `MIN_GAP_MS` exists to swallow, so they bypass it. Their `level` is peak amplitude straight to the destination, unlike a detent's pre-filter gain; rendered offline they peak at 0.16 and 0.12. Notes get a 1.5 ms attack because an oscillator started at full gain begins with a step edge, which is a click in front of the note.
- **`onRingMove` and `onArcMove` bail when the snapped minute has not changed.** That is what makes the clicks countable — one per fifteen-minute step rather than one per pointer event — and it also drops the re-render a `pointermove` would otherwise cause. `detent()` has its own 22 ms floor for the same reason, since a fast flick crosses steps faster than the ear separates them.
- **An arc's drag accumulates `wrapDelta` per pointer event; it never measures from the grab.** Two ring positions do not say which way round the circle the pointer went, so a delta measured from the grab flips sign the moment the drag passes twelve hours. Summing short hops instead lets a drag cross midnight as many times as it likes.
- **The minimum duration is clamped on the `delta`, not on the resulting instant** (`clampDelta` in `Dial.tsx`). Clamp the end and the overshoot is banked: the arc then lags by however far the pointer ran past the limit before it starts following back. Clamp the delta and it stops dead and releases instantly — and since the sound fires only when the delta changes, a clamped arc goes quiet, which is the feedback that says "this is as short as it gets".
- **A press on an arc that never changed the delta is a click.** `onArcUp` opens the editor when `delta === 0`, which is also the whole implementation of read-only arcs: a subscription's occurrence gets `grip: "none"`, `clampDelta` pins it to zero, and the press falls through to opening. There is no separate `onClick`.
- **Dragging an arc writes to the event's instants, so a recurring event moves as a series.** Shallow recurrence has no per-occurrence exceptions (see `occurrenceStartingOn`), and the editor already behaves this way. `App.adjustOccurrence` notifies when the event lands off the day on screen, because the arc vanishing from the face otherwise reads as a deletion.
- **The editor's Date row must call `showPicker()` itself.** The row is a transparent `input[type=date]` stretched over a label, and Chrome and Safari open the calendar only from the indicator that input is hiding — clicking the field opens nothing. `openDatePicker()` in `EventEditor.tsx` wraps the call, because it throws outside a user gesture and does not exist in every browser that renders the field.
