# app

Findings on shipping circal as a desktop app alongside the website. Researched 2026-08-07;
nothing here is built yet.

**Verdict: Tauri, macOS and Windows only. Linux gets the PWA.** The reason to do it is not the
icon — it is that a browser eats six of the app's shortcuts, including two it will not give back.

## what already ships

The PWA is complete and nobody has to write anything for it.
`public/manifest.webmanifest` is `display: standalone` with 192/512/maskable icons and a black
theme; `public/sw.js` runtime-caches. Add to Dock in Safari or ⌘⇧A in Chrome and it is a windowed
app today. Offline is free because there is no server-side state to lose — user events live in
`localStorage` under `circal.v1`, and the only route in the project is `/api/feed`.

So the question is never "can this be an app". It is "what does a shell buy over the PWA".

## what a shell buys

**Six shortcuts back.** This is the whole argument, and it is a product argument rather than a
packaging one. `hooks.ts:143` binds `e.metaKey || e.ctrlKey`, so the bindings themselves are sound,
but the browser resolves these before the page ever sees them:

| circal         | browser           |
| -------------- | ----------------- |
| `⌘D` day view  | bookmark          |
| `⌘L` life view | focus address bar |
| `⌘N` new event | new window        |
| `⌘Y` year view | history (Safari)  |
| `⌘P` palette   | print             |
| `⌘,` settings  | settings (Chrome) |

`⌘N` and `⌘L` are handled above the page and cannot be reclaimed with `preventDefault` at all.
[INFERENCE — documented browser behaviour, not keyboard-tested here; synthetic events cannot test
it, since they never reach browser chrome.] The rest are recoverable but hostile: a user who has
not yet learned the app will bookmark the page trying to see their day.

A keyboard-first calendar losing a third of its keyboard is not a cosmetic problem. Everything else
below is a rounding error next to this.

**`/api/feed` stops mattering.** The Worker route exists only because no calendar host sends CORS
headers (`worker/index.ts`, 299 lines). Native HTTP has no CORS, so a shell fetches ICS directly
and `lib/feeds.ts` (89 lines) grows one platform branch. The route stays for the website; app users
skip the proxy hop entirely.

**Menu bar, dock icon, no URL bar, a global shortcut to summon the dial.** Worth having, not worth
building for.

## tauri vs electron

Rust is not the reason to pick Tauri, and it will not make the dial faster. The frontend is the
same SVG, canvas and React either way; the shell language owns the window and the menus and nothing
on the render path. **Frame time is decided by the webview engine.** Tauri's win is binary size and
memory — 5–10 MB against Electron's 90–150 MB.

Electron's win is one engine everywhere. That matters here more than it usually would, because this
codebase is full of rendering constraints it had to discover the hard way, and every one of them was
verified against exactly two engines. But it turns out you can have both, because:

**Tauri's engine risk is entirely Linux.**

| platform | engine    | new risk                                                            |
| -------- | --------- | ------------------------------------------------------------------- |
| macOS    | WKWebView | none — the engine Safari visitors already run against the live site |
| Windows  | WebView2  | none — Chromium, the engine Chrome visitors already run             |
| Linux    | WebKitGTK | real, and circal is unusually exposed                               |

So Electron would bundle 150 MB on every platform to defend against a problem that exists on one.
Ship mac and Windows from Tauri, point Linux at the PWA — which already works in Chromium — and the
defence costs nothing.

## why linux specifically

[Tauri's own Linux graphics page](https://v2.tauri.app/develop/debug/linux-graphics/) has two lines
that land directly on this app.

> canvas content can silently land on a slow path while the rest of the app looks fine… There is no
> error to catch.

`LifeView.tsx:383-387` blits an offscreen field canvas and `:407` masks it with a radial gradient in
`destination-in`, **once per frame** of the zoom wave, at a budget of about 4 ms. The whole reason
the field lives in its own canvas (`:431-434`) is that thirty thousand arcs per frame is not
affordable. Land that on a software rasterizer and the wave stutters, with nothing thrown and
nothing to log.

And [discussion #9088](https://github.com/tauri-apps/tauri/discussions/9088): _"when a CSS animation
is playing, the rest of the app gets blurry."_ Per `astro.config.mjs:8-10`, _"the whole product is
one continuously-animating clock."_

The workaround ladder ends at `WEBKIT_DISABLE_COMPOSITING_MODE=1`, which for a 288-segment gradient
rim and a 30k-dot canvas is not a workaround. Upstream: [tauri#9394](https://github.com/tauri-apps/tauri/issues/9394),
[webkit#261874](https://bugs.webkit.org/show_bug.cgi?id=261874).

Revisit if anyone asks for a Linux build; ship it with the env-var caveat documented rather than
pretending it is equivalent.

## risk surface, audited

Smaller than first assumed. Two of the scares were wrong:

| feature                  | where                    | verdict                                                                                                                                                |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backdrop-filter`        | —                        | **not used.** `CenterPanel.tsx:278-282` documents deliberately _not_ using it                                                                          |
| `destination-in`         | `LifeView.tsx:407`       | ancient, universally supported. The risk is the _slow path_, not support                                                                               |
| `mask-image`, unprefixed | `global.css:127,140`     | needs `-webkit-` on older WebKit; lightningcss prefixes from targets                                                                                   |
| Tailwind v4 output       | `astro.config.mjs:19-21` | no explicit targets, so Tailwind's own baseline applies — Safari 16.4 / Chrome 111. Fine on WKWebView and WebView2; a WebKitGTK version floor on Linux |
| `showPicker()`           | `primitives.tsx:318-328` | already guarded and already documented as absent in some engines. Degrades to a typeable field                                                         |
| `createBiquadFilter`     | `feedback.ts:341,354`    | universal. The _tuning_ is measured against Chromium and WKWebView only                                                                                |
| `userSpaceOnUse`         | `Dial.tsx:1332`          | ancient SVG                                                                                                                                            |
| `devicePixelRatio`       | `LifeView.tsx:383,431`   | fine                                                                                                                                                   |
| fonts                    | Fontsource, self-hosted  | no system fallback drift                                                                                                                               |

## work, in order

**1. ⌘/Ctrl labels — do this regardless, it is a live bug.** `hooks.ts:143` and
`EventEditor.tsx:404` both accept Ctrl, so the behaviour is already cross-platform. Every label is
not. Windows and Linux visitors are told, right now, to press a key their keyboard does not have:

- `TopBar.tsx:51-53` view segments, `:95` palette pill, `:101` new-event pill
- `CommandPalette.tsx:294,318,333,348,399,414` — six hints
- `EventEditor.tsx:811` Delete, `:829` Save
- `App.tsx:545`, `backup.ts:310,351` — three "⌘Z to undo" toasts

**Open decision, and it is not mine.** `primitives.tsx:17` documents `Kbd` as _"Renders the glyph,
never the word (`⌘`, not `Cmd`)"_, and `AGENTS.md` carries the rule. There is no Ctrl glyph anyone
reads — Windows expects the word — so platform-aware labels break a rule that was written on
purpose. Two ways out:

- `⌘` / `Ctrl` — correct for users, breaks the glyph rule on Windows
- `⌘` / `⌃` — keeps the rule, and `⌃` means nothing to a Windows user

Pick one before the rest. It is ~8 files and a `MOD` constant either way, plus a `platform.ts`
in `src/lib/` — which by `AGENTS.md`'s standing rule owes a `tests/platform.test.ts`.

**2. Scaffold `src-tauri/`.** Point it at `dist/`. Check `trailingSlash: "always"`
(`astro.config.mjs:13`) against Tauri's asset protocol before assuming index resolution works.

**3. Branch `lib/feeds.ts`** onto native fetch, no proxy.

**4. Native menu and global shortcuts** for the six reclaimed keys.

**5. Icons.** Add `.icns` and `.ico` to the existing `rsvg-convert` recipe in `AGENTS.md`. Bump
`CACHE` in `sw.js` if any `public/` icon changes, per the standing rule.

## the alternative worth naming

A true native rewrite (SwiftUI, CoreGraphics) is weeks, and the dial is not the expensive part.
`src/lib` is 5,474 lines of pure domain logic that would all have to be re-derived: `recur.ts` (685,
the RFC 5545 expand/limit cascade), `ics.ts` (634, hand-rolled parser with folding, EXDATE,
RECURRENCE-ID), `store.ts` (832), `life.ts` (536), `sun.ts` (NOAA solar position). Plus the 602-case
suite that pins their correctness. Redrawing the instrument is days; re-earning that correctness in
another language is the cost, and it buys nothing a webview does not already deliver.
