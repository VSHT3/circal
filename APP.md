# app

circal as a desktop app alongside the website. Researched 2026-08-07, **built for macOS 2026-08-15**:
`mac/` is a Swift shell around a `WKWebView`, and `pnpm mac` produces a 1.7 MB `.app` (2.0 MB
universal). Windows is still unwritten and still wants Tauri. Linux gets the PWA.

The reason to do it was never the icon — it is that a browser eats six of the app's shortcuts,
including two it will not give back. What the shell turned out to be worth beyond that: reminders,
trackpad haptics, the mirror file the MCP server reads, a menu bar countdown, its own login item and
Dock-visibility toggle, notification actions and one global chord.

## what ships

**The PWA**, complete, and nobody had to write anything for it. `public/manifest.webmanifest` is
`display: standalone` with 192/512/maskable icons and a black theme; `public/sw.js` runtime-caches.
Add to Dock in Safari or ⌘⇧A in Chrome and it is a windowed app. Offline is free because there is no
server-side state to lose — user events live in `localStorage` under `circal.v1`, and the only route
in the project is `/api/feed`.

**The macOS shell**, `mac/`, four files and no dependency:

| file         | what it is                                                                        |
| ------------ | --------------------------------------------------------------------------------- |
| `main.swift` | the shell: loopback server, webview, menu, status item, hot key, the bridge       |
| `Info.plist` | bundle id `app.circal.mac`, single-instance, ATS local networking                 |
| `icon.svg`   | the favicon's mark on Apple's icon grid — an 824px body in 1024, radius 185.4     |
| `build.sh`   | `rsvg-convert` × 10 → `iconutil` → `swiftc` → `codesign`. ~3s, `--universal` ~40s |

`pnpm build:mac` builds the site and the bundle; `pnpm mac` also opens it. `mac/build/` is ignored by
git, eslint and prettier — it holds a copy of `dist/`, and linting a build is a page of warnings
about code nobody wrote.

## what the shell buys

**Six shortcuts back, and a seventh the web can never have.** This is the whole original argument, and
it is a product argument rather than a packaging one:

| circal         | browser           | in the shell                    |
| -------------- | ----------------- | ------------------------------- |
| `⌘D` day view  | bookmark          | reaches the page — **verified** |
| `⌘L` life view | focus address bar | reaches the page — **verified** |
| `⌘P` palette   | print             | reaches the page — **verified** |
| `⌘W` week view | closes the tab    | reaches the page — **verified** |
| `⌘N` new event | new window        | reaches the page                |
| `⌘Y` year view | history (Safari)  | reaches the page                |
| `⌘,` settings  | settings (Chrome) | reaches the page                |

`⌘N` and `⌘L` cannot be reclaimed with `preventDefault` in any browser, which is what made a shell the
only route. In Cocoa a ⌘-chord is offered to the menu bar first and to the first responder second, so
**the menus in `main.swift` work by omission**: no File menu (⌘N, ⌘P), no Settings item (⌘,), no
Undo/Redo in Edit (⌘Z, ⇧⌘Z, which the app's own sixty-step history takes instead), and no ⌘W on the
window item. Cut, Copy, Paste and Select All stay, because a text field needs the responder chain to
be told about them and none of those four is a circal binding.

⌘W is the interesting one. `App.tsx` binds `mod+w` **as well as** `mod+e`, and the line costs nothing
on the web: a browser closes the tab and never delivers the keydown, so it is dead there and correct
here. The chip in the top bar stays ⌘E, because that is the spelling true on every platform.

**Reminders, through the system, and they work on an ad-hoc build.**
`Notification.requestPermission()` answers `denied` in a WKWebView (measured): the grant path is
WebKit SPI. So `BRIDGE_JS` replaces `window.Notification` with a shim that posts to the shell, which
asks `UNUserNotificationCenter` and answers with the real verdict; a tapped banner hands the
occurrence's tag back to the page, where `note.onclick` already knows to focus and open the event.
`hooks.ts` and `remind.ts` are untouched.

Verified end to end on this ad-hoc signed build: the system prompt appeared under circal's own name
and icon, the log recorded `Requested authorization [ didGrant: 1 hasError: 0 ]` and
`Authorization set for app.circal.mac to allow: YES`, and a reminder ten minutes out arrived as a
banner reading `Reminder probe · in 10m · 09:54` **while the window was hidden** — which is the case
the whole put-away-rather-than-quit decision exists for.

There is a fallback behind it, and the reason is worth keeping even though circal does not need it: a
bundle the notification system declines is refused outright with `UNErrorDomain` code 1,
_"Notifications are not allowed for this application"_ — measured on a throwaway ad-hoc bundle, via
LaunchServices and directly, with a regular activation policy. Whatever distinguishes that bundle
from this one, a switch that turns on and then never fires is worse than one that says no, so an
**error** (never a plain refusal from the user) drops the bridge onto `osascript`'s own
`display notification`, which an ad-hoc bundle may use (measured: exit 0, no TCC prompt, no
Automation gate). It costs the banner its icon and its click, and it is remembered in `UserDefaults`
so the switch survives a reload. On this machine that flag reads `0`: the real path was taken.

**Snooze 10m and Open, on the banner itself.** A `UNNotificationCategory` carries both; `Open` is the
same `note.onclick` path a tap already used, and `Snooze` never leaves the shell — it re-posts the
identical banner ten minutes later rather than asking the page anything, because `remind.ts`'s
reminders are never allowed to catch up, and a snoozed one asking the page again would be exactly
that (`AGENTS.md`). Verified for real: a banner snoozed at 07:23:08 came back, identical, ten minutes
on. The `osascript` fallback above gets neither button — `display notification` has nothing to attach
them to — and does not pretend otherwise.

**Trackpad haptics, which the web build has never had at all.** `navigator.vibrate` is undefined in
every desktop browser, so `canVibrate()` was false and the Vibration toggle never appeared. The shim
maps the pattern `feedback.ts` already speaks — on, off, on — onto `NSHapticFeedbackManager`, one
`.alignment` strike per contact. The dial's fifteen-minute detent is now a detent you can feel.
**A lid closing does not leave the clock stale.** `useNow` already re-reads the clock and re-arms
its timer on `focus` and `visibilitychange` (`AGENTS.md`); the shell's only job is supplying the
`focus` a suspended machine never fires on its own — `NSWorkspace.didWakeNotification` dispatches a
synthetic one at the page. A reload would fix the same one-minute skew and was rejected on purpose:
it throws away scroll position, an open editor and an unsaved draft to correct a clock nobody would
otherwise have noticed was wrong.

**Ambient can take the screen.** `⇧F` withdraws the chrome and asks for the display through
`documentElement.requestFullscreen`, and in a `WKWebView` that method is undefined until
`WKPreferences.isElementFullscreenEnabled` is set: `document.fullscreenEnabled` reads false, the
request rejects, and `App.tsx` swallows the rejection on purpose (it is rejected rather than thrown
outside a user gesture in browsers too). So the mode shipped in the app half-done, chrome away and
the display untouched, which reads as a bug rather than a setting. One line in the configuration,
and `Esc` leaves through `fullscreenchange` exactly as it does on the web. Measured next door in the
same probe: `navigator.wakeLock` **is** here and `request("screen")` resolves, so the mode's other
half needed nothing.

**The window is the theme's colour, not black.** Three presets arrived after the shell did, and the
shell painted one of them: `paper` had a black titlebar strip and a black over-scroll around a
near-white page, with the traffic lights drawn for a dark window on a light one. `App` writes the
preset onto `<html data-theme>`, so `BRIDGE_JS` watches that attribute with a `MutationObserver` and
reports it; the shell holds each preset's `--void` (the same three `THEME_PALETTES` carries, for the
same reason: neither a canvas nor a window can read a CSS token) and sets the window's background,
the webview's `underPageBackgroundColor` and the window's appearance from it. Remembered in
`UserDefaults`, because the page cannot name a theme until its island has mounted and the window has
painted long before that — the white-flash fix arriving from the other side.

**The mirror file, so the MCP server works in the app.** `WKWebView` ships none of the File System
Access API (`showSaveFilePicker`, `showOpenFilePicker`, `showDirectoryPicker` are all undefined —
measured), so `mirrorSupported()` was false and the assistant story was silently missing. The shell
provides `window.__circalMirror` and `mirrorLink.ts` branches onto it: a save panel, then a
**security-scoped bookmark** rather than a browser handle, which follows the file when it moves. That
undersells it now — the _first_ launch needs no gesture either. `MirrorFile.remembered()` mints and
adopts `~/Library/Application Support/circal/calendar.json` the moment nothing is remembered and
nobody has declined, so an assistant connects before anyone has opened Settings at all; the save
panel is still there for iCloud Drive or a repo, it is just no longer the only way in. Everything
downstream — the poll, the digest, the three verdicts, `store.adopt` — is the same code the browser
path runs.

**A `.ics` dropped on the Dock icon imports itself.** `Info.plist` claims `.ics` as a viewer, or the
Dock refuses the file outright; `application(_:open:)` reads it as UTF-8 text and hands it to
`window.__circalImportIcs` — the settings panel's own Import button, unchanged — so a drop and a menu
import cannot mean two different things: same new calendar, same toast, same undo step. The shell
parses nothing; `src/lib/ics.ts` stays the only parser. A drop that lands before the page has
registered that global is queued and flushed once the page itself posts `window.__circalReady`, which
it does the instant the effect registering the import runs — not assumed from navigation finishing,
which is earlier than the island mounting, its effects running and, now that `Settings` and
`EventEditor` are their own lazy chunks, its imports landing. Closed entirely in menu-bar-only mode —
see below — since without a Dock tile there is nothing to drop it on.

**A menu bar item that carries the countdown.** `useTitleCountdown` already writes `· 14m · Standup`
into `document.title` while the tab is hidden, and a window ordered out **is** hidden (measured). So
the shell observes the webview's title and prints the suffix beside the ring: the reminder that
survives a put-away window, with no new state, no second clock and nothing asked of the page.

**Open at Login and Show in Dock, from the status item's own menu.** `SMAppService.mainApp` registers
or unregisters a login item, off until asked — a calendar adding itself to login items unbidden is
hostile, not helpful — and `NSApp.setActivationPolicy` swaps the Dock tile for menu-bar-only, off by
default too, applied at launch before the window exists. Both live in the status item's own menu
rather than behind ⌘, — that key already belongs to the page's settings — and `menuNeedsUpdate` reads
each live rather than caching it: a login item removed from System Settings, or a Dock policy changed
some other way, must not leave the menu asserting something no longer true. Accessory mode has a real
cost, stated where it is paid: no Dock tile means `applicationShouldHandleReopen` never fires, so the
`.ics` drop above cannot land — ⌥⌘C and the status item become the only ways in.

**⌥⌘C, from anywhere, into the palette.** Carbon's `RegisterEventHotKey`, not
`NSEvent.addGlobalMonitorForEvents`, because the latter wants Accessibility permission — a system
prompt and a privacy-pane entry that a calendar does not deserve for one chord. The chord shows the
window and dispatches ⌘P at it, so the palette opens through the app's own binding rather than a
second entry point that could drift from it; pressing it again while circal is frontmost puts the
window away. That is quick-add from anywhere, using the parser `quickadd.ts` already has — and, in
menu-bar-only mode, one of only two ways back into a window with no Dock tile to click.

**`/api/feed` stops being a Worker.** The route only ever existed because no calendar host sends CORS
headers, and native HTTP has no CORS. `main.swift` answers the same path with `URLSession`, carrying
the parts that are not incidental: the SSRF hostname guard, re-run on every redirect hop exactly as
`followChecked` does it, the 5 MB cap, and `looksLikeCalendar`'s `BEGIN:VCALENDAR` sniff. The guard
matters **more** here than on the Worker: a pasted feed URL naming `127.0.0.1` would otherwise reach
this app's own server, and everything else listening on the user's machine.

**The window is put away, not closed.** `applicationShouldTerminateAfterLastWindowClosed` is false,
the red button hides, and the status item, the dock icon and ⌥⌘C all bring it back. A calendar that
quits when you put it away cannot answer a reminder or hold a mirror file in step, which are the two
things it is most useful for while out of sight. `show()` calls `NSApp.unhide` first, and that is not
optional: an application hidden with `NSApp.hide` stays hidden through
`activate(ignoringOtherApps:)`, so ⌥⌘C did nothing at all until it was added.

## three bugs the shell found in the app

All three were app bugs the web build had all along; the shell is just where they became obvious.

**Dragging the dial selected the face.** A press that crosses an hour numeral starts a selection, so
one drag round the dial left half the numerals highlighted in accent blue and the next drag began by
clearing it. The fix is `useNoDragSelection` in `hooks.ts` — one `selectstart` listener, fields
exempt — and it is a listener rather than `user-select: none` because that provably does not work
here: `CSS.supports("user-select", "none")` is **false** in WKWebView, which still ships the property
only under `-webkit-`, and the prefixed declaration does not survive the CSS pipeline either, since
Lightning CSS folds it back into the unprefixed form for its own baseline. Verified through the app's
own page: `selectstart` is prevented on an SVG numeral and on chrome, and **not** prevented in the
palette's input.

**Export did nothing.** `backup.ts`'s `download()` builds a Blob URL and clicks a synthetic
`<a download>` — the web's whole mechanism for saving a file with no server — and a `WKWebView`
silently drops it: the click resolves and nothing lands on disk, no error, no event, so both the
`.json` backup and the `.ics` export shipped dead in the app while the identical code correctly
downloaded on the web. Fixed the same way as the mirror's own picker: `window.__circalSave` bridges
to an `NSSavePanel`, `download()` — now async — prefers it when the shell provides it and falls back
to the anchor otherwise, and reports back whether a file was actually written, so a dismissed panel
skips the toast rather than announcing an export nobody asked to keep.

**A white flash on a cold start.** Three separate whites, and it took all three:
`underPageBackgroundColor` for the over-scroll and the pre-paint colour, `drawsBackground = false`
(KVC — the property is not in the public header) so the webview never paints an opaque sheet over the
window's black, and `suppressesIncrementalRendering = true` so the first paint waits for content.
The first attempt was to hide the view and reveal it on a message from the page once it had painted;
it deadlocks, and the log says why — WebKit takes a hidden view as a background one and suspends the
web process (`WebProcessProxy::didChangeThrottleState(Suspended)`), so the frame being waited for is
a frame that will never be drawn. Gating rendering on rendering does not work however it is spelled.

## how the shell works, and the one number that matters

**The port is fixed at 47531, and it has to be.** `localStorage` is keyed by origin and an origin
includes its port, so an ephemeral port hands the app a brand-new empty store on every launch — every
event still on disk, under a number nothing will ever ask for again. Below 49152 so the kernel cannot
hand it to somebody's outbound connection, and `LSMultipleInstancesProhibited` is the other half:
two copies would race for that socket and the loser has no calendar.

Everything else follows from serving over loopback rather than `file:`. A `file:` origin has no usable
`localStorage` and no service worker, which for a local-first calendar is not a trade, it is the
product. `http://127.0.0.1` is a potentially-trustworthy origin, so **both work, verified**: the
webview's own registration table holds `http://127.0.0.1:47531/sw.js`, and `isSecureContext` is true.

The server is blocking, thread-per-connection BSD sockets on purpose. It serves about twenty files
once per launch — the service worker takes over after that — and it has no asynchrony for a bug to
hide in. `trailingSlash: "always"` is the one subtlety: every link the site writes ends in `/`, so a
path is a directory and the file under it is `index.html`.

Two window decisions worth keeping. The titlebar is transparent over a black window, which is a black
strip with the traffic lights in it — deliberately **not** `fullSizeContentView`, because the lights
would then land on `TopBar`'s left button group and three buttons under three buttons is a bar nobody
can aim at. And `allowsBackForwardNavigationGestures` is off: the app steps days through
`history.pushState`, so a two-finger swipe would be "yesterday", mid-drag on the dial.

## unsigned, by decision

`build.sh` ad-hoc signs, which is enough to launch a locally built app and nothing more: handed to
another Mac, the bundle is refused outright, and macOS 15 removed the right-click-Open escape hatch
that used to survive it, so whoever received it would see "circal is damaged" — indistinguishable
from malware. The fix is an Apple Developer account and a `Developer ID Application` certificate, and
the owner has refused to buy one; the subject does not get raised again. `clone && pnpm mac` is the
distribution, permanently, not a step toward a wider one.

`--universal` (`bash mac/build.sh --universal`, two `swiftc` passes and a `lipo`, 2.0 MB) and
`CIRCAL_SIGN_ID` (switches `codesign` to hardened runtime with `--timestamp --options runtime`, which
notarisation would need) stay wired anyway — not because signing is coming, but so the choice stays
somebody else's to make later without re-deriving the build script first. What the shell earns does
not need an audience beyond the one it already has: six shortcuts a browser cannot give back,
reminders that survive the window being put away, trackpad haptics no desktop browser has ever
exposed, a mirror file an assistant can read before Settings has even been opened, and the three bugs
above that only running the thing as an app ever surfaced.

## why swift and not tauri

Tauri's macOS target **is** `WKWebView`. So on this platform Rust owns the window and the menus and
nothing on the render path — same engine, same frame time, same SVG and canvas — and the entire delta
is what the shell weighs and what it costs to build. Swift wins both here: the toolchain ships with
the Command Line Tools, where Tauri wants a ~1.5 GB Rust install before it can print a window, and
the result is 1.7 MB with nothing bundled.

That is not an argument against Tauri, it is an argument about which platform is asking. **Windows
still wants it**: WebView2 is Chromium, the engine Chrome visitors already run, and nobody is writing
a Win32 shell by hand. Electron remains the wrong trade in both directions — 90–150 MB on every
platform to defend against an engine problem that exists on one:

| platform | engine    | new risk                                                            |
| -------- | --------- | ------------------------------------------------------------------- |
| macOS    | WKWebView | none — the engine Safari visitors already run against the live site |
| Windows  | WebView2  | none — Chromium, the engine Chrome visitors already run             |
| Linux    | WebKitGTK | real, and circal is unusually exposed                               |

## what the shell still does not have

- **A settable hot key.** ⌥⌘C is compiled in. If something else has it, `RegisterEventHotKey` fails
  and the shell says so on stderr rather than fighting for it.
- **A quick-add panel of its own.** ⌥⌘C summons the window and opens the palette; a borderless
  `NSPanel` with its own webview would be the Spotlight-shaped version, and it needs a route in the
  app that renders the palette alone. Worth doing only if the window turns out to be in the way.
- **A Windows build.** Still unwritten and still wants Tauri, per "what ships" above.
- **Tests, and by design.** `AGENTS.md`'s rule is a test file per `src/lib/` module; the suite is
  vitest with no DOM and cannot reach AppKit, and the shell holds no domain logic to pin. The one
  place it repeats the app rather than hosting it is the feed proxy's SSRF table, which is the
  Worker's `ssrfBlockReason` re-spelt in Swift — worth knowing if that table ever moves. Anything in
  `mac/` that starts wanting to know what an event is belongs in `src/lib/` instead.

## why linux specifically

[Tauri's own Linux graphics page](https://v2.tauri.app/develop/debug/linux-graphics/) has two lines
that land directly on this app.

> canvas content can silently land on a slow path while the rest of the app looks fine… There is no
> error to catch.

`LifeView.tsx` blits an offscreen field canvas and masks it with a radial gradient in
`destination-in`, **once per frame** of the zoom wave, at a budget of about 4 ms. The whole reason the
field lives in its own canvas is that thirty thousand arcs per frame is not affordable. Land that on
a software rasterizer and the wave stutters, with nothing thrown and nothing to log.

And [discussion #9088](https://github.com/tauri-apps/tauri/discussions/9088): _"when a CSS animation
is playing, the rest of the app gets blurry."_ Per `astro.config.mjs`, _"the whole product is one
continuously-animating clock."_

The workaround ladder ends at `WEBKIT_DISABLE_COMPOSITING_MODE=1`, which for a 288-segment gradient
rim and a 30k-dot canvas is not a workaround. Upstream: [tauri#9394](https://github.com/tauri-apps/tauri/issues/9394),
[webkit#261874](https://bugs.webkit.org/show_bug.cgi?id=261874).

Revisit if anyone asks for a Linux build; ship it with the env-var caveat documented rather than
pretending it is equivalent.

## risk surface, audited

Two of the original scares were wrong, and three absences turned out to be the interesting part:

| feature                  | where              | verdict                                                                                                                                                               |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backdrop-filter`        | —                  | **not used.** `CenterPanel.tsx` documents deliberately _not_ using it                                                                                                 |
| `destination-in`         | `LifeView.tsx`     | ancient, universally supported. The risk is the _slow path_, not support                                                                                              |
| `mask-image`, unprefixed | `global.css`       | needs `-webkit-` on older WebKit; lightningcss prefixes from targets                                                                                                  |
| `user-select`            | `hooks.ts`         | **unsupported unprefixed in WKWebView**, and the prefix does not survive the CSS pipeline. Hence `useNoDragSelection`                                                 |
| Tailwind v4 output       | `astro.config.mjs` | no explicit targets, so Tailwind's own baseline applies — Safari 16.4 / Chrome 111. Fine on WKWebView and WebView2; a WebKitGTK version floor on Linux                |
| `showPicker()`           | `primitives.tsx`   | already guarded and already documented as absent in some engines. Degrades to a typeable field                                                                        |
| File System Access       | `mirrorLink.ts`    | **absent in WKWebView.** Replaced by the shell's own bridge                                                                                                           |
| `Notification`           | `remind.ts`        | **`denied` in WKWebView.** Bridged onto `UNUserNotificationCenter`, granted and delivering on this ad-hoc build; `osascript` fallback for a bundle the system refuses |
| `navigator.vibrate`      | `feedback.ts`      | absent on every desktop browser; the shell is the first place the haptic channel exists                                                                               |
| `createBiquadFilter`     | `feedback.ts`      | universal. The _tuning_ is measured against Chromium and WKWebView only                                                                                               |
| `userSpaceOnUse`         | `Dial.tsx`         | ancient SVG                                                                                                                                                           |
| fonts                    | Fontsource         | self-hosted, no system fallback drift                                                                                                                                 |

## done since this file was first written

**⌘/Ctrl labels.** `MOD` in `ui/primitives.tsx` reads the platform once at module scope and is the
only place a modifier is spelled. `⌘` / `Ctrl` was the answer — the word, not `⌃`, which means nothing
to a Windows user — and `Kbd`'s glyph rule carries `MOD` as its one documented exception. The
consequence is measured in `TopBar`: `Ctrl` is 40px against ⌘'s 18, so its two breakpoints are a pair
and are written as whole class strings.

## the alternative worth naming

A true native rewrite (SwiftUI, CoreGraphics) is weeks, and the dial is not the expensive part.
`src/lib` is pure domain logic that would all have to be re-derived: `recur.ts` (the RFC 5545
expand/limit cascade), `ics.ts` (hand-rolled parser with folding, EXDATE, RECURRENCE-ID), `store.ts`,
`life.ts`, `sun.ts` — plus the suite that pins their correctness. Redrawing the instrument is days;
re-earning that correctness in another language is the cost, and it buys nothing a webview does not
already deliver. The Swift in `mac/main.swift` is the whole of what native was actually good for
here: a window, a menu, six keys, and the four capabilities WebKit withholds from a page.
