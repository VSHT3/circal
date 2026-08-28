import { describe, expect, it } from "vitest";
import { event, ms } from "./helpers";
import {
  clearedStamps,
  countStamped,
  keptEvent,
  keptEvents,
  movedEvent,
  movedEvents,
  movedInstant,
  placeName,
  stampedPlaces,
  travelNotice,
  travelShift,
} from "@/lib/travel";
import { dayKey, minutesOfDay, wallClockIn, zonedToUtc } from "@/lib/time";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const HOUR = 3_600_000;

/** The wall clock a moved instant lands on in the zone it was moved into —
 *  which is the whole claim these functions make, and the only form of it
 *  that reads the same from either test project. */
function wall(at: number, zone: string): string {
  const local = wallClockIn(at, zone);
  return `${dayKey(local)} ${String(local.getHours()).padStart(2, "0")}:${String(
    local.getMinutes(),
  ).padStart(2, "0")}`;
}

describe("travelNotice — when there is a question worth asking", () => {
  it("says nothing on a first run: an empty stored zone has no 'before' to compare against", () => {
    expect(travelNotice("", NEW_YORK, true)).toBeNull();
  });

  it("says nothing when the device has not moved", () => {
    expect(travelNotice(BERLIN, BERLIN, true)).toBeNull();
  });

  it("says nothing when the user has no events of their own — a prompt about moving nothing", () => {
    expect(travelNotice(BERLIN, NEW_YORK, false)).toBeNull();
  });

  it("says nothing for a stored zone `Intl` cannot resolve", () => {
    expect(travelNotice("Mars/Olympus_Mons", NEW_YORK, true)).toBeNull();
  });

  it("asks, naming both ends, when a browser with events has moved", () => {
    expect(travelNotice(BERLIN, NEW_YORK, true)).toEqual({ from: BERLIN, to: NEW_YORK });
  });
});

describe("placeName — cities, never IANA identifiers", () => {
  it.each([
    { name: "Europe/Berlin", zone: BERLIN, expected: "Berlin" },
    { name: "America/New_York", zone: NEW_YORK, expected: "New York" },
    { name: "a three-part name", zone: "America/Argentina/Ushuaia", expected: "Ushuaia" },
    // Not a place, so there is no city to name and it reads as itself rather
    // than as a path.
    { name: "UTC", zone: "UTC", expected: "UTC" },
    { name: "no zone at all", zone: "", expected: "" },
  ])("$name → $expected", ({ zone, expected }) => {
    expect.soft(placeName(zone)).toBe(expected);
  });
});

describe("travelShift — the two zones are not the same distance apart all year", () => {
  it("is six hours in July, when both zones are on summer time", () => {
    expect(travelShift(ms("2026-07-15 09:00"), BERLIN, NEW_YORK)).toBe(6 * HOUR);
  });

  it("is five in the fortnight the two zones' transition dates disagree", () => {
    // The US springs forward on 8 March 2026 and the EU on 29 March, so for
    // three weeks the gap is an hour narrower. A single shift measured today
    // and applied to the whole calendar is wrong for every event in here.
    expect(travelShift(ms("2026-03-15 09:00"), BERLIN, NEW_YORK)).toBe(5 * HOUR);
  });

  it("carries the wall clock, which is the definition the shift is derived from", () => {
    expect
      .soft(wall(movedInstant(ms("2026-03-15 09:00"), BERLIN, NEW_YORK), NEW_YORK))
      .toBe("2026-03-15 09:00");
    expect
      .soft(wall(movedInstant(ms("2026-07-15 09:00"), BERLIN, NEW_YORK), NEW_YORK))
      .toBe("2026-07-15 09:00");
  });
});

describe("movedEvent — a timed event keeps its hours and changes its instants", () => {
  it("moves both ends by the same shift, so the duration is untouched", () => {
    const moved = movedEvent(
      event({ start: "2026-07-15 09:00", end: "2026-07-15 10:30" }),
      BERLIN,
      NEW_YORK,
    );
    expect.soft(wall(moved.start, NEW_YORK)).toBe("2026-07-15 09:00");
    expect.soft(moved.end - moved.start).toBe(90 * 60_000);
  });

  it("leaves an event that already carries a zone completely alone, object identity included", () => {
    // A feed's event, or one imported from an .ics: its instants are anchored
    // to a real clock and are already right wherever they are read.
    const zoned = event({ start: "2026-07-15 09:00", tzid: "America/Chicago" });
    expect(movedEvent(zoned, BERLIN, NEW_YORK)).toBe(zoned);
  });

  it("moves `until` by the shift at its own instant, not by the seed's", () => {
    // Seeded in the three-week window (five hours) and bounded in July (six),
    // so a single shift applied to both would land the bound an hour out and
    // could drop or gain a final occurrence.
    const series = movedEvent(
      event({
        start: "2026-03-15 09:00",
        end: "2026-03-15 10:00",
        repeat: "weekly",
        until: ms("2026-07-15 09:00"),
      }),
      BERLIN,
      NEW_YORK,
    );
    expect.soft(series.start - ms("2026-03-15 09:00")).toBe(5 * HOUR);
    expect.soft(series.until - ms("2026-07-15 09:00")).toBe(6 * HOUR);
    expect.soft(wall(series.until, NEW_YORK)).toBe("2026-07-15 09:00");
  });

  it("leaves an unbounded series unbounded rather than moving 1970", () => {
    expect(movedEvent(event({ repeat: "weekly" }), BERLIN, NEW_YORK).until).toBe(0);
  });

  it("leaves the exclusion and extra-date keys alone: they are wall keys, and the wall clock is what survives", () => {
    const series = event({
      start: "2026-07-15 09:00",
      repeat: "weekly",
      exdates: ["2026-07-22T09:00:00", "2026-07-29"],
      rdates: ["2026-08-05T11:00:00"],
    });
    const moved = movedEvent(series, BERLIN, NEW_YORK);
    expect.soft(moved.exdates).toEqual(series.exdates);
    expect.soft(moved.rdates).toEqual(series.rdates);
  });

  it("returns the same object when two zones are a different place and the same clock", () => {
    const paris = event({ start: "2026-07-15 09:00" });
    expect(movedEvent(paris, BERLIN, "Europe/Paris")).toBe(paris);
  });
});

describe("movedEvent — an all-day event is re-anchored, never shifted", () => {
  it("stays on the same date, at midnight, rather than five hours off it", () => {
    // The bug this exists for: an offset applied to a day boundary puts the
    // 5th on the 4th, in the small hours.
    const moved = movedEvent(
      event({ start: "2026-10-05 00:00", end: "2026-10-06 00:00", allDay: true }),
      BERLIN,
      NEW_YORK,
    );
    expect.soft(wall(moved.start, NEW_YORK)).toBe("2026-10-05 00:00");
    expect.soft(minutesOfDay(wallClockIn(moved.start, NEW_YORK))).toBe(0);
    // `end` is exclusive, so the last day covered is read from `end - 1`.
    expect.soft(dayKey(wallClockIn(moved.end - 1, NEW_YORK))).toBe("2026-10-05");
  });

  it("keeps every day of a multi-day span, across a transition in the zone it lands in", () => {
    // 24–26 October inclusive; Berlin's clocks go back on the 25th, so the
    // span is 73 hours long there and 72 in New York. A span rebuilt from
    // `n × 1440` minutes loses the last evening either way.
    const span = event({ start: "2026-10-24 00:00", end: "2026-10-27 00:00", allDay: true });
    const west = movedEvent(span, BERLIN, NEW_YORK);
    expect.soft(wall(west.start, NEW_YORK)).toBe("2026-10-24 00:00");
    expect.soft(dayKey(wallClockIn(west.end - 1, NEW_YORK))).toBe("2026-10-26");
    expect.soft(west.end - west.start).toBe(72 * HOUR);

    // Written the other way round: the same three days, but stored as New
    // York's own midnights, which is what an event written there looks like.
    const east = movedEvent(
      event({
        start: zonedToUtc(2026, 10, 24, 0, 0, NEW_YORK),
        end: zonedToUtc(2026, 10, 27, 0, 0, NEW_YORK),
        allDay: true,
      }),
      NEW_YORK,
      BERLIN,
    );
    expect.soft(wall(east.start, BERLIN)).toBe("2026-10-24 00:00");
    expect.soft(dayKey(wallClockIn(east.end - 1, BERLIN))).toBe("2026-10-26");
    expect.soft(east.end - east.start).toBe(73 * HOUR);
  });

  it("keeps an all-day task a single instant rather than growing it a day", () => {
    const task = event({ start: "2026-10-05 00:00", end: "2026-10-05 00:00", allDay: true });
    const moved = movedEvent(task, BERLIN, NEW_YORK);
    expect(moved.end).toBe(moved.start);
  });
});

describe("keptEvent — the instants stand and the clock is named", () => {
  it("stamps a floating timed event with the zone it was written in, touching no instant", () => {
    const original = event({ start: "2026-07-15 09:00", end: "2026-07-15 10:00" });
    const kept = keptEvent(original, BERLIN, NEW_YORK);
    expect.soft(kept.start).toBe(original.start);
    expect.soft(kept.end).toBe(original.end);
    expect.soft(kept.tzid).toBe(BERLIN);
  });

  it("leaves an event that already names a zone alone: its zone is not this journey's to overwrite", () => {
    const zoned = event({ tzid: "America/Chicago" });
    expect(keptEvent(zoned, BERLIN, NEW_YORK)).toBe(zoned);
  });

  it("re-anchors an all-day event instead of stamping it — a date has no clock to keep", () => {
    // The rule `fromIcs` already keeps: an all-day event is never zoned,
    // because its date is the one the calendar printed. Left at the old
    // zone's midnight it would straddle two days here, and be drawn on the
    // second of them.
    const kept = keptEvent(
      event({ start: "2026-10-05 00:00", end: "2026-10-06 00:00", allDay: true }),
      BERLIN,
      NEW_YORK,
    );
    expect.soft(kept.tzid).toBe("");
    expect.soft(wall(kept.start, NEW_YORK)).toBe("2026-10-05 00:00");
    expect.soft(dayKey(wallClockIn(kept.end - 1, NEW_YORK))).toBe("2026-10-05");
  });
});

describe("the lists, and the way back", () => {
  it("moves and stamps every floating event and no other", () => {
    const events = [
      event({ start: "2026-07-15 09:00" }),
      event({ start: "2026-07-15 12:00", tzid: "America/Chicago" }),
    ];
    const moved = movedEvents(events, BERLIN, NEW_YORK);
    expect.soft(moved[0].start - events[0].start).toBe(6 * HOUR);
    expect.soft(moved[1]).toBe(events[1]);

    const kept = keptEvents(events, BERLIN, NEW_YORK);
    expect.soft(kept[0].tzid).toBe(BERLIN);
    expect.soft(kept[1]).toBe(events[1]);
  });

  it("counts, names and clears only the stamps the app recorded applying", () => {
    const floating = event({ title: "Mine" });
    // The one this had to be scoped for: a colleague's weekly 09:00 New York
    // standup, imported from an .ics, whose zone came out of the file. Flatten
    // it and its rule is walked against the reader's own wall clock, which is
    // the defect `startsBetweenIn` exists to prevent.
    const imported = event({ title: "Standup", tzid: NEW_YORK, repeat: "weekly" });
    const events = [event({ tzid: BERLIN }), floating, imported];

    expect.soft(countStamped(events, [BERLIN])).toBe(1);
    expect.soft(stampedPlaces(events, [BERLIN])).toEqual(["Berlin"]);

    const cleared = clearedStamps(events, [BERLIN]);
    expect.soft(cleared[0].tzid).toBe("");
    // Untouched events are the same objects, imported one included.
    expect.soft(cleared[1]).toBe(floating);
    expect.soft(cleared[2]).toBe(imported);
    expect.soft(countStamped(cleared, [BERLIN])).toBe(0);
  });

  it("counts nothing, and clears nothing, when no zone was recorded", () => {
    // Every browser that answered "move", and every one that never travelled:
    // an event may still carry a zone, and none of it is this row's.
    const events = [event({ tzid: NEW_YORK }), event({ tzid: BERLIN })];
    expect.soft(countStamped(events, [])).toBe(0);
    expect.soft(stampedPlaces(events, [])).toEqual([]);
    expect.soft(clearedStamps(events, [])).toEqual(events);
  });

  it("names both places when two journeys were kept in a row", () => {
    const events = [event({ tzid: BERLIN }), event({ tzid: NEW_YORK }), event()];
    expect.soft(countStamped(events, [BERLIN, NEW_YORK])).toBe(2);
    expect.soft(stampedPlaces(events, [BERLIN, NEW_YORK])).toEqual(["Berlin", "New York"]);
  });
});
