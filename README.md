# circal

**Time does not run out in front of you. It comes back around.**

A calendar that draws days the way they behave. A day is one revolution: events
are arcs, the day so far is a ramp of light around the rim, and the hand is the
current minute. Inspired by [Raycast's Radical](https://www.raycast.com), in the
browser.

The argument, on one page: **[the
manifesto](https://circal.day/manifesto/)**, also reachable from Settings.

The **[tour](https://circal.day/tour/)** explains the four views, event gestures,
task planning and optional connections, with images from the app and a keyboard reference.

The first time you open it, the face builds itself: the hand goes round once
and every tick, hour and event arrives as it passes, each one delayed by the
time it stands for. Then the hand carries on to the current minute and settles
onto it. The day in day order, which is the whole argument, in about three
seconds. Nothing waits on it — the dial is live throughout. Settings → About
has `Play again`, and `prefers-reduced-motion` skips it.

A one-time teaching card follows the intro, with the palette shortcut, four views and
event and task gestures. Dismiss it with **Start using circal** or Escape. Its dismissal
stays on this device, independent of calendar backups and sync.

**Settings → Data → Save face** saves the selected day or year as SVG or a 1600-pixel
PNG. It includes the visible event details and readout, uses the selected theme and
clock, and creates the image locally without uploading it.

The **Dial** setting (`⌘,`) picks how the face names its hours:

- **12 h** — noon at the top, midnight at the bottom, `12 · 1…11` twice with
  AM/PM captions. 6 AM sits at nine o'clock, 6 PM at three.
- **24 h** — midnight at the top, `00 · 1…23` running clockwise, so `06` is at
  three o'clock, `12` at the bottom and `18` at nine. The default: it is the
  face that matches the instrument, since one revolution here is a whole day
  rather than half of one, and an hour has exactly one place on it.

Same geometry either way: an event's arc is the same length on both faces, and
switching is a 180° rotation and a relabel. The setting also picks how every
time in the app is written — `1:15 PM` or `13:15`.

**Settings → Face → Dial → Join adjacent events** connects events that meet exactly
on the same lane, with a thin separator between them. It is off by default. Each
event keeps its own label and editing controls; gaps and overlaps stay separate.

Events take their colour from their calendar. Any one event can override that
from the editor's **Color** row: ten digital pastels, or a picker for anything
else.

Notes in event and task cards make web addresses and email addresses clickable.
Use the pencil to edit notes and the checkmark to return to clickable text.
The event's **URL** row also has a control to open its link in a new tab.

Calendars are yours to make. The sidebar's **Calendars** list has a `+` for a
new one and a pencil on each row, and ⌘P has `New calendar…` and `Edit …` for
both without reaching for the sidebar. Deleting one never deletes what is in
it: its events move to the calendar that is left, and the notice says how many
did. The last calendar stays — an event has to be somewhere.

A calendar can also carry a **mark**: one of 247 icons — searchable — or any
emoji you type. It stands wherever the calendar is named: the sidebar, the
palette, the event editor's **Calendar** row.

The row that picks one shows four rows of eight, which is a porthole onto a set
of 247. The button at the end of it opens every mark at once, full screen, at
nearly twice the size, with the same search box — type `first aid`, `firstaid`
or `aid` and all three land on the same glyph. Picking closes it; `Escape` or a
click outside leaves the card you were filling in exactly as it was.

Point at any mark, in either grid, and it says its name in a small bubble over
itself. Tab does the same, so the names are reachable without a pointer at all.

An event can carry its own, from the editor's **Mark** row, and then it rides
along the arc in front of the name. Colour and mark are two channels read
separately — the mark says what kind of thing this is, the colour still says
whose day it belongs to — so an event can take a glyph and keep its own hue.
An event with no mark of its own shows nothing by default; **Settings → Event
marks → Inherit** makes it borrow its calendar's instead, which is worth
turning on if you keep one calendar per kind of thing and not otherwise.

On a short arc the mark is dropped and the name kept: two more letters of a
title say more than a symbol every event on that calendar is wearing.

An event's name is printed along its own arc, inside the stroke — black on its
own colour, which is the strongest pairing this face has and the only one that
works on every lane. A name appears only where the arc can hold one: about
forty-five minutes for a word, about half an hour out at the rim for a stub,
and below that the arc stays the dot it already was. That is arithmetic rather
than a threshold — the same half hour is 38 units of paint on the outer lane
and 24 four lanes in. The **Arc names** setting takes `Always`, `Hover` — one
at a time, for a crowded day — or `Off`.

## Events longer than a day

A trip, a holiday, a conference. The editor's **Date** row is two dates the
way the **Time** row is two times, and the second one is the last day the
event covers — set it and the event runs to there. Every day inside the span
carries it: the interior prints `DAY 3/5` where it would otherwise print a
start time, because on the third morning of a five-day trip the hour it began
is not what you came to read.

A timed span draws a closed circle on the days in its middle — those days are
entirely inside the event, and a whole revolution is what the face has to say
about that. The **All-day** switch changes whether the two ends carry times,
never how many days there are.

## Tasks

A dated task is an event with no width, so it needs no second model: `⇧⌘N`, or
the **Task** switch in any editor, collapses the Time row to one field and the
Date row to one day. On the face it is a pip on the rim at the minute it is
due — the honest shape for a moment, where an arc would be lying about a
duration nobody gave it — and it takes no lane, so it never pushes a meeting
inwards to make room for itself.

Tick it off from the middle of the face: the row carries a mark at its end,
the name goes through, and the pip on the rim empties out. Filled while it
stands, hollow once it is done, on both surfaces. A repeating task is ticked
one occurrence at a time — this Monday, not every Monday — and `⌘Z` undoes a
tick like any other edit.

There is no inbox and there are no undated tasks. A to-do list with no day on
it is a different product wearing this one as a skin.

## Reminders

Off until you ask for them, in **Settings** → **Reminders**: a notification
when something starts, or up to an hour before it. Tasks are included, all-day
events are not — "ten minutes before midnight" is not what an all-day event
means — and a task already ticked off says nothing.

**Only while circal is open, in this tab.** Reminders with it closed would
need a server pushing them at you, and circal runs nowhere but this browser.
The setting says so in the panel rather than leaving it to be discovered by a
missed meeting. Nothing ever catches up either: a reminder fires in its own
minute or not at all, because a notification for a meeting that started an
hour ago is worse than none.

The tab title is the other half, and it needs no permission and no switch:
while circal is in a background tab it reads `· Standup · in 14m`, or
`· Standup · 40m` once that meeting is running and forty minutes of it are
left, so the answer is in the tab strip of whatever you went off to do
instead. It goes back to plain the moment you come back to it, because the
dial is already saying it.

## Editing something that repeats

A repeating event is asked what an edit means, at the moment it lands rather
than as a standing row of buttons: press **Save** or **Delete** on one and the
editor's footer becomes the question, with three answers.

- **Only this one** — the change becomes its own event, replacing that one
  occurrence and leaving the rule alone. Deleting takes the same shape: the day
  is excluded, the series is untouched.
- **This and all future** — the series stops the instant before the occurrence
  you are standing on and a new one starts there carrying the change. The past
  keeps the shape it had, which is the point: moving a standup to half past
  does not move every standup you have already been to.
- **The whole series** — the rule itself, every occurrence of it, and the
  exceptions that detached from it.

**Dragging one of its arcs on the dial asks the same question**, in a card of
its own, when you let go — and so does **⌘⌫ over an arc you are pointing at**.
Nothing is written until you answer: a dragged arc holds the position you
dragged it to while the card is up, and Cancel puts it back.

`esc` backs out of the question — in the editor it leaves the edit on screen
and a second press closes; on the dial it abandons the drag. A one-off is never
asked, on either surface: there is only one thing it could mean.

## Duplicating one

Hold `⌘` and drag an arc: the original stays where it is, a copy in its own
colour follows the pointer, and letting go writes it at the minute you left
it. Everything comes across — the rule included, so a copy of a weekly standup
dragged an hour later is a weekly standup an hour later. It asks no scope
question, because nothing existing is being changed.

In `⌘P`, `⌘↵` on an event does the same thing the other way round: no gesture
named a time, so the copy opens in the editor rather than landing invisibly on
top of its original. The foot of the palette says so on whichever row you are
standing on.

## Sharing one

**Share link**, at the foot of the event editor, puts the whole event on your
clipboard as a link. Not a link _to_ anything: the event travels inside it, in
the part of a URL that is never sent to a server, so there is nothing stored
anywhere, nothing to expire and nothing to take down. Open it in another
circal and the event arrives in the editor, on the day it names, in that
person's own default calendar — theirs to change, or to escape and keep
nothing. It is offered on a subscription's event too, since sharing is copying
rather than editing.

Two things it deliberately does not carry. **Guests do not travel** — an
invitation's organiser and attendees are other people's names and addresses,
and a link goes into group chats. And **it is not private**: the event is
encoded, not encrypted, so anyone holding the link holds the event, which is
what the notice says as the link is copied. A very long note or a rule with
dozens of exceptions will be refused rather than turned into a link that
breaks in transit; `.ics` is the way to hand those on, and the way to hand
anything to a calendar that is not circal.

## Sharing your free time

`⌘P` → **Share free time as a link** puts the next seven days' gaps on your
clipboard, the same way: the times travel inside the link, nothing is stored
anywhere. It is the gaps and never the events — what you are busy _with_
cannot leak because it was never encoded — measured against your own waking
hours, at least half an hour wide, starting from right now rather than from a
week's official Monday. Opened in any circal, the link lands on the week
strip with the free stretches drawn as hollow outlines under that person's
own days — the same empty band a free event draws, "open" rather than
"booked" — with a line at the top saying it is someone else's free time, and
a way to take it down. Nothing is written: the
overlay is gone on reload, and the same disclosure applies — encoded, not
encrypted, so anyone
holding the link can see when you are free.

**Booking one closes the loop, with no server in between.** Click a hollow
slot — on the week strip or on the day's own dial — and a draft opens
covering exactly that gap; name it, trim it if you like, Save — it lands on
_your_ calendar, and a line appears offering the reply: the saved event as a
link to message back (their circal opens it straight into an editor, one Save
and both calendars agree) or as an `.ics` file for a sender on any other
calendar. On the dial you can also just draw over the gap, as with any range.
circal posts nothing on your behalf; the message thread the offer arrived on
is the server. The sender re-checks on accept, which is what "does Tuesday
still work?" already is.

## The middle of the face

The ring says what shape the day is; the middle says the one sentence. It has
four moods and picks between them itself:

- **The next thing.** On today, the first event still to come is the headline —
  its name in white, and a countdown beside it that sharpens as it closes:
  `in 2h 10m`, `in 42m`, and inside the last minute `in 45s`. Under five
  minutes its dot takes a thin ring. Once it starts, the dot pulses and the
  countdown becomes `ends in 16m`. Everything after it stays a whisper, which
  is the whole point — one row is the answer and the others are context.
- **Whatever you are pointing at.** Hover an arc, or its row, and the readout
  becomes that event's span — `3 PM – 4:30 PM · 1h 30m` — in exactly the voice
  a range you are _drawing_ is printed in, because it is the same question. The
  clock shrinks into the span on the same curve and duration as the arc
  thickens, so the two read as one movement. A finished event comes back into
  the list while you point at it: a span with no name is half an answer.
- **The time**, on today, and **the date** on any other day.

**Totals** (off, in Settings) adds one line: how much of the day is spoken for,
and how much of it is still free. Booked counts the whole revolution — a six
o'clock run is time spent — while free counts only the hours you would book in,
because nobody reads "nineteen hours free" as an offer. Those hours are yours
to set, in **Settings → Day → Hours**; the palette's free-slot search reads the
same pair, so both mean the same thing by "free". The nine-cell picker
beside the switch says where it sits: under the list, or in any corner or edge
of the window, which on anything wider than it is tall is black the circle
never reaches.

![the day view](docs/day.png)

## Lightcycle and a second zone

Two optional annotations, both configured in **Settings** (`⌘,`):

- **Lightcycle.** Pick your city and the track stops describing the elapsed day
  and starts describing the light: civil twilight as a shoulder rising out of
  black, sunrise to sunset ramping with the sun's altitude, and the night hours
  in violet, which closes the ring. **Daylight** and **Moonlight** switch
  independently, so you can keep either half alone. It is drawn _on_ the track
  rather than beside it, because two rings a few units apart read as one line
  doubled by mistake. This is the one thing the circle can show that a grid
  cannot, and its shape visibly turns through the year. Polar day and polar
  night are handled; the band simply fills or vanishes.
- **A second timezone.** Pick a zone and its `00 · 06 · 12 · 18` appear on an
  outer ring, rotated so they sit where those hours fall on _your_ day. The
  caption names the city and how far ahead or behind you it is — `Tokyo +7`,
  not `GMT+9` — and the name and the offset switch on and off separately.
  There is no second hand, because the instant is the same everywhere; only
  the labels move. That zone gets **Daylight** and **Moonlight** of its own,
  drawn as a second band on the rim outside yours: two places' light on one
  face, so you can see at a glance that their morning is your afternoon.
  Its two switches are independent of yours — a comparison you can only half
  draw is not a comparison.

With the lightcycle off — no city, or both halves switched off — the dial is
exactly as it was: the elapsed day as a ramp of light around the rim.

## The moon

In the sidebar rather than on the face, because every radius the dial gains
costs legibility and the moon is not a fact about the day the way the light on
the rim is. It reads the day you have selected, so arrowing through a week
walks the moon through its week. Off until you ask for it, in **Settings** →
**Sidebar**.

It draws the astronomy, in the app's own black and white, and it draws only the
lit part: the terminator as an ellipse over it, no outline and no dark limb, so
a crescent is a crescent rather than a disc with a crescent on it and a new
moon is nothing at all. Beside it, the phase's name, how much of it is lit, and
how many days to the next full or new moon.

## The week, as seven dials

`⌘E` is the one thing the rest of this cannot answer: what does my week look
like. The year ring says how _busy_ a day was and never _when_; a column of
text says when and gives up the shape. Seven faces do both — the same
instrument at a different count, so nothing is conceded.

The whole idea is that all seven sit at the **same rotation**. A ten o'clock
meeting is at the same angle on every face, so a standup every weekday is the
same mark in the same place all week and the Friday you keep giving away is a
gap in it. That is a pattern you see rather than a list you read, and it is
free: angle is already time.

They are laid out for size rather than in a line. Seven circles across a
landscape window are a seventh of it wide, which is a face too small to point
at and far too small to label, so the seven take whichever arrangement makes
them biggest in the window you have: four and three on a laptop, three rows on
a tablet, two columns down a phone. Reading order is still day order and the
rotation is still shared, which is all the idea ever needed.

Each face carries what survives at that size — the rim, the arcs, the half-hour
ticks and the four hours it is navigated by, with the ramp of light and the
hand on today alone. No second zone, no interior, and no names on the arcs:
a name on an arc is printed inside a stroke five pixels wide here. Instead
there is one readout under the grid, and it answers whatever you are pointing
at — the week, then the day, then the event. **Click an arc and it opens**;
click anywhere else on a face and the day does, with the dial growing out of
the very face you clicked.

Seven faces is seven tab stops, so this one needs no cursor of its own: tab
through the week and `↵` opens the day you are on. `←` and `→` step a whole
week, because a step should move the picture by exactly the picture.

A week also takes the gesture the year ring and the life grid already have:
**press, drag across faces, release** and you get one event across those days,
the readout naming the range as you go. A press that never leaves its face is
still a click. That is the only thing on this strip you can write — the arcs
themselves stay read-only, because seven faces of drag handles are seven
chances to edit the wrong day, and the dial is one keystroke away.

Which day the week starts on is yours: **Settings → Week**, Monday, Sunday or
Saturday. It is one setting for a reason — the strip, the sidebar's mini-month
and the life grid's columns are all built out of real weeks, so they move
together and cannot end up disagreeing.

## The year, on one revolution

`⌘Y` is the same instrument asked a bigger question. One revolution is one
year, clockwise from 1 January at the top, and every day of it gets one mark
on the rim — a stub when there is nothing on it, growing outwards with what
there is, in the colour of the first thing there. A busy autumn is a bright
ragged stretch and an empty spring is a dotted line, so the shape of a year is
something you read rather than count. Months are named outside the ring, today
is a pip just inside it, and the day you came in on is a white mark.

The middle prints the year until you point at a day, and then prints that day
— its date, and what is on it. Click a mark to open that day on the dial, or
drag across the rim to take a run of them.

A day is a third of a degree wide, which is smaller than the pointer, so the
ring magnifies rather than merely highlighting. The day under the pointer
reaches out towards you and lights up, its neighbours come part of the way,
and the few days either side lean aside to make room — so what you are
pointing at is unmistakable without anything being drawn over the ring. Each
new day the pointer crosses ticks, on the same switches the dial's drag uses:
read it slowly and it is one tick a day, sweep it and it is a finger down a
comb.

It is one tab stop, not three hundred and sixty five. Tab to the ring and the
arrows move a cursor round it — a day at a time, a week with up/down, four
weeks with page up and down, `home` and `end` for the ends of the year — with
the middle reading out whatever the cursor is on. `↵` opens it. `←` and `→`
still step the whole year whenever the ring does not have focus.

There is no daylight curve in the middle of it. There was, for a while, and it
was the one picture a grid cannot draw — and it was never what anyone came to
a calendar to find out.

Under the year it prints a line of your own. The dial's centre can answer a
day because you are living in it; a year has no answer worth printing every
time you open one, so the space goes to something you wrote instead. It shows
only at rest, and it is yours to change in **Settings** — or to empty, which
leaves the middle bare.

And like the life grid, the ring answers a question. Open `⌘P` while it is up
and every day carrying a matching event keeps its colour and swells; the rest
of the year falls back to a grey. "When in the year do I do this" has a shape,
and this is the scale it has it at. The count sits under the year, the thread
stays lit after the palette closes, and `esc` clears it.

## Your life, in days

`⌘L` pulls all the way back. One dot is one day and the whole life is one
viewport: days grouped into weeks, weeks into years, years into the decades
marked down the side. Days you have spent are dim, today is the one lit dot,
the ones you have not are plain grey. A day carrying something wears its
calendar's colour, so a birthday runs down the grid as a coloured thread.

It asks for one date the first time you open it — a birth date, kept in this
browser like everything else — and a number of years to expect, which is a
guess and is drawn as one: the last week of it dims away to nothing, so the
field trails off rather than stopping at a date it does not know. Both live in
**Settings** afterwards.

The strip above the field counts: days lived, days left, and how much of the
whole is spent to seven decimals, which is enough to watch it move — the last
digit turns every couple of seconds, because a life is long enough that six
would leave it sitting still for half a minute. Hover a dot for its date, how
far off it is and what is on it; click one to open that day on the dial. Drag
across a run of them and the strip counts it — `8 Apr 2026 – 30 Jul 2026 · 114
days` — and letting go opens that run as a multi-day event, which is the year
ring's own gesture one scale further out.

A dot is four pixels, though, and four pixels is a picture rather than a day.
So rest the pointer on one and the year it belongs to comes up on a card over
the field, at four or five times the size: every day of that year, months
named across the top, weekdays down the side, and the same colours the field
is drawn in. The eighty years do not move a pixel while it is up — this is a
magnifier, not a zoom, and the whole life staying in one viewport is the point
of the view.

The card is where the grid becomes usable rather than only readable. Point at
a day in it and the ring moves on the field below; press one and it opens on
the dial; drag across it and you are picking a hundred days at fifteen pixels
each instead of at four. It hangs in whichever half of the screen your pointer
is not in, waits a moment before appearing so that crossing the grid on the
way somewhere else does not summon it, and goes when you stop pointing.
**Settings → Life → Loupe** turns it off.

It is one tab stop too, the same way the year ring is. Tab to the field and
the arrows move a cursor across it — a day at a time, a week with up/down, a
whole year with page up and down, `home` and `end` for the two ends of the
life — with the same card the pointer gets following it, and `↵` opening that
day on the dial. `←` and `→` still step the year whenever the grid does not
have focus.

A few days are named. The ten-thousandth, the twenty-thousandth, the midpoint
of the estimate: each one takes a thin ring, and clicking it says what the
number is for. Three marks on thirty thousand dots, which is a constellation
rather than furniture, and the switch for them is in **Settings**.

And it is the one view you can ask a question of. Open `⌘P` while the grid is
up and every day carrying a matching event lights, in its own colour, with the
rest of the life falling back to almost nothing — "every day I ran", as a
thread down eighty years. The strip counts the answer, the palette stops
blurring what is behind it, and the thread stays lit after the palette closes,
because it is drawn at a size worth reading. `esc` clears it.

Between the dial and the grid it is a zoom, not a cut. Going out, the dial —
arcs, hand and all — shrinks until it is the single dot standing for the day
you were looking at, and the field arrives as a wave leaving that same dot,
the days lighting up as it passes. Coming back, the wave collapses onto the
day you clicked and the dial grows out of it.

Between the year and the grid it is an unroll, which is the stricter claim of
the two: a year in day order round a circle _is_ one row of this grid rolled
up. So the ring opens at 1 January and straightens, the days settling onto the
row they were always going to be, and rolls back up the other way. Day and
year is neither — a day is not a magnified year and it is not a rolled-up one
— so that pair crossfades. With **reduce motion** set nothing moves at all.

## Ambient

`F` takes the chrome away and gives the window to the dial. What is left is the
day at a glance: the ring, the light on it, the arcs, the hand, the time, and
one line under it for the next thing and how long you have. Twelve hour
numerals become the four the face is navigated by, and the names come off the
arcs — both are type meant to be read from a chair, and this is a face meant to
be read from across a room.

It is a mode you leave running, so it behaves like one. The screen is kept
awake. The pointer disappears after two seconds and comes back when you move
it. The whole composition wanders a few pixels over five minutes, which no one
will ever notice and which is what stops a static rim burning into a panel.
And if you have picked a city for the lightcycle, the face **dims with your own
dusk** — full brightness while the sun is up, a little over half of it in the
middle of the night, on the same curve the band is drawing. A clock in a dark
room should not be a lamp.

Everything still works: drag the ring, move an arc, `⌘P`. Opening the editor
brings the chrome back with it, because that is a surface you work on rather
than one you look at. `⇧F` asks for the whole screen as well, and `Esc` leaves.

**Settings** has a section for it, because a display mode's face is its own
question: whether it dims with dusk, its own **Daylight** and **Moonlight**
halves, whether it keeps the second ring, and its own **Arc names** mode — off
by default, where the working face's is on.

The two halves are ambient's own, not a view of the ones above. Only the
_place_ is shared, because there is one of those: a person is somewhere, and
where they are is not a property of a mode. The halves are — on the working
face the band shares the rim with a day's arcs and dropping one is a
legibility trade, and on a face that is nothing but the rim it is the picture.
So the night half can be on here and off there, or the other way round, and
with both off the elapsed trail comes back exactly as it does on the working
face.

**Start on its own** is the last row: never, or after one, two, five, ten,
thirty minutes or an hour of the dial being left alone. It arms only on the
dial with nothing open — a timer that swapped the view out from under a grid
would lose the year you were reading. Arriving that way it is a screensaver
and leaves like one, at the first sign of anybody being there; asked for with
`F` it stays, because there the pointer is how you use it.

Nothing about the change is a cut, and all of it moves on one beat. The chrome
withdraws, the eight hour numerals between the quarters recede, the names
leave the arcs, the middle grows into its larger type and the rim crossfades
between the band and the elapsed trail — over the same 600ms, on the way in
and again on the way out. A half of the lightcycle that is on in one mode and
off in the other **draws itself** between them, from its own first minute and
in the direction the day runs: daylight out of dawn, night out of dusk and on
through midnight. A half that is the same either side does not move at all.
With **reduce motion** set, none of it moves.

## Three greyscales

Chrome is greyscale by rule — colour belongs to events — but _which_
greyscale is yours: **Settings → Face → Theme** offers **Midnight** (the
true-black original), **Ember** (the same instrument on a warm dark ground)
and **Paper** (ink on a light page, where the elapsed ring darkens the way
ink accumulates rather than brightening). Three named presets, never a
theme editor: a slider is a thousand faces nobody tested. Event colours
stay put on all three.

## Your data

Events live in this browser's `localStorage` under `circal.v1`, and by default
that is the only place they live. Nothing is sent anywhere until you connect
one of the two copies below, and a browser can be cleared by a menu item, so
the copy you take yourself is still the one that matters:

- **Export `.ics`** hands your events to any other calendar.
- **Backup `.json`** is the whole store — events, calendars, settings — and
  restores exactly. Both live in Settings and in `⌘P`.
- **Import** takes either. A `.ics` lands in a calendar of its own so an
  import can always be told apart from what you wrote; a `.json` restores the
  store. Both are one `⌘Z` away from being undone.

**Subscriptions** mirror a public ICS URL — a Google, Apple or Fastmail
"secret address" — as a read-only calendar, pulled on launch and on demand.
Their events draw on the dial and open in the editor, but every field is
locked: it is somebody else's calendar. A subscription that publishes a
timezone keeps it — a weekly 09:00 New York standup stays 09:00 in New York
whatever your own clock is doing, including the weeks when the two hemispheres
change on different dates — and the editor says which city its hours are read
against. Export keeps it too, so a round trip through circal no longer
flattens somebody else's morning into UTC.

Install it (Add to Home Screen, or the browser's install button) and it works
offline. On iOS that is also what stops the seven-day storage eviction from
taking your calendar with it.

## The mirror, and an AI that can read it

Optional, off, and in **Settings** → **Mirror**. Connect a file and circal
keeps a live `.json` copy of the whole store in it — the same format
**Backup** writes, so the two are interchangeable. That is a backup which
survives "Clear site data" without anybody remembering to take it.

It is also the one surface something outside the browser can hold. `mcp/` is a
small [MCP](https://modelcontextprotocol.io) server that reads and writes that
same file, so an assistant in Claude, Claude Code or Cursor can answer what is
on Thursday, find you a free hour, and write the appointment you just agreed
to. It works with the tab closed, because a file does.

It is not a second calendar engine. The server imports circal's own domain
layer, so a typed line goes through the same grammar `⌘P` uses and a repeating
event asks the same three-way question the editor asks — and **refuses** to
act on one until it is answered, rather than guessing that "delete my standup"
meant all fifty-two of them. Subscriptions stay read-only there too.

Open [the assistant setup page](https://circal.day/assistant/) to choose your
client and a mirror or cloud connection. It generates the client configuration
and copies the complete setup prompt, including optional agent skill installation.
For a mirror file, find its path with:

```sh
npx -y circal-mcp --find
```

The [circal agent skill](skills/README.md) teaches the connected agent to check
the document, find availability, manage tasks and choose recurrence scopes:

```sh
npx skills add VSHT3/circal --skill circal
```

Building from source instead: `pnpm build:mcp` produces
`mcp/dist/circal-mcp.mjs`, and [`mcp/README.md`](mcp/README.md) has the
client config for that path. One thing to know before switching it on: while
the file is connected, anything that can read that file can read and change
your calendar. Nothing goes over the network for it, and nothing about it asks
you to sign in to anything.

## The cloud copy

Optional, off, and in **Settings** → **Cloud**. It holds one copy of the whole
store on a server, so a second machine signed in to the same account opens the
calendar you left on the first one. It is the same document the mirror file
carries, in the same format: the only thing that changes is where the copy
sits, and either side of a sync merges rather than overwriting, so two
machines edited on two days keep both days.

Signing in is an email address, then a code out of that email. There is no
link to click: the code goes through you rather than through whatever mail
client happens to open a link, and it works the same wherever circal is
running. How long the code is is the identity provider's own setting, so
circal prints what it is told and counts nothing.

Then a passphrase, once, and this is the part worth reading twice. Circal
seals the copy with it in this browser before anything leaves, so what the
server holds is a locked box and a row number rather than your appointments.
The other half of that same fact is the cost: there is nobody who can reset it
for you, so losing the passphrase loses the cloud copy with it. What it does
not lose is your calendar, which is still in this browser and in the mirror
file if you keep one. And signing in is still signing in: whoever runs the
project knows the email address you used, and encrypting the calendar does not
change that.

One live copy at a time. The file and the cloud are two answers to the same
question rather than a pair, so while either is connected the panel puts the
other's Connect button beyond reach and says why. Two writers merging one
document is a thing to arrive at deliberately.

A paused project reads as a link that is down. Supabase, which is what holds
the row, stops a free project nobody has used for a week, and the panel prints
what to do about it instead of retrying in silence; your calendar is whole on
this device throughout, the way it is whenever the link is not working.

## Interaction

|                           |                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------- |
| `⌘P`                      | Command palette — write an event, search, jump to a date, find free time, run     |
| `⌘N` / `⇧⌘N`              | New event / new task                                                              |
| `⌘,`                      | Settings                                                                          |
| `⌘Z` / `⇧⌘Z`              | Undo / redo                                                                       |
| `⌘D` / `⌘E` / `⌘Y` / `⌘L` | Day / week / year / life view. `⌘E` and not `⌘W`, which no browser will hand over |
| `⌘B`                      | Sidebar                                                                           |
| `←` `→`                   | Previous / next day (a week in the week view, a year in the year and life views)  |
| `T`                       | Today                                                                             |
| `F` / `⇧F`                | Ambient — chrome away, and with the screen as well                                |
| `⌘↵` / `⌘⌫` / `esc`       | Save / delete / cancel in the editor                                              |
| `⌘⌫`                      | Delete the event previewed by pointer or keyboard on the dial                     |
| `⌘`-drag an arc           | Duplicate it: the original stays, the copy lands where you let go                 |
| `⌘↵` on a `⌘P` event row  | Duplicate it into the editor, where you can say when                              |

`⌘` throughout means Ctrl on Windows and Linux — every shortcut here takes
either, and the app prints whichever one your keyboard actually has.

Tab to the dial's event list to browse the whole day, including events that have
already ended. Arrow keys preview an event; Home and End jump to the first and
last. Enter or Space opens its editor. Tab leaves the list.

Type a duration into `⌘P` — `45m`, `1h30`, `free 20` — and the palette lists
the gaps in the day that fit it. Picking one opens a draft already filling the
slot.

Or write the event itself: **`lunch tomorrow 1pm 45m`** is one line and one
`↵`. The parts can come in any order, a range works too (`dinner 19:00-21:30`,
`party 22:00-01:00`), and a name with a day but no time makes an all-day event,
because that is what you said. The row shows the day and the span it resolved to
before you commit it, and `⌘Z` undoes it. A word on its own stays a search —
the line has to name a day, a time or a length to become an event.

It takes the repetition too: **`morning run 8am 45m daily`**, or `every 2
weeks`, `every other friday`, `weekdays`, `every mon/wed/fri`, `monthly`,
`fortnightly`. A rule that names weekdays also moves the first one onto a day it
generates — `gym every monday` written on a Wednesday starts on the Monday,
rather than being an event its own rule skips. A bare weekday is still a date:
`party friday` is one party. The row spells the rule out beside the span.

Or say when it starts from here: **`dinner in 2h`**, `standup in 20m`, `dinner in
an hour`, `dinner now`. The word `in` is the switch — `dinner 2h` is a two-hour
dinner, `dinner in 2h` is a dinner two hours from now — and everything after it
belongs to the offset, so `in 1h 30m` is ninety minutes from now. To give a
length as well, put it in front of the name: **`45min dinner in 1h`**. An offset
lands on the quarter hour, like every other time this app picks for you, and it
rolls onto tomorrow when it crosses midnight. Name a day too and the day wins
while the clock still comes from now: `dinner tomorrow in 2h` is tomorrow, two
hours past this moment. `in` in front of anything that is not a length is just a
word — `dinner in Rome 8pm` keeps its name, and `checkup in 3 days` is still that
day.

Search is forgiving. `dsgn rev` finds "Design review", `reveiw` and `desgin`
find it too, and results are ranked rather than filtered — whole words beat
scattered letters, the start of a name beats the middle of one, and a hit in an
event's notes ranks below one in its title. It ranks the commands as well, so
`lfe vw` reaches the life view.

Drag anywhere on the ring to block out time — the readout in the middle turns
into the range you are drawing. The range follows the way your hand went rather
than the shorter way round, so a drag can run the whole revolution; take it all
the way from midnight back to midnight and the readout says **All day**, because
that is what it will make. A click on the ring, with no drag, makes an event of
the default length instead — an hour, until you say otherwise in Settings'
**New event** card, which also names the calendar a new event lands on. Both
answer for `⌘N` and for a quick-add line that gave a time and no length.

Let go and the arc stays where you drew it while you fill the event in, taking
whatever colour you pick, so you are looking at the shape of the thing while you
name it. Cancel and it goes; save and the arc that replaces it is in exactly the
same place, because it is the same arc.

The year ring takes that gesture one scale up. Drag across its rim and every day
you cross goes white while the middle prints them — **8 – 18 Aug**, eleven days
— and letting go opens an all-day event running exactly that long. The days stay
lit behind the editor and answer the swatch you pick, so you are looking at the
shape of the thing while you name it; cancel and they go back. It stops dead at
31 December rather than rolling into the next year, because the year on screen is
the year you are drawing in, and a press that never crossed a day is still just a
click on that day.

An arc already on the face is draggable too: grab its middle to move the whole
event, or either end to move that end alone. The minimum is one fifteen-minute
step, ends stop dead there, and a move that passes midnight lands on the next
day and says so. A subscription's arcs only open — somebody else's calendar is
a mirror. Click an arc, an agenda row or a mark on the year ring to open it —
a click being a press that never crossed a step, so an end held against the
minimum is still a drag however long it stays there and releasing it opens
nothing.

`Esc` abandons a drag in flight — the range, the moved arc or the run of days
goes back to where it was and nothing opens. It is the one gesture you can start
by accident, and letting go used to be the only way out of it.

Every drag moves in fifteen-minute steps and each step **clicks**: a
three-millisecond synthesised detent, plus a tap on hardware with a vibrator.
Every fourth one lands on a whole hour and lands deeper for it — the same click
on a bigger notch — so a drag can be counted by ear without watching the face.
Moving a whole event sounds lower and rounder than moving one of its ends, so
you can hear which one you grabbed. Three longer cues come out of the same
mechanism, struck two or three times instead of once — letting go of a new range
knocks and ticks as the editor arrives, saving a new event answers with the
pitches rising, and deleting one falls away hollow, with two taps rather than
one. No tones anywhere: a clean sine among these clicks sounds like a
notification from another application. Both channels switch off under
**Feedback** in Settings, and the vibration switch only appears on a device that
has a motor to offer.

The selected day and the view are in the URL (`?d=2026-08-05`, `&v=life`), so a
day is linkable and the back button works.

## Stack

Astro 7 static shell → one React 19 island → Tailwind v4. Events live in
`localStorage` under `circal.v1` and sync across tabs via the `storage` event.
Deployed as a Cloudflare Worker that serves static assets and exactly one
route: `/api/feed`, a proxy for subscriptions, because no calendar host sends
CORS headers.

```
src/
  lib/
    dial.ts      polar geometry — the 1000-unit viewBox, radii, arc paths
    life.ts      the life grid — its span, its layout, its arithmetic
    year.ts      the year ring — its angle, its marks, and the unroll's maths
    time.ts      day arithmetic, the app's formatting voice, zone conversion
    events.ts    event model, recurrence expansion, lane packing, free gaps
    sun.ts       solar position — sunrise, sunset, civil twilight
    places.ts    city → coordinates, from the IANA tz database
    ics.ts       RFC 5545 serialise and parse
    quickadd.ts  the palette's parsers — one typed line into one event
    fuzzy.ts     forgiving match and ranking, for the palette's results
    store.ts     the store (useSyncExternalStore + localStorage)
    feeds.ts     subscription pulls
    backup.ts    export and import
    notify.ts    the toast channel
  components/react/
    App.tsx          shell: which day, which view, which overlay, the URL
    Dial.tsx         the instrument
    CenterPanel.tsx  readout + agenda, pinned to the dial's centre
    LifeView.tsx     the life grid, on a canvas, and the year loupe over it
    YearView.tsx     the year ring, and both halves of its unroll
    TopBar.tsx  Sidebar.tsx  EventEditor.tsx
    CommandPalette.tsx  Settings.tsx  Toast.tsx
worker/index.ts  assets + the /api/feed proxy
public/sw.js     offline cache
tests/           1,265 cases over src/lib and the worker's guards
```

Two overlapping events are pushed onto concentric rings by `packLanes`, so
neither is hidden — that is why the afternoon reads as two arcs, not one.

## Develop

```sh
pnpm install
pnpm dev        # localhost:4321
pnpm dev:worker # build + wrangler dev — the only way to exercise /api/feed
pnpm test       # vitest, two TZ-pinned projects
pnpm verify     # format:check + lint + astro check + test + build
pnpm deploy     # build + wrangler deploy
```

The suite covers the domain layer — recurrence against the RFC 5545 worked
examples, ICS round-trips, the store's write/delete/move paths, and the
worker's SSRF guard. Not the dial: that is a visual instrument and is verified
by looking at it.

## License

[AGPL-3.0](./LICENSE). Run it, fork it, learn from it; a modified circal served
to others must publish its source. The vendored Phosphor icon paths in
`src/components/react/ui/marks.ts` remain MIT, credited there.
