# circal

A calendar whose day is a circle.

A day is one revolution. Events are arcs, the day so far is a ramp of light
around the rim, and the hand is the current minute. A web recreation of
[Radical](https://www.raycast.com) for the browser.

The sidebar's **Dial** setting picks how the face names its hours:

- **12 h** — noon at the top, midnight at the bottom, `12 · 1…11` twice with
  AM/PM captions. 6 AM sits at nine o'clock, 6 PM at three.
- **24 h** — midnight at the top, `00 · 1…23` running clockwise, so `06` is at
  three o'clock, `12` at the bottom and `18` at nine.

Same geometry either way: an event's arc is the same length on both faces, and
switching is a 180° rotation and a relabel. The setting also picks how every
time in the app is written — `1:15 PM` or `13:15`.

Events take their colour from their calendar. Any one event can override that
from the editor's **Color** row: ten digital pastels, or a picker for anything
else.

![the day view](docs/day.png)

## Interaction

|                     |                                                               |
| ------------------- | ------------------------------------------------------------- |
| `⌘K`                | Command palette — search events, jump to a date, run anything |
| `⌘N`                | New event                                                     |
| `⌘D` / `⌘Y`         | Day view / year view                                          |
| `⌘B`                | Sidebar                                                       |
| `←` `→`             | Previous / next day (year in year view)                       |
| `T`                 | Today                                                         |
| `⌘↵` / `⌘⌫` / `esc` | Save / delete / cancel in the editor                          |

Drag anywhere on the ring to block out time — the readout in the middle turns
into the range you are drawing. A click on the ring creates an hour. Click an
arc, an agenda row or a day in the year grid to open it.

## Stack

Astro 7 static shell → one React 19 island → Tailwind v4. No backend: events
live in `localStorage` under `circal.v1` and sync across tabs via the `storage`
event. Deployed as an assets-only Cloudflare Worker.

```
src/
  lib/
    dial.ts      polar geometry — the 1000-unit viewBox, radii, arc paths
    time.ts      day arithmetic and the app's formatting voice
    events.ts    event model, recurrence expansion, lane packing
    store.ts     the store (useSyncExternalStore + localStorage)
  components/react/
    App.tsx          shell: which day, which view, which overlay
    Dial.tsx         the instrument
    CenterPanel.tsx  readout + agenda, pinned to the dial's centre
    TopBar.tsx  Sidebar.tsx  EventEditor.tsx  YearView.tsx  CommandPalette.tsx
```

Two overlapping events are pushed onto concentric rings by `packLanes`, so
neither is hidden — that is why the afternoon reads as two arcs, not one.

## Develop

```sh
pnpm install
pnpm dev        # localhost:4321
pnpm verify     # format:check + lint + astro check + build
pnpm deploy     # build + wrangler deploy
```
