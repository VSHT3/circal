/* ------------------------------------------------------------------ *
 * Travel: what a device changing zone does to the events written in the
 * old one, and the two answers a user is allowed to give about it.
 *
 * Every event the user writes is floating (`tzid: ""`): its instants are
 * epoch ms, so the moment is absolute, and what the app draws is that
 * moment on whatever clock the browser is now having. Fly Berlin → New York
 * and a 09:00 meeting is drawn at 03:00 — the same instant it always was,
 * which is why it moved. Nothing is corrupt and nothing here pretends
 * otherwise; the defect was that the app said nothing.
 *
 * So it asks, once per move, and both answers are honest:
 *
 *  - **Move them with me.** The wall clock is preserved and the instants
 *    change: 09:00 in Berlin becomes 09:00 in New York.
 *  - **Keep them as they are.** The instants are untouched and the events
 *    are stamped with the zone they were written in, so every surface can
 *    go on saying which clock those hours belong to. That is exactly what
 *    `CalEvent.tzid` is — the zone a rule is read against — and stamping it
 *    also walks a repeating event over Berlin's transitions, which is where
 *    it was written and therefore the right answer for it too.
 *
 * Three rules the arithmetic here exists for, none of them a subtraction:
 *
 *  - A timed event moves by the difference between the two zones *at its
 *    own instant*, not by today's difference. Berlin and New York are six
 *    hours apart in July and five in the fortnight their transition dates
 *    disagree, so an event in March and one in July do not move alike. The
 *    pivot is `wallClockIn`/`instantOfWall`, the pair the recurrence walk
 *    already turns on, which also settles a wall time landing in a gap or
 *    in a repeated hour the way every calendar settles it.
 *  - An **all-day** event must not shift by an offset at all: the 5th is
 *    the 5th everywhere, and five hours off a day boundary is the 4th. It
 *    is re-anchored to local midnight of its own calendar date — the same
 *    argument the dial's multi-day span makes about `addDays` rather than
 *    `n × 1440` minutes. It is re-anchored under *either* answer and
 *    stamped under neither: "keep the old times" is meaningless for a thing
 *    with no time on it, and leaving its instants alone would draw it
 *    across two days, on the second of which it is not.
 *  - A repeating event moves by moving its **seed**, and everything else
 *    keyed to an instant must travel with it — `until` bounds a start, so a
 *    series moved and handed its old bound stops on the wrong day. Its
 *    `exdates`/`rdates`/`doneKeys` deliberately do *not* move: those are
 *    local wall-clock keys, and both answers keep the wall clock intact —
 *    a move by preserving it, a stamp by naming the zone they were written
 *    against. Rewriting them would be the resurrection bug `duplicateOf`
 *    documents, arrived at from the other side.
 *
 * An event that already carries a zone is never touched by any of this: its
 * instants are anchored to a real clock and are already right wherever they
 * are read, which is the one part of zone support that has always worked.
 * ------------------------------------------------------------------ */

import type { CalEvent } from "./events";
import { placeForZone } from "./places";
import { addDays, instantOfWall, isZone, startOfDay, wallClockIn, zoneCity } from "./time";

/** The move to ask about: the zone the events were written in, and the one
 *  this browser is in now. */
export interface TravelNotice {
  from: string;
  to: string;
}

/**
 * Whether to ask, given the zone this browser last saw and the one it is in
 * now.
 *
 * Three refusals, and each of them is a screen nobody should be shown. A
 * `stored` that names no zone is a **first run** — there is no "before" to
 * compare against, and greeting somebody with a timezone question is absurd.
 * The same zone twice is not a move. And events of one's own are what the
 * question is *about*: a prompt offering to move nothing is noise, and the
 * seed calendar is not the user's work either, which is why the caller
 * counts `snapshot.events` and not what the dial happens to draw.
 */
export function travelNotice(
  stored: string,
  current: string,
  hasEvents: boolean,
): TravelNotice | null {
  if (!isZone(stored) || !isZone(current)) return null;
  if (stored === current || !hasEvents) return null;
  return { from: stored, to: current };
}

/**
 * The city a zone is read as, never the IANA name. `placeForZone`'s table is
 * what says a zone is a *place* at all; the handful that are not (`UTC`, the
 * `Etc/GMT±n` family) have no city to name and read as themselves, which is
 * still the string somebody would recognise rather than a path.
 */
export function placeName(zone: string): string {
  if (!zone) return "";
  const place = placeForZone(zone);
  return zoneCity(place ? place.zone : zone);
}

/**
 * Where an instant lands when its wall clock is carried from one zone to the
 * other — the whole of the shift, and the reason it is not a subtraction.
 */
export function movedInstant(at: number, from: string, to: string): number {
  return instantOfWall(wallClockIn(at, from), to);
}

/** How far that carries it, in milliseconds. Signed, and a function of the
 *  instant: the two zones are not the same distance apart all year. */
export function travelShift(at: number, from: string, to: string): number {
  return movedInstant(at, from, to) - at;
}

/** A bound is an instant too, and `0` is "unbounded" rather than 1970. */
function movedUntil(until: number, from: string, to: string): number {
  return until > 0 ? movedInstant(until, from, to) : 0;
}

/**
 * An all-day event put back on the days it names, in the new zone. Its
 * instants are day boundaries, so they are rebuilt from the *dates* the old
 * zone was showing rather than shifted: `end` is exclusive, hence the last
 * day is read from `end - 1` and the boundary is `addDays(…, 1)` of it — a
 * day is not always 1440 minutes long.
 *
 * The unchanged case returns the same object, as every function here does:
 * two zones can be a different place and the same clock (Berlin and Paris),
 * so "did this event move" is a question about instants and never about the
 * names, and the notice's count has to be able to say nothing happened.
 */
function reanchored(event: CalEvent, from: string, to: string): CalEvent {
  const start = instantOfWall(startOfDay(wallClockIn(event.start, from)), to);
  const until = movedUntil(event.until, from, to);
  // A task is a moment, not a span: `end === start`, and there is no last day
  // to name.
  const end =
    event.end <= event.start
      ? start
      : instantOfWall(addDays(startOfDay(wallClockIn(event.end - 1, from)), 1), to);
  const still = start === event.start && end === event.end && until === event.until;
  return still ? event : { ...event, start, end, until };
}

/** One event, moved so its wall clock survives the journey. */
export function movedEvent(event: CalEvent, from: string, to: string): CalEvent {
  if (event.tzid) return event;
  if (event.allDay) return reanchored(event, from, to);
  const shift = travelShift(event.start, from, to);
  // Its own instant, not the seed's: a bound six months down the year is a
  // different distance from the same event's first morning.
  const until = movedUntil(event.until, from, to);
  if (shift === 0 && until === event.until) return event;
  return { ...event, start: event.start + shift, end: event.end + shift, until };
}

/** One event left where it is, saying which clock it was written on. */
export function keptEvent(event: CalEvent, from: string, to: string): CalEvent {
  if (event.tzid) return event;
  if (event.allDay) return reanchored(event, from, to);
  return { ...event, tzid: from };
}

/** Every floating event moved with the traveller. */
export function movedEvents(events: CalEvent[], from: string, to: string): CalEvent[] {
  return events.map((event) => movedEvent(event, from, to));
}

/** Every floating event stamped with the zone it was written in. */
export function keptEvents(events: CalEvent[], from: string, to: string): CalEvent[] {
  return events.map((event) => keptEvent(event, from, to));
}

/**
 * Which of these events this feature stamped, scoped to the zones the app
 * recorded stamping — never "every event with a zone on it".
 *
 * A non-empty `tzid` has a second writer: `ics.ts`'s DTSTART reader, and an
 * imported `.ics` lands its events in the same `snapshot.events` this walks,
 * carrying zones that came out of the file. A colleague's weekly 09:00 New
 * York standup is exactly that, and flattening it to floating would walk its
 * rule against the reader's own wall clock — the defect `startsBetweenIn`
 * exists to prevent, reintroduced by a settings row.
 *
 * Not perfect, and the residue is named rather than papered over: an imported
 * event that genuinely names one of those same cities is indistinguishable
 * from a stamped one and is caught with them. Telling the two apart needs a
 * provenance field on every event, recording which of two writers set its
 * zone — a permanent addition to the model to serve one settings row, against
 * a residue that is narrow and one undo step wide. The row's caption says so
 * rather than claiming precision this does not have.
 */
function stampedBy(event: CalEvent, stamped: readonly string[]): boolean {
  return event.tzid !== "" && stamped.includes(event.tzid);
}

/**
 * The stamp taken back off. A decision made in one click at an airport has to
 * be revisable, and there is no per-event zone picker to revise it in — so
 * the settings panel offers this instead, over the whole list at once.
 */
export function clearedStamps(events: CalEvent[], stamped: readonly string[]): CalEvent[] {
  return events.map((event) => (stampedBy(event, stamped) ? { ...event, tzid: "" } : event));
}

/** How many carry one — the number the settings row prints, and what tells it
 *  whether there is anything to offer clearing at all. */
export function countStamped(events: CalEvent[], stamped: readonly string[]): number {
  return events.reduce((n, event) => (stampedBy(event, stamped) ? n + 1 : n), 0);
}

/** The places those stamps name, in the order they are read, so the row can
 *  say what is about to happen rather than printing a bare number. */
export function stampedPlaces(events: CalEvent[], stamped: readonly string[]): string[] {
  const places: string[] = [];
  for (const event of events) {
    if (!stampedBy(event, stamped)) continue;
    const place = placeName(event.tzid);
    if (!places.includes(place)) places.push(place);
  }
  return places;
}
