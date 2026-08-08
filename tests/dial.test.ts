import { describe, expect, it } from "vitest";
import "./helpers";
import {
  ARC_LABEL_SIZE,
  DIAL,
  angleAt,
  arcLabel,
  arcPath,
  capInset,
  minutesAtPoint,
  polar,
  seamTrim,
} from "@/lib/dial";
import { MINUTES_PER_DAY } from "@/lib/time";

/* -------------------------- angleAt / minutesAtPoint ------------------------- */

describe("angleAt and minutesAtPoint are exact inverses", () => {
  // The whole drag-to-create feature depends on this holding for every
  // minute of the day, on both faces. Sweep all 1440 and report every minute
  // that fails to round-trip, rather than stopping at the first one.
  it.each(["12h", "24h"] as const)("holds for all 1440 minutes on the %s face", (clock) => {
    const offenders: string[] = [];
    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      const p = polar(DIAL.TRACK, angleAt(m, clock));
      const back = minutesAtPoint(p.x, p.y, clock);
      const diff = Math.min(Math.abs(back - m), MINUTES_PER_DAY - Math.abs(back - m));
      if (diff > 1e-6) offenders.push(`minute ${m} -> ${back}`);
    }
    expect(offenders.slice(0, 5), `${offenders.length} offending minute(s)`).toEqual([]);
  });
});

describe("the two faces differ only by origin", () => {
  it("puts noon at the top of the 12h face", () => {
    const top = polar(DIAL.TRACK, 0);
    expect(minutesAtPoint(top.x, top.y, "12h")).toBe(720);
  });

  it("puts midnight at the top of the 24h face", () => {
    const top = polar(DIAL.TRACK, 0);
    expect(minutesAtPoint(top.x, top.y, "24h")).toBe(0);
  });
});

describe("an event's arc length is clock-independent", () => {
  it.each([
    { name: "a mid-morning span", from: 100, to: 300 },
    { name: "a span crossing the 12h origin (noon)", from: 600, to: 800 },
    { name: "a span crossing the 24h origin (midnight)", from: 1400, to: 30 + MINUTES_PER_DAY },
  ])("$name has the same angular length on both faces", ({ from, to }) => {
    const span12 = angleAt(to, "12h") - angleAt(from, "12h");
    const span24 = angleAt(to, "24h") - angleAt(from, "24h");
    expect.soft(span12).toBeCloseTo(span24, 9);
  });
});

/* --------------------------------- arcPath ---------------------------------- */

describe("arcPath", () => {
  it("draws a full turn as two arc segments, not one degenerate arc", () => {
    const path = arcPath(DIAL.TRACK, 0, 360);
    expect(path.match(/A /g)).toHaveLength(2);
  });

  it("draws an ordinary arc as a single segment", () => {
    const path = arcPath(DIAL.TRACK, 0, 100);
    expect(path.match(/A /g)).toHaveLength(1);
  });

  it("flips the large-arc-flag above 180 degrees of sweep", () => {
    // `A rx ry x-rotation large-arc-flag sweep-flag x y`
    const under = arcPath(DIAL.TRACK, 0, 100).match(/A [\d.]+ [\d.]+ 0 (\d) 1/);
    const over = arcPath(DIAL.TRACK, 0, 200).match(/A [\d.]+ [\d.]+ 0 (\d) 1/);
    expect.soft(under?.[1]).toBe("0");
    expect.soft(over?.[1]).toBe("1");
  });

  it("flips exactly at the 180 degree boundary", () => {
    const at180 = arcPath(DIAL.TRACK, 0, 180).match(/A [\d.]+ [\d.]+ 0 (\d) 1/);
    expect(at180?.[1]).toBe("0");
  });
});

/* ---------------------------------- polar ------------------------------------ */

describe("polar", () => {
  it.each([
    { name: "0 degrees is 12 o'clock (up, negative y)", deg: 0, x: 500, y: 400 },
    { name: "90 degrees is 3 o'clock (right)", deg: 90, x: 600, y: 500 },
    { name: "180 degrees is 6 o'clock (down, positive y)", deg: 180, x: 500, y: 600 },
    { name: "270 degrees is 9 o'clock (left)", deg: 270, x: 400, y: 500 },
  ])("$name", ({ deg, x, y }) => {
    const p = polar(100, deg);
    expect.soft(p.x).toBeCloseTo(x, 9);
    expect.soft(p.y).toBeCloseTo(y, 9);
  });
});

/* ----------------------------- capInset / seamTrim ---------------------------- */

describe("capInset", () => {
  it("shrinks as the radius grows — the overhang is a fixed arc length, not a fixed angle", () => {
    expect(capInset(200)).toBeGreaterThan(capInset(400));
  });
});

describe("seamTrim", () => {
  it("is zero when there is nothing beside the arc (gap = Infinity)", () => {
    expect(seamTrim(DIAL.TRACK, Infinity)).toBe(0);
  });

  it("is positive for two events that abut exactly (gap = 0)", () => {
    expect(seamTrim(DIAL.TRACK, 0)).toBeGreaterThan(0);
  });

  it("floors at zero once the neighbouring gap already exceeds the seam", () => {
    expect(seamTrim(DIAL.TRACK, 1000)).toBe(0);
  });
});

/* --------------------------------- arcLabel ---------------------------------- */

/** The glyph budget the label maths gives an arc, from the outside in. */
function budget(r: number, sweepDeg: number): number {
  const label = arcLabel(r, 0, sweepDeg, "x".repeat(80));
  return label ? label.text.length : 0;
}

describe("arcLabel decides by glyphs, not by minutes", () => {
  // The whole reason the gate is not a duration: the same hour is a different
  // amount of paint on every lane, so a minute threshold would label an event
  // at the rim and crop the same event two lanes in.
  it("gives the same duration a smaller budget on an inner lane", () => {
    const hour = angleAt(60) - angleAt(0);
    const outer = budget(DIAL.LANE, hour);
    const inner = budget(DIAL.LANE - 4 * DIAL.LANE_STEP, hour);
    expect.soft(outer).toBeGreaterThan(inner);
    expect.soft(inner).toBeGreaterThan(0);
  });

  // Where the gate lands in minutes is a consequence, not a setting: half an
  // hour is five glyphs at the rim and under the floor two lanes in.
  it("labels a half hour on the outer lane and refuses it on an inner one", () => {
    const half = angleAt(30) - angleAt(0);
    expect.soft(arcLabel(DIAL.LANE, 0, half, "Standup")).not.toBeNull();
    expect.soft(arcLabel(DIAL.LANE - 2 * DIAL.LANE_STEP, 0, half, "Standup")).toBeNull();
  });

  it("refuses an arc too short to hold five glyphs", () => {
    // A fifteen-minute arc on the innermost lane: 3.75°, about 12 units of
    // paint.
    const quarter = angleAt(15) - angleAt(0);
    expect(arcLabel(DIAL.LANE - 4 * DIAL.LANE_STEP, 0, quarter, "Standup")).toBeNull();
  });

  it("refuses an untitled event rather than printing an ellipsis", () => {
    expect(arcLabel(DIAL.LANE, 0, 90, "   ")).toBeNull();
  });

  it("keeps a title that fits, whole", () => {
    expect(arcLabel(DIAL.LANE, 0, 90, "Lunch")?.text).toBe("Lunch");
  });

  it("cuts a title to the budget, the ellipsis counted", () => {
    const room = budget(DIAL.LANE, 30);
    const label = arcLabel(DIAL.LANE, 0, 30, "Quarterly planning review");
    expect.soft(label?.text).toHaveLength(room);
    expect.soft(label?.text.endsWith("…")).toBe(true);
  });

  it("scales the budget with the sweep", () => {
    expect(budget(DIAL.LANE, 90)).toBeGreaterThan(budget(DIAL.LANE, 45));
  });

  it("fits inside the stroke it is drawn in", () => {
    // The label's whole claim: 11 units of type inside a 14-unit arc, so it
    // costs no radius and reads the same on every lane.
    expect(ARC_LABEL_SIZE * 0.7).toBeLessThan(DIAL.ARC_WIDTH);
  });
});

describe("arcLabel makes room for a mark without costing the name", () => {
  // Two glyphs, the gap included — see ARC_MARK_GLYPHS. Asserted through the
  // public answer rather than the constant, so the trade stays visible.
  const MARK_COST = 2;

  it("takes the mark's glyphs out of the title's budget", () => {
    const plain = arcLabel(DIAL.LANE, 0, 90, "x".repeat(80));
    const marked = arcLabel(DIAL.LANE, 0, 90, "x".repeat(80), "barbell");
    expect.soft(marked?.text).toHaveLength((plain?.text.length ?? 0) - MARK_COST);
    expect.soft(marked?.mark).not.toBeNull();
  });

  // The rule the whole feature turns on: a symbol shared with everything on
  // one calendar is worth less than the last two characters of a name.
  it("drops the mark rather than the name when the arc is tight", () => {
    const half = angleAt(30) - angleAt(0);
    const marked = arcLabel(DIAL.LANE, 0, half, "Standup", "barbell");
    expect.soft(marked).not.toBeNull();
    expect.soft(marked?.mark).toBeNull();
    // And it kept every glyph it would have had with no mark asked for.
    expect.soft(marked?.text).toBe(arcLabel(DIAL.LANE, 0, half, "Standup")?.text);
  });

  it("leaves an unmarked label centred, and pushes a marked one along", () => {
    expect.soft(arcLabel(DIAL.LANE, 0, 90, "Lunch")?.startOffset).toBe(50);
    expect.soft(arcLabel(DIAL.LANE, 0, 90, "Lunch", "🍜")?.startOffset).toBeGreaterThan(50);
  });

  it("puts the mark on the arc's own radius", () => {
    const at = arcLabel(DIAL.LANE, 0, 90, "Lunch", "fork-knife")?.mark;
    expect(at).not.toBeUndefined();
    // The glyph rides inside the stroke exactly as the name does — it costs no
    // radius, which is the whole claim the label already makes for itself.
    expect(Math.hypot((at?.x ?? 0) - DIAL.C, (at?.y ?? 0) - DIAL.C)).toBeCloseTo(DIAL.LANE, 6);
  });

  /**
   * The mark leads the name, and "leads" is a fact about *reading* order, not
   * about the sweep: the label reverses its path through the bottom half so
   * the glyphs stay upright, and the mark has to reverse with it. The top and
   * the bottom are the two places where reading order is horizontal, so at
   * both of them leading means sitting to the left — even though at the top
   * that is the smaller angle and at the bottom it is the larger one.
   */
  it.each([
    { name: "above the horizontal", from: 0, to: 90, mid: 45, upright: true },
    { name: "through the bottom", from: 160, to: 200, mid: 180, upright: false },
  ])("keeps the mark left of the name $name", ({ from, to, mid, upright }) => {
    const at = arcLabel(DIAL.LANE, from, to, "Dinner", "fork-knife")?.mark;
    expect.soft(at?.x).toBeLessThan(polar(DIAL.LANE, mid).x);
    // And it is turned the same way the letters beside it are: radially on the
    // clockwise path, and half a turn over on the one that had to flip.
    expect.soft(Math.abs((at?.rotate ?? 0) - mid) < 90).toBe(upright);
  });

  it("ignores a mark on an arc that gets no label at all", () => {
    const quarter = angleAt(15) - angleAt(0);
    expect(arcLabel(DIAL.LANE - 4 * DIAL.LANE_STEP, 0, quarter, "Standup", "barbell")).toBeNull();
  });
});

describe("arcLabel turns its path through the bottom of the face", () => {
  /** Sweep flag of the first arc command — 1 clockwise, 0 anticlockwise. */
  function direction(d: string): string | undefined {
    return /A [\d.]+ [\d.]+ 0 \d (\d)/.exec(d)?.[1];
  }

  it.each([
    { name: "the top", from: -20, to: 20, flag: "1" },
    { name: "just past three o'clock", from: 95, to: 130, flag: "0" },
    { name: "the bottom", from: 170, to: 190, flag: "0" },
    { name: "just past nine o'clock", from: 275, to: 310, flag: "1" },
  ])("runs clockwise at $name only above the horizontal", ({ from, to, flag }) => {
    const label = arcLabel(DIAL.LANE, from, to, "Meeting");
    expect(direction(label?.d ?? "")).toBe(flag);
  });

  it("starts a reversed path at the arc's far end", () => {
    const forward = arcPath(DIAL.LANE, 170, 190);
    const back = arcPath(DIAL.LANE, 170, 190, true);
    expect.soft(back).not.toBe(forward);
    // Same two endpoints, swapped: a reversed path traces the same arc.
    const ends = (d: string) => /^M ([\d.-]+) ([\d.-]+) A .* ([\d.-]+) ([\d.-]+)$/.exec(d);
    const f = ends(forward);
    const b = ends(back);
    expect.soft(Number(b?.[1])).toBeCloseTo(Number(f?.[3]), 6);
    expect.soft(Number(b?.[2])).toBeCloseTo(Number(f?.[4]), 6);
    expect.soft(Number(b?.[3])).toBeCloseTo(Number(f?.[1]), 6);
    expect.soft(Number(b?.[4])).toBeCloseTo(Number(f?.[2]), 6);
  });

  it("still draws a full turn as two segments when reversed", () => {
    expect(arcPath(DIAL.TRACK, 0, 360, true).match(/A /g)).toHaveLength(2);
  });
});
