# todo

Recurrence is real, the interior answers the day, arcs carry their own names, the dial has an
ambient mode, ⌘P writes an event in one line and ranks what it finds, the year is a revolution and
unrolls into the life grid, the life grid names its round days and can be walked with the arrow
keys, an event can run for as many days as it likes, a drag across the year ring makes one, the
dial's hour detent can be counted by ear, editing a repeating event asks which occurrences it
means, ⌘⌫ deletes the arc you are pointing at, a calendar can be made and named and marked and
recoloured and deleted without losing what is in it, an event can wear a mark of its own along its
arc, a dated task is a pip on the rim you can tick off, the app can tell you a thing is about to
start, the sidebar carries the moon, and there is a test suite — 1,048 cases over the domain layer,
`pnpm test`, in the gate.

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

**1. quotes page** — _you are a worm through time, you have no obligations to your former self, be
the change you wish to see in the world._

Not a page. A page of quotes is a thing an app does when it has run out of ideas, and the first two
lines here are better than that. "A worm through time" _is_ the life view — it is the picture that
grid already draws — so it belongs in the life view's empty state, next to the birth prompt, where
somebody is looking at eighty years of nothing and needs a reason to type a date. Drop "be the
change you wish to see in the world": it is a bumper sticker sitting between two ideas that are not.
Fold the rest into (9) — see there.

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

**4. week view — seven dials, not seven columns**

In. The old line here read _"no week view: the circle is the argument, a seven-column grid concedes
it"_ — and that argument does not survive the counter-proposal, because **seven dials are not a
grid.** They are the same instrument at a different count, and nothing is conceded.

The gap is real and the old line was hiding it: **circal cannot answer "what does my week look
like."** ⌘Y says how _busy_ each day is — mark length is a count — and never _when_. That is the one
question this product cannot answer today, and angle-is-time answers it for free.

The version to build:

- **All seven faces at the same rotation.** This is the whole idea. A ten o'clock meeting sits at
  the same angle on every face, so the week reads as a _pattern_ — a recurring thing is a radial
  column across the strip. It is the one thing a seven-column grid is genuinely good at, and it
  survives the translation to dials intact.
- **A reduced face**: track, event arcs, and the elapsed ring plus now-hand on today alone. No
  numerals, no zone ring, no interior. One shared legend, and one shared readout under the strip
  printing the hovered day's sentence — the centre panel's voice, once, not seven times.
- **Hover grows a face and click is ⌘D on that day** — the year ring's grammar, unchanged.
- ⌘W. It crossfades with everything: a week is not a magnified anything.
- On a phone it cannot be a row. Scroll-snap the faces horizontally; a wrapped 4+3 grid of circles
  _is_ the version that concedes the argument.

Two costs to accept before starting. **It is a fourth scale** — "one idea at three scales" becomes
four, and the README's thesis paragraph needs rewriting rather than extending. And **`Dial.tsx` is
built around one face filling a viewport**: doing this properly means extracting a `<Face>` that the
dial and the strip both render, with numerals, zone ring and interior as opt-in. That extraction is
the real work and the real prerequisite — perhaps 300 careful lines — and skipping it means a second
copy of the arc-drawing code, which is how this repo gets its first duplicated convention.
`faceToPanel` / `polar` / `arcPath` are already scale-free, so the geometry side is ready.

**5. look at sidebar** — _half done, and the half that landed is the opposite of what this said._

The old line here read _"the sidebar and the centre panel print the same agenda twice"_, and
prescribed the mini-month's removal to make room for the day's full log. Both halves were wrong.
The duplication was real but narrow — the interior is "now and next", and on any day that is not
today it prints a date and nothing else — and the mini-month is the one thing in the column the
interior genuinely cannot do. So: **the agenda went and the mini-month stayed.** What is left is
Calendars, the month, and the moon.

What is still open is the mechanical half, which the old line was right about: it is a 260px
column that _pushes_ (`Sidebar.tsx`) with no drawer mode, so on a phone it is unusable. The
tab-order half of that is fixed (`inert`, not `aria-hidden` over live children); the drawer half
is not, and it is now the last plain defect in the app.

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

**8. zoom in life view**

The need is real — 30,000 dots at ~4px is at the edge of legibility and the screenshot proves it —
but "zoom" contradicts the view's one invariant: _the whole life in one viewport_. Pan and zoom
turns it into a map, and a map of your life is a worse idea than a picture of it. What you actually
want is **focus without losing the whole**: the year under the pointer expands into a strip along
the bottom, or a decade fisheyes in place, and the eighty years stay on screen the entire time.
`lifeCellAt` (`life.ts:301`) already tells you which year you are over, and the field is one
`drawImage` per frame (`LifeView.tsx:416`), so a second, larger strip is cheap. If you do add true
zoom, keep the full span as a mini-map or you have lost the argument.

**9. manifest** — _we are used to the linearity of time. however, days are circular. you live your
day just to find yourself at the same time as before._

The best line on the list, and the actual thesis — it is better than the README's opening and it
should probably become it. Tighten the last clause; "you live your day just to find yourself at the
same time as before" wants to land harder than it does. And note that this does **not** break the
one-route rule: that rule is about `/api/*` on the Worker. A static `/manifest/` is another file in
`dist/`, served by the assets binding, costing the product nothing. So: one static page, the
manifest, and the worm-through-time line from (1) lives on it. One page, not two.

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
day 10,000, the midpoint, day 20,000, each a ring on its dot and a card of prose behind it. And the
field itself is now walkable: one tab stop, arrows for a cursor, `↵` to open the day.

- **Drag a range** → "4,182 days". The distance maths already exists (`formatDistance`).
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
every legitimate geometry tweak. That is the honest boundary of what 1,048 pure-function tests buy
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
clock, the milestones, the hour detent, the year ring's range drag, calendar CRUD, the life grid's
focus path, tasks, reminders and the moon. The small list has one thing on it: **the sidebar's
drawer mode**, so the column works on a phone. That is the last plain defect in the app and it is
an afternoon.

What is left after it is one big thing: **the week view** (4), and before it the `<Face>`
extraction it needs. It is the only item that adds a screen rather than finishing one, and it is a
week rather than an afternoon — `Dial.tsx` is 1,700 lines built around one face filling a
viewport, and half of this file's rationale lives inside it. Decide up front which of numerals,
zone ring, interior and bands are opt-in props and which are composed children; do not start it
because it sounded good.
