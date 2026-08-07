# todo

Recurrence is real, the interior answers the day, arcs carry their own names, the dial has an
ambient mode, and there is a test suite — 619 cases over the domain layer, `pnpm test`, in the gate.

## the list, and what I think of it

0. Moonpohases somewhere as an optional eyecandy
1. Intro animation like what animejs has
2. icons into dial list based on custom or default to calendar icon (which can be set too)
3. event and stuff search

**1. quotes page** — _you are a worm through time, you have no obligations to your former self, be
the change you wish to see in the world._

Not a page. A page of quotes is a thing an app does when it has run out of ideas, and the first two
lines here are better than that. "A worm through time" _is_ the life view — it is the picture that
grid already draws — so it belongs in the life view's empty state, next to the birth prompt, where
somebody is looking at eighty years of nothing and needs a reason to type a date. Drop "be the
change you wish to see in the world": it is a bumper sticker sitting between two ideas that are not.
Fold the rest into (9) — see there.

**2. year -> life transition**

Yes, and it is arguably more on-thesis than the zoom you already have: a year _is_ one row of the
life grid, which is a stricter identity than "the dial is the dot". The catch is that it is only
true if the year view lays its days out the way the life row does. Today it is twelve month blocks
in a 4×3 grid (`YearView.tsx:133`) and a life row is 52-odd Monday-to-Sunday weeks on one to six
lines (`life.ts:190`) — morph one into the other and you get an expensive crossfade wearing a
zoom's clothes. So this is blocked on deciding what the year view is (see **Year view** below). Do
that first, then `zoomsOut`/`zoomsIn` in `App.tsx:63-69` grow a second pair and `flow` already
carries everything the exit variant needs.

**3. group ui**

Reading this as grouping calendars. Premature: you cannot create, rename, recolour or delete a local
calendar from any surface in the app — `Sidebar.tsx:131-159` only toggles visibility, and
`store.addCalendarWithEvents`/`removeCalendar` are wired to import and feed-removal alone. Colour is
the only category encoding this product has, and the user cannot make one. Ship calendar CRUD;
groups only start paying rent past about eight calendars, and you cannot get to eight.

**4. cleanup settings**

Agreed, and the screenshot says exactly what is wrong. The panel is seven rows of wildly unequal
density in one unbroken scroll, and four of them end in a paragraph set in `.label` — 11px, mono,
uppercase, 0.18em tracking, `text-ink-3` at ~3.1:1 on black (`Settings.tsx:231,267,289,299,379`).
The Feedback one is sixty words of it. `.label` is a _label_ voice; prose wants sentence case,
12–13px, `text-ink-2`. Then: one line of help per row, the rest behind a disclosure, and section
rules between Face / Life / Feedback / Data. It is currently the least readable surface in an app
whose whole argument is legibility.

**5. look at sidebar**

Agreed, but the fix is a decision, not a tidy-up: **the sidebar and the centre panel print the same
agenda twice.** If the interior becomes "now and next" (see below), the sidebar becomes the full
day's log plus calendar management, and that is a coherent split. Also: the mini-month earns less
than it costs — ⌘P jumps to a date better than a 7×6 grid of 20px cells does — and that space is
where calendar CRUD goes. Mechanically it is a 260px column that _pushes_ (`Sidebar.tsx:58`) with no
drawer mode, so on a phone it is unusable, and it sets `aria-hidden` while leaving its children
mounted at `w-0`, so closed-sidebar content is still in the tab order.

**6. tasks?**

The question mark is right. A dated task is a zero-length event and the dial already has an honest
form for one — the dot-collapse at `Dial.tsx:817`, a pip on the rim at the right minute rather than
an arc that lies about duration. That part is nearly free. An _undated_ task is a to-do list, and a
to-do list on a dial is a different product wearing this one as a skin. If you do it: dated only, a
pip, struck through when done, and no inbox. Lower priority than making the calendar you already
have correct — see RRULE below.

**7. ~~test import~~** — done, and bigger than import

Vitest, `tests/`, wired into `verify`. **602 cases, 14 files, ~450 ms.** Two projects: `local` under
`TZ=Europe/Berlin` and `west` under `TZ=America/Los_Angeles` in its own process, because nearly
every date function here is deliberately local-time and an unpinned suite passes in one zone and
fails in the other.

| module               | cases   | what it defends                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recur.ts`           | 67      | every RFC 5545 §3.8.5.3 worked example, transcribed and cross-checked against independent date arithmetic rather than against the engine. WKST sensitivity, BYSETPOS, BYWEEKNO, BYYEARDAY across a leap year, Friday-the-13th, the `MAX_INSTANTS` cap, COUNT counting before EXDATE, DST on both Berlin transitions |
| `backup.ts`          | 90      | hostile input, one row per thing a hand-edited backup can contain, plus `importBackup`'s orphan reparenting in both directions                                                                                                                                                                                      |
| `store.ts`           | 67      | write / delete / **move** (day boundary, DST, a recurring series), undo depth and rebasing, the `fresh()` cross-tab path, `sane()`, `migrateSettings`, the quota notify, seeding through `subscribe`                                                                                                                |
| `time.ts`            | 88      | `dayKey` local-time, `parseClock`'s five forms, both faces, DST arithmetic, `zonedToUtc` in and out of a gap                                                                                                                                                                                                        |
| `life.ts` + `sun.ts` | 61      | `lifeCellAt` as the exact inverse of `lifeDotX/Y` swept across five years, the density policy, NOAA reference sunrises, polar day and night                                                                                                                                                                         |
| `ics.ts`             | 50      | round-trip for every value type, octet-counted folding around a 4-byte emoji, escaping, and a table of malformed feeds that must not throw                                                                                                                                                                          |
| `events.ts`          | 54      | day-clipping, the exclusive end, override suppression, lane packing, `freeGaps`, `colorOf` precedence, `inkOn` against all ten presets                                                                                                                                                                              |
| `worker`             | 35 + 35 | the SSRF table in every IPv4 spelling, and the proxy's redirect chain hop by hop                                                                                                                                                                                                                                    |
| `feeds.ts`           | 11      | id stability across pulls, error recording, and the cross-tab undo interaction                                                                                                                                                                                                                                      |
| `dial.ts`            | 33      | `angleAt` ↔ `minutesAtPoint` swept over all 1440 minutes on both faces, and `arcLabel`'s glyph budget, cut and turn                                                                                                                                                                                                 |

Three custom matchers do the heavy lifting on readability — `toBeInstants`, `toOccurOn`,
`toBeSameInstantAs` print an aligned actual/expected column with `(missing)` / `(unexpected)` /
`(out of order)` markers, because a 40-instance RRULE diff as raw epoch integers is not a diff.

Deliberately out of scope: no DOM, no jsdom, no component tests. A snapshot of an SVG path is a
change-detector that fails on every legitimate geometry tweak; the dial stays eye-verified.
`feedback.ts` and `keys.ts` are tuned by offline measurement, not asserted.

**Seven real bugs fell out of writing it. All seven are fixed** — see the correctness table below.

**8. zoom in life view**

The need is real — 30,000 dots at ~4px is at the edge of legibility and the screenshot proves it —
but "zoom" contradicts the view's one invariant: _the whole life in one viewport_. Pan and zoom
turns it into a map, and a map of your life is a worse idea than a picture of it. What you actually
want is **focus without losing the whole**: the year under the pointer expands into a strip along
the bottom, or a decade fisheyes in place, and the eighty years stay on screen the entire time.
`lifeCellAt` (`life.ts:301`) already tells you which year you are over, and the field is one
`drawImage` per frame (`LifeView.tsx:416`), so a second, larger strip is cheap. If you do add true
zoom, keep the full span as a mini-map or you have lost the argument.

**9. manifest** — _we are used to the linearity of time. However, days are circular. you live your
day just to find yourself at the same time as before._

The best line on the list, and the actual thesis — it is better than the README's opening and it
should probably become it. Tighten the last clause; "you live your day just to find yourself at the
same time as before" wants to land harder than it does. And note that this does **not** break the
one-route rule: that rule is about `/api/*` on the Worker. A static `/manifest/` is another file in
`dist/`, served by the assets binding, costing the product nothing. So: one static page, the
manifest, and the worm-through-time line from (1) lives on it. One page, not two.

---

## review — the code as it stands

Read directly: the dial, the event model, the shell, the geometry. The store/worker, palette/editor,
and life/year internals come from a read-only sweep with line cites.

The thesis is intact and the instrument is finished. What is not finished is **the calendar
underneath it**, and the largest single area on screen — the dial's interior — currently prints
three grey rows.

### The interior — decided

`DRAG_INNER` is 165, so there is a 330-unit-diameter hole in the middle of the face, spending itself
on a date and three 10.5px rows in a 226-unit box (`CenterPanel.tsx:124,135-193`). The rule for
filling it: **the ring says what shape the day is, the middle says the one sentence.** Nothing new
is added to the face — the same two elements already there, the readout and the card, take on more
moods.

**Mood — today, idle: promote the first row.** Not a new block; a hierarchy inside the card that
already exists. The next upcoming row gets its title in `text-ink` at roughly 13 units instead of
10.5, a slightly larger dot, and a live countdown in the right-hand column that is currently empty.
Rows two and three keep exactly today's voice, and that contrast _is_ the feature. The unit sharpens
as it closes — `in 2h 10m`, then `in 42m`, and only inside the last minute `in 45s`; a stopwatch in
the middle of a clock is noise. Under five minutes the dot takes a thin ring — cocked, not pulsing,
because the pulse is already spoken for by an event that is running. On an empty day the card
vanishes as it does today: silence is the right answer and this app is good at it. **[high / small]**

**Mood — hovering an arc, or its agenda row: reuse the drag voice, exactly.** The readout becomes
the event's span in the mood that already exists for drawing one — `13:15 – 14:00` with the duration
as its suffix, at the drag sizes (`CenterPanel.tsx:61-65,95`). Hovering an arc and drawing an arc
ask the same question, so they should look identical. The card must also show the hovered event even
when it is behind the hand, since today's card filters to `occ.end > now` and a span with no name is
half an answer. The turnover crossfades in 140 ms on the same ease as the arc's own stroke-width
transition (`Dial.tsx:884`), so the arc thickens and the middle changes in one beat — that is the
tactile part, and it is the whole reason not to reach for a popup. The life grid's `DayTip` is the
wrong precedent here: nothing precious sits under a card in the life grid, whereas on the dial the
pointer is _on the ring_, and the ring is the one thing that must never be covered. **[high / small]**

**Mood — totals: a setting, default off.** One line under the card in the `.label` voice — uppercase
mono is correct here, this is a label and not prose — reading `4H BOOKED · 6H FREE`, from `freeGaps`
(`events.ts:202`), which today only the palette ever calls. Hidden on an empty day, and while
dragging or hovering. The switch belongs in the existing `DIAL` row of Settings beside 12/24H, as a
`Toggle` named `TOTALS`. Unproven, hence off. **[medium / small]**

The countdown makes the centre a per-second surface. `App` already re-renders everything each second
(see the 1 Hz note below), so this costs nothing today — but when that is fixed, the countdown is
part of whatever leaf keeps second resolution.

### ~~Give arcs identity~~ — done

`arcLabel` in `dial.ts`, set with `<textPath>` **inside** the stroke: 11px mono, `inkOn(color)` — black
on the event's own pastel at about 10:1, which is the strongest pairing this face has. Inside rather
than beside, because beside only ever works on the outermost lane: `LANE_STEP - ARC_WIDTH` leaves 13
units of black between two lanes, and the numerals come down to 333 just outside the first. Inside
costs no radius, so the "do not add a ring" rule survives the change.

Three things fell out of building it that are worth keeping in mind:

- **The budget is glyphs, not minutes**, and it is measured against the _paint_ — the span less any
  seam a neighbour claimed, not the `capInset`-shortened centre line. Handing it the centre line
  forfeits 14 units on every arc, which is every half-hour event on the face going anonymous; that
  was the first cut, and the screenshot of it showed four unlabelled ticks. Where the gate lands in
  minutes is a consequence: a word from about 45 minutes, a stub from about 30 out at the rim,
  nothing on the inner lanes. Mono keeps the width arithmetic — no `getComputedTextLength`, so no
  layout read per arc per frame of a drag.
- **A glyph takes its up-vector from the path's direction**, so `arcPath` grew a `back` flag and
  `arcLabel` reverses through the bottom half of the face. Derived from the drawn angle, so both
  faces get it for nothing.
- **The label keeps full alpha on a dimmed arc.** Ink is the absence of light: dim it with the body
  and the name goes to 1.5:1. Left alone it softens from 10:1 to 4.8:1 as the arc recedes, which is
  what the dimming meant.

The setting is `arcLabels`: `always` (default) / `hover` / `off`, in the `Dial` row. `hover` is the
density escape hatch and the weakest of the three — a hovered arc already thickens and the centre
already prints what it is — and it is `off` by another name on a touch device.

### ~~Recurrence and ICS are where the product actually breaks~~ — done, in full

`src/lib/recur.ts` is RFC 5545 §3.3.10, whole: a period expanded into candidate days by the BY\*
parts, given a clock, narrowed by BYSETPOS, then bounded. Verified against every worked example in
§3.8.5.3 — daily/weekly/monthly/yearly with intervals, `BYDAY=20MO`, `BYWEEKNO=20;BYDAY=MO`,
`BYYEARDAY=1,100,200`, Friday-the-13th, the first Saturday following the first Sunday, the last
workday of the month, the third instance of TU/WE/TH — all matching.

- Every frequency, including the sub-daily three, which arrive only from a feed and are capped
  rather than dropped (`MAX_INSTANTS` 512 a call — a `SECONDLY` rule names 86,400 a day).
- `INTERVAL`, `WKST`, `UNTIL`, `COUNT` (walked into an `until`, so the model carries one bound),
  `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`, `BYMONTHDAY`, `BYDAY` with signed ordinals, `BYHOUR`,
  `BYMINUTE`, `BYSECOND`, `BYSETPOS`.
- `EXDATE` **and** `RDATE`, both across several lines, in both RFC value types, stored as local
  day-or-instant keys, expanded and emitted.
- **`RECURRENCE-ID`**: an override is its own event, linked by `seriesId` + `seriesKey`. The series
  skips the occurrence an override claims, so a moved meeting no longer renders twice. `feeds.ts`
  gives it an id including the recurrence-id, since it shares its parent's UID.
- The editor grew the rule — frequency, interval, weekday chips, monthly position, end date — plus
  **Skip this one** and **Only this one**. A rule it cannot spell is printed as a sentence rather
  than flattened onto the nearest checkbox.
- The seed is an instance only when the rule generates it, so deselecting the weekday an event is
  on actually moves it.
- `lifeDensity` and `YearView` now share one core and one answer; the `new Date(y, 1, 29)` rollover
  that painted 1 March is gone, and a _bounded_ daily rule is drawn on the life grid at last.

Not modelled, deliberately: `RANGE=THISANDFUTURE` (only the single instant is replaced) and
`VALARM`. There are still no reminders — see below.

### The year view is the weak sibling, and the biggest opportunity

It is a conventional twelve-month grid that shares no _metaphor_ with the other two. It does now
share code — `mondayOffset` and `dayColors` both live in `life.ts` and both views call them, so an
event no longer gets two different answers — but it is still the one screen that contradicts "one
idea at three scales", and it is still what blocks (2). Two honest paths:

- **On-thesis: the year is a revolution too.** 365 spokes on one ring — and the thing only this app
  can draw, **the day-length curve across a year**, from `sunTimes` sampled 365 times (`sun.ts:72`).
  A solstice-to-solstice figure no grid can show, for the price of a loop. **[high / medium]**
- **Or accept it as an index** and give it what an index needs: hover detail, its own year stepper
  (`year` is a fixed prop), and weight by count rather than "up to three dots".

### Life view

The strongest concept in the app, and the render is fighting it.

- **~~Invert the tone.~~** — done. Lived days were the dim ones and the first eighteen years were
  near-black, which is backwards emotionally _and_ informationally. `TONE` in `LifeView.tsx` now
  runs solid past (0.58 / 0.45, about `ink-2`) against a faint future (0.23 / 0.17, about `ink-4`).
  The ratio between the two states is the one it always had; the whole figure moved up, because
  neither half may go to near-black — the argument of the view is the entire span in one viewport.
  The tone stops at the field: an event's colour is no longer dimmed by how far off it is (it used
  to be, for the past). Grey carries time, which the row already says, and colour carries the only
  data in the picture — dimming the days ahead that carry something quietened the half you can
  still act on, in a calendar.
- **The month banding reads as vertical striping**, not as months (`TONE`, `LifeView.tsx:99`). At
  this density, alternating tone per month across eighty rows is near-moiré, and the brighter past
  has made it louder than it was. Tone by year-half, or drop it and keep the decade rules. This is
  the next thing in this view.
- **Search the whole life.** Every event is already in hand and there is a per-day lookup: type in
  ⌘P and every matching day lights in the grid. "Every day I ran", as a thread down eighty years.
  Nobody else has this and it is mostly wiring. **[high / medium]**
- **Milestones.** You know the birth date: day 10,000, the halfway dot, each decade. Cheap, on
  thesis, high delight. **[medium / small]**
- **Drag a range** → "4,182 days". The distance maths already exists (`formatDistance`).
- Density excludes daily and weekly repeats by design (`life.ts:~357`) while the year grid includes
  them (`YearView.tsx:20`) — the same event, two answers. Pick one policy, share one core.

### Input: the palette should create, not only navigate

`parseDate` handles a dozen forms, `parseClock` takes `9p` and `1045`, `parseDuration` takes `1h30`
— and nothing composes them into an event. **`lunch tomorrow 1pm 45m` should be one line.** Every
parser exists; the sentence does not. **[high / small]**

Also cheap and missing: fuzzy and recency ranking (plain substring today), **duplicate event** (no
such action anywhere), and calendar CRUD (see (3)).

### ~~Ambient mode~~ — done, and one thing left beside it

`F` withdraws the chrome, `⇧F` takes the screen too, `Esc` leaves. Not a setting: a mode that
survives a reload with nothing on screen to say how to leave it is a trap.

It is the day view with a mood, not a second component — four numerals instead of twelve, no names
on the arcs, the readout and the card at ×1.55 with one row instead of three. `[high / trivial]`
was wrong: chrome-off is a boolean, but the things that make it an object rather than a screenshot
are not.

- **It dims with your own dusk.** `ambientLevel` in `sun.ts` rides the same curve the lightcycle
  band draws — full while the sun is up where you are, down to 0.55 in the middle of the night. One
  opacity on the instrument: over true black, opacity _is_ luminance, and it costs a composite
  rather than a repaint of nine hundred paths. No place picked, no curve, no dimming.
- **Wake lock, cursor, drift.** The screen is held awake and re-held on `visibilitychange` (the
  platform drops it on every hide). The pointer goes after two seconds. The whole face wanders six
  pixels over five minutes, so a static rim never burns in.
- **The hand glides its minute.** `useEasedAngle`, 420 ms, on both faces rather than only in
  ambient — a clock whose hand steps is a clock that redraws, and the mode only makes it obvious.
  `NowHand` is keyed on the clock so the 180° relabel stays a jump. A second hand
  was the obvious idea and it contradicts the product's one sentence.

Two things fell out of it that were bugs of their own: `useNow` takes a period and ambient runs at
one minute, which is the first cut at the 1 Hz whole-tree re-render below; and Escape's meaning was
ordered wrongly — a panel's own Escape re-renders the shell before the shell's `window` listener
sees the same press, so the palette and the editor now `stopPropagation` and one press means one
thing.

It has its own section in Settings, because a display mode's face is its own question:
`ambientDim`, `ambientDaylight`, `ambientMoonlight`, `ambientZoneRing`, `ambientArcLabels` (`off`
by default, where the working face's is `always`) and `ambientAfter`.

The two halves are its own, not a view of the working face's — only the _place_ is shared, because
a person is somewhere and that is not a property of a mode. The halves are: on the working face
the band shares the rim with a day's arcs and dropping one is a legibility trade, and on a face
that is nothing but the rim it is the picture.

`ambientAfter` is the one that acts on its own, so it carries the most rules: armed only on the
dial with nothing open, and `AmbientMode` is `off | manual | auto` because how it arrived decides
how it leaves. Auto is a screensaver and goes at the first input; manual stays, since there the
pointer is how you use the dial. The 500 ms grace on the auto exit is not politeness — withdrawing
the chrome moves the layout under a parked cursor and the browser calls that a `pointermove`, so
without it the mode arrived and left in the same frame.

And the default face is now `24h`. It is the one that matches the instrument: a revolution here is
a whole day, so an hour has exactly one place on it. No schema bump — a default is what a blob says
when it says nothing, and every stored blob says one or the other out loud.

**And nothing about the change is a cut.** That was the second pass and it is most of the work.

**Two beats and two curves, in `lib/motion.ts`.** The whole reason the first attempt read as
"blocky": arriving in ambient ran the centre at 140 ms and the chrome at 240, so what you saw was a
snap followed by a crawl. Now `MOOD_MS` (260) is a pointer being answered — an arc thickening, the
readout shrinking into its span, a lane repacking — and `MODE_MS` (600) is a mode changing, which
is everything ambient touches. One curve, `EASE`, matching `--ease`; six components had their own
copy of it.

The second curve is `--ease-size`. `--ease` spends two thirds of its travel in the first quarter of
its time, which is right for a highlight arriving under a cursor and wrong for type dropping forty
per cent — at any duration the readout banged and then settled. Every size in the centre is on the
gentler one now.

- **The centre's mood is one `scale()`**, not a dozen sizes. It had to be: a mode change and a
  pointer both want the readout's size, and as two font-size transitions on one element they can
  only have one duration. On separate properties they each keep their own, and the mode's rides the
  same 600 ms as the chrome and the stage growing under it — which is what actually removed the
  two-step.
- **The rim crossfades.** `Fade` in `Dial.tsx` is an `AnimatePresence`-mounted `motion.g`, so the
  band and the elapsed trail dissolve into each other rather than swapping, and nothing is kept on
  the canvas for the sake of the transition.
- **The band's two halves each draw themselves**, from that half's own first minute and in the
  direction the day runs, through a mask of their own — a `motion.path` on the mask's arc,
  `pathLength` from 0 to 1, so it is one animated element per half rather than 144. A band is a
  thing that happens _over_ a day, so it should arrive over one; appearing whole was the last piece
  of the rim that just turned up.

  The mask is that half's arc, not the whole revolution. Sweeping from midnight was the first cut
  and it was wrong for exactly one of the two: night runs dusk → midnight → dawn, so a mask that
  started at midnight started in the middle of it and the band grew out of its own centre in two
  pieces. Each half is one contiguous run — `solarLight` is positive from dawn to dusk and negative
  the rest of the way round — so the run's start is the lit slot whose predecessor is dark. Polar
  day and polar night fill every slot and get the whole turn.

  A half that is the same either side of a mode change still does not move at all, and the switch
  no longer recomputes 288 segments.

- The eight minor numerals recede by opacity rather than unmounting, and an arc's name is `off` by
  opacity too — `labels === "off"` used to unmount the `<textPath>`, blinking every name out at
  once.
- The card's rows enter and leave through `AnimatePresence` with their own height, which also fixes
  rows popping as events end. Its width went back to a number, because `max-content` cannot be
  interpolated.
- The sidebar's content is held mounted while it leaves, so the column's 220 ms of width has
  something in it to clip.

Measured, not eyeballed: 60 fps through the whole transition, no frame over 18 ms.

What is left here:

- **Hear the hour.** Every 15-minute detent in a drag clicks identically; give every fourth one a
  different resonance and you can count hours by ear without looking, which is exactly the
  affordance a physical dial has. `SOUNDS` is already parameterised for it. **[medium / small]**

And the honest omission: **there are no reminders.** A calendar that never tells you anything is a
viewer. While the tab is open, `Notification` is enough; closed, it needs a server, and a server is
off-thesis. Say so in the UI rather than leaving the absence unexplained.

### Correctness — eight fixed, four open

Fixed while writing the suite, each with the tests that pin it — plus one the suite could never
have caught, because it is a gesture.

| what                                     | the fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**SSRF via redirect**~~                | `followChecked` in `worker/index.ts` walks the chain itself with `redirect: "manual"`, re-running the guard on every hop and capping at 5. A `302` into `169.254.169.254` is a 400, not a proxied body.                                                                                                                                                                                                                                                                    |
| ~~**IP literals bypass the guard**~~     | `ipv4Number` normalises decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f000001`), short forms (`127.1`) and v4-mapped v6 (`::ffff:127.0.0.1`) before anything is compared. The guard blocked the spelling, not the address. Carrier NAT, multicast and `0.0.0.0/8` added while there.                                                                                                                                                                              |
| ~~**Feeds without UID churn ids**~~      | The random id was in `ics.ts`, not `feeds.ts` — `crypto.randomUUID()` on every parse. Now `derivedUid()`, FNV-1a over DTSTART/DTEND/SUMMARY/LOCATION/RECURRENCE-ID. Fixes `.ics` import too, which had the same churn.                                                                                                                                                                                                                                                     |
| ~~**Cross-tab writes wipe undo**~~       | The wipe is scoped by `baseSignature()` — events, calendars minus their `feed`, settings. A background tab's feed pull no longer costs the foreground tab sixty steps.                                                                                                                                                                                                                                                                                                     |
| ~~**Undo reverted settings**~~           | Found by the suite. Settings commit with `record: false`, but undo restored a whole recorded snapshot, so undoing an event silently rolled back a switch flipped after it. Steps now carry `ownsSettings`, and only `restore` sets it.                                                                                                                                                                                                                                     |
| ~~**`zonedToUtc` wrong west of UTC**~~   | Found by the suite. The two-pass estimate converged from the naive UTC reading, so a spring-forward gap resolved _after_ the gap in Berlin and an hour _before_ it in Los Angeles. Now brackets the wall time with the offsets a day either side.                                                                                                                                                                                                                          |
| ~~**All-day toggle loses times**~~       | `timedSpan` ref in `EventEditor.tsx` remembers `{ startMin, durationMs }` across the toggle.                                                                                                                                                                                                                                                                                                                                                                               |
| ~~**RDATE without RRULE dropped**~~      | Found by the suite. `readRecurrence` returned a bare `NEVER` when RRULE was absent, discarding EXDATE/RDATE with it — though `repeats()` and `startsBetween` both support an RDATE-only series. The lists are read independently now.                                                                                                                                                                                                                                      |
| ~~**A clamped drag opened the editor**~~ | `onArcUp` read "no delta" as "never moved", and a grip held against the minimum duration reports no delta however far the pointer runs (that is what `clampDelta` is for). So dragging the end of a fifteen-minute event — which cannot get shorter — opened it on release. `Adjust` carries `moved` now: crossing a step is the drag, changing the delta is only the arc having room. A press on a read-only arc still opens, which is the whole implementation of those. |

Still open:

| what                             | where and why                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feed payloads share the blob** | Everything is one `circal.v1` key, so a fat subscription competes with your own events for one ~5MB quota; `write()` toasts once and then loses the write silently on reload. Feeds want their own key, and a cap. Needs a schema bump and a migration, so it is its own commit.                                                            |
| **No focus trap in any modal**   | Three hand-rolled dialogs, no shared primitive: Tab escapes to the page behind, and the global hotkeys (←/→/`t`) still fire under an open editor.                                                                                                                                                                                           |
| **`text-ink-3` for prose**       | ~3.1:1 on black, and `ink-4` is ~1.5:1 — decorative only, never text. See (4).                                                                                                                                                                                                                                                              |
| **1 Hz whole-tree re-render**    | `useNow` ticks every second and `App` hands `now` to Dial, Sidebar, CenterPanel and LifeView, but only the readout and the hand move. Ambient takes the period to a minute, which is the right answer for a mode left running and no answer at all for the other 23 hours. Push second-resolution into a leaf and keep the rest on minutes. |
| **Life grid is invisible to AT** | `role="img"`, one label, 30,000 dots, no focus path. The year grid does it right with real buttons — but its `aria-label` omits whether the day carries anything.                                                                                                                                                                           |

The last four are all DOM-shaped, which is exactly the surface this suite does not cover. That is
the honest boundary of what 571 pure-function tests buy you.

### What not to do

- **No week view.** The circle is the argument; a seven-column grid concedes it.
- **No sync, no accounts.** "Nothing leaves this browser" is a feature, and a second API route is a
  different product.
- **Do not add a ring.** Every radius costs `PAD` and legibility, and the face already carries four
  plus two bands. The room is in the interior.

### If it were five things

The old list is spent: ~~real RRULE in and out~~, ~~next event and countdown in the interior~~ and
~~a test suite~~ all shipped. What is left, in order:

1. ~~**Invert the life grid's tone.**~~ Done — see Life view above.
2. ~~**Labels on arcs.**~~ Done — see Give arcs identity above. `always` by default, because the
   glyph budget means a label only lands where the sweep can hold one.
3. **Quick-add in ⌘P.** `[high / small]` — every parser exists, the sentence does not. And the
   parsers it composes are now covered, which is what makes it safe to build on them.
4. ~~**Ambient mode.**~~ Done — see Ambient mode above. `F`, `⇧F` for the screen, and it dims with
   your own dusk, which is the part that makes it an object rather than a hidden toolbar.

Then the year view, which is the one screen still contradicting "one idea at three scales" and the
thing blocking (2).
