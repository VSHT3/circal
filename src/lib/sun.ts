/* ------------------------------------------------------------------ *
 * Solar position — sunrise, sunset and civil twilight, for the dial's
 * daylight arc.
 *
 * Low-precision NOAA / Astronomical Almanac algorithm: Julian day of year
 * → mean solar anomaly → ecliptic longitude → declination → equation of
 * time → hour angle. No timezone database, no network — just trig on a
 * lat/lon and a calendar date. Accurate to about a minute, which is all a
 * rim a few pixels wide needs.
 * ------------------------------------------------------------------ */

import { startOfDay } from "./time";

export interface Place {
  lat: number; // degrees, +N
  lon: number; // degrees, +E
  label: string; // what the user calls it; never parsed
}

/**
 * Every boundary as **minutes since local midnight of `day`**, in the
 * *browser's* local zone (that is the zone the dial is drawn in), so a value
 * may legitimately fall outside [0, 1440] when the place is far from the
 * viewer — callers clip. `null` means the sun never crosses that altitude on
 * that day.
 */
export interface SunDay {
  dawn: number | null; // civil, sun at -6 degrees, before sunrise
  sunrise: number | null; // -0.833 degrees (refraction + solar radius)
  sunset: number | null;
  dusk: number | null; // civil, after sunset
  /** "day" = midnight sun, "night" = polar night, null = the sun rises and sets. */
  polar: "day" | "night" | null;
}

const DEG = Math.PI / 180;

/** Sun's centre altitude, in degrees, that defines sunrise/sunset — the
 *  standard almanac convention (~34' atmospheric refraction plus the sun's
 *  ~16' angular radius, both near the horizon). */
const HORIZON_ALTITUDE = -0.833;
/** Altitude that defines civil twilight — bright enough to work outdoors
 *  without artificial light. */
const CIVIL_TWILIGHT_ALTITUDE = -6;

/** 1-based day-of-year for a calendar date, ignoring time of day. */
function dayOfYear(year: number, month: number, date: number): number {
  return Math.round((Date.UTC(year, month, date) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
}

/**
 * Cosine of the hour angle at which the sun's centre crosses `altitude`.
 * Spherical trig: sin(alt) = sin(lat)sin(decl) + cos(lat)cos(decl)cos(H).
 * Outside [-1, 1] the sun never reaches `altitude` that day — the sign says
 * whether it stays above (> the noon altitude) or below (< the midnight one).
 */
function hourAngleCos(altitude: number, latDeg: number, decl: number): number {
  const lat = latDeg * DEG;
  return (
    (Math.sin(altitude * DEG) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl))
  );
}

export function sunTimes(day: Date, place: Place): SunDay {
  const year = day.getFullYear();
  const month = day.getMonth();
  const date = day.getDate();

  // Spencer (1971)'s Fourier fit to the low-precision solar ephemeris,
  // evaluated once for `day`'s calendar date (not iterated against the
  // events it produces) — good to about a minute, which is what this
  // algorithm promises.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear(year, month, date) - 1);

  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // UTC minutes-of-day of solar noon at `place`'s longitude, on `day`'s
  // calendar date; every event below is this plus or minus a hour angle's
  // worth of time (1 degree of Earth's rotation is 4 minutes).
  const solarNoonUtcMin = 720 - 4 * place.lon - eqTime;
  const utcMidnight = Date.UTC(year, month, date);
  const localMidnight = startOfDay(day).getTime();

  const toLocalMinutes = (utcMinutesOfDay: number): number =>
    Math.round((utcMidnight + utcMinutesOfDay * 60_000 - localMidnight) / 60_000);

  const cosHorizon = hourAngleCos(HORIZON_ALTITUDE, place.lat, decl);
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let polar: "day" | "night" | null = null;
  if (cosHorizon >= -1 && cosHorizon <= 1) {
    const ha = Math.acos(cosHorizon) / DEG;
    sunrise = toLocalMinutes(solarNoonUtcMin - 4 * ha);
    sunset = toLocalMinutes(solarNoonUtcMin + 4 * ha);
  } else {
    polar = cosHorizon < -1 ? "day" : "night";
  }

  const cosTwilight = hourAngleCos(CIVIL_TWILIGHT_ALTITUDE, place.lat, decl);
  let dawn: number | null = null;
  let dusk: number | null = null;
  if (cosTwilight >= -1 && cosTwilight <= 1) {
    const ha = Math.acos(cosTwilight) / DEG;
    dawn = toLocalMinutes(solarNoonUtcMin - 4 * ha);
    dusk = toLocalMinutes(solarNoonUtcMin + 4 * ha);
  }

  return { dawn, sunrise, sunset, dusk, polar };
}
