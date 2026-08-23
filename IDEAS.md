# Ideas: beyond TASKS.md

**Status:** brainstorm, not approved. Written 2026-08-23, after the cloud-sync audit.

Every idea here is filtered through the rules the repo already holds: chrome stays
greyscale and colour belongs to events, the Worker keeps exactly one route,
local-first with no readable server-side state, and everything findable by walking
the days. Each entry notes what it would cost and what it must reuse. Two ideas at
the end are recorded as refusals, so they are argued once instead of re-litigated.

---

## More calendary — missing calendar table-stakes

1. **Multi-day drag on the dial.** Dragging an arc past midnight currently wraps
   within the day. Let a drag that crosses midnight step the day underneath — the
   face rotating a day forward mid-gesture is navigation as geometry, the app's own
   thesis. Cost: `Dial.tsx` gesture state plus the shell's `go(replace)`; the
   accumulate-sweep rule (`wrapDelta`) already prevents the sign-flip class of bug.

2. **Travel time on events.** `Where` exists; a "leave by" pip ahead of an arc —
   walking/driving estimate typed by hand, deliberately no geo API, so the
   no-runtime-external-requests rule holds — answers the one question a clock face
   is best at. Cost: one `CalEvent` field through the `readEvent` checklist
   (hydrate fast path, backup, duplicate, ics as an `X-` line, feeds, MCP patch).

3. **Day-shape templates.** "Tuesday is a deep-work day": a named waking window and
   default calendar per weekday. Cheap — it is settings — and it feeds `freeGaps`,
   the palette's slot search, and TASKS.md's auto-schedule when that lands. One
   idea of the working day stays one idea; the template merely varies it by day.

4. **A `Join` verb on conferencing links.** Detect Meet/Zoom/Jitsi in `url` /
   `location` and give the headline row a `Join` verb that appears only inside the
   event's reminder lead. High utility, one regex in `events.ts`, zero new chrome
   at rest — the verb exists exactly while it is the next thing you need.

5. **Duplicate day.** Palette verb: copy a day's user-written events onto the
   selected day ("same as last Tuesday"). Falls out of `duplicateOf` + `dayAgenda`;
   one commit, one ⌘Z, toast counts what landed.

6. **Jog-wheel day scrubbing.** Hold a modifier and drag on empty face = rotate the
   day like a jog wheel, one revolution = one day. Same family as the zoom/unroll
   transitions: moving between days is geometry, not a button.

## Productive

7. **Weekly totals band.** ⌘E is read-only about events; give each strip face a
   booked/free line from `dayLoad`, `.caption` voice, no bars. The week becomes an
   instrument for balancing a week, not only looking at one. Reuses the totals
   line's exact vocabulary so "free" keeps one meaning.

8. **Free-slot sharing.** `freeGaps` + the share-token machinery already exist:
   "share my free time this week" mints a link that opens circal with ghost arcs of
   the gaps — not the events, so privacy falls out of the construction rather than
   a filter. Booking stays out (needs a channel this product refuses); _showing_
   does not. The sleeper: the only idea here useful to people who don't use circal.

9. **Natural-language edits in the palette.** `move standup to 10`, `push lunch
30m` — `parseQuickAdd` already owns the grammar's right-to-left scanner; this
   adds verb heads and resolves the target through `fuzzyScore`. The palette
   becomes an editor, not only a creator. Scope question (one/future/all) reuses
   `ScopeChoices`.

10. **Day notes.** One plain-text note per day key, stored in the blob, drawn as a
    dot on the mini-month and a paragraph in the interior at rest. Journaling
    without becoming a journal app: still keyed by day, still found by walking
    days. Must not grow markdown, titles, or a list of notes — one day, one note.

## Eye-catching — each must earn its ink

11. **Ambient mode as a real clock face.** `ambientAfter` exists; lean in — a
    screensaver-grade mode: dial centred, chrome gone, next-event headline only,
    wake-lock optional. People would leave it on a spare monitor or an iPad; it is
    marketing that is also a feature. Mostly composition of switches that exist.

12. **Daylight across the year, on the year ring.** Day length over a year is one
    picture only a circular year can draw, and `sun.ts` ships already. As the
    ring's own background tint (the lightcycle band's palette, heavily dimmed),
    not a new ring — the interior figure was already tried and refused; the rim's
    background is the one place this reads as data about the days it sits behind.

13. **Rings closed.** When the last task pip of a day is ticked, one subtle
    full-revolution shimmer of the elapsed ring. Fired at most once a day, gated on
    `useReducedMotion`, silent otherwise. One animation; delight budget of one.

14. **Save this face.** Print/export a day or year as SVG/PNG — the faces are
    resolution-independent drawings already. Screenshots of dials are how this app
    spreads; give them a verb. Shell save-panel bridge (`window.__circalSave`)
    already answers the WKWebView half.

## Customizable

15. **Theme presets.** Chrome is greyscale by rule — but _which_ greyscale (current
    black, warm dark, paper light) and the accent could be a small preset list, the
    `PALETTE` shape: enumerated, `sane()`-pinned, never a free-form theme editor. A
    light theme is the most-requested thing this class of app gets. Cost is real:
    every token in `global.css` moves to the preset, and `inkOn` contrast must be
    re-verified per preset.

16. **Editable event palette.** `ColorPicker` has an any-colour cell; let the ten
    `PALETTE` slots themselves be edited (settings, synced), with `inkOn` checks so
    a user cannot pick a colour the arc label cannot sit on.

17. **Dial density presets.** Numerals every hour vs. every three, tick weight —
    `DIAL` is already a table; expose two or three named presets ("minimal",
    "instrument", "dense"), never sliders. A slider is a thousand faces nobody
    tested; three presets are three faces somebody did.

18. **Per-calendar reminder lead.** The inherit chain gains one level — event →
    calendar → setting — exactly `colorOf`'s shape, closing an asymmetry that
    already half-exists. `leadOf` stays the sole reader of the precedence.

## Refusals, argued once

- **Month grid view.** The obvious ask and the wrong one: a grid is the thing every
  other calendar is. Circal's answer to "month" is the year ring plus the drawer's
  mini-month; a grid view would be a second product's home screen inside this one.

- **Accounts, collaboration, shared calendars.** The invitation-reading section
  already draws this line: answering is a message, and circal has no channel to
  post one. Crossing it makes circal a sync product — the cloud copy stays a
  sealed box, never a relay.

## Shortlist by value per effort

**#4 (Join verb), #11 (ambient clock), #15 (theme presets)** — roughly an afternoon
each, and each hits a different axis: productive, eye-catching, customizable.
**#8 (free-slot sharing)** is the strategic one: the only idea that makes circal
useful to somebody who doesn't use circal.
