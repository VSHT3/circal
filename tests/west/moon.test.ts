import { describe, expect, it } from "vitest";
import { moonForDay, moonPhase } from "@/lib/moon";
import { at, day } from "../helpers";

/* ------------------------------------------------------------------ *
 * `moonForDay` is day-keyed local-time arithmetic — it reads `day`'s own
 * `getFullYear`/`getMonth`/`getDate` and rebuilds local noon from them —
 * so it gets the same west-of-UTC re-run every other day-keyed function in
 * this suite gets. This file runs under TZ=America/Los_Angeles.
 * ------------------------------------------------------------------ */

describe("moonForDay evaluates at local noon, west of UTC", () => {
  it("agrees with moonPhase at that day's local noon", () => {
    const noon = at("2026-03-08 12:00");
    expect(moonForDay(day("2026-03-08"))).toEqual(moonPhase(noon));
  });

  it("two adjacent days differ by roughly 1/SYNODIC_DAYS of a cycle", () => {
    const a = moonForDay(day("2026-03-08"));
    const b = moonForDay(day("2026-03-09"));
    const delta = (((b.phase - a.phase) % 1) + 1) % 1;
    // Same band as tests/moon.test.ts (~0.0339 of a cycle per day, with
    // day-to-day slack for the true rate's own wander) — the point here is
    // that it holds identically on the other side of the meridian, not
    // that this zone gets its own tolerance.
    expect(delta).toBeGreaterThan(0.02);
    expect(delta).toBeLessThan(0.05);
  });
});
