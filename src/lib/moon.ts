/* ------------------------------------------------------------------ *
 * Moon phase — low-precision Meeus (*Astronomical Algorithms*, 2nd ed.,
 * ch. 47 "Position of the Moon" and ch. 48 "Illuminated Fraction of the
 * Moon"), truncated to the leading terms. Good to well under an hour on
 * phase instants (new/full) — more than the sidebar's 40px complication
 * will ever show, and the same order of accuracy `sun.ts` keeps for
 * sunrise/sunset.
 *
 * Deliberately not the "phase angle from mean anomalies" shortcut: that
 * formula only ever returns an angle in [0°, 180°], so on its own it
 * cannot tell a waxing crescent from a waning one. The *true elongation*
 * series below already carries the sign (0…360° round the whole cycle),
 * so waxing vs waning, and every named phase, falls out of one number.
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000;
const DEG = Math.PI / 180;

/**
 * Mean length of a synodic month (new moon to new moon), days. The
 * *true* interval between two new moons varies roughly ±7 hours around
 * this — see the `nextPhase` round-trip test in `tests/moon.test.ts` —
 * so this is a mean, never a per-cycle answer.
 */
export const SYNODIC_DAYS = 29.530588853;

export type MoonName =
  | "New moon"
  | "Waxing crescent"
  | "First quarter"
  | "Waxing gibbous"
  | "Full moon"
  | "Waning gibbous"
  | "Last quarter"
  | "Waning crescent";

export interface MoonPhase {
  /** 0…1 through the synodic month: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number;
  /** 0…1 of the disc that is lit. */
  illumination: number;
  /** Days since the last new moon, 0…SYNODIC_DAYS. */
  age: number;
  /** Lit limb on the right (northern hemisphere): the first half of the cycle. */
  waxing: boolean;
  name: MoonName;
}

/** Julian centuries since the J2000.0 epoch — the clock every mean
 *  argument below runs on. `Date#getTime()` is already milliseconds
 *  since the Unix epoch, which sits at Julian Day 2440587.5. */
function julianCenturies(at: Date): number {
  const jd = at.getTime() / MS_PER_DAY + 2440587.5;
  return (jd - 2451545.0) / 36525;
}

/**
 * The Moon's *true* elongation from the Sun, in degrees, 0…360 — Meeus
 * 47.x's mean arguments run through the six largest terms of the
 * periodic series that corrects them. This is what makes `moonPhase` a
 * real ephemeris rather than a mean-phase clock: the mean arguments
 * alone (`D` below) already give a linear approximation, and everything
 * added to them here is the actual lunar-orbit wobble the round-trip
 * test is checking for.
 */
function trueElongation(T: number): number {
  // Moon's mean elongation from the Sun.
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + (T * T * T) / 545868;
  // Sun's mean anomaly.
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T;
  // Moon's mean anomaly.
  const M1 = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T;

  const d = D * DEG;
  const m = M * DEG;
  const m1 = M1 * DEG;

  const elong =
    D +
    6.289 * Math.sin(m1) -
    2.1 * Math.sin(m) +
    1.274 * Math.sin(2 * d - m1) +
    0.658 * Math.sin(2 * d) +
    0.214 * Math.sin(2 * m1) +
    0.11 * Math.sin(d);

  return ((elong % 360) + 360) % 360;
}

/**
 * Half the exact-phase window, in cycles: ±0.02 (~14 hours) either side
 * of new / first-quarter / full / last-quarter reads as that phase's own
 * name — a crescent named "New moon" for a whole day is what a reader
 * expects, and a name that only holds for the true instant is a name
 * nobody ever sees.
 */
const EXACT_BAND = 0.02;

const EXACT_PHASES: ReadonlyArray<{ at: number; name: MoonName }> = [
  { at: 0, name: "New moon" },
  { at: 0.25, name: "First quarter" },
  { at: 0.5, name: "Full moon" },
  { at: 0.75, name: "Last quarter" },
];

/** Quadrant name, indexed by `Math.floor(phase * 4)` — `[0, 0.25)`
 *  through `[0.75, 1)`. */
const QUADRANT_NAMES: ReadonlyArray<MoonName> = [
  "Waxing crescent",
  "Waxing gibbous",
  "Waning gibbous",
  "Waning crescent",
];

function moonName(phase: number): MoonName {
  for (const { at, name } of EXACT_PHASES) {
    const d = Math.abs(phase - at);
    // Circular distance: phase 0 and phase 1 name the same instant, so
    // 0.99 has to read as "close to 0", not "close to nothing".
    if (Math.min(d, 1 - d) <= EXACT_BAND) return name;
  }
  return QUADRANT_NAMES[Math.floor(phase * 4)];
}

/** The moon at an instant. */
export function moonPhase(at: Date): MoonPhase {
  const elong = trueElongation(julianCenturies(at));
  const phase = elong / 360;
  // Meeus 48.4: illuminated fraction k = (1 + cos(i)) / 2, where the
  // phase angle i = 180° − elongation and cos(180° − x) = −cos(x).
  const illumination = (1 - Math.cos(elong * DEG)) / 2;
  return {
    phase,
    illumination,
    age: phase * SYNODIC_DAYS,
    waxing: phase < 0.5,
    name: moonName(phase),
  };
}

/**
 * The moon as of local noon on `day` — the one answer a day-shaped
 * surface wants. Noon rather than midnight: the phase is a fact about
 * the *night* that day names, and midnight sits on the boundary between
 * two of them.
 */
export function moonForDay(day: Date): MoonPhase {
  return moonPhase(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12));
}

/**
 * Signed distance from `t`'s true elongation to `target`'s, in degrees,
 * wrapped to (−180°, 180°] — the root `nextPhase` bisects on.
 */
function elongOffset(t: Date, target: number): number {
  const raw = trueElongation(julianCenturies(t)) - target * 360;
  return ((((raw + 180) % 360) + 360) % 360) - 180;
}

/** A guess this close to `from` risks a ±1.5-day bracket that straddles
 *  it — see the "already at target" note in `nextPhase`. */
const MIN_LEAD_DAYS = 2;
const BRACKET_HALF_DAYS = 1.5;
/** 40 halvings of a 3-day bracket is a fraction of a millisecond of
 *  residual — the loop's own resolution, not the algorithm's accuracy. */
const BISECTION_STEPS = 40;

/** The next instant the moon is new (`0`) or full (`0.5`), strictly after `from`. */
export function nextPhase(from: Date, target: 0 | 0.5): Date {
  const current = moonPhase(from).phase;
  // Cycles until `target`, forward-only. `from` itself may already sit on
  // `target` — that is exactly what the round-trip test does, feeding
  // each result back in as the next call's `from` — so a delta near zero
  // means "a whole cycle from here", not "right now": stepping forward
  // an instant from an exact new moon moves *away* from phase 0, and the
  // next time it reads 0 again is a full synodic month later.
  let deltaCycles = (((target - current) % 1) + 1) % 1;
  if (deltaCycles * SYNODIC_DAYS < MIN_LEAD_DAYS) deltaCycles += 1;

  const guessMs = from.getTime() + deltaCycles * SYNODIC_DAYS * MS_PER_DAY;
  let lo = guessMs - BRACKET_HALF_DAYS * MS_PER_DAY;
  let hi = guessMs + BRACKET_HALF_DAYS * MS_PER_DAY;

  // True elongation is monotonically increasing across a 3-day window —
  // its fastest periodic term moves far slower than the ~12.19 deg/day
  // mean rate — so plain bisection on its sign converges to the exact
  // root, not just a local one.
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (elongOffset(new Date(mid), target) < 0) lo = mid;
    else hi = mid;
  }
  return new Date(Math.round((lo + hi) / 2));
}
