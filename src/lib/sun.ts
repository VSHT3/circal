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

import { MINUTES_PER_DAY, clamp, minutesOfDay, startOfDay } from "./time";

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

/* ------------------------------- the curve -------------------------------- */

/**
 * Signed light at minute `m` of the day this `SunDay` describes: positive is
 * sun, negative is night, and it passes through zero exactly at the civil
 * twilight boundary.
 *
 * One continuous function rather than four cases with their own constants,
 * because every discontinuity in here becomes a visible step on the rim — the
 * shoulders used to start at 0.04 and the band began with a hard edge.
 *
 * It answers for the whole day whatever the band's two switches say: dropping
 * a half is a filter on the segments drawn, not a hole punched in the curve,
 * so the half that stays keeps the exact shape it had beside the other.
 */
export function solarLight(sun: SunDay, m: number): number {
  if (sun.polar === "day") return DAY_PEAK;
  const { dawn, sunrise, sunset, dusk } = sun;
  if (sun.polar !== "night" && sunrise !== null && sunset !== null) {
    if (m >= sunrise && m <= sunset) {
      // A sine between the two horizons stands in for solar altitude: wrong
      // by a few percent, right about where the day is brightest.
      const t = (m - sunrise) / (sunset - sunrise);
      return TWILIGHT + (DAY_PEAK - TWILIGHT) * Math.sin(Math.PI * t) ** 0.7;
    }
    // Civil twilight: a shoulder that reaches the horizon at zero, so the
    // warm band and the night band meet without either one starting on a step.
    if (dawn !== null && m >= dawn && m < sunrise) {
      return TWILIGHT * ((m - dawn) / (sunrise - dawn));
    }
    if (dusk !== null && m > sunset && m <= dusk) {
      return TWILIGHT * ((dusk - m) / (dusk - sunset));
    }
  }
  // Night wraps midnight, so it is measured as the fraction of the way from
  // dusk to the next dawn rather than as a span of this day.
  const from = sun.dusk ?? sun.sunset ?? 0;
  const to = (sun.dawn ?? sun.sunrise ?? MINUTES_PER_DAY) + MINUTES_PER_DAY;
  const at = m < from ? m + MINUTES_PER_DAY : m;
  const u = sun.polar === "night" ? 0.5 : clamp((at - from) / (to - from), 0, 1);
  return -(NIGHT_BASE + NIGHT_SWING * Math.sin(Math.PI * u) ** 0.6);
}

/** Light at the brightest minute of a clear day, and at the horizon. */
const DAY_PEAK = 0.86;
const TWILIGHT = 0.14;
/** Night's two terms: the floor it starts at, and how much deeper the middle
 *  of it goes. Their sum is the darkest `solarLight` ever returns. */
const NIGHT_BASE = 0.05;
const NIGHT_SWING = 0.42;
const DARKEST = NIGHT_BASE + NIGHT_SWING;

/**
 * How bright the instrument should be, at an instant, in a place: full while
 * the sun is up and falling to `AMBIENT_FLOOR` in the middle of the night.
 *
 * This is what makes the ambient dial an object in a room rather than a web
 * page showing the time — a screen at full brightness in a dark room is the
 * one thing a desk clock must not be. It rides the same curve the lightcycle
 * band draws, so the face dims exactly as the band's violet half comes round.
 *
 * No place, no curve, no dimming: an inferred brightness is worse than none.
 */
export function ambientLevel(now: Date, place: Place | null): number {
  if (!place) return 1;
  const light = solarLight(sunTimes(now, place), minutesOfDay(now));
  if (light >= 0) return 1;
  return 1 - (1 - AMBIENT_FLOOR) * clamp(-light / DARKEST, 0, 1);
}

/**
 * The dimmest the face goes. Not lower: the elapsed trail's own ramp starts
 * at about 4% white, and a multiplier that takes it under a couple of percent
 * erases the first hours of the day rather than dimming them.
 */
const AMBIENT_FLOOR = 0.55;
