# todo

Recurrence is real, the interior answers the day, arcs carry their own names, the dial has an
ambient mode, ⌘P writes an event in one line and ranks what it finds, the year is a revolution and
unrolls into the life grid, and there is a test suite — 868 cases over the domain layer,
`pnpm test`, in the gate.

Done work is not recorded here. The rationale that outlived it lives in `AGENTS.md`, next to the
code it constrains.

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

**2. year -> life transition** — _done._

And it turned out to be the same job as deciding what the year view is, not a job blocked behind it.
The year is now 365 marks in day order on one revolution, which is a row of the life grid rolled up
— so ⌘Y ⇄ ⌘L is a genuine unroll: the ring opens at 1 January, straightens, and the days settle onto
the row they were always going to be. `unroller` in `lib/year.ts` does the maths, `YearView` owns
both halves on a canvas, and `App.tsx`'s `PANEL` keeps out of the way.

Two things it left behind. The unroll lands on the _first_ line a year occupies, and `lifeLayout`
splits a desktop year across two — the settle covers it, but a one-line split is the case it looks
best in. And the year ring still has no year-scale summary in the middle; the readout prints `2026`
and a date, where the dial's centre prints a whole sentence about the day.

**3. group ui**

Reading this as grouping calendars. Premature: you cannot create, rename, recolour or delete a local
calendar from any surface in the app — `Sidebar.tsx:131-159` only toggles visibility, and
`store.addCalendarWithEvents`/`removeCalendar` are wired to import and feed-removal alone. Colour is
the only category encoding this product has, and the user cannot make one. Ship calendar CRUD;
groups only start paying rent past about eight calendars, and you cannot get to eight.

**5. look at sidebar**

Agreed, but the fix is a decision, not a tidy-up: **the sidebar and the centre panel print the same
agenda twice.** The interior is now "now and next", so the sidebar becomes the full day's log plus
calendar management, and that is a coherent split. Also: the mini-month earns less than it costs —
⌘P jumps to a date better than a 7×6 grid of 20px cells does — and that space is where calendar CRUD
goes. Mechanically it is a 260px column that _pushes_ (`Sidebar.tsx:58`) with no drawer mode, so on
a phone it is unusable, and it sets `aria-hidden` while leaving its children mounted at `w-0`, so
closed-sidebar content is still in the tab order.

**6. tasks?**

The question mark is right. A dated task is a zero-length event and the dial already has an honest
form for one — the dot-collapse at `Dial.tsx:817`, a pip on the rim at the right minute rather than
an arc that lies about duration. That part is nearly free. An _undated_ task is a to-do list, and a
to-do list on a dial is a different product wearing this one as a skin. If you do it: dated only, a
pip, struck through when done, and no inbox.

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

The thesis is intact and the instrument is finished. The calendar underneath it is now real —
RFC 5545 in and out, the interior answering the day, and one typed line making an event. All three
screens now make the same argument, and the moves between them are geometry. What is left is one
panel that is hard to read and two DOM-shaped bugs.

### The year view — settled

It is a revolution: 365 marks in day order, growing outwards with what is on the day, months named
outside, one tab stop with a cursor inside it. The twelve-month grid is gone, and with it the last
screen that contradicted "one idea at three scales".

What it does _not_ have, deliberately: a daylight figure. Radius inside the marks was time of day
for one draft, with sunrise and sunset as two curves round the year — the one picture a grid cannot
draw, and never what anybody came to a calendar to find out. If it ever comes back it belongs
behind a switch, beside the dial's own lightcycle, not as the face's furniture.

What it still could use, in order:

- **A year-scale sentence in the middle.** The dial's centre prints what the day is made of; the
  year's prints `2026` and a date. Busiest month, longest run of empty days, events this year — one
  line, the same voice as `totals`. **[medium / small]**
- **Drag an arc of the ring** to select a range of days, the way a drag on the dial selects a range
  of minutes. The maths is `dayAtPoint` twice and the readout already knows how to print a span.

### Life view

The strongest concept in the app, and searching it is now the thing no other calendar can do —
⌘P lights every matching day and the thread stays lit after the palette closes.

- **Milestones.** You know the birth date: day 10,000, the halfway dot, each decade. Cheap, on
  thesis, high delight. **[medium / small]**
- **Drag a range** → "4,182 days". The distance maths already exists (`formatDistance`).

### Input: what the palette still cannot do

Quick-add shipped — a sentence, its repetition included — and results are ranked with a forgiving
match rather than filtered by substring. What is still missing there is cheap and unglamorous:
**recency ranking** (nothing records what you opened, so the tiebreak is still nearness to the day
on screen — it wants a stored `openedAt` and therefore a schema bump), **duplicate event** (no such
action anywhere, and the decision is where it lives: the editor, the palette, or a modifier-drag on
the arc), and calendar CRUD (see (3)).

### The dial

- **Hear the hour.** Every 15-minute detent in a drag clicks identically; give every fourth one a
  different resonance and you can count hours by ear without looking, which is exactly the
  affordance a physical dial has. `SOUNDS` is already parameterised for it. **[medium / small]**

And the honest omission: **there are no reminders.** A calendar that never tells you anything is a
viewer. While the tab is open, `Notification` is enough; closed, it needs a server, and a server is
off-thesis. Say so in the UI rather than leaving the absence unexplained.

### Correctness — two open

| what                             | where and why                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 Hz whole-tree re-render**    | `useNow` ticks every second and `App` hands `now` to Dial, Sidebar, CenterPanel, YearView and LifeView, but only the readout and the hand move. Ambient takes the period to a minute, which is the right answer for a mode left running and no answer at all for the other 23 hours. Push second-resolution into a leaf and keep the rest on minutes.  |
| **Life grid is invisible to AT** | `role="img"`, one label, 30,000 dots, no focus path. The year ring now does it right — one `sr-only` listbox, arrows for a cursor, labels that say whether the day carries anything — and the same shape is what the grid wants: it is the same question at another scale, and 30,000 options is not it. A row-and-column cursor, or a year at a time. |

Both are DOM-shaped, which is exactly the surface the suite does not cover: no DOM, no jsdom, no
component tests, on purpose — a snapshot of an SVG path is a change-detector that fails on every
legitimate geometry tweak. That is the honest boundary of what 868 pure-function tests buy you, and
the faces stay eye-verified.

### What not to do

- **No week view.** The circle is the argument; a seven-column grid concedes it.
- **No sync, no accounts.** "Nothing leaves this browser" is a feature, and a second API route is a
  different product.
- **Do not add a ring to the dial.** Every radius costs `PAD` and legibility, and that face already
  carries four plus two bands. The room is in the interior. The year face is a separate object with
  its own budget, and it is nearly empty — but see what happened to the daylight figure.

### If it were three things

The old five are spent, and so are the month banding, the life search and the year view. What is
left, in order:

1. **The 1 Hz whole-tree re-render**, then **a focus path into the life grid** — the two DOM-shaped
   bugs left, and the suite covers neither. The year ring's listbox is the pattern for the second.
   `[medium / small]`
2. **Milestones in the life grid** — day 10,000, the halfway dot. Cheap, on thesis, high delight.
   `[medium / small]`
3. **A year-scale sentence in the middle of the year ring.** The one thing the new face is missing
   against the dial it is a copy of. `[medium / small]`
