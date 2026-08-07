import { describe, expect, it } from "vitest";
import "./helpers";
import { DIAL, VIEW_SIZE, polar } from "@/lib/dial";
import {
  YEAR,
  dateOfYear,
  dayAngle,
  dayAtPoint,
  dayOfYear,
  daysInYear,
  magnify,
  ringDelta,
  spread,
  yearAtPoint,
  markRadius,
  faceToPanel,
  monthMarks,
  unroller,
  yearAngle,
} from "@/lib/year";

/* --------------------------------- the year -------------------------------- */

describe("daysInYear", () => {
  it.each([
    { year: 2023, days: 365 },
    { year: 2024, days: 366 },
    { year: 1900, days: 365 },
    { year: 2000, days: 366 },
  ])("gives $year $days days", ({ year, days }) => {
    expect(daysInYear(year)).toBe(days);
  });
});

describe("dayOfYear", () => {
  it("is zero-based from 1 January", () => {
    expect(dayOfYear(new Date(2024, 0, 1))).toBe(0);
    expect(dayOfYear(new Date(2024, 0, 2))).toBe(1);
  });

  it("counts the leap day", () => {
    expect(dayOfYear(new Date(2024, 11, 31))).toBe(365);
    expect(dayOfYear(new Date(2023, 11, 31))).toBe(364);
  });

  it("is the exact inverse of dateOfYear, every day of a leap year", () => {
    const offenders: string[] = [];
    for (let i = 0; i < daysInYear(2024); i++) {
      const back = dayOfYear(dateOfYear(2024, i));
      if (back !== i) offenders.push(`${i} -> ${back}`);
    }
    expect(offenders.slice(0, 5), `${offenders.length} offending day(s)`).toEqual([]);
  });
});

/* ---------------------- dayAngle / dayAtPoint are inverses ------------------ */

describe("dayAngle and dayAtPoint are exact inverses", () => {
  // The same contract `angleAt` and `minutesAtPoint` have on the dial, and it
  // carries the whole of pointing at a day: get it wrong by one slot and every
  // hover, click and readout on this face names the wrong date.
  it.each([2023, 2024])("holds for every day of %i", (year) => {
    const days = daysInYear(year);
    const offenders: string[] = [];
    for (let i = 0; i < days; i++) {
      for (const r of [YEAR.TODAY_RING, YEAR.DAY_INNER, YEAR.MONTH]) {
        const p = polar(r, dayAngle(i, days));
        const back = dayAtPoint(p.x, p.y, days);
        if (back !== i) offenders.push(`day ${i} at r=${r} -> ${back}`);
      }
    }
    expect(offenders.slice(0, 5), `${offenders.length} offending day(s)`).toEqual([]);
  });

  it("never names a day past the end of the year", () => {
    // A point a hair anticlockwise of 12 o'clock is 359.99…°, which rounds up
    // to a slot that does not exist without the clamp.
    const p = polar(YEAR.DAY_INNER, 359.9999);
    expect(dayAtPoint(p.x, p.y, 365)).toBe(364);
    expect(dayAtPoint(p.x, p.y, 366)).toBe(365);
  });

  it("puts 1 January at the top of the face", () => {
    const top = polar(YEAR.DAY_INNER, 0);
    expect(dayAtPoint(top.x, top.y, 365)).toBe(0);
  });

  it("runs clockwise", () => {
    const days = 365;
    const spring = polar(YEAR.DAY_INNER, 90);
    // A quarter turn clockwise from 1 January is a quarter of the way through.
    expect(dayAtPoint(spring.x, spring.y, days)).toBe(Math.floor(days / 4));
  });
});

describe("yearAngle", () => {
  it("spends exactly one revolution on a year", () => {
    expect(yearAngle(0, 365)).toBe(0);
    expect(yearAngle(365, 365)).toBe(360);
    expect(yearAngle(366, 366)).toBe(360);
  });

  it("gives a leap year the same revolution in smaller slots", () => {
    expect(360 / 366).toBeLessThan(360 / 365);
    expect(yearAngle(1, 366)).toBeLessThan(yearAngle(1, 365));
  });
});

/* --------------------------------- radii ----------------------------------- */

describe("markRadius", () => {
  it("draws an empty day as a stub", () => {
    expect(markRadius(0)).toBe(YEAR.DAY_INNER + YEAR.DAY_STUB);
  });

  it("grows with the load and stops at full", () => {
    expect(markRadius(1)).toBeGreaterThan(markRadius(0));
    expect(markRadius(3)).toBeGreaterThan(markRadius(1));
    expect(markRadius(YEAR.DAY_FULL_COUNT)).toBe(YEAR.DAY_OUTER);
    expect(markRadius(40)).toBe(YEAR.DAY_OUTER);
  });

  it("never draws past the month ticks", () => {
    expect(YEAR.DAY_OUTER).toBeLessThan(YEAR.TICK_INNER);
  });
});

describe("the face fits its crop", () => {
  it("keeps the outermost ring inside the dial's own", () => {
    // Both faces share `VIEW_BOX`, so anything past `DIAL.ZONE` is cropped.
    expect(YEAR.MONTH).toBe(DIAL.ZONE);
    expect(YEAR.TICK_OUTER).toBeLessThan(YEAR.MONTH);
  });

  it("orders the rings from the inside out", () => {
    const rings = [
      YEAR.TODAY_RING,
      YEAR.DAY_INNER,
      YEAR.DAY_OUTER,
      YEAR.TICK_INNER,
      YEAR.TICK_OUTER,
      YEAR.MONTH,
    ];
    expect(rings).toEqual([...rings].sort((a, b) => a - b));
  });
});

/* --------------------------------- months ---------------------------------- */

describe("monthMarks", () => {
  it("gives twelve marks starting at the top", () => {
    const marks = monthMarks(2024);
    expect(marks).toHaveLength(12);
    expect(marks[0].edge).toBe(0);
  });

  it("orders every boundary and keeps each name inside its own month", () => {
    const marks = monthMarks(2025);
    for (let i = 0; i < 12; i++) {
      const next = i === 11 ? 360 : marks[i + 1].edge;
      expect.soft(marks[i].mid).toBeGreaterThan(marks[i].edge);
      expect.soft(marks[i].mid).toBeLessThan(next);
    }
  });

  it("shifts every boundary after February in a leap year", () => {
    const common = monthMarks(2023);
    const leap = monthMarks(2024);
    // January is the same length either way, so its slot only shrinks.
    expect(leap[1].edge).toBeLessThan(common[1].edge);
    // Past February the extra day outweighs the smaller slot, so every later
    // month sits a little further round the face.
    for (let i = 2; i < 12; i++) expect.soft(leap[i].edge).toBeGreaterThan(common[i].edge);
  });
});

/* ------------------------------ magnification ------------------------------ */

describe("ringDelta", () => {
  // Callers pass a slot's own middle, `i + 0.5`, against the pointer's exact
  // place in the year — so a whole-number result is a whole day apart.
  it("measures the short way round the year", () => {
    // 31 December and 1 January are neighbours. Measured linearly the end of
    // the year is 364 days from the start and would stay flat while the
    // pointer sat on 2 January.
    expect(ringDelta(364.5, 0.5, 365)).toBeCloseTo(-1, 9);
    expect(ringDelta(0.5, 364.5, 365)).toBeCloseTo(1, 9);
  });

  it("is plain subtraction away from the seam", () => {
    expect(ringDelta(100.5, 97.5, 365)).toBeCloseTo(3, 9);
    expect(ringDelta(97.5, 100.5, 365)).toBeCloseTo(-3, 9);
  });

  it("never reports more than half a year", () => {
    const offenders: string[] = [];
    for (let i = 0; i < 366; i++) {
      for (const at of [0.5, 90.5, 182.5, 300.5]) {
        const d = ringDelta(i, at, 366);
        if (Math.abs(d) > 183) offenders.push(`${i} from ${at} -> ${d}`);
      }
    }
    expect(offenders.slice(0, 5), `${offenders.length} offender(s)`).toEqual([]);
  });
});

describe("magnify", () => {
  it("gives the pointer's own day the whole bulge", () => {
    expect(magnify(0)).toBe(1);
  });

  it("gives each neighbour about half of it", () => {
    // The shape of the effect, and the one number worth pinning: "and its two
    // neighbours, less so" is what makes it read as a magnifier rather than
    // as a single day switching size.
    expect(magnify(1)).toBeCloseTo(0.5, 1);
    expect(magnify(2)).toBeLessThan(0.1);
  });

  it("is symmetric and never negative", () => {
    for (const x of [0.3, 1, 1.7, 2.5, 3.3]) {
      expect.soft(magnify(x)).toBeCloseTo(magnify(-x), 12);
      expect.soft(magnify(x)).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls to nothing by `REACH`, with no step where it is cut", () => {
    expect(magnify(YEAR.REACH + 0.001)).toBe(0);
    // The cut is only honest if the curve is already invisible there — a step
    // here is a day that visibly snaps as the pointer crosses it.
    expect(magnify(YEAR.REACH)).toBeLessThan(1e-5);
  });

  it("leaves a magnified tip room before the month ticks", () => {
    // It grows outwards now, so the tip is what has to clear something. The
    // resting ring has to clear today's pip at the other end.
    expect(YEAR.DAY_OUTER + YEAR.GROW_OUT).toBeLessThan(YEAR.TICK_INNER);
    expect(YEAR.DAY_INNER).toBeGreaterThan(YEAR.TODAY_RING + YEAR.TODAY_PIP);
  });
});

describe("spread", () => {
  it("leaves the pointer's own day exactly where it is", () => {
    expect(spread(0)).toBe(0);
  });

  it("pushes each side away from the pointer", () => {
    expect(spread(1)).toBeGreaterThan(0);
    expect(spread(-1)).toBeLessThan(0);
    expect(spread(1)).toBeCloseTo(-spread(-1), 12);
  });

  it("peaks just outside the hovered mark, where the room is wanted", () => {
    expect(spread(YEAR.SIGMA_PUSH)).toBeCloseTo(1, 9);
    expect(spread(0.4)).toBeLessThan(spread(YEAR.SIGMA_PUSH));
    expect(spread(2.6)).toBeLessThan(spread(YEAR.SIGMA_PUSH));
  });

  it("returns the rest of the year to where it was", () => {
    // Everything past `REACH` sits on its own slot, so the ring keeps its
    // rhythm and only the neighbourhood breathes.
    expect(spread(YEAR.REACH + 0.001)).toBe(0);
    expect(Math.abs(spread(YEAR.REACH))).toBeLessThan(0.005);
  });

  it("opens up about the air the growth takes", () => {
    // Nearly a slot each side against 5.5 units of extra width: the two have
    // to stay in step or the hovered day either eats its neighbours or floats
    // in a gap of its own.
    const slot = (2 * Math.PI * YEAR.DAY_INNER) / 365;
    const extra = YEAR.DAY_WIDTH * YEAR.GROW_WIDTH;
    expect(2 * YEAR.PUSH * slot).toBeGreaterThan(extra);
    expect(2 * YEAR.PUSH * slot).toBeLessThan(extra * 2.5);
  });
});

/* -------------------------------- yearAtPoint ------------------------------ */

describe("yearAtPoint", () => {
  it("is continuous where `dayAtPoint` steps", () => {
    // The bulge is drawn from this and the readout from the integer: quantise
    // the bulge and it lurches a slot at a time under a smoothly moving
    // pointer, which is the one thing a magnifier must not do.
    const days = 365;
    const seen = [0.1, 0.5, 0.9].map((f) => {
      const p = polar(YEAR.DAY_INNER, yearAngle(100 + f, days));
      return yearAtPoint(p.x, p.y, days);
    });
    expect(seen[0]).toBeCloseTo(100.1, 6);
    expect(seen[1]).toBeCloseTo(100.5, 6);
    expect(seen[2]).toBeCloseTo(100.9, 6);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true);
  });

  it("agrees with `dayAtPoint` on which slot it is", () => {
    const days = 366;
    const offenders: string[] = [];
    for (let i = 0; i < days; i++) {
      const p = polar(YEAR.DAY_INNER, dayAngle(i, days));
      if (Math.floor(yearAtPoint(p.x, p.y, days)) !== dayAtPoint(p.x, p.y, days)) {
        offenders.push(`day ${i}`);
      }
    }
    expect(offenders.slice(0, 5), `${offenders.length} offender(s)`).toEqual([]);
  });
});

/* --------------------------------- unroller -------------------------------- */

describe("faceToPanel", () => {
  it("centres the face on the long side of the panel", () => {
    const wide = faceToPanel(1000, 600);
    // The face is scaled to the shorter side, so `u` follows the height…
    expect(wide.u).toBeCloseTo(600 / VIEW_SIZE, 9);
    // …and the centre of the viewBox lands on the centre of the panel.
    const middle = wide.at(DIAL.C, DIAL.C);
    expect(middle.x).toBeCloseTo(500, 6);
    expect(middle.y).toBeCloseTo(300, 6);
  });

  it("is the same mapping in portrait", () => {
    const tall = faceToPanel(600, 1000);
    const middle = tall.at(DIAL.C, DIAL.C);
    expect(middle.x).toBeCloseTo(300, 6);
    expect(middle.y).toBeCloseTo(500, 6);
  });
});

describe("unroller", () => {
  const TOP = { x: 500, y: 100 };
  const ROW = { x: 40, y: 700 };
  const R = 400;
  const LENGTH = 900;
  const DAYS = 365;

  it("is exactly the ring at t = 0", () => {
    // The whole transition hangs on this: one pixel of mismatch on the first
    // frame is a visible jump out of the drawing it is supposed to continue.
    const roll = unroller(0, TOP, ROW, R, LENGTH);
    const centre = { x: TOP.x, y: TOP.y + R };
    const offenders: string[] = [];
    for (let i = 0; i < DAYS; i++) {
      const { point, out } = roll((i + 0.5) / DAYS);
      const p = polar(R, dayAngle(i, DAYS));
      // `polar` works in the dial's own frame; compare against the same
      // circle re-centred on the anchor.
      const want = { x: centre.x + (p.x - DIAL.C), y: centre.y + (p.y - DIAL.C) };
      if (Math.hypot(point.x - want.x, point.y - want.y) > 1e-6) {
        offenders.push(`day ${i}: ${JSON.stringify(point)} vs ${JSON.stringify(want)}`);
      }
      // The normal points away from the centre, which is what a mark grows
      // along.
      const radial = { x: (want.x - centre.x) / R, y: (want.y - centre.y) / R };
      if (Math.abs(out.x - radial.x) > 1e-9 || Math.abs(out.y - radial.y) > 1e-9) {
        offenders.push(`day ${i} normal`);
      }
    }
    expect(offenders.slice(0, 5), `${offenders.length} offending day(s)`).toEqual([]);
  });

  it("is exactly the line at t = 1", () => {
    const roll = unroller(1, TOP, ROW, R, LENGTH);
    expect(roll(0).point).toEqual(ROW);
    expect(roll(1).point.x).toBeCloseTo(ROW.x + LENGTH, 9);
    expect(roll(1).point.y).toBeCloseTo(ROW.y, 9);
    expect(roll(0.5).out).toEqual({ x: 0, y: -1 });
  });

  it("keeps 1 January on the anchor at every step", () => {
    for (const t of [0, 0.1, 0.37, 0.8, 1]) {
      const head = unroller(t, TOP, ROW, R, LENGTH)(0).point;
      expect.soft(head.x).toBeCloseTo(TOP.x + (ROW.x - TOP.x) * t, 9);
      expect.soft(head.y).toBeCloseTo(TOP.y + (ROW.y - TOP.y) * t, 9);
    }
  });

  it("flattens monotonically — the year never bends back on itself", () => {
    // Curvature is `(1 - t) / radius`, so the total angle the year subtends
    // has to fall to zero. Measured as how far the last day has swung.
    let previous = Infinity;
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const roll = unroller(t, TOP, ROW, R, LENGTH);
      const head = roll(0).point;
      const tail = roll(1).point;
      const swing = Math.abs(Math.atan2(tail.y - head.y, tail.x - head.x));
      expect.soft(swing).toBeLessThanOrEqual(previous + 1e-9);
      previous = swing;
    }
  });

  it("never leaves a hole where the curvature underflows", () => {
    // `1 / k` is not a number at t = 1 and is enormous just before it. Every
    // step has to stay finite, or the last few frames throw the year off the
    // canvas instead of landing it.
    const offenders: string[] = [];
    for (let n = 0; n <= 200; n++) {
      const t = n / 200;
      const roll = unroller(t, TOP, ROW, R, LENGTH);
      for (const at of [0, 0.25, 0.5, 0.75, 1]) {
        const { point } = roll(at);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          offenders.push(`t=${t} at=${at}`);
        }
      }
    }
    expect(offenders.slice(0, 5), `${offenders.length} bad frame(s)`).toEqual([]);
  });
});
