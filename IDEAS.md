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

4. **A `Join` verb on conferencing links.** — **Shipped** (`d764774`). `joinLink`
   in `events.ts` (whole-hostname match: Meet/Zoom/Jitsi, `url` then `location`);
   the verb sits on the headline row inside the reminder lead _and while running_
   — you join the meetings you are late to most of all.

5. **Duplicate day.** — **Shipped** (`7ea7107`, plus `4e1f822`/`c019934` date
   grammar). The Jump row's ⌘↵: `Copy N events here`, counted off `dayCopies`
   before Enter. One decision beyond the sketch: copies are _one-offs_ — a day's
   shape once, never a second series — and only occurrences starting on the
   source day travel. `last <weekday>` and nearest-month-day parsing exist
   because the copy source is almost always in the past.

6. **Jog-wheel day scrubbing.** Hold a modifier and drag on empty face = rotate the
   day like a jog wheel, one revolution = one day. Same family as the zoom/unroll
   transitions: moving between days is geometry, not a button.

## Productive

7. **Weekly totals band.** ⌘E is read-only about events; give each strip face a
   booked/free line from `dayLoad`, `.caption` voice, no bars. The week becomes an
   instrument for balancing a week, not only looking at one. Reuses the totals
   line's exact vocabulary so "free" keeps one meaning.

8. **Free-slot sharing.** — **Shipped** (`d54b6dc`). As sketched: `freeGaps` +
   the share-token machinery, gaps never events, booking stays out. Decisions
   beyond the sketch: slots travel as **absolute instants**, the timed event's
   own rule — free time exists to be booked over, so it is a moment two people
   share, and wall minutes would offer hours the sender is asleep in; the
   window is seven days from _now_, not "this week" — Monday-to-Sunday minted
   on a Friday is four dead days; and the receiver lands on the **week strip**,
   the one face that reads the whole payload at a glance, with the gaps drawn
   hollow — the free event's own encoding, since a filled arc at any alpha
   read as the receiver's own events — and one quiet line naming whose the
   overlay is and how to take it down. Nothing is ever
   written: the fragment is consumed on arrival, a reload starts clean.

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

11. **Ambient mode as a real clock face.** — **Already shipped** before this list
    was written: `F`/`⇧F` (fullscreen), auto-arrival after `ambientAfter`, wake
    lock, parked cursor, headline-only card, lightcycle dim. Nothing left to do.

12. **Daylight across the year, on the year ring.** Day length over a year is one
    picture only a circular year can draw, and `sun.ts` ships already. As the
    ring's own background tint (the lightcycle band's palette, heavily dimmed),
    not a new ring — the interior figure was already tried and refused; the rim's
    background is the one place this reads as data about the days it sits behind.

13. **Rings closed.** — **Shipped** (`e2cad30`). One dash of light walked once
    round the track when the day's last open pip is ticked — the intro's own
    dash arithmetic, leaving from the current minute. Decisions beyond the
    sketch: what "the day's work is done" means is a predicate, `dayCleared`
    in `events.ts`, not a check inlined in the shell — an empty checklist is
    not a finished one, and a subscription's task (which cannot be ticked
    here) keeps the day open; the once-a-day guard is a session ref, not
    storage — it exists against tick-untick-tick, not against tomorrow; and
    it never fires on an untick or under `useReducedMotion`, where it would
    be the only thing left moving.

14. **Save this face.** Print/export a day or year as SVG/PNG — the faces are
    resolution-independent drawings already. Screenshots of dials are how this app
    spreads; give them a verb. Shell save-panel bridge (`window.__circalSave`)
    already answers the WKWebView half.

## Customizable

15. **Theme presets.** — **Shipped** (`5eab28b`). Midnight, Ember, Paper —
    enumerated, `sane()`-pinned, never a theme editor, as sketched. Two
    corrections to the sketch's cost line. The tokens moving was the _small_
    half: the real work was every colour a stylesheet cannot reach — the
    elapsed ramp, the life grid's greys, the year ring's canvas — now fed by
    `lib/theme.ts`, whose `wash` is a lerp from the theme's own void; on a
    black void that is byte-identical to the multiply it replaced, so
    midnight repaints nothing (pinned in `tests/theme.test.ts`). And `inkOn`
    needed no re-verification at all — an arc label sits inside its own
    pastel, not on the canvas; the contrast that _did_ need computing was
    the accent as small text, which is why paper's is a darker aqua than
    the calendar default it echoes.

16. **Editable event palette.** `ColorPicker` has an any-colour cell; let the ten
    `PALETTE` slots themselves be edited (settings, synced), with `inkOn` checks so
    a user cannot pick a colour the arc label cannot sit on.

17. **Dial density presets.** Numerals every hour vs. every three, tick weight —
    `DIAL` is already a table; expose two or three named presets ("minimal",
    "instrument", "dense"), never sliders. A slider is a thousand faces nobody
    tested; three presets are three faces somebody did.

18. **Per-calendar reminder lead.** — **Shipped** (`d355909`). The inherit chain
    gained its middle level — event → calendar → setting — exactly `colorOf`'s
    shape; `leadOf(event, calendars, fallback)` stays the sole reader of the
    precedence. Two decisions beyond the sketch: a calendar's _silence_ quiets
    every inheriting event on it (the third state exists at this level too),
    and the event editor's inherit option now names the level that answers —
    `Follow calendar · 1h before` when the calendar has an opinion.

## Outward — other calendars

19. **Google Calendar, both directions.** The read half is already shipped by
    construction: every Google calendar has a "secret address in iCal format",
    and pasting it into subscriptions works today through the one route the
    Worker has. The write half is **not architecturally blocked**, which is
    worth recording because "we can't, no server" is the reflexive answer and
    it is wrong: Google Identity Services' token flow hands the browser an
    access token with no backend at all, and the Calendar API accepts requests
    straight from the browser — so a `googleLink.ts` would sit at exactly
    `cloudLink.ts`'s tier and shape (opt-in, lazily imported, talks directly
    to Google, no new Worker route, no readable server-side state). The hard
    parts already exist in the repo: `ics.ts` speaks full RRULE / EXDATE /
    RECURRENCE-ID, and `merge.ts` / `mutate.ts` define what a conflict means.
    What it is actually blocked on: real engineering (a foreign data model,
    sync tokens, a mapping layer — months, not weeks), Google's OAuth
    verification for the calendar scope, and one honest line to draw out
    loud — events synced there sit **plaintext in the user's own Google**,
    which softens the sealed-box story. That is the user's choice about their
    own account, the travel prompt's shape; the standing refusal below is
    circal becoming a relay _between_ users, which this is not. Decision
    deferred until demand shows up after launch, not refused.

## Refusals, argued once

- **Month grid view.** The obvious ask and the wrong one: a grid is the thing every
  other calendar is. Circal's answer to "month" is the year ring plus the drawer's
  mini-month; a grid view would be a second product's home screen inside this one.

- **Accounts, collaboration, shared calendars.** The invitation-reading section
  already draws this line: answering is a message, and circal has no channel to
  post one. Crossing it makes circal a sync product — the cloud copy stays a
  sealed box, never a relay.

## Shortlist by value per effort

**#4 (Join verb)**, **#8 (free-slot sharing)**, **#11 (ambient clock)**,
**#13 (rings closed)** and **#15 (theme presets)** are done — see their
entries. The shortlist is spent; what remains above is unranked.
