import { describe, expect, it } from "vitest";
import { moonForDay, moonPhase, nextPhase, SYNODIC_DAYS, type MoonName } from "@/lib/moon";
import { at, day } from "./helpers";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/* ------------------------------ reference anchors ---------------------------- */

describe("moonPhase reference anchors", () => {
  it("the standard epoch new moon, 2000-01-06 18:14 UTC", () => {
    // `Date.UTC` is correct here, deliberately, and the only place in this
    // file it is: the published instant is UTC, and `at()` would parse the
    // stamp as *local* time and silently shift it by this process's own
    // offset — exactly the bug `at()`'s own doc comment exists to prevent.
    const anchor = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)));
    expect(anchor.illumination).toBeLessThan(0.001);
    expect(Math.min(anchor.phase, 1 - anchor.phase)).toBeLessThan(0.002);
  });

  // Five more published new/full moon instants (Universal Time), spanning
  // 1990-2030, sourced from Fred Espenak / astropixels.com, "Moon Phases:
  // 1901 to 2000" and "Moon Phases: 2001 to 2100" —
  // https://astropixels.com/ephemeris/phasescat/phases1901.html and
  // .../phases2001.html. Each is located by searching forward from a
  // round date several weeks earlier, the way a real caller would.
  it.each([
    {
      name: "New moon 1990-01-26 19:20 UT",
      target: 0 as const,
      from: "1990-01-01",
      want: Date.UTC(1990, 0, 26, 19, 20),
    },
    {
      name: "Full moon 1993-06-04 13:02 UT",
      target: 0.5 as const,
      from: "1993-05-10",
      want: Date.UTC(1993, 5, 4, 13, 2),
    },
    {
      name: "New moon 2001-01-24 13:07 UT",
      target: 0 as const,
      from: "2001-01-01",
      want: Date.UTC(2001, 0, 24, 13, 7),
    },
    {
      name: "Full moon 2010-08-24 17:05 UT",
      target: 0.5 as const,
      from: "2010-08-01",
      want: Date.UTC(2010, 7, 24, 17, 5),
    },
    {
      name: "Full moon 2030-01-19 15:54 UT",
      target: 0.5 as const,
      from: "2030-01-01",
      want: Date.UTC(2030, 0, 19, 15, 54),
    },
  ])("$name, located by nextPhase within 2 hours", ({ target, from, want }) => {
    const got = nextPhase(day(from), target).getTime();
    expect.soft(Math.abs(got - want) / MS_PER_HOUR).toBeLessThan(2);
  });
});

/* -------------------------- nextPhase round trip ----------------------------- */

describe("nextPhase round trip: 200 consecutive new moons from 2000", () => {
  const start = new Date(Date.UTC(2000, 0, 6, 18, 14)); // the same epoch anchor above
  const steps: Date[] = [];
  let cursor = start;
  for (let i = 0; i < 200; i++) {
    cursor = nextPhase(cursor, 0);
    steps.push(cursor);
  }

  it("each step is 29.27…29.83 days after the last — the synodic month's own spread", () => {
    let prev = start;
    for (const next of steps) {
      const gapDays = (next.getTime() - prev.getTime()) / MS_PER_DAY;
      expect.soft(gapDays).toBeGreaterThanOrEqual(29.27);
      expect.soft(gapDays).toBeLessThanOrEqual(29.83);
      prev = next;
    }
  });

  it("the mean gap converges far tighter than any single step, toward SYNODIC_DAYS", () => {
    const totalDays = (steps[steps.length - 1].getTime() - start.getTime()) / MS_PER_DAY;
    const meanDays = totalDays / steps.length;
    // 200 cycles is ~16.17 years — not a whole number of years — so the
    // annual term in `trueElongation` does not fully cancel between the
    // first and last instant; a couple of minutes of residual bias is the
    // correct, physical answer for *this* start and *this* N, not a bug
    // (running 201 steps from the same start lands under half a minute —
    // the boundary term is bounded, not zero, and N=200 does not happen to
    // land on its own zero crossing). What a mean-phase-only model could
    // never produce is the *per-step* spread asserted above: every one of
    // its 200 gaps would read exactly 29.530588853, with no spread at all.
    expect(Math.abs(meanDays - SYNODIC_DAYS) * 1440).toBeLessThan(1.5);
  });
});

/* ------------------------------ illumination shape ---------------------------- */

describe("illumination", () => {
  it("rises monotonically from new to full, then falls monotonically back", () => {
    const cycleStart = new Date(Date.UTC(2000, 0, 6, 18, 14));
    const cycleEnd = nextPhase(cycleStart, 0);
    const stepMs = 6 * MS_PER_HOUR;
    const samples: number[] = [];
    for (let t = cycleStart.getTime(); t < cycleEnd.getTime(); t += stepMs) {
      samples.push(moonPhase(new Date(t)).illumination);
    }
    // Unimodal, not "before/after the phase-0.5 threshold": the true peak
    // can fall anywhere inside a 6-hour sampling gap, and pinning the split
    // to whichever sample first reads phase >= 0.5 is a coin flip on which
    // side of the peak that particular sample landed.
    let peak = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i] > samples[peak]) peak = i;
    for (let i = 1; i <= peak; i++) expect.soft(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    for (let i = peak + 1; i < samples.length; i++)
      expect.soft(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
  });

  it("stays within [0, 1], and phase within [0, 1), for 10,000 samples across a century", () => {
    const from = Date.UTC(1950, 0, 1);
    const to = Date.UTC(2050, 0, 1);
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const t = from + ((to - from) * i) / (n - 1);
      const p = moonPhase(new Date(t));
      expect(p.illumination).toBeGreaterThanOrEqual(0);
      expect(p.illumination).toBeLessThanOrEqual(1);
      expect(p.phase).toBeGreaterThanOrEqual(0);
      expect(p.phase).toBeLessThan(1);
    }
  });
});

/* ---------------------------------- waxing ------------------------------------ */

describe("waxing", () => {
  it("agrees with illumination's own direction, sampled every 6 hours across a cycle", () => {
    const cycleStart = new Date(Date.UTC(2000, 0, 6, 18, 14));
    const cycleEnd = nextPhase(cycleStart, 0);
    const stepMs = 6 * MS_PER_HOUR;
    const samples = [];
    for (let t = cycleStart.getTime(); t < cycleEnd.getTime(); t += stepMs) {
      samples.push(moonPhase(new Date(t)));
    }
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      // Skip the one pair straddling the exact new/full instant — `waxing`
      // flips there, but which of two adjacent 6-hour samples sits nearer
      // the true turning point is a discretisation accident, not something
      // the flag promises (the unimodal shape test above already covers
      // the turning point itself, without that accident).
      if (prev.waxing !== cur.waxing) continue;
      if (cur.waxing) expect.soft(cur.illumination).toBeGreaterThanOrEqual(prev.illumination);
      else expect.soft(cur.illumination).toBeLessThanOrEqual(prev.illumination);
    }
  });
});

/* ----------------------------------- names ------------------------------------- */

/**
 * A local twin of `nextPhase`'s bisection, generalised to any target phase
 * in [0, 1) rather than just 0 and 0.5 — `nextPhase` itself only ever
 * promises new and full. Exists solely to manufacture a precise
 * first/last-quarter instant for the name-band tests below.
 */
function exactPhaseInstant(near: Date, target: number): Date {
  const current = moonPhase(near).phase;
  let deltaCycles = (((target - current) % 1) + 1) % 1;
  if (deltaCycles * SYNODIC_DAYS < 2) deltaCycles += 1;
  const guessMs = near.getTime() + deltaCycles * SYNODIC_DAYS * MS_PER_DAY;
  let lo = guessMs - 1.5 * MS_PER_DAY;
  let hi = guessMs + 1.5 * MS_PER_DAY;
  const offset = (t: number) => {
    const raw = moonPhase(new Date(t)).phase - target;
    return ((((raw + 0.5) % 1) + 1) % 1) - 0.5;
  };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (offset(mid) < 0) lo = mid;
    else hi = mid;
  }
  return new Date(Math.round((lo + hi) / 2));
}

describe("moon names", () => {
  it("produces all eight names across one cycle, sampled every 3 hours", () => {
    const cycleStart = new Date(Date.UTC(2000, 0, 6, 18, 14));
    const cycleEnd = nextPhase(cycleStart, 0);
    const stepMs = 3 * MS_PER_HOUR;
    const seen = new Set<MoonName>();
    for (let t = cycleStart.getTime(); t < cycleEnd.getTime(); t += stepMs) {
      seen.add(moonPhase(new Date(t)).name);
    }
    const all: MoonName[] = [
      "New moon",
      "Waxing crescent",
      "First quarter",
      "Waxing gibbous",
      "Full moon",
      "Waning gibbous",
      "Last quarter",
      "Waning crescent",
    ];
    for (const name of all) expect.soft(seen.has(name)).toBe(true);
  });

  it.each([
    { name: "New moon" as const, target: 0 },
    { name: "First quarter" as const, target: 0.25 },
    { name: "Full moon" as const, target: 0.5 },
    { name: "Last quarter" as const, target: 0.75 },
  ])("$name holds at its instant and ±12h, but not ±3 days", ({ name, target }) => {
    const instant = exactPhaseInstant(new Date(Date.UTC(2000, 3, 1)), target);
    expect.soft(moonPhase(instant).name).toBe(name);
    expect.soft(moonPhase(new Date(instant.getTime() - 12 * MS_PER_HOUR)).name).toBe(name);
    expect.soft(moonPhase(new Date(instant.getTime() + 12 * MS_PER_HOUR)).name).toBe(name);
    expect.soft(moonPhase(new Date(instant.getTime() - 3 * MS_PER_DAY)).name).not.toBe(name);
    expect.soft(moonPhase(new Date(instant.getTime() + 3 * MS_PER_DAY)).name).not.toBe(name);
  });
});

/* -------------------------------- moonForDay ---------------------------------- */

describe("moonForDay", () => {
  it("evaluates at local noon of the given day", () => {
    const noon = at("2026-03-08 12:00");
    expect(moonForDay(day("2026-03-08"))).toEqual(moonPhase(noon));
  });

  it("two adjacent days differ by roughly 1/SYNODIC_DAYS of a cycle", () => {
    const a = moonForDay(day("2026-03-08"));
    const b = moonForDay(day("2026-03-09"));
    const delta = (((b.phase - a.phase) % 1) + 1) % 1;
    // ~0.0339 of a cycle per day on average; the true rate wanders enough
    // day to day that a tight band would be asserting the mean, not the
    // day — this just rules out "barely moved" and "wrapped an extra cycle".
    expect(delta).toBeGreaterThan(0.02);
    expect(delta).toBeLessThan(0.05);
  });
});
