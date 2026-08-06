import { describe, expect, it } from "vitest";
import "./helpers";
import { angleAt, arcPath, capInset, DIAL, minutesAtPoint, polar, seamTrim } from "@/lib/dial";
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
