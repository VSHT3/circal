import { describe, expect, it } from "vitest";
import {
  WEEK_CAPTION_H,
  WEEK_DAYS,
  WEEK_META_H,
  WEEK_MIN_FACE,
  weekDays,
  weekFaceCentre,
  weekLayout,
  weekStage,
  weekZoomScale,
  type WeekLayout,
} from "@/lib/week";
import { dayKey } from "@/lib/time";
import { day, show } from "./helpers";

/** Every face's box, in the panel coordinates the view positions them at. */
function boxes(layout: WeekLayout) {
  return Array.from({ length: WEEK_DAYS }, (_, i) => {
    const c = weekFaceCentre(layout, i);
    return {
      left: c.x - layout.size / 2,
      right: c.x + layout.size / 2,
      top: c.y - layout.size / 2,
      bottom: c.y + layout.size / 2,
    };
  });
}

/* --------------------------------- weekDays -------------------------------- */

describe("weekDays", () => {
  it("is seven consecutive local midnights from the Monday given", () => {
    const days = weekDays(day("2026-08-03"));
    expect(days.map(dayKey)).toEqual([
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  // Berlin springs forward on 2026-03-29, inside this week. Stepping in
  // milliseconds would put the last two days an hour before midnight, which
  // keys them to the day before.
  it("stays on local midnight through a spring-forward week", () => {
    for (const d of weekDays(day("2026-03-23"))) {
      expect.soft(d.getHours(), show(d)).toBe(0);
      expect.soft(d.getMinutes(), show(d)).toBe(0);
    }
  });
});

/* -------------------------------- weekLayout ------------------------------- */

describe("weekLayout", () => {
  /** The chrome a group costs: one readout, and one caption per row. */
  const CHROME = WEEK_CAPTION_H + WEEK_META_H;

  it("deals the seven into rows that add up, widest first", () => {
    for (const [w, h] of [
      [1400, 700],
      [1400, 300],
      [700, 700],
      [400, 1400],
      [390, 600],
      [200, 2000],
    ]) {
      const { rows } = weekLayout(w, h);
      expect
        .soft(
          rows.reduce((a, b) => a + b, 0),
          `${w}x${h}`,
        )
        .toBe(WEEK_DAYS);
      // Never a row wider than the one above it: the ragged row belongs at
      // the bottom, and a short row followed by a full one reads as a gap.
      for (let i = 1; i < rows.length; i += 1) {
        expect.soft(rows[i], `${w}x${h}`).toBeLessThanOrEqual(rows[i - 1]);
      }
    }
  });

  // The whole reason this is not a single row any more. Seven across a
  // landscape window is a seventh of it, whatever the height says; wrapping is
  // what buys the diameter the arcs are read at.
  it("wraps a landscape box rather than conceding the face to a seventh of it", () => {
    const layout = weekLayout(1400, 700);
    expect(layout.rows.length).toBeGreaterThan(1);
    expect(layout.size).toBeGreaterThan(1400 / WEEK_DAYS);
  });

  it("goes the other way in a column, and stays one row where a row is biggest", () => {
    expect(weekLayout(400, 1400).rows.length).toBeGreaterThanOrEqual(4);
    // Flat and wide: any second row costs more height than the box has left.
    expect(weekLayout(1400, 120 + CHROME).rows).toEqual([WEEK_DAYS]);
  });

  it("keeps every face inside the box, and none of them overlapping", () => {
    for (const [w, h] of [
      [1400, 700],
      [1000, 900],
      [700, 700],
      [400, 1400],
    ]) {
      const layout = weekLayout(w, h);
      const cells = boxes(layout);
      for (const cell of cells) {
        expect.soft(cell.left, `${w}x${h}`).toBeGreaterThanOrEqual(-1e-9);
        expect.soft(cell.right, `${w}x${h}`).toBeLessThanOrEqual(w + 1e-9);
        // The caption above the first row is inside the group too.
        expect.soft(cell.top - WEEK_CAPTION_H, `${w}x${h}`).toBeGreaterThanOrEqual(-1e-9);
        expect.soft(cell.bottom, `${w}x${h}`).toBeLessThanOrEqual(h - WEEK_META_H + 1e-9);
      }
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) {
          const apart =
            cells[j].left >= cells[i].right - 1e-9 ||
            cells[i].left >= cells[j].right - 1e-9 ||
            cells[j].top >= cells[i].bottom - 1e-9 ||
            cells[i].top >= cells[j].bottom - 1e-9;
          expect.soft(apart, `${w}x${h}: ${i} and ${j}`).toBe(true);
        }
      }
    }
  });

  it("centres every row on its own, so the short one sits under the middle", () => {
    const layout = weekLayout(1400, 700);
    const cells = boxes(layout);
    let first = 0;
    for (const count of layout.rows) {
      const row = cells.slice(first, first + count);
      const left = row[0].left;
      const right = 1400 - row[row.length - 1].right;
      expect.soft(left, `row of ${count}`).toBeCloseTo(right);
      first += count;
    }
  });

  it("centres the group in the box while it fits, and hard-tops it once it scrolls", () => {
    const roomy = weekLayout(1400, 700);
    expect(roomy.scrolls).toBe(false);
    expect(roomy.groupTop * 2 + roomy.groupHeight).toBeCloseTo(700);

    const phone = weekLayout(390, 600);
    expect(phone.scrolls).toBe(true);
    // A scroll container that starts part-way in opens on half of Monday.
    expect(phone.groupTop).toBe(0);
    expect(phone.groupHeight).toBeGreaterThan(600);
  });

  // The whole point of the scroll: below this a face is smaller than the arcs
  // drawn on it, and seven of those is a grid of smudges.
  it("scrolls rather than shrinking a face below the floor", () => {
    expect(weekLayout(390, 600).size).toBeGreaterThanOrEqual(WEEK_MIN_FACE);
  });

  it("does not claim to scroll when the box is too short for a floor-sized face either", () => {
    // Nothing is gained by scrolling a grid that cannot show a usable face in
    // the height it has: it would scroll *and* still be too small.
    const squashed = weekLayout(390, WEEK_MIN_FACE - 40 + CHROME);
    expect(squashed.scrolls).toBe(false);
    expect(squashed.size).toBeLessThan(WEEK_MIN_FACE);
  });

  it("never returns a negative size for a box with no room in it", () => {
    for (const [w, h] of [
      [0, 0],
      [100, 0],
      [0, 100],
      [100, WEEK_CAPTION_H - 5],
    ]) {
      expect.soft(weekLayout(w, h).size, `${w}x${h}`).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------ weekFaceCentre ----------------------------- */

describe("weekFaceCentre", () => {
  const layout = weekLayout(1400, 700);

  it("puts the days in reading order: along a row, then down", () => {
    const cells = boxes(layout);
    let first = 0;
    for (const count of layout.rows) {
      for (let i = 1; i < count; i += 1) {
        const prev = cells[first + i - 1];
        const here = cells[first + i];
        expect.soft(here.left - prev.left).toBeCloseTo(layout.pitch);
        expect.soft(here.top).toBeCloseTo(prev.top);
      }
      if (first > 0) {
        expect.soft(cells[first].top - cells[first - 1].top).toBeCloseTo(layout.rowPitch);
      }
      first += count;
    }
  });

  it("leaves the caption's height above every row", () => {
    const cells = boxes(layout);
    let first = 0;
    for (const count of layout.rows) {
      // The row above ends `rowPitch` back, and the caption is what the gap
      // between two faces is mostly made of.
      const gap = first === 0 ? cells[0].top - layout.groupTop : layout.rowPitch - layout.size;
      expect.soft(gap).toBeGreaterThanOrEqual(WEEK_CAPTION_H - 1e-9);
      first += count;
    }
  });
});

/* -------------------------------- weekStage -------------------------------- */

describe("weekStage", () => {
  it("starts on the week's Monday whichever day of it is selected", () => {
    for (const on of ["2026-08-03", "2026-08-06", "2026-08-09"]) {
      expect.soft(dayKey(weekStage(day(on), 1400, 700)!.from)).toBe("2026-08-03");
    }
  });

  it("lays out against the whole panel, readout included", () => {
    const stage = weekStage(day("2026-08-06"), 1400, 700)!;
    const { layout } = stage;
    expect(stage.box.height).toBe(700);
    // Every row's caption, every row's face, and the one readout: that is the
    // group, and the group is what is centred in the panel.
    const faces = layout.rows.length * (WEEK_CAPTION_H + layout.size);
    expect(layout.groupHeight).toBeGreaterThanOrEqual(faces + WEEK_META_H);
    expect(layout.groupTop * 2 + layout.groupHeight).toBeCloseTo(700);
  });

  it("is null before the panel has been measured, or when it is too short to hold a group", () => {
    expect(weekStage(day("2026-08-06"), 0, 0)).toBeNull();
    expect(weekStage(day("2026-08-06"), 1400, WEEK_CAPTION_H + WEEK_META_H - 1)).toBeNull();
  });
});

/* ------------------------------ weekZoomScale ------------------------------ */

describe("weekZoomScale", () => {
  // The zoom's contract: the dial drawn at this scale has the same diameter as
  // the face it is landing on. Anything else and the handover visibly jumps.
  it("scales the dial's drawn diameter to exactly one face", () => {
    const [w, h] = [1400, 700];
    const layout = weekLayout(w, h);
    const scale = weekZoomScale(layout, w, h);
    expect(Math.min(w, h) * scale).toBeCloseTo(layout.size);
  });

  it("is a modest zoom, not the life grid's two orders of magnitude", () => {
    const [w, h] = [1400, 700];
    const scale = weekZoomScale(weekLayout(w, h), w, h);
    expect(scale).toBeGreaterThan(0.1);
    expect(scale).toBeLessThan(1);
  });

  it("falls back to 1 rather than dividing by an unmeasured box", () => {
    expect(weekZoomScale(weekLayout(0, 0), 0, 0)).toBe(1);
  });
});
