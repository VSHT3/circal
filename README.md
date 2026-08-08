# circal

A calendar whose day is a circle.

A day is one revolution. Events are arcs, the day so far is a ramp of light
around the rim, and the hand is the current minute. A web recreation of
[Radical](https://www.raycast.com) for the browser.

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

Events take their colour from their calendar. Any one event can override that
from the editor's **Color** row: ten digital pastels, or a picker for anything
else.

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
carries it: the interior and the sidebar print `DAY 3/5` where they would
otherwise print a start time, because on the third morning of a five-day trip
the hour it began is not what you came to read.

A timed span draws a closed circle on the days in its middle — those days are
entirely inside the event, and a whole revolution is what the face has to say
about that. The **All-day** switch changes whether the two ends carry times,
never how many days there are.

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
because nobody reads "nineteen hours free" as an offer. The nine-cell picker
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

## The year, on one revolution

`⌘Y` is the same instrument asked a bigger question. One revolution is one
year, clockwise from 1 January at the top, and every day of it gets one mark
on the rim — a stub when there is nothing on it, growing outwards with what
there is, in the colour of the first thing there. A busy autumn is a bright
ragged stretch and an empty spring is a dotted line, so the shape of a year is
something you read rather than count. Months are named outside the ring, today
is a pip just inside it, and the day you came in on is a white mark.

The middle prints the year until you point at a day, and then prints that day
— its date, and what is on it. Click a mark to open that day on the dial.

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
far off it is and what is on it; click one to open that day on the dial.

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

## Your data

Events live in this browser's `localStorage` under `circal.v1`. Nothing is
sent anywhere, which also means nothing is backed up anywhere:

- **Export `.ics`** hands your events to any other calendar.
- **Backup `.json`** is the whole store — events, calendars, settings — and
  restores exactly. Both live in Settings and in `⌘P`.
- **Import** takes either. A `.ics` lands in a calendar of its own so an
  import can always be told apart from what you wrote; a `.json` restores the
  store. Both are one `⌘Z` away from being undone.

**Subscriptions** mirror a public ICS URL — a Google, Apple or Fastmail
"secret address" — as a read-only calendar, pulled on launch and on demand.
Their events draw on the dial and open in the editor, but every field is
locked: it is somebody else's calendar.

Install it (Add to Home Screen, or the browser's install button) and it works
offline. On iOS that is also what stops the seven-day storage eviction from
taking your calendar with it.

## Interaction

|                     |                                                                               |
| ------------------- | ----------------------------------------------------------------------------- |
| `⌘P`                | Command palette — write an event, search, jump to a date, find free time, run |
| `⌘N`                | New event                                                                     |
| `⌘,`                | Settings                                                                      |
| `⌘Z` / `⇧⌘Z`        | Undo / redo                                                                   |
| `⌘D` / `⌘Y` / `⌘L`  | Day view / year view / life view                                              |
| `⌘B`                | Sidebar                                                                       |
| `←` `→`             | Previous / next day (year in the year and life views)                         |
| `T`                 | Today                                                                         |
| `F` / `⇧F`          | Ambient — chrome away, and with the screen as well                            |
| `⌘↵` / `⌘⌫` / `esc` | Save / delete / cancel in the editor                                          |

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
into the range you are drawing. A click on the ring creates an hour instead.
The range follows the way your hand went rather than the shorter way round, so
a drag can run the whole revolution; take it all the way from midnight back to
midnight and the readout says **All day**, because that is what it will make.

An arc already on the face is draggable too: grab its middle to move the whole
event, or either end to move that end alone. The minimum is one fifteen-minute
step, ends stop dead there, and a move that passes midnight lands on the next
day and says so. A subscription's arcs only open — somebody else's calendar is
a mirror. Click an arc, an agenda row or a mark on the year ring to open it —
a click being a press that never crossed a step, so an end held against the
minimum is still a drag however long it stays there and releasing it opens
nothing.

`Esc` abandons a drag in flight — the range or the moved arc goes back to where
it was and nothing opens. It is the one gesture you can start by accident, and
letting go used to be the only way out of it.

Every drag moves in fifteen-minute steps and each step **clicks**: a
three-millisecond synthesised detent, plus a tap on hardware with a vibrator.
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
    LifeView.tsx     the life grid, on a canvas
    YearView.tsx     the year ring, and both halves of its unroll
    TopBar.tsx  Sidebar.tsx  EventEditor.tsx
    CommandPalette.tsx  Settings.tsx  Toast.tsx
worker/index.ts  assets + the /api/feed proxy
public/sw.js     offline cache
tests/           907 cases over src/lib and the worker's guards
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
