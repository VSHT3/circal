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
} from "@/lib/week";
import { dayKey } from "@/lib/time";
import { day, show } from "./helpers";

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
  it("fits seven faces and their gutters inside the width", () => {
    const layout = weekLayout(1400, 700);
    const used = layout.pitch * (WEEK_DAYS - 1) + layout.size;
    expect(layout.scrolls).toBe(false);
    expect(used).toBeLessThanOrEqual(1400 + 1e-9);
  });

  // Derived from the constants rather than hardcoded, so retuning the floor
  // or the gutter cannot quietly turn these into assertions about nothing.
  const roomy = Math.ceil(WEEK_MIN_FACE * (WEEK_DAYS + (WEEK_DAYS - 1) * 0.08)) + 40;

  /** The chrome a group costs on top of its faces. */
  const CHROME = WEEK_CAPTION_H + WEEK_META_H;

  it("is height-bound in a flat box and width-bound in a tall one", () => {
    expect(weekLayout(roomy, 90 + CHROME).size).toBeCloseTo(90);
    const tall = weekLayout(roomy, 900 + CHROME);
    expect(tall.scrolls).toBe(false);
    expect(tall.size).toBeLessThan(900);
  });

  it("centres the row while it fits and hard-lefts it once it scrolls", () => {
    // Height-bound, so the seven do not use the width and the slack is split.
    expect(weekLayout(roomy, 90 + CHROME).inset).toBeGreaterThan(0);
    const phone = weekLayout(390, 600);
    expect(phone.scrolls).toBe(true);
    expect(phone.inset).toBe(0);
  });

  // The whole point of the scroll: below this a face is smaller than the arcs
  // drawn on it, and seven of those is a row of smudges.
  it("scrolls rather than shrinking a face below the floor", () => {
    const phone = weekLayout(390, 600);
    expect(phone.size).toBeGreaterThanOrEqual(WEEK_MIN_FACE);
  });

  it("does not claim to scroll when the box is too short for a floor-sized face either", () => {
    // Nothing is gained by scrolling a strip that cannot show a usable face in
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
      expect.soft(weekLayout(w, h).size).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------ weekFaceCentre ----------------------------- */

describe("weekFaceCentre", () => {
  const layout = weekLayout(1400, 400);

  it("puts the seven centres one pitch apart, in order", () => {
    const xs = Array.from({ length: WEEK_DAYS }, (_, i) => weekFaceCentre(layout, i).x);
    for (let i = 1; i < xs.length; i += 1) {
      expect.soft(xs[i] - xs[i - 1]).toBeCloseTo(layout.pitch);
    }
  });

  it("shares one vertical centre — the whole strip is one row", () => {
    const ys = new Set(
      Array.from({ length: WEEK_DAYS }, (_, i) => weekFaceCentre(layout, i).y.toFixed(6)),
    );
    expect(ys.size).toBe(1);
  });

  it("keeps every face inside the box it was laid out in", () => {
    for (let i = 0; i < WEEK_DAYS; i += 1) {
      const { x } = weekFaceCentre(layout, i);
      expect.soft(x - layout.size / 2).toBeGreaterThanOrEqual(-1e-9);
      expect.soft(x + layout.size / 2).toBeLessThanOrEqual(1400 + 1e-9);
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
    expect(stage.box.height).toBe(700);
    // The three parts are the group, and the group is centred in the panel.
    expect(stage.layout.groupHeight).toBe(WEEK_CAPTION_H + stage.layout.size + WEEK_META_H);
    expect(stage.layout.groupTop * 2 + stage.layout.groupHeight).toBeCloseTo(700);
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
