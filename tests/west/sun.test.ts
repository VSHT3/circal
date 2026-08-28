import { describe, expect, it } from "vitest";
import { dayLength, type Place } from "@/lib/sun";
import { day } from "../helpers";

/* ------------------------------------------------------------------ *
 * `dayLength` is day-keyed: `sunTimes` frames its answer against the
 * *viewer's* local midnight, and the year ring calls it once per day of a
 * year. So it gets the west-of-UTC re-run every day-keyed function in this
 * suite gets. This file runs under TZ=America/Los_Angeles.
 * ------------------------------------------------------------------ */

const BERLIN: Place = { lat: 52.52, lon: 13.405, label: "Berlin" };
const SEATTLE: Place = { lat: 47.6062, lon: -122.3321, label: "Seattle" };

describe("dayLength, west of UTC", () => {
  it("is the same length for a place whichever side of the meridian the viewer sits", () => {
    // The pair of instants shifts with the viewer's midnight; the gap between
    // them is a fact about the place, and must not.
    expect(dayLength(day("2026-06-21"), BERLIN)).toBeGreaterThan(16 * 60);
    expect(dayLength(day("2026-12-21"), BERLIN)).toBeLessThan(8 * 60);
  });

  it("runs long in midsummer and short in midwinter for a local place too", () => {
    const june = dayLength(day("2026-06-21"), SEATTLE);
    const december = dayLength(day("2026-12-21"), SEATTLE);
    expect(june).toBeGreaterThan(15 * 60);
    expect(december).toBeLessThan(9 * 60);
  });

  it("never leaves a day, on either solstice", () => {
    for (const date of ["2026-06-21", "2026-12-21"]) {
      for (const place of [BERLIN, SEATTLE]) {
        const length = dayLength(day(date), place);
        expect(length).toBeGreaterThanOrEqual(0);
        expect(length).toBeLessThanOrEqual(1440);
      }
    }
  });
});
