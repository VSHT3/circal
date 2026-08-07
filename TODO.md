# todo

Recurrence is real, the interior answers the day, arcs carry their own names, the dial has an
ambient mode, ⌘P writes an event in one line and ranks what it finds, and there is a test suite —
820 cases over the domain layer, `pnpm test`, in the gate.

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
RFC 5545 in and out, the interior answering the day, and one typed line making an event. What is
left is one screen that contradicts the argument, one panel that is hard to read, and five
DOM-shaped bugs.

### The year view is the weak sibling, and the biggest opportunity

It is a conventional twelve-month grid that shares no _metaphor_ with the other two. It does share
code — `mondayOffset` and `dayColors` both live in `life.ts` and both views call them, so an event
no longer gets two different answers — but it is still the one screen that contradicts "one idea at
three scales", and it is still what blocks (2). Two honest paths:

- **On-thesis: the year is a revolution too.** 365 spokes on one ring — and the thing only this app
  can draw, **the day-length curve across a year**, from `sunTimes` sampled 365 times (`sun.ts:72`).
  A solstice-to-solstice figure no grid can show, for the price of a loop. **[high / medium]**
- **Or accept it as an index** and give it what an index needs: hover detail, its own year stepper
  (`year` is a fixed prop), and weight by count rather than "up to three dots".

### Life view

The strongest concept in the app, and the render is still fighting it in one place.

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

### Correctness — four open

| what                             | where and why                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feed payloads share the blob** | Everything is one `circal.v1` key, so a fat subscription competes with your own events for one ~5MB quota; `write()` toasts once and then loses the write silently on reload. Feeds want their own key, and a cap. Needs a schema bump and a migration, so it is its own commit.                                                            |
| **No focus trap in any modal**   | Three hand-rolled dialogs, no shared primitive: Tab escapes to the page behind, and the global hotkeys (←/→/`t`) still fire under an open editor.                                                                                                                                                                                           |
| **1 Hz whole-tree re-render**    | `useNow` ticks every second and `App` hands `now` to Dial, Sidebar, CenterPanel and LifeView, but only the readout and the hand move. Ambient takes the period to a minute, which is the right answer for a mode left running and no answer at all for the other 23 hours. Push second-resolution into a leaf and keep the rest on minutes. |
| **Life grid is invisible to AT** | `role="img"`, one label, 30,000 dots, no focus path. The year grid does it right with real buttons — but its `aria-label` omits whether the day carries anything.                                                                                                                                                                           |

All four are DOM-shaped, which is exactly the surface the suite does not cover: no DOM, no jsdom, no
component tests, on purpose — a snapshot of an SVG path is a change-detector that fails on every
legitimate geometry tweak. That is the honest boundary of what 820 pure-function tests buy you, and
the dial stays eye-verified.

### What not to do

- **No week view.** The circle is the argument; a seven-column grid concedes it.
- **No sync, no accounts.** "Nothing leaves this browser" is a feature, and a second API route is a
  different product.
- **Do not add a ring.** Every radius costs `PAD` and legibility, and the face already carries four
  plus two bands. The room is in the interior.

### If it were four things

The old five are spent — real RRULE in and out, the interior, arc labels, ambient mode, quick-add
and the suite all shipped. What is left, in order:

1. **Decide what the year view is.** The last screen off-thesis, and the only thing blocking (2).
   Everything else here is an improvement; this one is an argument. `[high / medium]`
2. **The life grid's month banding**, then **search the whole life** — one is a render bug wearing a
   feature's clothes, the other is the thing no other calendar can do. `[high / medium]`
3. **Split the feed payloads out of the blob.** The only open bug that can lose data. `[high /
medium]`
4. **A focus trap, once, in a primitive** — three dialogs already need it and the next one will too.
   `[medium / small]`
