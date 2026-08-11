# todo

Recurrence is real, the interior answers the day, arcs carry their own names, the dial has an
ambient mode, ⌘P writes an event in one line and ranks what it finds, the year is a revolution and
unrolls into the life grid, the life grid names its round days and can be walked with the arrow
keys, an event can run for as many days as it likes, a drag across the year ring makes one, the
dial's fifteen-minute grid clicks under the pointer, editing a repeating event asks which
occurrences it means, ⌘⌫ deletes the arc you are pointing at, a calendar can be made and named and
marked and recoloured and deleted without losing what is in it, an event can wear a mark of its own
along its arc, a dated task is a pip on the rim you can tick off, the app can tell you a thing is
about to start, the sidebar carries the moon, the week is seven of the same face at one rotation, a
year of the life grid comes up under the pointer at a size you can read, the argument has a page of
its own, and there is a test suite — 1,118 cases over the domain layer, `pnpm test`, in the gate.

Done work is not recorded here. The rationale that outlived it lives in `AGENTS.md`, next to the
code it constrains.

## the list, and what I think of it

0. ~~Moonphases somewhere as an optional eyecandy~~ — _done, in the sidebar, in two registers._ It
   is not on the face and it is not going to be: every radius the dial gains costs `PAD` and
   legibility, and unlike the lightcycle band the moon is not a fact about the _day_. It reads the
   **selected** day, which is what earns it — arrowing through a week walks the moon through its
   week. `Minimal` draws the terminator as an ellipse; `Aperture` occults the disc behind a curved
   window with bites of exactly the moon's own radius, which is the mechanism itself rather than a
   picture of one, and it is driven by the lit fraction rather than linearly in phase — a real
   complication's linear disc shows a crescent close to twice as full as the sky's, which is
   forgivable on a wrist and not two centimetres from a caption printing the true figure. Both are
   shipped because the question was which register this app wants, and that is worth being able to
   switch between rather than arguing about.
1. Intro animation like what animejs has
2. ~~icons into dial list based on custom or default to calendar icon (which can be set too)~~ —
   _done, and the "default to" turned out to be a setting rather than a default._ A calendar carries
   a mark (247 searchable Phosphor glyphs or any emoji) and so does an event; `markOf` mirrors
   `colorOf`'s precedence but **does not inherit unless asked**, because a calendar's glyph repeated
   down forty arcs of one day says nothing the colour was not already saying —
   `settings.inheritMarks`, off. On the face the mark rides the arc label in front of the name and
   is priced at two glyphs of its budget, dropped rather than truncating the title. **`CenterPanel`
   deliberately has none**: its dot is about five pixels, and a legible glyph there would widen
   every row inside a panel with 29 units of clearance to `HAND_INNER`. That is the one surface an
   event's mark does not reach, and it should stay that way until the interior is rethought.
3. ~~event and stuff search (idk, cmd f)~~ — _already answered, so struck rather than built._ ⌘P
   ranks with `fuzzyScore` over title, location and notes, and the life grid lights every matching
   day of an eighty-year span with the same `scoreEvent` the palette uses. A second search would be
   a second matcher, and a day could then light for a query the list would not have found.
4. ~~deleting/modifying a repeating event~~ — _done._ Save and Delete both ask, and the answer is
   `EditScope`: only this one (an override, or an EXDATE), this and all future (`splitRule` cuts the
   series in two), or the whole series. **Export is not a defect** — two VEVENTs with distinct UIDs,
   the first bounded by UNTIL, is what Google and Apple emit and what the ecosystem reads. A
   `RELATED-TO` on the tail would need a back-pointer field on `CalEvent` to write a line nothing
   here reads. **Import of `RANGE=THISANDFUTURE` is the one real gap**, and it is bounded: the param
   is already parsed (`props["RECURRENCE-ID"].params.RANGE`) and `splitRule` already exists, so it is
   a post-pass in `fromIcs` — there, not in a consumer, because `feeds.ts` and `backup.ts` each link
   overrides themselves. Three things it has to get right: chained splits fold left (the second
   override's instant belongs to the first split's tail by then); the promoted tail needs its own
   stable uid (`uid#recurrence-id`) or it collides with its parent in both consumers' keys; and it
   inherits the parent's rule, with `splitRule`'s partitioned lists, when it brought no RRULE. Worth
   doing the day a feed turns up carrying one — nothing mainstream emits it, Thunderbird still
   renders it wrong, and today it lands as a single-instance override, which is wrong but not lossy.
5. ~~command + delete should delete an event you are hovering over~~ — _done._ ⌘⌫ (and ⌦) on the
   dial, off while a panel covers the face and off mid-drag, silent on a subscription's arc. A
   repeating one gets the same `ScopeDialog` a drag gets, in danger colour. It always toasts: a
   destructive single keystroke with no receipt is a key nobody presses twice.
6. onboarding, after everything is finalised

**1. quotes page** — _done, and it is not a page of quotes._

A page of quotes is what an app does when it has run out of ideas. Two lines survived and each went
where it argues for something. "You are a worm through time" **is** the life view, so it heads the
`BirthPrompt` — the one screen where somebody is looking at eighty years of nothing and needs a
reason to type a date — and it opens that section of the manifesto. It is **attributed in both
places**: it is the opening of the Hiss incantation, out of _Control_, and passing a borrowed line
off as the product's own thesis is the one thing a manifesto cannot do. "Be the change you wish to
see in the world" is dropped, a bumper sticker sitting between two ideas that are not. The
linearity-of-time line went to (9), where it is now the first thing on the page.

**2. year -> life transition** — _done._

Two things it left behind. The unroll lands on the _first_ line a year occupies, and `lifeLayout`
splits a desktop year across two — the settle covers it, but a one-line split is the case it looks
best in. And the year ring still has no year-scale summary in the middle; the readout prints `2026`
and a date, where the dial's centre prints a whole sentence about the day.

**3. group ui**

Reading this as grouping calendars. **Calendar CRUD shipped** — the sidebar's list has a `+` and a
pencil per row, ⌘P has `New calendar…` and `Edit …`, and `CalendarEditor.tsx` is name plus colour
plus a delete that _moves_ the events rather than taking them with it. So the argument that blocked
this is gone and the one that remains is arithmetic: groups start paying rent past about eight
calendars. Wait until somebody has eight.

**4. week view — seven dials, not seven columns** — _done._

The old line here read _"no week view: the circle is the argument, a seven-column grid concedes
it"_, and it did not survive the counter-proposal: **seven dials are not a grid.** They are the
same instrument at a different count, and nothing is conceded. What it was hiding is that circal
could not answer "what does my week look like" — ⌘Y says how _busy_ a day was and never _when_ —
and angle-is-time answers it for nothing.

`⌘E`, and the whole idea is that all seven sit at the same rotation. Verified rather than assumed:
a standup at 09:30 on five weekdays draws at an identical angle on all five faces and is absent on
the other two, which is the radial column this was for. Each face is `<Face>` with `track`, its
arcs, and `elapsed`/`hand` on today alone. One readout under the strip, naming the week at rest
and the day under the pointer. Read-only: no drag targets on seven faces, and the dial is one
keystroke away.

Four things the build decided that the plan above got wrong or left open.

**⌘W is not available**, to any web page, in any browser — it closes the tab and the keydown is
never delivered. ⌘E, and the chip in the segment is how anybody finds it anyway.

**Day ⇄ week is a zoom, not a crossfade.** The strip's face for the day you are on _is_ the dial
four times smaller, so crossfading would have been the one transition in the app that throws away
a geometric relationship it actually has. It could not use `transform-origin`, though — the panel
already carries one for the life zoom — so it solves for a translation instead: `t = f - o - (c -
o) * s`. Week ⇄ year and week ⇄ life are the crossfades.

**The readout belongs inside the group, not at the foot of the panel.** Seven circles in a row are
a seventh of the width tall, so a landscape window leaves a great deal of black under them, and a
sentence alone in it is a caption for the window rather than a readout for the strip.

**A fourth segment costs the top bar all three of its breakpoints.** The wordmark now goes at
1430, the readout at 1220 and the `‹ Today ›` stepper at 480 — the last being new, because below
that the three groups no longer fit a phone at all. Swept 360→1600 for overflows and collisions.

What it deliberately does not have: an interior, arc labels (11px mono at a seventh of the width
is a smudge), a lightcycle band, and any way to edit. If a week ever needs to be edited, the
honest move is to open the day.

**5. look at sidebar** — _done, and the half that landed is the opposite of what this said._

The old line here read _"the sidebar and the centre panel print the same agenda twice"_, and
prescribed the mini-month's removal to make room for the day's full log. Both halves were wrong.
The duplication was real but narrow — the interior is "now and next", and on any day that is not
today it prints a date and nothing else — and the mini-month is the one thing in the column the
interior genuinely cannot do. So: **the agenda went and the mini-month stayed.** What is left is
Calendars, the month, and the moon.

The mechanical half landed too, and the interesting part is that it needed no breakpoint. The
column pushes while the dial is height-bound — which is every stage wider than it is tall, where
260px off the width costs the face nothing at all — and becomes a drawer the moment the stage
would go width-bound. `rowWidth - SIDEBAR_W < rowHeight`, measured on the row. A tablet in
portrait is 1024px wide and still cannot afford it; a half-screen desktop window flips over
exactly where it starts to hurt. The drawer sits under the top bar rather than over it, so the
button that opened it closes it and there is no second verb to explain.

Two things the phone found on the way: the top bar's centred readout collides with the left group
below 820px, and the ⌘ chips on `ActionPill` pushed Settings clean off a 414px screen. Both are
one line each and both are measured, in the same style as the wordmark's own 1180.

**6. tasks?** — _done, and the question mark answered itself: dated only._

A task is `CalEvent.task` with `end === start`, so the dial's existing sub-cap dot-collapse draws
it as a pip on the rim at the minute it is due, and it takes no lane. Ticking is per _occurrence_
(`doneKeys`, the same shape `exdates` has), so a weekly task ticked this Monday is not ticked every
Monday, and `⌘Z` undoes a tick. Filled while it stands, hollow once it is done, on both the rim and
the interior's tick target, with the name struck through in the list.

**No inbox, and no undated tasks** — that was the whole of the question mark, and the answer has
not changed. One thing the flag did cost that was not obvious: `occurrencesOn` had to measure the
day overlap against `Math.max(duration, 1)`, because an exclusive `end` throws away a task standing
exactly at midnight.

**7. reminders** — _done, and the honest half of it is the sentence in the panel._

Notifications while the tab is open, at a lead you pick, off until asked for. Tasks included,
all-day events not, a ticked task silent. It never catches up: a reminder fires in its own minute
or not at all. Closed-tab reminders need a push service, which needs a server, which is the one
thing this product has said it will not have — so **Settings says so in words**, which is what the
review below asked for and is the whole of that item.

**8. zoom in life view** — _done, and it is not a zoom. It is a loupe._

The need was real and the noun was wrong. "Zoom" contradicts the view's one invariant — _the whole
life in one viewport_ — because pan and zoom turns the life into a map, and a map of your life is a
worse idea than a picture of it. So the eighty years never move at all. The year under the pointer
is simply drawn a second time, large, on a card held over the field.

**The fisheye was the other candidate and it is the instructive rejection.** It works on the year
ring, so it looked like a solved problem — but a ring is one-dimensional and _closed_, which is
what lets `spread` conserve its own slack and put the borrowed air back. A grid pushed aside in two
axes has no such conservation: it either overlaps rows or opens a hole, and its columns stop being
real Monday-to-Sunday weeks, which is the one structural claim this field makes. Distorting the
cartogram means the picture you are reading is no longer the picture.

**The transpose is arithmetic, not a look.** A year magnified in the field's own orientation buys
nothing: at the desktop split one line already spans the whole width, so there is no room across
and none down either. Turned on its side — a column is a week, seven rows are the weekdays — a year
is 54 columns instead of 372, and the pitch lands four or five times the field's. It is literally
`lifeCell` with `colsPerLine` fixed at seven, and `loupeCell(d).row === mondayOffset(d)` is the
tested claim that keeps the two pictures agreeing about where a week starts.

Three things the build decided. The card **writes the field's own hover**, so pointing at a big dot
moves the small one's ring and pressing opens the day — a magnifier you cannot act through is a
picture of a picture, and clicking a four-pixel dot was half the original complaint. It hangs in
whichever half the pointer is not in, on two thresholds, because one line across the field flips
150px of chrome for every pixel of jitter across it. And `LOUPE_GAIN` exists because the same
`TONE` on a dot with four times the diameter is forty per cent more light per unit area, which came
out as a pale slab competing with the event colours — the correction is `0.36 / 0.50`, the two
coverages, and it leaves the ratio inside `TONE` alone.

**A first pass shipped it too eager, too thin and unswitchable, and all three were the same
mistake: treating it as a tooltip.** It is a hundred and fifty pixels of chrome that nothing
clicked, so it now waits out `LOUPE_DWELL` before arriving, arrives on a third of a second and
leaves in two thirds of that — a pointer crossing the field on its way to the top bar must not
throw it up and take it down again. The keyboard skips the wait, because a keypress was never on
its way somewhere else.

**And it earns the room by being the surface a range can be drawn on.** Press, drag, release —
the year ring's grammar exactly, through the same `onCreateSpan`, so a run of days becomes a
multi-day event whichever face drew it. The field takes the gesture too, which is (8)'s sibling
item finally done; but a hundred days at four pixels is a gesture you cannot aim, and in the card
it is a hundred days at fifteen. The strip prints `8 Apr 2026 – 30 Jul 2026 · 114 days` while it
is live, the tip goes away (a card naming one end of a range is a second answer), and the run is
drawn as **bands** rather than dots: contiguous in reading order means at most three rectangles,
so dragging the whole life costs three `<rect>`s instead of thirty thousand arcs.

`settings.lifeLoupe`, on by default. It was going to have no switch on the argument that it only
appears when pointed at — but it is the biggest thing here that arrives unclicked, and somebody
who came for the eighty-year picture and nothing else is entitled to just the picture.

What it still deliberately does not have: milestone rings (the field owns those), and any presence
on a box too small to hold one worth drawing — `loupeLayout` returns `null` below `1.8` times the
field's own dot.

**9. manifesto** — _done, at `/manifesto/`._

_Time does not run out in front of you. It comes back around._ That opens the README now and it
opens the page. One static route under `Base.astro` with **no island** — a manifesto that ships
React costs more to load than the product it describes — and it does not break the one-route rule,
which was always about `/api/*`.

**Two drafts were thrown away and the second one is the instructive failure.** The first was six
sections of how the software works: the moon went to the sidebar, the detent measured 1.3 dB, one
route on the network and here is why. Obviously wrong. The second fixed the register and kept the
shape, which is where it got interesting: five headed sections, two of them arguing against list
calendars and against SaaS. That reads as a manifesto and is actually **positioning**. A page about
time does not need an opponent, and the moment it has one it is selling. It was also still full of
`which is`, `that is`, `because` — a joined-up argument invites disagreement with the joins, and
these are meant to be statements.

What shipped is **249 words, no headings, no enemy**: the return, the fact that a list will never
say the word full, the count (about twenty nine thousand, and it does not grade you, it counts),
the transfer (nobody is keeping these for you, which means you are), and the offer. Three
assertions stand alone at display size and carry the whole thing; the borrowed line sits under the
title rather than in a section of its own. Nothing in it names a file or defends a decision.

The one thing kept from draft one is the figure: four inline SVGs, two of them a single element
each (a dashed circle is a ring of 365 marks; a `<pattern>` is a life grid), because a decoration
costing 20 KB of `<line>`s would be the page arguing against itself. It carries the four-scales
idea without a paragraph explaining it, which is the only reason it survived.

Three things the build found. The route is `/manifesto/`, not `/manifest/`, because
`/manifest.webmanifest` already exists and means something else. `body` is `overflow-hidden` in the
base layer, so this is the first thing here that scrolls and `Base.astro` grew an explicit `scroll`
prop rather than a page-local hack. And `sw.js` filed **every** navigation under `"/"`, which was
right with one route and a shell-poisoning bug with two: reading the manifesto once made it the
page a cold offline launch booted. Keyed by request now, with `"/"` as the offline fallback.

Reachable from Settings → About and from the README. Deliberately **not** a ⌘P row: the palette is
for a day's work, and a first-run route to it belongs to onboarding (6).

---

## review — the code as it stands

The thesis is intact and the instrument is finished. The calendar underneath it is now real —
RFC 5545 in and out, the interior answering the day, one typed line making an event, and as of this
pass a dated task and a notification that says it is about to start. All three screens make the
same argument, and the moves between them are geometry. What is left is one column that does not
work on a phone, and one screen that does not exist.

### The year view — settled

It is a revolution: 365 marks in day order, growing outwards with what is on the day, months named
outside, one tab stop with a cursor inside it. The twelve-month grid is gone, and with it the last
screen that contradicted "one idea at three scales".

What it does _not_ have, deliberately: a daylight figure. Radius inside the marks was time of day
for one draft, with sunrise and sunset as two curves round the year — the one picture a grid cannot
draw, and never what anybody came to a calendar to find out. If it ever comes back it belongs
behind a switch, beside the dial's own lightcycle, not as the face's furniture.

The middle now carries a line, and it is not the sentence this list used to ask for. A year-scale
summary — busiest month, longest empty run — is the obvious thing to compute and the wrong thing to
print: the dial's interior answers a day because you are living in it, and nobody opens a year to
be told which month was busy. `settings.yearQuote` is a line the user writes, shown only at rest.

### Life view

The strongest concept in the app, and searching it is now the thing no other calendar can do —
⌘P lights every matching day and the thread stays lit after the palette closes. Milestones landed:
day 10,000, the midpoint, day 20,000, each a ring on its dot and a card of prose behind it. The
field itself is walkable: one tab stop, arrows for a cursor, `↵` to open the day. And it is now
_readable_ at the day, which was the last thing against it — the loupe (8) puts the year under the
pointer on a card at four times the pitch, without the eighty years moving a pixel.

**Drag a range is done**, and it turned out to be the same item as the loupe rather than a
neighbour of it: press-drag-release on the field or on the card, the strip prints
`8 Apr 2026 – 30 Jul 2026 · 114 days`, and the release hands the run to the editor as a multi-day
event through the year ring's own `onCreateSpan`. The field can be dragged on alone, but a hundred
days at four pixels is a gesture nobody can aim, so the card is where the gesture is actually
usable — which is the answer to "what is the magnifier _for_".

- **The card's `Go to this day` is load-bearing**, because the hit areas cost those three days their
  click on the field. If milestones ever grow past four marks, that trade stops being cheap.

### Input: what the palette still cannot do

Quick-add shipped — a sentence, its repetition included — and results are ranked with a forgiving
match rather than filtered by substring. What is still missing there is cheap and unglamorous:
**recency ranking** (nothing records what you opened, so the tiebreak is still nearness to the day
on screen — it wants a stored `openedAt` and therefore a schema bump) and **duplicate event** (no
such action anywhere, and the decision is where it lives: the editor, the palette, or a
modifier-drag on the arc). Calendar CRUD is no longer on this list — `New calendar…` and `Edit …`
are palette rows now.

### The dial

There is nothing left on the face. The honest omission is closed: **reminders exist**, in the one
form this product can honestly ship — while the tab is open — and the panel says so in words
rather than leaving the absence to be discovered by a missed meeting. Closed-tab reminders need a
push service, which needs a server, which is off-thesis and stays off it.

The face gained exactly one thing and it cost no radius: a task's pip, which is the sub-cap
dot-collapse that was already there.

### Correctness — clear

The life grid's focus path landed and the table it was the only row of is empty. One `sr-only`
listbox, `aria-activedescendant`, options that are the days of the cursor's calendar _year_ and are
rebuilt as it crosses into the next — 366 nodes rather than thirty thousand — and the canvas
dropped to `aria-hidden`, because two nodes describing one field is a field described twice. The
cursor's ring and the pointer's are one ring and one card.

What is left of that surface is not a defect but a limit: **no DOM in the suite** — no jsdom, no
component tests, on purpose, because a snapshot of an SVG path is a change-detector that fails on
every legitimate geometry tweak. That is the honest boundary of what 1,118 pure-function tests buy
you, and the faces stay eye-verified.

### What not to do

- **No seven-column grid.** This used to read "no week view", which was the wrong noun: the circle
  is the argument and a _grid_ concedes it, but seven dials do not. See (4).
- **No sync, no accounts.** "Nothing leaves this browser" is a feature, and a second API route is a
  different product.
- **Do not add a ring to the dial.** Every radius costs `PAD` and legibility, and that face already
  carries four plus two bands. The room is in the interior. The year face is a separate object with
  its own budget, and it is nearly empty — but see what happened to the daylight figure. The moon
  is the newest test of this rule and it went to the sidebar, which is the answer for anything that
  is not a fact about the day.

### If it were one thing

The old five are spent, and so are the month banding, the life search, the year view, the shell's
clock, the milestones, the year ring's range drag, calendar CRUD, the life grid's focus path,
tasks, reminders, the moon and the sidebar's drawer. **The small list is empty.**

The hour detent is **gone**, and it is the one thing on this list that was removed rather than
finished. It shipped measured-in-isolation at "+20% energy", which came to **1.3 dB in a stream**
against a click-to-click spread of 0.1 dB — inaudible, for months, unmissed. Retuning it to a real
4 dB and a 14 ms rebound proved the point rather than fixing it: the centre of the face is
printing `9:00 – 11:30 · 2h 30m` for the whole of the drag, so an audible accent turned out to be
a second answer to a question already answered, on a channel firing fifteen times a second. Two
lessons worth keeping. Anything tuned by rendering one event has not been tuned. And a signal
nobody noticed was missing was not carrying anything.

**The big one is spent too.** The week view shipped, and with it the `<Face>` extraction under it,
so the app is now one idea at four scales and the README says so. The manifesto (9) shipped with
the worm-through-time line (1), so the product finally states its argument somewhere other than in
its own geometry. And (8) is closed, together with the drag-range that turned out to be the same
item — it was the last thing on this list with a design problem in it rather than a task. What is
left is duplicate-event, recency ranking in ⌘P, and `RANGE=THISANDFUTURE` on import — and then (6)
onboarding and (1) the intro animation, which were always last and now genuinely are.

There is no item left that adds a screen, and none left that needs an argument. Everything above
finishes one.
