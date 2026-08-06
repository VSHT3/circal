# todo

Fixed dial hover animations

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

**7. test import**

Yes — and the honest version is bigger than import. There is no test runner at all, and the modules
that most need one are exactly the ones that lose data silently when they are wrong: `ics.ts`
(round-trip), `backup.ts` (`readEvent`/`readSettings`/`importBackup`'s orphan reparenting),
`store.ts` (`sane()`, `migrateSettings`, the `fresh()` cross-tab path), `events.ts`
(`occurrenceStartingOn` on month ends and DST). Thirty tests over pure functions, no DOM, vitest,
wired into `verify` so the gate stays single. This is the cheapest confidence available in the repo
and it is currently zero.

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

### ~~Recurrence and ICS are where the product actually breaks~~ — done

`Repeat` is now a `Recurrence`: `repeat` plus `interval`, `until`, `byDay`, `nth`, `exdates`, flat
on `CalEvent`. `fires()` in `events.ts` is an O(1) predicate per frequency, so `occurrencesOn` is
still a filter over the event list rather than an expansion of every series.

- `FREQ=WEEKLY;BYDAY=TU,TH` renders two meetings a week. `INTERVAL=2` is fortnightly.
- `UNTIL` and `COUNT` both bound the series — `COUNT` is walked into an `until` on the way in
  (`countedUntil`), so the model carries one bound rather than two.
- `EXDATE` is parsed (across several lines), stored as local day keys, expanded and emitted.
- Monthly nth-weekday, forwards and backwards: `BYDAY=3TH`, `BYDAY=-1FR`, and `BYSETPOS`.
- Monthly-on-the-31st and yearly-on-29-Feb skip the months with no such date — RFC 5545 §3.3.10's
  invalid-instance rule, deliberate now rather than accidental. `lifeDensity` had the
  `new Date(y, 1, 29)` rollover bug and no longer paints 1 March.
- `toIcs` emits all of it; round-trip verified through the live modules.
- The editor grew the rule: frequency, interval, weekday chips, monthly position, and an end date.

Still not modelled, and dropped to "happens once" rather than approximated: BYMONTH, BYWEEKNO,
BYYEARDAY, RDATE, sub-daily FREQ, and **RECURRENCE-ID** — a per-occurrence _override_. EXDATE can
remove a day; nothing can yet replace one, and no surface offers "skip / edit just this
occurrence". That is the next honest step here, and it wants the editor to know which occurrence
it was opened from.

### The year view is the weak sibling, and the biggest opportunity

It is a conventional twelve-month grid that shares no code and no metaphor with the other two — it
even reimplements Monday-offset and density separately from `life.ts` (`YearView.tsx:20,47`). It is
the one screen that contradicts "one idea at three scales", and it is what blocks (2). Two honest
paths:

- **On-thesis: the year is a revolution too.** 365 spokes on one ring — and the thing only this app
  can draw, **the day-length curve across a year**, from `sunTimes` sampled 365 times (`sun.ts:72`).
  A solstice-to-solstice figure no grid can show, for the price of a loop. **[high / medium]**
- **Or accept it as an index** and give it what an index needs: hover detail, its own year stepper
  (`year` is a fixed prop), and weight by count rather than "up to three dots".

### Life view

The strongest concept in the app, and the render is fighting it.

- **Invert the tone.** Lived days are currently the dim ones, and the first eighteen years of the
  screenshot are near-black. That is backwards emotionally _and_ informationally: the past is the
  part you own and the part that carries events. Solid past, faint future is also the convention
  every reader arrives with. **[high / trivial]**
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

### Correctness, regardless of direction

| what                             | where and why                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF via redirect**            | `worker/index.ts` validates the URL, then `fetch`es with default redirect-following — an allowlisted host can `302` to `http://127.0.0.1/`. Decimal, octal and hex IPv4 (`http://2130706433/`) and `[::ffff:127.0.0.1]` also bypass the guards. `redirect: "manual"` and re-validate every hop. |
| **Feed payloads share the blob** | Everything is one `circal.v1` key, so a fat subscription competes with your own events for one ~5MB quota; `write()` toasts once and then loses the write silently on reload. Feeds want their own key, and a cap.                                                                              |
| **Feeds without UID churn ids**  | `feeds.ts:58` falls back to `newId()`, so React keys, hover and selection reset on every pull — contradicting the comment directly above it.                                                                                                                                                    |
| **Cross-tab writes wipe undo**   | Deliberate, but a _background_ tab's feed pull destroys the foreground tab's 60-step history. Scope the wipe to writes that actually move the base.                                                                                                                                             |
| **No focus trap in any modal**   | Three hand-rolled dialogs, no shared primitive: Tab escapes to the page behind, and the global hotkeys (←/→/`t`) still fire under an open editor.                                                                                                                                               |
| **`text-ink-3` for prose**       | ~3.1:1 on black, and `ink-4` is ~1.5:1 — decorative only, never text. See (4).                                                                                                                                                                                                                  |
| **1 Hz whole-tree re-render**    | `useNow` ticks every second and `App` hands `now` to Dial, Sidebar, CenterPanel and LifeView, but only the readout and the hand move. Push second-resolution into a leaf and keep the rest on minutes.                                                                                          |
| **Life grid is invisible to AT** | `role="img"`, one label, 30,000 dots, no focus path. The year grid does it right with real buttons — but its `aria-label` omits whether the day carries anything.                                                                                                                               |
| **All-day toggle loses times**   | Off → on → off resets to 9–10am (`EventEditor.tsx:275`); the draft keeps no memory of what it had.                                                                                                                                                                                              |

### What not to do

- **No week view.** The circle is the argument; a seven-column grid concedes it.
- **No sync, no accounts.** "Nothing leaves this browser" is a feature, and a second API route is a
  different product.
- **Do not add a ring.** Every radius costs `PAD` and legibility, and the face already carries four
  plus two bands. The room is in the interior.

### If it were five things

Invert the life grid's tone → next event and countdown in the interior → labels on arcs →
~~real RRULE in and out~~ (done) → quick-add in ⌘P. The first two change how the app feels daily;
the remaining one and the shipped RRULE decide whether it can be somebody's actual calendar.
