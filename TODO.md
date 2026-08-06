# todo

Recurrence is real, the interior answers the day, and there is now a test suite —
571 cases over the domain layer, `pnpm test`, in the gate.

## the list, and what I think of it

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

Vitest, `tests/`, wired into `verify`. **571 cases, 14 files, 447 ms.** Two projects: `local` under
`TZ=Europe/Berlin` and `west` under `TZ=America/Los_Angeles` in its own process, because nearly
every date function here is deliberately local-time and an unpinned suite passes in one zone and
fails in the other.

| module               | cases   | what it defends                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recur.ts`           | 67      | every RFC 5545 §3.8.5.3 worked example, transcribed and cross-checked against independent date arithmetic rather than against the engine. WKST sensitivity, BYSETPOS, BYWEEKNO, BYYEARDAY across a leap year, Friday-the-13th, the `MAX_INSTANTS` cap, COUNT counting before EXDATE, DST on both Berlin transitions |
| `backup.ts`          | 86      | hostile input, one row per thing a hand-edited backup can contain, plus `importBackup`'s orphan reparenting in both directions                                                                                                                                                                                      |
| `store.ts`           | 63      | write / delete / **move** (day boundary, DST, a recurring series), undo depth and rebasing, the `fresh()` cross-tab path, `sane()`, `migrateSettings`, the quota notify, seeding through `subscribe`                                                                                                                |
| `time.ts`            | 88      | `dayKey` local-time, `parseClock`'s five forms, both faces, DST arithmetic, `zonedToUtc` in and out of a gap                                                                                                                                                                                                        |
| `life.ts` + `sun.ts` | 61      | `lifeCellAt` as the exact inverse of `lifeDotX/Y` swept across five years, the density policy, NOAA reference sunrises, polar day and night                                                                                                                                                                         |
| `ics.ts`             | 50      | round-trip for every value type, octet-counted folding around a 4-byte emoji, escaping, and a table of malformed feeds that must not throw                                                                                                                                                                          |
| `events.ts`          | 45      | day-clipping, the exclusive end, override suppression, lane packing, `freeGaps`, `colorOf` precedence                                                                                                                                                                                                               |
| `worker`             | 35 + 35 | the SSRF table in every IPv4 spelling, and the proxy's redirect chain hop by hop                                                                                                                                                                                                                                    |
| `feeds.ts`           | 11      | id stability across pulls, error recording, and the cross-tab undo interaction                                                                                                                                                                                                                                      |
| `dial.ts`            | 16      | `angleAt` ↔ `minutesAtPoint` swept over all 1440 minutes on both faces                                                                                                                                                                                                                                              |

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

### Give arcs identity

A 30-minute event is 7.5° — in the day screenshot the whole afternoon is four coloured ticks and you
cannot tell which is which. `<textPath>` along the arc's own path, mono ~11px, only above about a
45-minute sweep; below that the dot-collapse at `Dial.tsx:817` is honest and should stay. This is
the single change that moves the dial from beautiful to readable without hovering.
**[high / medium]**

### Stop making light and progress mutually exclusive

`elapsedSegments` returns `[]` whenever a band is drawn (`Dial.tsx:222`), so switching on Lightcycle
**costs you the elapsed day** — on any day that is not today the face then says nothing at all about
where the day is. Fix it without adding a radius: **draw the band at full chroma behind `now` and
materially dimmed ahead of it.** One ring, one mechanism, both facts, and "the light you have
already spent" is a better idea than either half alone. **[high / small]**

### All-day events are invisible

`EventArc` returns `null` for `allDay` (`Dial.tsx:808`), `packLanes` skips them (`events.ts:167`),
`freeGaps` ignores them (deliberate and correct). So "Berlin", or a birthday, exists in the agenda
list and nowhere on the face. Either a hairline full-circumference ring in the event's colour just
inside `TRACK`, or a chip in the interior — but not silence. **[high / small]**

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
  runs solid past (0.58 / 0.45, about `ink-2`) against a faint future (0.23 / 0.17, about `ink-4`),
  and an event's colour is dimmed while its day is still _ahead_ of you rather than behind. The
  ratio between the two states is the one it always had; the whole figure moved up, because neither
  half may go to near-black — the argument of the view is the entire span in one viewport.
- **The month banding reads as vertical striping**, not as months (`TONE`, `LifeView.tsx:100`). At
  this density, alternating tone per month across eighty rows is near-moiré. Tone by year-half, or
  drop it and keep the decade rules.
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

### Two things that cost nothing and change how it feels

- **Ambient mode** (`F`, or ⌘.): chrome away, dial to the viewport, hand and lightcycle only, wake
  on pointer. This is already the best-looking desk clock on the web and it is one boolean from
  shipping as one. **[high / trivial]**
- **Hear the hour.** Every 15-minute detent in a drag clicks identically; give every fourth one a
  different resonance and you can count hours by ear without looking, which is exactly the
  affordance a physical dial has. `SOUNDS` is already parameterised for it. **[medium / small]**

And the honest omission: **there are no reminders.** A calendar that never tells you anything is a
viewer. While the tab is open, `Notification` is enough; closed, it needs a server, and a server is
off-thesis. Say so in the UI rather than leaving the absence unexplained.

### Correctness — seven fixed, four open

Fixed while writing the suite, each with the tests that pin it:

| what                                   | the fix                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~**SSRF via redirect**~~              | `followChecked` in `worker/index.ts` walks the chain itself with `redirect: "manual"`, re-running the guard on every hop and capping at 5. A `302` into `169.254.169.254` is a 400, not a proxied body.                                                                                       |
| ~~**IP literals bypass the guard**~~   | `ipv4Number` normalises decimal (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f000001`), short forms (`127.1`) and v4-mapped v6 (`::ffff:127.0.0.1`) before anything is compared. The guard blocked the spelling, not the address. Carrier NAT, multicast and `0.0.0.0/8` added while there. |
| ~~**Feeds without UID churn ids**~~    | The random id was in `ics.ts`, not `feeds.ts` — `crypto.randomUUID()` on every parse. Now `derivedUid()`, FNV-1a over DTSTART/DTEND/SUMMARY/LOCATION/RECURRENCE-ID. Fixes `.ics` import too, which had the same churn.                                                                        |
| ~~**Cross-tab writes wipe undo**~~     | The wipe is scoped by `baseSignature()` — events, calendars minus their `feed`, settings. A background tab's feed pull no longer costs the foreground tab sixty steps.                                                                                                                        |
| ~~**Undo reverted settings**~~         | Found by the suite. Settings commit with `record: false`, but undo restored a whole recorded snapshot, so undoing an event silently rolled back a switch flipped after it. Steps now carry `ownsSettings`, and only `restore` sets it.                                                        |
| ~~**`zonedToUtc` wrong west of UTC**~~ | Found by the suite. The two-pass estimate converged from the naive UTC reading, so a spring-forward gap resolved _after_ the gap in Berlin and an hour _before_ it in Los Angeles. Now brackets the wall time with the offsets a day either side.                                             |
| ~~**All-day toggle loses times**~~     | `timedSpan` ref in `EventEditor.tsx` remembers `{ startMin, durationMs }` across the toggle.                                                                                                                                                                                                  |
| ~~**RDATE without RRULE dropped**~~    | Found by the suite. `readRecurrence` returned a bare `NEVER` when RRULE was absent, discarding EXDATE/RDATE with it — though `repeats()` and `startsBetween` both support an RDATE-only series. The lists are read independently now.                                                         |

Still open:

| what                             | where and why                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feed payloads share the blob** | Everything is one `circal.v1` key, so a fat subscription competes with your own events for one ~5MB quota; `write()` toasts once and then loses the write silently on reload. Feeds want their own key, and a cap. Needs a schema bump and a migration, so it is its own commit. |
| **No focus trap in any modal**   | Three hand-rolled dialogs, no shared primitive: Tab escapes to the page behind, and the global hotkeys (←/→/`t`) still fire under an open editor.                                                                                                                                |
| **`text-ink-3` for prose**       | ~3.1:1 on black, and `ink-4` is ~1.5:1 — decorative only, never text. See (4).                                                                                                                                                                                                   |
| **1 Hz whole-tree re-render**    | `useNow` ticks every second and `App` hands `now` to Dial, Sidebar, CenterPanel and LifeView, but only the readout and the hand move. Push second-resolution into a leaf and keep the rest on minutes.                                                                           |
| **Life grid is invisible to AT** | `role="img"`, one label, 30,000 dots, no focus path. The year grid does it right with real buttons — but its `aria-label` omits whether the day carries anything.                                                                                                                |

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
2. **All-day events on the face**, and **stop making light and progress mutually exclusive.**
   `[high / small]` each, and they are one afternoon together. Both are the dial saying less than it
   knows: `EventArc` returns `null` for an all-day event, and switching on Lightcycle deletes the
   elapsed ring. A setting should not be able to make the instrument silently incomplete.
3. **Labels on arcs.** `[high / medium]` — the single change that moves the dial from beautiful to
   readable without hovering.
4. **Quick-add in ⌘P.** `[high / small]` — every parser exists, the sentence does not. And the
   parsers it composes are now covered, which is what makes it safe to build on them.
5. **Ambient mode.** `[high / trivial]` — one boolean from shipping the best desk clock on the web.

Then the year view, which is the one screen still contradicting "one idea at three scales" and the
thing blocking (2).
