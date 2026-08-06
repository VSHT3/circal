import { describe, expect, it } from "vitest";
import { placeForZone } from "@/lib/places";
import { sunTimes, type Place } from "@/lib/sun";
import { day } from "./helpers";

const BERLIN: Place = { lat: 52.52, lon: 13.405, label: "Berlin" };
const LONDON: Place = { lat: 51.5074, lon: -0.1278, label: "London" };

/* ------------------------------ reference values ----------------------------- */

describe("sunTimes reference values (this file runs under TZ=Europe/Berlin)", () => {
  // Published clock times, timeanddate.com, 2026. Berlin's own local
  // midnight is the frame the test process itself uses, so Berlin's
  // published clock reading is the expected minute count directly.
  //
  // London's published reading is in *London's own* zone. Berlin is always
  // exactly one hour ahead of London (both flip DST on the same calendar
  // date), so translating a London clock reading into this process's
  // (Berlin) frame means adding 60 minutes — which is exactly the
  // no-clipping-to-the-viewer's-zone contract `SunDay` documents.
  it.each([
    {
      name: "Berlin, summer solstice (timeanddate: sunrise 04:43, sunset 21:33 Berlin time)",
      place: BERLIN,
      date: "2026-06-21",
      wantSunrise: 4 * 60 + 43,
      wantSunset: 21 * 60 + 33,
    },
    {
      name: "Berlin, winter solstice (timeanddate: sunrise 08:14, sunset 15:54 Berlin time)",
      place: BERLIN,
      date: "2026-12-21",
      wantSunrise: 8 * 60 + 14,
      wantSunset: 15 * 60 + 54,
    },
    {
      name: "London, summer solstice (timeanddate: 04:43 / 21:21 London time, +60min frame shift)",
      place: LONDON,
      date: "2026-06-21",
      wantSunrise: 4 * 60 + 43 + 60,
      wantSunset: 21 * 60 + 21 + 60,
    },
    {
      name: "London, winter solstice (timeanddate: 08:03 / 15:53 London time, +60min frame shift)",
      place: LONDON,
      date: "2026-12-21",
      wantSunrise: 8 * 60 + 3 + 60,
      wantSunset: 15 * 60 + 53 + 60,
    },
  ])("$name", ({ place, date, wantSunrise, wantSunset }) => {
    const sun = sunTimes(day(date), place);
    expect.soft(sun.sunrise).not.toBeNull();
    expect.soft(sun.sunset).not.toBeNull();
    // The algorithm promises ~1 minute accuracy; give the reference (a
    // different, independently computed source) a couple more.
    expect.soft(Math.abs(sun.sunrise! - wantSunrise)).toBeLessThanOrEqual(3);
    expect.soft(Math.abs(sun.sunset! - wantSunset)).toBeLessThanOrEqual(3);
  });
});

/* --------------------------------- equinox -------------------------------- */

describe("an equinox gives roughly 12 hours of daylight at any latitude", () => {
  it.each([
    { name: "the equator", place: { lat: 0, lon: 0, label: "Equator" } },
    { name: "a mid-latitude (Berlin)", place: BERLIN },
  ])("$name", ({ place }) => {
    const sun = sunTimes(day("2026-03-20"), place); // March equinox, 2026
    expect(sun.sunrise).not.toBeNull();
    expect(sun.sunset).not.toBeNull();
    const dayLength = sun.sunset! - sun.sunrise!;
    // Not exactly 12h: the -0.833° horizon (refraction + the sun's own
    // radius) always adds a few minutes, more at higher latitudes.
    expect(Math.abs(dayLength - 12 * 60)).toBeLessThan(20);
  });
});

/* ----------------------------- polar day / night ---------------------------- */

describe("polar day and polar night", () => {
  // Well above the Arctic Circle (66.56°N) — Tromsø-ish.
  const arctic: Place = { lat: 70, lon: 20, label: "Arctic" };

  it("midsummer: the sun's centre never crosses the horizon altitude — polar day", () => {
    const sun = sunTimes(day("2026-06-21"), arctic);
    expect(sun.polar).toBe("day");
    expect(sun.sunrise).toBeNull();
    expect(sun.sunset).toBeNull();
    // At 70°N in midsummer the sun stays comfortably above -6° too, so
    // civil twilight never triggers either — there is no dawn or dusk to
    // report, the whole day (and night) is "daylight".
    expect(sun.dawn).toBeNull();
    expect(sun.dusk).toBeNull();
  });

  it("midwinter: the sun's centre never rises above the horizon altitude — polar night", () => {
    const sun = sunTimes(day("2026-12-21"), arctic);
    expect(sun.polar).toBe("night");
    expect(sun.sunrise).toBeNull();
    expect(sun.sunset).toBeNull();
  });
});

/* ------------------------------- no clipping -------------------------------- */

describe("SunDay does not clip to the viewer's own zone", () => {
  it("a place ~10 zones west of Berlin produces an instant outside [0, 1440]", () => {
    // Honolulu never observes DST (UTC-10); Berlin is UTC+2 in June — a
    // 12-hour civil gap between the two, comfortably enough to push a
    // Honolulu sunrise or sunset outside this process's own [0, 1440) day.
    const honolulu: Place = { lat: 21.3069, lon: -157.8583, label: "Honolulu" };
    const sun = sunTimes(day("2026-06-21"), honolulu);
    expect(sun.sunrise).not.toBeNull();
    expect(sun.sunset).not.toBeNull();
    const rise = sun.sunrise!;
    const set = sun.sunset!;
    expect(rise < 0 || rise > 1440 || set < 0 || set > 1440).toBe(true);
  });
});

/* ------------------------- ordering: rise, noon, set ------------------------- */

describe("sunrise is before sunset, and solar noon sits between them", () => {
  it("Berlin, summer solstice", () => {
    const sun = sunTimes(day("2026-06-21"), BERLIN);
    expect(sun.sunrise).not.toBeNull();
    expect(sun.sunset).not.toBeNull();
    expect(sun.sunrise!).toBeLessThan(sun.sunset!);

    // The midpoint of sunrise and sunset *is* solar noon, by construction
    // (both are `solarNoon ± hourAngle`) — cross-checked against
    // timeanddate's own published solar noon for the day, 1:08 pm (788 min).
    const noon = (sun.sunrise! + sun.sunset!) / 2;
    expect(noon).toBeGreaterThan(sun.sunrise!);
    expect(noon).toBeLessThan(sun.sunset!);
    expect(Math.abs(noon - 788)).toBeLessThan(3);
  });

  it("Berlin, winter solstice", () => {
    const sun = sunTimes(day("2026-12-21"), BERLIN);
    expect(sun.sunrise).not.toBeNull();
    expect(sun.sunset).not.toBeNull();
    expect(sun.sunrise!).toBeLessThan(sun.sunset!);

    // timeanddate's published solar noon for the day: 12:04 pm (724 min).
    const noon = (sun.sunrise! + sun.sunset!) / 2;
    expect(Math.abs(noon - 724)).toBeLessThan(3);
  });
});

/* -------------------------------- placeForZone ------------------------------- */

describe("placeForZone", () => {
  it("resolves a known zone to its coordinates", () => {
    const place = placeForZone("Europe/Berlin");
    expect(place).not.toBeNull();
    expect(place!.lat).toBeCloseTo(52.5);
    expect(place!.lon).toBeCloseTo(13.37);
    expect(place!.zone).toBe("Europe/Berlin");
  });

  it("returns null for UTC, which has no place behind it", () => {
    expect(placeForZone("UTC")).toBeNull();
  });

  it("resolves a retired alias to its current name's coordinates, not null", () => {
    // The source's own doc comment on `placeForZone` says only zones with no
    // place behind them at all (UTC, Etc/GMT+n) return null. A retired
    // spelling like Asia/Calcutta is explicitly *not* one of those — it is
    // resolved through `ALIASES` to Asia/Kolkata's coordinates, which is the
    // entire point of that table (a browser can report the old name and the
    // picker must not decide India has no sunrise). The result keeps the
    // *requested* spelling as `.zone`, so a caller can round-trip it.
    const current = placeForZone("Asia/Kolkata");
    const alias = placeForZone("Asia/Calcutta");
    expect(current).not.toBeNull();
    expect(alias).not.toBeNull();
    expect(alias!.lat).toBe(current!.lat);
    expect(alias!.lon).toBe(current!.lon);
    expect(alias!.zone).toBe("Asia/Calcutta");
  });

  it("returns null for a zone that isn't in the picker at all", () => {
    expect(placeForZone("Mars/Cydonia")).toBeNull();
  });
});
