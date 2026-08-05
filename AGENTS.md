# Repository Guidelines

## Project Overview

**circal** is a calendar whose day view is a single dial — a web recreation of Raycast's macOS app _Radical_. One revolution is twenty-four hours: **noon at the top, midnight at the bottom, clockwise**, so 6 AM sits at nine o'clock and 6 PM at three. Events are arcs, the elapsed day is a ramp of light around the rim, the hand is the current minute.

No backend. Events live in `localStorage` under `circal.v1`. Shipped as an assets-only Cloudflare Worker.

`README.md` covers the user-facing keyboard table and feature tour — this file covers the parts you need in order to _edit_ the code safely.

## Architecture & Data Flow

```
src/pages/index.astro   static HTML shell
  └─ <App client:only="react" />        ← the ONLY island in the project
       ├─ useStore()   → { events, calendars, settings }   (persisted)
       ├─ useState ×5  → day, view, sidebarOpen, editor, paletteOpen
       ├─ useNow()     → ticking Date, second-aligned
       └─ actions: ShellActions (one useMemo object)
            ├─ TopBar / Sidebar / CommandPalette   receive `actions` whole
            └─ Dial / EventEditor / YearView       receive narrow callbacks
```

- **`src/lib/` is the domain layer**, mostly pure. Dependency direction is one-way: `time.ts` (base, imports nothing) ← `dial.ts`, `events.ts` ← `store.ts`. Components import it via `@/lib/*` and never reimplement geometry or date maths locally.
- **The store is the only source of truth for persisted data.** `App.tsx` holds _view_ state only (which day, which view, which overlay). Mutations go through `store.create/update/remove/toggleCalendar/setClock` — never `setState` a copy of an event.
- **`dayAgenda(events, calendars, day, clock)`** is the single read path onto a day: it expands recurrence, clips to the day, and packs overlapping events onto concentric lanes. `Dial`, `CenterPanel` and `Sidebar` all render from its output.
- **Units.** Everything inside the dial is _minutes since local midnight_ (`0…1440`). `CalEvent.start`/`end` are **epoch milliseconds**, and `end` is **exclusive**. Nothing downstream of `dayAgenda` reasons about a `Date`.

## Key Directories

| Path                                     | Purpose                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/dial.ts`                        | Polar geometry: the `DIAL` radius table, `angleAt` / `polar` / `arcPath` / `minutesAtPoint` / `capInset`, the `Clock` type |
| `src/lib/time.ts`                        | Day arithmetic and the app's formatting voice (`formatTime`, `formatDuration`, `parseClock`, `dayKey`, `snap`)             |
| `src/lib/events.ts`                      | `CalEvent` / `Calendar` / `Occurrence`, recurrence expansion, `packLanes`, `dayAgenda`                                     |
| `src/lib/store.ts`                       | `useSyncExternalStore` over `localStorage`, `PALETTE`, `draftEvent`, seed data                                             |
| `src/components/react/`                  | The island. `App.tsx` shell, `Dial.tsx` instrument, panels                                                                 |
| `src/components/react/ui/primitives.tsx` | The six shared controls all chrome is built from                                                                           |
| `src/components/react/types.ts`          | **Every panel prop interface.** Edit shapes here                                                                           |
| `src/styles/global.css`                  | Design tokens, `@theme inline` colour mappings, four component classes                                                     |

## Development Commands

```sh
pnpm install
pnpm dev        # astro dev — http://localhost:4321
pnpm verify     # THE gate: format:check && lint && check && build
pnpm format     # prettier --write . (run this, never hand-format)
pnpm deploy     # astro build && wrangler deploy
```

`pnpm verify` is the only quality gate; run it before declaring work done. Individual steps: `pnpm format:check`, `pnpm lint` (eslint), `pnpm check` (astro check / tsc), `pnpm build`.

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

`fill-*` and `stroke-*` variants exist too and are used in SVG. Component classes: `.label` (uppercase 11px mono, the app's label voice), `.kbd`, `.fade-y` (mask a scroll area's ends), `.no-scrollbar` — pair the last two on every scroll region. Chrome is greyscale by rule: **colour belongs to events**, sourced from `colorOf(event, calendars)`.

**New chrome must reuse `ui/primitives.tsx`** — `Kbd`, `IconButton`, `ActionPill`, `Segmented`, `Switch`, `Select`. Do not hand-roll a button.

**State sync — hard convention.** `react-hooks/set-state-in-effect` is active and will reject an effect that copies props into state. When new props must reset local state, use React's render-phase adjustment pattern (four existing sites: `Sidebar.tsx:37`, `EventEditor.tsx:134` and `:82`, `CommandPalette.tsx:152`):

```tsx
const [seeded, setSeeded] = useState(day);
if (seeded !== day) {
  setSeeded(day);
  setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
}
```

**Effects are for external systems only** — `window` listeners, `ResizeObserver`, timers.

**Hotkeys** — `useHotkeys({ "mod+k": fn })`. Combo format is optional `mod+` (⌘ or Ctrl), optional `shift+`, then the lowercased `e.key` (`k`, `escape`, `arrowleft`, `t`). Handlers are skipped while the user is typing in an input unless the combo carries `mod` or is `Escape`.

**TypeScript** — `strict`, no `any`. Prefix intentionally unused bindings with `_`.

**Comments** explain _why_, never _what_. Most non-obvious decisions in this repo already carry one; read it before changing the line.

## Important Files

| File                            | Why it matters                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/index.astro`         | The only route. Mounts `<App client:only="react" />` — `client:only` because a live clock plus `localStorage` makes any SSR markup wrong on hydrate |
| `src/components/react/App.tsx`  | Island root; owns view state, builds `actions`, registers the nine global hotkeys                                                                   |
| `src/components/react/Dial.tsx` | The instrument. Draw order: elapsed ring → ticks → numerals → band guides → drag annulus → event arcs → ghost arc → now-hand                        |
| `src/components/react/types.ts` | All panel prop contracts (`DialProps` and `CenterPanelProps` are the two deliberate exceptions, declared locally)                                   |
| `astro.config.mjs`              | `devToolbar: false` (it floats over the dial), `trailingSlash: "always"`                                                                            |
| `eslint.config.js`              | Flat config; `jsx-a11y/no-autofocus` is off for exactly `CommandPalette.tsx` and `EventEditor.tsx` (modals must take focus)                         |
| `wrangler.jsonc`                | Assets-only Worker — deliberately no `main`                                                                                                         |

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
2. **Drive the change in a browser.** `pnpm dev`, then exercise the specific path: create an event, drag the ring, open ⌘K, switch the dial mode, step days. The dial is a visual instrument; a screenshot of the changed state is the proof.

If you add a test framework, wire it into `verify` in `package.json` so the gate stays single.

## Gotchas

- **`dayKey()` is deliberately local-time.** `toISOString()` shifts the day west of UTC, which is exactly where a day-keyed store breaks. Never swap it in.
- **`angleAt` and `minutesAtPoint` are exact inverses** and must stay so; `minutesAtPoint` takes a `pm` flag because a 12-hour angle names two times a day.
- **`arcPath` has two special cases**: it adds 360° when `to < from` (12-hour wrap), and draws a full turn as two half-arcs because a single arc whose endpoints coincide renders nothing. Removing either makes arcs vanish.
- **`dayAgenda` packs lanes per band in 12-hour mode** (split at minute 720). Do not merge the two `packLanes` calls — a 9 AM and a 9 PM event share an angle but sit on different rings.
- **Store hydration is lazy, at first `subscribe`**, not module scope; `load()` and `commit()` swallow `localStorage` errors on purpose (private mode / quota must not brick the app).
- **`seed()` only runs when no stored blob exists** and anchors on today's local midnight.
- **`<input type="time">` is banned here** — it renders in the _browser's_ UI locale, not the app's. Use the `TimeField` in `EventEditor.tsx`, backed by `parseClock` (accepts `10:45 AM`, `10:45am`, `1045`, `9p`, `13:00`).
- **No `backdrop-filter` on an element that also carries `.fade-y`** — Chromium paints the blur over a box far larger than the element, appearing as a grey rectangle mid-dial (see the comment in `CenterPanel.tsx`).
- **Dead code, safe to delete**: `fromDayKey` in `src/lib/time.ts` and `store.recolorCalendar` in `src/lib/store.ts` have no callers.
