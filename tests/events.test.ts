import { describe, expect, it } from "vitest";
import { at, attendee, calendar, day, event, ms } from "./helpers";
import {
  ATTENDEE_MAX,
  GRAVE_MAX,
  readGraves,
  readStamp,
  GUEST_ADDRESS_MAX,
  GUEST_NAME_MAX,
  ICON_MAX,
  ICON_NAME_MAX,
  REMIND_INHERIT,
  REMIND_LEAD_MAX,
  REMIND_SILENT,
  PALETTE,
  DEFAULT_WAKING,
  clashesWith,
  colorOf,
  dayAgenda,
  dayLoad,
  firstGrapheme,
  freeGaps,
  instantKey,
  joinLink,
  inkOn,
  isIconName,
  markOf,
  ownLead,
  readGuests,
  readMark,
  readPartstat,
  readPerson,
  readRemindLead,
  occurrencesOn,
  scoreEvent,
  spanLabel,
  statusOf,
  type Gap,
} from "@/lib/events";
import { MINUTES_PER_DAY, zonedToUtc } from "@/lib/time";

const cal = calendar();

/* ------------------------------- occurrences ------------------------------ */

describe("occurrencesOn: clipping to the day", () => {
  const rows = [
    {
      name: "fully inside the day",
      start: "2026-03-08 09:00",
      end: "2026-03-08 10:30",
      allDay: false,
      startMin: 540,
      endMin: 630,
      continuesBefore: false,
      continuesAfter: false,
    },
    {
      name: "starts before midnight, ends during the day",
      start: "2026-03-07 22:00",
      end: "2026-03-08 03:00",
      allDay: false,
      startMin: 0,
      endMin: 180,
      continuesBefore: true,
      continuesAfter: false,
    },
    {
      name: "starts during the day, runs past midnight",
      start: "2026-03-08 23:00",
      end: "2026-03-09 02:00",
      allDay: false,
      startMin: 1380,
      endMin: 1440,
      continuesBefore: false,
      continuesAfter: true,
    },
    {
      name: "spans the whole day from both directions",
      start: "2026-03-07 20:00",
      end: "2026-03-09 04:00",
      allDay: false,
      startMin: 0,
      endMin: 1440,
      continuesBefore: true,
      continuesAfter: true,
    },
    {
      name: "an all-day event covering exactly this day",
      start: day("2026-03-08").getTime(),
      end: day("2026-03-09").getTime(),
      allDay: true,
      startMin: 0,
      endMin: 1440,
      continuesBefore: false,
      continuesAfter: false,
    },
  ] as const;

  it.each(rows)(
    "$name",
    ({ start, end, allDay, startMin, endMin, continuesBefore, continuesAfter }) => {
      const e = event({ start, end, allDay });
      const [occ] = occurrencesOn([e], [cal], day("2026-03-08"));
      expect.soft(occ).toBeDefined();
      expect.soft(occ?.startMin).toBe(startMin);
      expect.soft(occ?.endMin).toBe(endMin);
      expect.soft(occ?.continuesBefore).toBe(continuesBefore);
      expect.soft(occ?.continuesAfter).toBe(continuesAfter);
      // The dial can only draw within one revolution.
      expect.soft(occ?.startMin).toBeGreaterThanOrEqual(0);
      expect.soft(occ?.startMin).toBeLessThanOrEqual(1440);
      expect.soft(occ?.endMin).toBeGreaterThanOrEqual(0);
      expect.soft(occ?.endMin).toBeLessThanOrEqual(1440);
    },
  );
});

describe("occurrencesOn: the exclusive end at midnight", () => {
  // Regression for the commit that made a midnight-ending occurrence end at
  // 1440 on the day it started rather than 0 on the day after.
  const e = event({ start: "2026-03-08 22:00", end: "2026-03-09 00:00" });

  it("ends the day it started at 1440, not the next day at 0", () => {
    const [occ] = occurrencesOn([e], [cal], day("2026-03-08"));
    expect(occ?.endMin).toBe(1440);
    expect(occ?.continuesAfter).toBe(false);
  });

  it("does not also appear on the day it would naively roll onto", () => {
    expect(occurrencesOn([e], [cal], day("2026-03-09"))).toHaveLength(0);
  });
});

describe("occurrencesOn: an event longer than a day", () => {
  // The bug this covers: the query looked back exactly one day for a start, so
  // anything longer than about forty-eight hours existed on its first two days
  // and then vanished. Every multi-day holiday a subscription delivers is this
  // shape, and `lifeDensity` was already colouring the days the dial denied.
  const holiday = event({
    id: "kyoto",
    start: "2026-03-05",
    end: "2026-03-10",
    allDay: true,
  });

  it.each([
    { stamp: "2026-03-04", present: false },
    { stamp: "2026-03-05", present: true },
    { stamp: "2026-03-06", present: true },
    { stamp: "2026-03-07", present: true },
    { stamp: "2026-03-08", present: true },
    { stamp: "2026-03-09", present: true },
    { stamp: "2026-03-10", present: false },
  ])("$stamp: $present", ({ stamp, present }) => {
    expect(occurrencesOn([holiday], [cal], day(stamp))).toHaveLength(present ? 1 : 0);
  });

  it("numbers each day inside the span", () => {
    const seen = ["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"].map(
      (stamp) => occurrencesOn([holiday], [cal], day(stamp))[0],
    );
    expect(seen.map((occ) => occ?.dayIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.map((occ) => occ?.dayCount)).toEqual([5, 5, 5, 5, 5]);
  });

  it("fills a middle day from midnight to midnight, continuing both ways", () => {
    const [occ] = occurrencesOn([holiday], [cal], day("2026-03-07"));
    expect.soft(occ?.startMin).toBe(0);
    expect.soft(occ?.endMin).toBe(1440);
    expect.soft(occ?.continuesBefore).toBe(true);
    expect.soft(occ?.continuesAfter).toBe(true);
  });

  it("clips a timed span to each of the four days it touches", () => {
    // Friday evening to Monday morning: the two ends are partial days and the
    // two in between are whole revolutions.
    const trip = event({ start: "2026-03-06 18:00", end: "2026-03-09 09:00" });
    const spans = ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"].map((stamp) => {
      const [occ] = occurrencesOn([trip], [cal], day(stamp));
      return [occ?.startMin, occ?.endMin, occ?.dayIndex, occ?.dayCount];
    });
    expect(spans).toEqual([
      [1080, 1440, 1, 4],
      [0, 1440, 2, 4],
      [0, 1440, 3, 4],
      [0, 540, 4, 4],
    ]);
  });

  it("finds the middle of a later instance of a repeating multi-day event", () => {
    // The lookback is the recurrence window too, so a rule whose instances are
    // longer than a day has to be expanded from far enough back.
    const shift = event({
      start: "2026-03-02 20:00",
      end: "2026-03-05 06:00",
      repeat: "weekly",
    });
    // Third instance starts Monday the 16th and runs to Thursday the 19th, so
    // both of these days are well past the old one-day window.
    const [middle] = occurrencesOn([shift], [cal], day("2026-03-18"));
    expect.soft(middle?.dayIndex).toBe(3);
    expect.soft(middle?.dayCount).toBe(4);
    expect.soft(middle?.endMin).toBe(1440);

    const [tail] = occurrencesOn([shift], [cal], day("2026-03-19"));
    expect.soft(tail?.dayIndex).toBe(4);
    expect.soft(tail?.endMin).toBe(360);
  });

  it("says 1 of 1 for anything inside a single day", () => {
    const [occ] = occurrencesOn(
      [event({ start: "2026-03-08 09:00", end: "2026-03-08 10:30" })],
      [cal],
      day("2026-03-08"),
    );
    expect(occ?.dayIndex).toBe(1);
    expect(occ?.dayCount).toBe(1);
  });

  it("says 1 of 1 for an event ending exactly at the next midnight", () => {
    // `end` is exclusive: an all-day event covers one day, not two.
    const [occ] = occurrencesOn(
      [event({ start: "2026-03-08", end: "2026-03-09", allDay: true })],
      [cal],
      day("2026-03-08"),
    );
    expect(occ?.dayIndex).toBe(1);
    expect(occ?.dayCount).toBe(1);
  });
});

describe("occurrencesOn: hidden calendars", () => {
  it("excludes events on a calendar marked invisible", () => {
    const hidden = calendar({ visible: false });
    const e = event({ calendarId: hidden.id, start: "2026-03-08 09:00" });
    expect(occurrencesOn([e], [hidden], day("2026-03-08"))).toHaveLength(0);
  });

  it("shows events whose calendar is absent from the list entirely", () => {
    // Only a calendar explicitly marked `visible: false` is hidden — one that
    // simply isn't in the array is not the same thing as one that opted out.
    const e = event({ calendarId: "cal-ghost", start: "2026-03-08 09:00" });
    expect(occurrencesOn([e], [cal], day("2026-03-08"))).toHaveLength(1);
  });
});

describe("occurrencesOn: recurrence expansion", () => {
  describe("a weekly MO/WE/FR rule", () => {
    const e = event({
      start: "2026-03-02 09:00",
      end: "2026-03-02 09:30",
      repeat: "weekly",
      byDay: [
        { day: 1, nth: 0 },
        { day: 3, nth: 0 },
        { day: 5, nth: 0 },
      ],
    });

    it.each([
      { stamp: "2026-03-02", weekday: "Mon", expected: true },
      { stamp: "2026-03-03", weekday: "Tue", expected: false },
      { stamp: "2026-03-04", weekday: "Wed", expected: true },
      { stamp: "2026-03-06", weekday: "Fri", expected: true },
      { stamp: "2026-03-08", weekday: "Sun", expected: false },
    ])("lands on $weekday: $expected", ({ stamp, expected }) => {
      expect(occurrencesOn([e], [cal], day(stamp))).toHaveLength(expected ? 1 : 0);
    });
  });

  describe("a monthly BYMONTHDAY=31 rule crossing a short month", () => {
    const e = event({
      start: "2026-01-31 10:00",
      end: "2026-01-31 10:30",
      repeat: "monthly",
      byMonthDay: [31],
    });

    it.each([
      { stamp: "2026-01-31", name: "the seed month, which has a 31st", expected: true },
      { stamp: "2026-02-28", name: "February, which never has a 31st", expected: false },
      { stamp: "2026-03-31", name: "March, the next month that has one", expected: true },
    ])("$name", ({ stamp, expected }) => {
      expect(occurrencesOn([e], [cal], day(stamp))).toHaveLength(expected ? 1 : 0);
    });
  });
});

describe("occurrencesOn: RECURRENCE-ID overrides", () => {
  const parent = event({
    id: "series",
    title: "Standup",
    start: "2026-03-02 09:00",
    end: "2026-03-02 09:30",
    repeat: "weekly",
    byDay: [{ day: 1, nth: 0 }],
  });

  it("the parent renders normally on a non-overridden Monday", () => {
    const occs = occurrencesOn([parent], [cal], day("2026-03-09"));
    expect(occs).toHaveLength(1);
    expect(occs[0]?.event.id).toBe("series");
    expect(occs[0]?.start).toBeSameInstantAs("2026-03-09 09:00");
  });

  it("an override on the same day suppresses the parent, so the meeting renders once", () => {
    const override = event({
      id: "series-moved",
      title: "Standup (moved later)",
      seriesId: "series",
      seriesKey: instantKey(at("2026-03-16 09:00")),
      start: "2026-03-16 14:00",
      end: "2026-03-16 14:30",
    });
    const occs = occurrencesOn([parent, override], [cal], day("2026-03-16"));
    expect(occs).toHaveLength(1);
    expect(occs[0]?.event.id).toBe("series-moved");
    expect(occs[0]?.start).toBeSameInstantAs("2026-03-16 14:00");
  });

  it("an override moved to a different day vacates the original day and lands on the new one", () => {
    const override = event({
      id: "series-relocated",
      title: "Standup (moved to Wednesday)",
      seriesId: "series",
      seriesKey: instantKey(at("2026-03-23 09:00")),
      start: "2026-03-25 11:00",
      end: "2026-03-25 11:30",
    });
    const events = [parent, override];
    expect(occurrencesOn(events, [cal], day("2026-03-23"))).toHaveLength(0);
    const onNewDay = occurrencesOn(events, [cal], day("2026-03-25"));
    expect(onNewDay).toHaveLength(1);
    expect(onNewDay[0]?.event.id).toBe("series-relocated");
  });
});

describe("occurrencesOn: Occurrence.key", () => {
  const e = event({
    id: "standup",
    start: "2026-03-08 09:00",
    end: "2026-03-08 09:15",
    repeat: "daily",
    byHour: [9, 13, 17],
  });
  const occs = occurrencesOn([e], [cal], day("2026-03-08"));

  it("produces one occurrence per BYHOUR entry, all on the same day", () => {
    expect(occs.map((o) => o.start)).toBeInstants([
      "2026-03-08 09:00",
      "2026-03-08 13:00",
      "2026-03-08 17:00",
    ]);
  });

  it("gives each same-day occurrence a distinct key keyed by its start instant, not the day", () => {
    expect(new Set(occs.map((o) => o.key)).size).toBe(3);
    expect(occs.map((o) => o.key)).toEqual([
      `standup@${instantKey(ms("2026-03-08 09:00"))}`,
      `standup@${instantKey(ms("2026-03-08 13:00"))}`,
      `standup@${instantKey(ms("2026-03-08 17:00"))}`,
    ]);
  });
});

/* ---------------------------------- packing -------------------------------- */

describe("dayAgenda: lane packing", () => {
  const rows = [
    {
      name: "two non-overlapping events share lane 0",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 10:00" },
        { start: "2026-03-08 10:30", end: "2026-03-08 11:30" },
      ],
      lanes: [0, 0],
    },
    {
      name: "events that merely touch (end === next start) also share a lane",
      events: [
        { start: "2026-03-08 10:00", end: "2026-03-08 11:00" },
        { start: "2026-03-08 11:00", end: "2026-03-08 12:00" },
      ],
      lanes: [0, 0],
    },
    {
      name: "two overlapping events get separate lanes",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 10:00" },
        { start: "2026-03-08 09:30", end: "2026-03-08 10:30" },
      ],
      lanes: [0, 1],
    },
    {
      name: "three mutually overlapping events use three lanes",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 11:00" },
        { start: "2026-03-08 09:15", end: "2026-03-08 10:45" },
        { start: "2026-03-08 09:30", end: "2026-03-08 10:30" },
      ],
      lanes: [0, 1, 2],
    },
    {
      name: "an event that outlives lane 1's occupant reuses it, even while lane 0 is still busy",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 10:00" }, // lane 0, busy until 10:00
        { start: "2026-03-08 09:30", end: "2026-03-08 09:45" }, // lane 1, frees at 09:45
        { start: "2026-03-08 09:50", end: "2026-03-08 10:30" }, // overlaps lane 0's occupant, reuses lane 1
      ],
      lanes: [0, 1, 1],
    },
  ] as const;

  it.each(rows)("$name", ({ events, lanes }) => {
    const built = events.map((spec) => event(spec));
    const { timed } = dayAgenda(built, [cal], day("2026-03-08"));
    expect(timed.map((o) => o.lane)).toEqual([...lanes]);
  });

  it("skips all-day events entirely, keeping timed lanes as if they weren't there", () => {
    const allDay = event({
      allDay: true,
      start: day("2026-03-08").getTime(),
      end: day("2026-03-09").getTime(),
    });
    const a = event({ start: "2026-03-08 09:00", end: "2026-03-08 10:00" });
    const b = event({ start: "2026-03-08 09:30", end: "2026-03-08 10:30" });
    const agenda = dayAgenda([allDay, a, b], [cal], day("2026-03-08"));

    expect(agenda.allDay).toHaveLength(1);
    expect(agenda.timed.map((o) => o.lane)).toEqual([0, 1]);
    expect(agenda.all).toHaveLength(3);
  });
});

describe("dayAgenda: ordering", () => {
  it("breaks a tied start by the earlier end", () => {
    const long = event({ id: "long", start: "2026-03-08 09:00", end: "2026-03-08 10:00" });
    const short = event({ id: "short", start: "2026-03-08 09:00", end: "2026-03-08 09:30" });
    const { timed } = dayAgenda([long, short], [cal], day("2026-03-08"));
    expect(timed.map((o) => o.event.id)).toEqual(["short", "long"]);
  });

  it("is stable for two events with identical start and end", () => {
    const a = event({ id: "a", start: "2026-03-08 09:00", end: "2026-03-08 10:00" });
    const b = event({ id: "b", start: "2026-03-08 09:00", end: "2026-03-08 10:00" });
    expect(dayAgenda([a, b], [cal], day("2026-03-08")).timed.map((o) => o.event.id)).toEqual([
      "a",
      "b",
    ]);
    expect(dayAgenda([b, a], [cal], day("2026-03-08")).timed.map((o) => o.event.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("groups every all-day occurrence ahead of timed ones, even when a timed occurrence starts earlier in wall-clock time", () => {
    // `nightshift` started the previous evening, so its real `start` instant
    // precedes the all-day event's midnight start — a naive chronological
    // merge would put it first. `dayAgenda` groups by kind instead.
    const holiday = event({
      id: "holiday",
      allDay: true,
      start: day("2026-03-08").getTime(),
      end: day("2026-03-09").getTime(),
    });
    const nightshift = event({
      id: "nightshift",
      start: "2026-03-07 22:00",
      end: "2026-03-08 02:00",
    });

    const raw = occurrencesOn([nightshift, holiday], [cal], day("2026-03-08"));
    expect(raw.map((o) => o.event.id)).toEqual(["nightshift", "holiday"]);

    const { all } = dayAgenda([nightshift, holiday], [cal], day("2026-03-08"));
    expect(all.map((o) => o.event.id)).toEqual(["holiday", "nightshift"]);
  });
});

/* -------------------------------- free time -------------------------------- */

describe("freeGaps", () => {
  type Spec = { start: string; end: string; allDay?: boolean; free?: boolean };
  const build = (specs: Spec[]) =>
    occurrencesOn(
      specs.map((s) => event(s)),
      [cal],
      day("2026-03-08"),
    );

  const rows: Array<{ name: string; events: Spec[]; min: number; expected: Gap[] }> = [
    {
      name: "an empty day is one gap spanning the whole waking window",
      events: [],
      min: 30,
      expected: [{ start: DEFAULT_WAKING.from, end: DEFAULT_WAKING.to }],
    },
    {
      name: "a day booked exactly across the window has no gaps",
      events: [{ start: "2026-03-08 08:00", end: "2026-03-08 22:00" }],
      min: 30,
      expected: [],
    },
    {
      name: "adjacent events leave no gap between them",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 10:00" },
        { start: "2026-03-08 10:00", end: "2026-03-08 11:00" },
      ],
      min: 30,
      expected: [
        { start: DEFAULT_WAKING.from, end: 540 },
        { start: 660, end: DEFAULT_WAKING.to },
      ],
    },
    {
      name: "an event starting before the window clips to it",
      events: [{ start: "2026-03-08 07:00", end: "2026-03-08 09:00" }],
      min: 30,
      expected: [{ start: 540, end: DEFAULT_WAKING.to }],
    },
    {
      name: "an event ending after the window clips to it",
      events: [{ start: "2026-03-08 21:00", end: "2026-03-08 23:00" }],
      min: 30,
      expected: [{ start: DEFAULT_WAKING.from, end: 1260 }],
    },
    {
      name: "a gap narrower than minMinutes is dropped",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 10:00" },
        { start: "2026-03-08 10:10", end: "2026-03-08 11:00" },
      ],
      min: 30,
      expected: [
        { start: DEFAULT_WAKING.from, end: 540 },
        { start: 660, end: DEFAULT_WAKING.to },
      ],
    },
    {
      name: "an all-day event does not occupy a gap",
      events: [{ start: "2026-03-08 00:00", end: "2026-03-09 00:00", allDay: true }],
      min: 30,
      expected: [{ start: DEFAULT_WAKING.from, end: DEFAULT_WAKING.to }],
    },
    {
      // The case the function exists for: a placeholder is exactly what you
      // want to be offered room inside, so it books no block at all.
      name: "a free event does not occupy a gap",
      events: [{ start: "2026-03-08 09:00", end: "2026-03-08 17:00", free: true }],
      min: 30,
      expected: [{ start: DEFAULT_WAKING.from, end: DEFAULT_WAKING.to }],
    },
    {
      // And it does not shorten one either: the busy event beside it is the
      // only thing the gaps are measured against.
      name: "a free event overlapping a busy one leaves the busy one's gaps alone",
      events: [
        { start: "2026-03-08 09:00", end: "2026-03-08 17:00", free: true },
        { start: "2026-03-08 12:00", end: "2026-03-08 13:00" },
      ],
      min: 30,
      expected: [
        { start: DEFAULT_WAKING.from, end: 720 },
        { start: 780, end: DEFAULT_WAKING.to },
      ],
    },
  ];

  it.each(rows)("$name", ({ events, min, expected }) => {
    const gaps = freeGaps(build(events), min, DEFAULT_WAKING.from, DEFAULT_WAKING.to);
    expect(gaps).toEqual(expected);
  });
});

describe("dayLoad", () => {
  const load = (
    specs: Array<{ start: string; end: string; allDay?: boolean; free?: boolean }>,
    waking: { from: number; to: number } = DEFAULT_WAKING,
  ) =>
    dayLoad(
      occurrencesOn(
        specs.map((s) => event(s)),
        [cal],
        day("2026-03-08"),
      ),
      waking,
    );

  // The distinction the return type exists for: a day with nothing timed on it
  // has no answer, which is not the same as an answer of zero.
  it("is null for an empty day and for one carrying only an all-day event", () => {
    expect(load([])).toBeNull();
    expect(load([{ start: "2026-03-08 00:00", end: "2026-03-09 00:00", allDay: true }])).toBeNull();
  });

  // The whole reason it goes through `freeGaps`: two events on one hour are
  // one hour booked. Summing durations would say two.
  it("merges overlapping events rather than summing their durations", () => {
    const overlapping = load([
      { start: "2026-03-08 09:00", end: "2026-03-08 11:00" },
      { start: "2026-03-08 10:00", end: "2026-03-08 12:00" },
    ]);
    expect(overlapping?.booked).toBe(180);
  });

  // Booked is the whole revolution, free is only the given window, and they
  // are deliberately not complements: nobody reads "nineteen hours free" as
  // an offer. An event outside the waking window is booked and costs no free.
  it("counts a night event as booked without taking it off the free window", () => {
    const night = load([{ start: "2026-03-08 05:00", end: "2026-03-08 06:00" }]);
    expect(night?.booked).toBe(60);
    expect(night?.free).toBe(DEFAULT_WAKING.to - DEFAULT_WAKING.from);
  });

  it("does not sum to a day, or to anything", () => {
    const some = load([{ start: "2026-03-08 09:00", end: "2026-03-08 10:00" }])!;
    expect(some.booked).toBe(60);
    expect(some.free).toBe(DEFAULT_WAKING.to - DEFAULT_WAKING.from - 60);
    expect(some.booked + some.free).not.toBe(MINUTES_PER_DAY);
  });

  // `waking` is now the caller's own argument, not a module constant `dayLoad`
  // reads for itself — so free has to track whatever window it is handed,
  // including one nowhere near `DEFAULT_WAKING`.
  it("free tracks the window it is given, not a fixed default", () => {
    const midnight = load([{ start: "2026-03-08 01:00", end: "2026-03-08 01:30" }], {
      from: 0,
      to: 120,
    })!;
    expect(midnight.booked).toBe(30);
    expect(midnight.free).toBe(90);
  });

  // A naive implementation could measure `booked` against the given window
  // too, instead of the whole revolution — the two would then "add up" to
  // the window's own width and look plausible. Here the event sits entirely
  // outside a narrow window: `booked` must still count it in full while
  // `free` reports the window untouched, so the pair does not collapse into
  // the window width the way a naive reading would.
  it("booked ignores the given window entirely — a bug that reused it would undercount", () => {
    const outside = load([{ start: "2026-03-08 23:00", end: "2026-03-09 00:00" }], {
      from: 9 * 60,
      to: 10 * 60,
    })!;
    expect(outside.booked).toBe(60);
    expect(outside.free).toBe(60);
  });

  // The half of "free" that is not decoration: a placeholder is not time
  // spent, so the number the totals line prints stops counting it.
  it("leaves a free event out of the booked total", () => {
    const held = load([{ start: "2026-03-08 09:00", end: "2026-03-08 11:00", free: true }])!;
    expect(held.booked).toBe(0);
    expect(held.free).toBe(DEFAULT_WAKING.to - DEFAULT_WAKING.from);
  });

  it("counts only the busy half of a day carrying both", () => {
    const mixed = load([
      { start: "2026-03-08 09:00", end: "2026-03-08 10:00" },
      { start: "2026-03-08 14:00", end: "2026-03-08 15:30", free: true },
    ])!;
    expect(mixed.booked).toBe(60);
    // The free window is untouched by the hold as well — it is time on offer.
    expect(mixed.free).toBe(DEFAULT_WAKING.to - DEFAULT_WAKING.from - 60);
  });

  // Not the `null` case: something *is* on this day, and `0m booked` is the
  // answer the line exists to give about a day whose only entry is a birthday.
  it("still answers for a day whose only timed event is free", () => {
    const only = load([{ start: "2026-03-08 09:00", end: "2026-03-08 10:00", free: true }]);
    expect(only).not.toBeNull();
    expect(only?.booked).toBe(0);
  });
});

describe("clashesWith", () => {
  type Spec = {
    start: string;
    end: string;
    title?: string;
    allDay?: boolean;
    free?: boolean;
    task?: boolean;
  };
  const clash = (specs: Spec[], startMin: number, endMin: number) =>
    clashesWith(
      occurrencesOn(
        specs.map((s) => event(s)),
        [cal],
        day("2026-03-08"),
      ),
      startMin,
      endMin,
    ).map((occ) => occ.event.title);

  const rows: Array<{ name: string; events: Spec[]; span: [number, number]; expected: string[] }> =
    [
      {
        name: "an empty day clashes with nothing",
        events: [],
        span: [9 * 60, 10 * 60],
        expected: [],
      },
      {
        name: "a span landing on top of a meeting names it",
        events: [{ title: "Standup", start: "2026-03-08 09:00", end: "2026-03-08 09:30" }],
        span: [9 * 60, 10 * 60],
        expected: ["Standup"],
      },
      {
        name: "a span wholly inside a longer event still clashes",
        events: [{ title: "Workshop", start: "2026-03-08 09:00", end: "2026-03-08 17:00" }],
        span: [13 * 60, 13 * 60 + 30],
        expected: ["Workshop"],
      },
      {
        // `end` is exclusive everywhere in this app, so the next thing is not a
        // collision. The whole notice would cry wolf on every back-to-back day
        // if this were inclusive.
        name: "a span starting exactly where one ends does not clash",
        events: [{ title: "Standup", start: "2026-03-08 09:00", end: "2026-03-08 10:00" }],
        span: [10 * 60, 11 * 60],
        expected: [],
      },
      {
        name: "a span ending exactly where one starts does not clash",
        events: [{ title: "Standup", start: "2026-03-08 10:00", end: "2026-03-08 11:00" }],
        span: [9 * 60, 10 * 60],
        expected: [],
      },
      {
        // An all-day "Berlin" covers the revolution and is context, not a
        // conflict — `freeGaps`' own rule, and the reason it is reused here.
        name: "an all-day event is context and never clashes",
        events: [
          { title: "Berlin", start: "2026-03-08 00:00", end: "2026-03-09 00:00", allDay: true },
        ],
        span: [9 * 60, 10 * 60],
        expected: [],
      },
      {
        name: "a free event is the placeholder you book over",
        events: [
          { title: "Birthday", start: "2026-03-08 09:00", end: "2026-03-08 17:00", free: true },
        ],
        span: [9 * 60, 10 * 60],
        expected: [],
      },
      {
        // A task holds no minutes, so it is dropped on width rather than by a
        // flag of its own — and one standing inside the span is the case a
        // zero-width end alone would have let through.
        name: "a task inside the span holds no minutes and does not clash",
        events: [
          {
            title: "Renew passport",
            start: "2026-03-08 09:30",
            end: "2026-03-08 09:30",
            task: true,
          },
        ],
        span: [9 * 60, 10 * 60],
        expected: [],
      },
      {
        name: "several clashes come back in the day's own order",
        events: [
          { title: "Late", start: "2026-03-08 09:45", end: "2026-03-08 10:15" },
          { title: "Early", start: "2026-03-08 09:00", end: "2026-03-08 09:30" },
        ],
        span: [9 * 60, 10 * 60],
        expected: ["Early", "Late"],
      },
      {
        name: "only the events the span actually reaches are named",
        events: [
          { title: "Standup", start: "2026-03-08 09:00", end: "2026-03-08 09:30" },
          { title: "Retro", start: "2026-03-08 16:00", end: "2026-03-08 17:00" },
        ],
        span: [9 * 60, 10 * 60],
        expected: ["Standup"],
      },
    ];

  it.each(rows)("$name", ({ events, span, expected }) => {
    expect.soft(clash(events, span[0], span[1])).toEqual(expected);
  });

  // A task being *created* has no width of its own, so there is nothing for it
  // to land on top of — the guard is what keeps the notice off ⌘P's own tasks.
  it("a zero-width span asks nothing", () => {
    const events = [{ title: "Workshop", start: "2026-03-08 09:00", end: "2026-03-08 17:00" }];
    expect(clash(events, 13 * 60, 13 * 60)).toEqual([]);
  });

  // An event through midnight runs past 1440, and the part of it on this day
  // is answered normally rather than the query being refused.
  it("answers for the part of a span that lands on this day", () => {
    const events = [{ title: "Late shift", start: "2026-03-08 23:00", end: "2026-03-08 23:45" }];
    expect(clash(events, 23 * 60 + 30, 25 * 60)).toEqual(["Late shift"]);
  });
});

/* --------------------------------- colour --------------------------------- */

describe("colorOf", () => {
  it.each([
    {
      name: "the event's own colour wins over the calendar's",
      eventColor: "#123456",
      calendarId: "cal-work",
      calendars: [calendar({ id: "cal-work", color: "#a3d9e4" })],
      expected: "#123456",
    },
    {
      name: "an empty colour falls back to the calendar's",
      eventColor: "",
      calendarId: "cal-work",
      calendars: [calendar({ id: "cal-work", color: "#a3d9e4" })],
      expected: "#a3d9e4",
    },
    {
      name: "an event pointing at a calendar that no longer exists gets the orphan fallback",
      eventColor: "",
      calendarId: "cal-deleted",
      calendars: [calendar({ id: "cal-work", color: "#a3d9e4" })],
      expected: PALETTE[0],
    },
  ])("$name", ({ eventColor, calendarId, calendars, expected }) => {
    const e = event({ color: eventColor, calendarId });
    expect(colorOf(e, calendars)).toBe(expected);
  });
});

/**
 * `markOf` is deliberately *not* `colorOf`. Colour must inherit — every event
 * needs one — so `CalEvent.color` is an override on a required field. A mark
 * is optional at both levels, and inheriting it by default would put the same
 * three glyphs on forty arcs of one day.
 */
describe("markOf inherits only when asked", () => {
  const cals = [calendar({ id: "cal-work", icon: "briefcase" })];

  it.each([
    {
      name: "its own mark wins, inheritance off",
      icon: "barbell",
      inherit: false,
      want: "barbell",
    },
    { name: "its own mark wins, inheritance on", icon: "barbell", inherit: true, want: "barbell" },
    { name: "no mark and no inheritance is no mark", icon: "", inherit: false, want: "" },
    {
      name: "no mark with inheritance takes the calendar's",
      icon: "",
      inherit: true,
      want: "briefcase",
    },
  ])("$name", ({ icon, inherit, want }) => {
    expect(markOf(event({ icon, calendarId: "cal-work" }), cals, inherit)).toBe(want);
  });

  // The default is the setting's default, so a caller that forgets the third
  // argument gets the conservative answer rather than the surprising one.
  it("does not inherit when nobody says", () => {
    expect(markOf(event({ icon: "", calendarId: "cal-work" }), cals)).toBe("");
  });

  // No `ORPHAN_COLOR` equivalent: a wrong glyph says something specific and a
  // missing one says nothing, so the orphan gets nothing.
  it("gives an orphaned event no mark rather than a borrowed one", () => {
    expect(markOf(event({ icon: "", calendarId: "cal-gone" }), cals, true)).toBe("");
  });

  it("reads the two channels independently — a borrowed glyph in its own colour", () => {
    const cal = [calendar({ id: "cal-work", icon: "briefcase", color: "#a3d9e4" })];
    const e = event({ icon: "", color: "#ff9fb4", calendarId: "cal-work" });
    expect.soft(markOf(e, cal, true)).toBe("briefcase");
    expect.soft(colorOf(e, cal)).toBe("#ff9fb4");
  });
});

/* ---------------------------------- marks --------------------------------- */

describe("isIconName tells the two mark vocabularies apart", () => {
  it.each([
    { name: "a plain Phosphor name", icon: "barbell", want: true },
    { name: "a hyphenated one", icon: "fork-knife", want: true },
    { name: "digits are allowed", icon: "number-1", want: true },
    { name: "no mark at all", icon: "", want: false },
    { name: "a plain emoji", icon: "🏋", want: false },
    { name: "an emoji with a variation selector", icon: "🏋️", want: false },
    { name: "a zero-width-joined family", icon: "👩‍👩‍👧‍👦", want: false },
    { name: "a flag", icon: "🇯🇵", want: false },
    // Anything that is neither reads as a name and falls back to the dot,
    // which is the safe half of the ambiguity.
    { name: "capitals are not a name", icon: "Barbell", want: false },
    { name: "a space is not a name", icon: "fork knife", want: false },
  ])("$name", ({ icon, want }) => {
    expect(isIconName(icon)).toBe(want);
  });
});

describe("firstGrapheme keeps one glyph whole", () => {
  it.each([
    { name: "a bare emoji", typed: "🎵", want: "🎵" },
    { name: "the first of several", typed: "🎵🎸🥁", want: "🎵" },
    // The cases the naive `[0]` and `[...s][0]` both get wrong: these are one
    // character to a reader and seven code points to a string.
    { name: "a ZWJ family stays one", typed: "👩‍👩‍👧‍👦", want: "👩‍👩‍👧‍👦" },
    { name: "a skin tone stays attached", typed: "👍🏽", want: "👍🏽" },
    { name: "a flag is one glyph", typed: "🇯🇵", want: "🇯🇵" },
    { name: "surrounding space is dropped", typed: "  🌱  ", want: "🌱" },
    { name: "nothing typed is no mark", typed: "   ", want: "" },
    { name: "a pasted sentence keeps its first character", typed: "hello", want: "h" },
  ])("$name", ({ typed, want }) => {
    expect(firstGrapheme(typed)).toBe(want);
  });

  it("never returns more than a stored mark may hold", () => {
    // A ZWJ family is 11 UTF-16 units; the cap has to clear it and still bound
    // whatever a future emoji sequence turns out to be.
    expect.soft(firstGrapheme("👩‍👩‍👧‍👦").length).toBeLessThanOrEqual(ICON_MAX);
    expect.soft(firstGrapheme("a".repeat(100)).length).toBeLessThanOrEqual(ICON_MAX);
  });
});

describe("readMark: a vocabulary each", () => {
  it.each([
    { name: "not a string", value: 7, want: "" },
    { name: "absent", value: undefined, want: "" },
    { name: "empty", value: "", want: "" },
    { name: "only space", value: "   ", want: "" },
    { name: "a known name", value: "barbell", want: "barbell" },
    // A set that shrinks, or a backup through a newer build, must not come
    // back with the mark missing.
    { name: "an unknown name is kept", value: "unicorn", want: "unicorn" },
    { name: "a name is trimmed, not dropped", value: "  barbell  ", want: "barbell" },
    { name: "an emoji survives", value: "🎸", want: "🎸" },
    { name: "an emoji is cut to one grapheme", value: "🎵🎸🥁", want: "🎵" },
    { name: "a ZWJ family stays one glyph", value: "👩‍👩‍👧‍👦", want: "👩‍👩‍👧‍👦" },
  ])("$name", ({ value, want }) => {
    expect.soft(readMark(value)).toBe(want);
  });

  // The bug, from the format's own side. Every one of these is a real entry in
  // `marks.ts` and every one was longer than the single shared cap.
  it.each([
    "person-simple-run",
    "dots-three-circle",
    "presentation-chart",
    "thermometer-simple",
    "person-simple-walk",
    "person-simple-swim",
    "person-simple-bike",
    "person-simple-tai-chi",
    "globe-hemisphere-west",
    "currency-circle-dollar",
  ])("keeps the shipped name %s whole", (icon) => {
    expect.soft(readMark(icon)).toBe(icon);
    expect.soft(icon.length).toBeGreaterThan(ICON_MAX);
    expect.soft(icon.length).toBeLessThanOrEqual(ICON_NAME_MAX);
  });

  /**
   * The claim that makes dropping the right answer rather than a second bug: a
   * sliced name is *guaranteed* to be invalid, because the table is keyed by
   * whole names. So slicing turns a legal value into one that renders as the
   * plain dot with nothing raised, where dropping renders as the same dot and
   * means it.
   */
  it("never returns a name it had to shorten", () => {
    const long = "a".repeat(ICON_NAME_MAX + 1);
    expect(readMark(long)).toBe("");
  });

  it("keeps a name of exactly the cap", () => {
    const exact = "a".repeat(ICON_NAME_MAX);
    expect(readMark(exact)).toBe(exact);
  });

  // A paste that happens to be lowercase ASCII reads as a name, so it is the
  // one that gets dropped; a paste with any other character in it is an emoji
  // field and keeps its first grapheme, which is what that field means.
  it("tells a lowercase paste from a pasted sentence", () => {
    expect.soft(readMark("x".repeat(500))).toBe("");
    expect.soft(readMark("Hello there, this is a whole sentence")).toBe("H");
  });
});

/* ----------------------------- the reminder lead --------------------------- *
 * The model half of the per-event reminder: what the field legally is, which
 * is this file's business for the same reason `ICON_MAX` and `isIconName`
 * are. Which lead an event actually gets — the precedence between its own
 * and the setting's — is `leadOf`'s, and is tested in
 * `tests/remind.test.ts`. */

describe("ownLead: the lead an event names for itself", () => {
  it.each([
    { name: "a named lead", own: 30, expected: 30 },
    { name: "zero is named", own: 0, expected: 0 },
    { name: "inheriting names none", own: REMIND_INHERIT, expected: null },
    // Silent names no *number*, which is what the exporter is asking: there
    // is no VALARM to write for it.
    { name: "silent names none", own: REMIND_SILENT, expected: null },
  ])("$name", ({ own, expected }) => {
    expect(ownLead(event({ remindLead: own }))).toBe(expected);
  });
});

describe("readRemindLead: one validator, four readers", () => {
  it.each([
    { name: "a lead the panel offers", value: 15, expected: 15 },
    { name: "zero", value: 0, expected: 0 },
    { name: "a lead only an import could name", value: 7, expected: 7 },
    { name: "silent", value: REMIND_SILENT, expected: REMIND_SILENT },
    { name: "inherit", value: REMIND_INHERIT, expected: REMIND_INHERIT },
    { name: "absent", value: undefined, expected: REMIND_INHERIT },
    { name: "a string that looks like one", value: "15", expected: REMIND_INHERIT },
    { name: "a negative that is neither state", value: -99, expected: REMIND_INHERIT },
    { name: "half a minute", value: 1.5, expected: REMIND_INHERIT },
    { name: "NaN", value: Number.NaN, expected: REMIND_INHERIT },
    { name: "at the cap", value: REMIND_LEAD_MAX, expected: REMIND_LEAD_MAX },
    // Past the cap it is dropped rather than clamped: a clamp would invent a
    // four-week warning nobody asked for, where inheriting is what an event
    // that said nothing readable already gets.
    { name: "past the cap", value: REMIND_LEAD_MAX + 1, expected: REMIND_INHERIT },
  ])("$name", ({ value, expected }) => {
    expect.soft(readRemindLead(value)).toBe(expected);
  });
});

describe("inkOn", () => {
  // The claim the arc label rests on: every preset takes black, so a label
  // inside the stroke is the strongest pairing on the face rather than a
  // per-colour judgement call.
  it("takes black on all ten presets", () => {
    expect(PALETTE.map(inkOn)).toEqual(PALETTE.map(() => "#000000"));
  });

  it.each([
    { name: "a near-black override, which only a hand-edited blob has", color: "#101010" },
    { name: "a saturated mid-blue", color: "#0033aa" },
    { name: "shorthand, expanded", color: "#036" },
  ])("turns white on $name", ({ color }) => {
    expect(inkOn(color)).toBe("#ffffff");
  });

  it.each(["", "not a colour", "#12", "rgb(1,2,3)", "#gggggg"])(
    "falls back to black for %s, which is what every light colour wants",
    (color) => {
      expect(inkOn(color)).toBe("#000000");
    },
  );
});

/* --------------------------------- status --------------------------------- */

describe("statusOf", () => {
  const [occ] = occurrencesOn(
    [event({ start: "2026-03-08 09:00", end: "2026-03-08 10:00" })],
    [cal],
    day("2026-03-08"),
  );

  it.each([
    { name: "exactly at the start", now: () => occ!.start, expected: "now" },
    { name: "exactly at the end", now: () => occ!.end, expected: "past" },
    {
      name: "one millisecond before the end",
      now: () => new Date(occ!.end.getTime() - 1),
      expected: "now",
    },
    {
      name: "one millisecond before the start",
      now: () => new Date(occ!.start.getTime() - 1),
      expected: "upcoming",
    },
  ])("$name is $expected", ({ now, expected }) => {
    expect(statusOf(occ!, now())).toBe(expected);
  });
});

describe("spanLabel", () => {
  const on = (stamp: string, e: ReturnType<typeof event>) =>
    occurrencesOn([e], [cal], day(stamp))[0]!;

  it("says nothing about an event inside one day", () => {
    expect(spanLabel(on("2026-03-08", event({ start: "2026-03-08 09:00" })))).toBeNull();
  });

  it("names the position and the length of a longer span", () => {
    const holiday = event({ start: "2026-03-05", end: "2026-03-10", allDay: true });
    expect(spanLabel(on("2026-03-05", holiday))).toBe("Day 1/5");
    expect(spanLabel(on("2026-03-07", holiday))).toBe("Day 3/5");
    expect(spanLabel(on("2026-03-09", holiday))).toBe("Day 5/5");
  });
});

describe("scoreEvent", () => {
  const e = event({ title: "Morning run", location: "Riverside", notes: "bring the dog" });

  it("misses when the query is in none of the three fields", () => {
    expect(scoreEvent(e, "dentist")).toBeNull();
  });

  it("takes the empty query as a hit, so an empty box ranks everything the same", () => {
    expect(scoreEvent(e, "")).toBe(0);
    expect(scoreEvent(event({ title: "Anything else" }), "")).toBe(0);
  });

  it("scores a title hit above the same hit in the location", () => {
    const titled = event({ title: "Riverside", location: "", notes: "" });
    const located = event({ title: "", location: "Riverside", notes: "" });
    expect(scoreEvent(titled, "riverside")!).toBeGreaterThan(scoreEvent(located, "riverside")!);
  });

  it("scores a location hit above the same hit in the notes", () => {
    const located = event({ title: "", location: "Riverside", notes: "" });
    const noted = event({ title: "", location: "", notes: "Riverside" });
    expect(scoreEvent(located, "riverside")!).toBeGreaterThan(scoreEvent(noted, "riverside")!);
  });

  it("keeps the best of the three fields rather than the last one tried", () => {
    // The title match must survive a weaker hit in the notes beside it.
    const both = event({ title: "Riverside", location: "", notes: "r i v e r s i d e" });
    const titleOnly = event({ title: "Riverside", location: "", notes: "" });
    expect(scoreEvent(both, "riverside")).toBe(scoreEvent(titleOnly, "riverside"));
  });

  it("finds a match the palette forgives one character into", () => {
    // The grid lights every match, so its reach is exactly the palette's: one
    // typo forgiven, and no second, stricter matcher anywhere.
    expect(scoreEvent(event({ title: "Morning run" }), "mornng run")).not.toBeNull();
  });
});

/* --------------------------- occurrencesOn: zoned events -------------------------- */

describe("occurrencesOn: a zoned event lands on the day its own zone says", () => {
  it("a London-zoned weekly Monday-night rule shows on the viewer's Tuesday, an hour east", () => {
    // 23:30 Monday in London is 00:30 Tuesday in Berlin (this file's pinned
    // TZ, an hour further east in winter) — so BYDAY=Monday has to be matched
    // against *London's* calendar to fire at all. Matched against the
    // viewer's, the seed itself already reads Tuesday and a Monday-only rule
    // would never generate it.
    const seedMs = zonedToUtc(2026, 1, 5, 23, 30, "Europe/London"); // Monday
    const e = event({
      start: seedMs,
      end: seedMs + 30 * 60_000,
      tzid: "Europe/London",
      repeat: "weekly",
      byDay: [{ day: 1, nth: 0 }], // Monday
    });
    expect.soft(occurrencesOn([e], [cal], day("2026-01-06"))).toHaveLength(1); // Tue, Berlin
    expect.soft(occurrencesOn([e], [cal], day("2026-01-05"))).toHaveLength(0); // Mon, Berlin
  });
});

/* ------------------------------- guest lists ------------------------------- *
 * `readGuests` and `readPerson` are the one validator behind three readers —
 * `ics.ts`'s ATTENDEE lines, `backup.readEvent`'s untrusted JSON and
 * `store.hydrateEvents`' older blob — so the caps and the counting rules are
 * pinned here rather than three times over. */

describe("readPartstat", () => {
  it.each([
    { name: "ACCEPTED", value: "ACCEPTED", expected: "accepted" },
    { name: "already the stored spelling", value: "needs-action", expected: "needs-action" },
    { name: "padded and mixed case", value: " Tentative ", expected: "tentative" },
    // The one the model refuses on purpose: a delegation is neither yes nor no,
    // and the delegate is a line of its own. See `PARTSTATS`.
    { name: "DELEGATED", value: "DELEGATED", expected: "needs-action" },
    { name: "a value no standard defines", value: "SOON", expected: "needs-action" },
    { name: "not a string at all", value: 3, expected: "needs-action" },
    { name: "absent", value: undefined, expected: "needs-action" },
  ])("reads $name as $expected", ({ value, expected }) => {
    expect(readPartstat(value)).toBe(expected);
  });
});

describe("readPerson", () => {
  it("keeps a name and an address, trimmed", () => {
    expect(readPerson({ name: " Ada ", address: " ada@example.com " })).toEqual({
      name: "Ada",
      address: "ada@example.com",
    });
  });

  it.each([
    { name: "no address", value: { name: "Ada" } },
    { name: "an empty address", value: { name: "Ada", address: "   " } },
    { name: "an address that is not a string", value: { address: 42 } },
    { name: "null", value: null },
    { name: "a string instead of a record", value: "ada@example.com" },
  ])("refuses $name — a row the surface could not explain", ({ value }) => {
    expect(readPerson(value)).toBeNull();
  });

  it("truncates rather than refusing, since the row is only ever printed", () => {
    const person = readPerson({
      name: "N".repeat(GUEST_NAME_MAX + 20),
      address: "a".repeat(GUEST_ADDRESS_MAX + 20),
    });
    expect.soft(person?.name).toHaveLength(GUEST_NAME_MAX);
    expect.soft(person?.address).toHaveLength(GUEST_ADDRESS_MAX);
  });
});

describe("readGuests", () => {
  const list = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ name: "", address: `g${i + from}@example.com` }));

  it("keeps a legal list whole and counts it", () => {
    const { attendees, attendeeCount } = readGuests(
      [{ name: "Grace", address: "grace@example.com", status: "ACCEPTED" }],
      undefined,
    );
    expect.soft(attendees).toEqual([attendee("grace@example.com", "accepted", "Grace")]);
    expect.soft(attendeeCount).toBe(1);
  });

  it("caps the list at ATTENDEE_MAX and remembers how many there were", () => {
    const { attendees, attendeeCount } = readGuests(list(ATTENDEE_MAX + 40), undefined);
    expect.soft(attendees).toHaveLength(ATTENDEE_MAX);
    expect.soft(attendeeCount).toBe(ATTENDEE_MAX + 40);
  });

  // The count exists to say what the cap dropped, so it can never be smaller
  // than the list it labels — otherwise the surface prints a negative
  // remainder, which is a truncation announcing itself backwards.
  it("clamps a count that understates its own list", () => {
    expect(readGuests(list(3), 1).attendeeCount).toBe(3);
    expect(readGuests(list(3), -9).attendeeCount).toBe(3);
    expect(readGuests(list(3), "many").attendeeCount).toBe(3);
  });

  it("keeps a count that overstates the list, because that is what a cap does", () => {
    expect(readGuests(list(3), 400).attendeeCount).toBe(400);
  });

  it("refuses to print an unreadable number of guests", () => {
    // Only ever a figure in a sentence, so a blob claiming a billion costs a
    // line nobody can read rather than anything worse.
    expect(readGuests(list(2), 1e9).attendeeCount).toBe(9999);
    expect(readGuests(list(2), Number.NaN).attendeeCount).toBe(2);
  });

  it("drops the rows that name nobody without dropping the list", () => {
    const { attendees, attendeeCount } = readGuests(
      [{ name: "Ghost" }, null, "grace@example.com", { address: "grace@example.com" }],
      undefined,
    );
    expect.soft(attendees).toEqual([attendee("grace@example.com")]);
    expect.soft(attendeeCount).toBe(1);
  });

  it("collapses one person listed twice, keeping the first line", () => {
    const { attendees, attendeeCount } = readGuests(
      [
        { name: "Grace", address: "grace@example.com", status: "ACCEPTED" },
        { name: "G", address: "GRACE@example.com", status: "DECLINED" },
      ],
      undefined,
    );
    expect.soft(attendees).toEqual([attendee("grace@example.com", "accepted", "Grace")]);
    expect.soft(attendeeCount).toBe(1);
  });

  it.each([
    { name: "not an array", value: "grace@example.com" },
    { name: "absent", value: undefined },
    { name: "empty", value: [] },
  ])("reads $name as nobody at all", ({ value }) => {
    expect(readGuests(value, undefined)).toEqual({ attendees: [], attendeeCount: 0 });
  });
});

/* --------------------------- stamps and graves ---------------------------- */

/**
 * The format half of the merge. Both readers are asked about *validity* rather
 * than only shape, and the reason is the same for each: every merge decision
 * is an inequality on one of these numbers, and an inequality against `NaN`
 * answers `false` in both directions — a record that can never win and never
 * lose, silently.
 */
describe("readStamp", () => {
  it.each([
    { name: "a stamp", value: ms("2026-03-08 09:00"), want: ms("2026-03-08 09:00") },
    { name: "zero, which is a record that predates stamping", value: 0, want: 0 },
    { name: "a fraction, floored so two readers agree", value: 1.7, want: 1 },
    { name: "a negative instant", value: -1, want: 0 },
    { name: "NaN", value: NaN, want: 0 },
    { name: "Infinity", value: Infinity, want: 0 },
    { name: "a string that looks like one", value: "1772946000000", want: 0 },
    { name: "nothing at all", value: undefined, want: 0 },
  ])("reads $name", ({ value, want }) => {
    expect.soft(readStamp(value)).toBe(want);
  });
});

describe("readGraves", () => {
  it("keeps the later of two graves for one id, which is what a re-deletion is", () => {
    const graves = readGraves([
      { id: "a", at: ms("2026-03-08 09:00") },
      { id: "a", at: ms("2026-03-10 09:00") },
    ]);
    expect(graves).toEqual([{ id: "a", at: ms("2026-03-10 09:00") }]);
  });

  it.each([
    { name: "not an array", value: {} },
    { name: "a row with no id", value: [{ at: 1 }] },
    { name: "a row with an empty id", value: [{ id: "", at: 1 }] },
    { name: "a row with an unreadable instant", value: [{ id: "a", at: "yesterday" }] },
    // `0` is "predates stamping" for a record, so it cannot also mean a
    // deletion: a grave at the epoch would outrank nothing and bury nothing.
    { name: "a row stamped zero", value: [{ id: "a", at: 0 }] },
    { name: "a row that is not an object", value: ["a"] },
  ])("drops $name", ({ value }) => {
    expect.soft(readGraves(value)).toEqual([]);
  });

  // The cap bounds the one part of the blob that grows with *use* rather than
  // with what the user is holding, inside the same ~5MB origin quota
  // `FEED_BUDGET` already carves 2M characters out of.
  it("keeps the newest GRAVE_MAX and drops the oldest", () => {
    const many = Array.from({ length: GRAVE_MAX + 10 }, (_, i) => ({ id: `g${i}`, at: i + 1 }));
    const graves = readGraves(many);
    expect.soft(graves).toHaveLength(GRAVE_MAX);
    expect.soft(graves[0]).toEqual({ id: `g${GRAVE_MAX + 9}`, at: GRAVE_MAX + 10 });
    expect.soft(graves.some((g) => g.id === "g0")).toBe(false);
  });
});

/* --------------------------------- joinLink -------------------------------- */

describe("joinLink", () => {
  it.each([
    {
      name: "a Meet link in the url field",
      url: "https://meet.google.com/abc-defg-hij",
      location: "",
      found: "https://meet.google.com/abc-defg-hij",
    },
    {
      name: "a Zoom link on a vanity subdomain, query kept",
      url: "https://acme.zoom.us/j/91234567890?pwd=abc123",
      location: "",
      found: "https://acme.zoom.us/j/91234567890?pwd=abc123",
    },
    {
      name: "a bare-domain Zoom link",
      url: "https://zoom.us/j/91234567890",
      location: "",
      found: "https://zoom.us/j/91234567890",
    },
    {
      name: "a Jitsi room",
      url: "https://meet.jit.si/circal-standup",
      location: "",
      found: "https://meet.jit.si/circal-standup",
    },
    {
      name: "a link embedded in location prose",
      url: "",
      location: "Room 4 · https://meet.google.com/abc-defg-hij",
      found: "https://meet.google.com/abc-defg-hij",
    },
    {
      name: "trailing punctuation prose hung on the link is not part of it",
      url: "",
      location: "join here: https://zoom.us/j/123).",
      found: "https://zoom.us/j/123",
    },
    {
      name: "the url field outranks a link in the location",
      url: "https://zoom.us/j/111",
      location: "https://meet.google.com/abc-defg-hij",
      found: "https://zoom.us/j/111",
    },
    {
      name: "a non-conferencing url in the field is skipped for the location's real one",
      url: "https://docs.example.com/agenda",
      location: "https://meet.jit.si/weekly",
      found: "https://meet.jit.si/weekly",
    },
    {
      name: "uppercase host still recognised",
      url: "https://MEET.GOOGLE.COM/abc-defg-hij",
      location: "",
      found: "https://MEET.GOOGLE.COM/abc-defg-hij",
    },
  ])("finds $name", ({ url, location, found }) => {
    expect.soft(joinLink(event({ url, location }))).toBe(found);
  });

  it.each([
    { name: "an agenda doc", url: "https://docs.example.com/agenda", location: "" },
    { name: "a plain room name", url: "", location: "Conference room 4" },
    { name: "a conferencing homepage with no room", url: "https://zoom.us/", location: "" },
    {
      name: "a lookalike host suffixed past the real one",
      url: "https://meet.google.com.evil.com/abc-defg-hij",
      location: "",
    },
    {
      name: "a lookalike host prefixed onto another domain",
      url: "https://zoom.us.evil.com/j/123",
      location: "",
    },
    { name: "notzoom, one letter of host away", url: "https://notzoom.us/j/123", location: "" },
    {
      name: "a bare host pasted without a scheme",
      url: "meet.google.com/abc-defg-hij",
      location: "",
    },
    { name: "nothing at all", url: "", location: "" },
  ])("refuses $name", ({ url, location }) => {
    expect.soft(joinLink(event({ url, location }))).toBeNull();
  });
});
