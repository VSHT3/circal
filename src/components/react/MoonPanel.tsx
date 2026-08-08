/* ------------------------------------------------------------------ *
 * The sidebar's moon, in two registers.
 *
 * `minimal` draws the astronomy: one disc, the terminator as an ellipse
 * over it, in the app's own greyscale. `aperture` draws the horology —
 * the moon rides behind a crescent-shaped window and is occulted by its
 * two lobes, which is how the mechanism on a wrist actually works and is
 * a completely different way of arriving at the same crescent.
 *
 * Neither is on by default. This is the one thing in circal that draws
 * something the calendar does not contain.
 * ------------------------------------------------------------------ */

import { moonForDay, nextPhase, type MoonPhase } from "@/lib/moon";
import { daysBetween, startOfDay } from "@/lib/time";
import type { MoonStyle } from "@/lib/store";

/** The disc, in each drawing's own units. */
const MINIMAL = { c: 50, r: 44 } as const;

/**
 * The window, and the disc that rides behind it.
 *
 * This is the mechanism, not a picture of it. The disc is occulted at each
 * end by a **circular bite of exactly its own radius**, and that equality is
 * the whole thing: a disc occulted by an equal disc leaves a lune, which is
 * the shape a crescent moon is. An end that merely tapered to a point — the
 * obvious way to draw this — cuts a wedge instead, and a wedge is not a moon.
 *
 * It follows that the journey is `4r` end to end. At new the disc sits dead
 * in a bite and is gone; a quarter later the bite's edge passes through its
 * centre, which is what a half moon looks like; at full it is `2r` from both
 * bites and clear of them. Linear in phase, because the disc it stands for
 * turns at a constant rate.
 *
 * The bites are **not** the window. They clip the disc and nothing else, so
 * the sky runs on behind them and the slot is free to be whatever shape reads
 * best — here a curved one with rounded ends, half a radius taller than the
 * moon so the disc has air above and below it. Punching them out of the
 * window itself was the first version, and it made the ends two scoops the
 * size of the moon: a shape that says "machinery" rather than "sky".
 */
const AP = {
  /** Moon radius, and each bite's. Equal by construction — see above. */
  r: 30,
  /** Half the slot's thickness. Wider than `r`, or the disc rides with its
   *  limbs shaved off by the very frame that is supposed to hold it. */
  h: 36,
  /**
   * Curvature of the band the disc rides along, so the slot is an arc cut out
   * of a face rather than a flat window. Tuned rather than derived: the band
   * is only `4r` long, so it takes a radius under about six times that before
   * the curve is visible at all.
   */
  ring: 260,
  /** The band's midpoint, in the viewBox. */
  cx: 94,
  cy: 40,
} as const;

/** Half the journey, as an angle: `2r` of arc each way. */
const AP_TRAVEL = (2 * AP.r) / AP.ring;
/** Centre of curvature, below the band. */
const AP_O = { x: AP.cx, y: AP.cy + AP.ring };
const AP_OUTER = AP.ring + AP.h;
const AP_INNER = AP.ring - AP.h;

/** A point on the band's circle: `a` radians from straight up, `rad` out. */
function apPoint(a: number, rad: number): { x: number; y: number } {
  return { x: AP_O.x + rad * Math.sin(a), y: AP_O.y - rad * Math.cos(a) };
}

/** The two instants the disc is hidden at, which are also where the slot ends. */
const AP_ENDS = [apPoint(-AP_TRAVEL, AP.ring), apPoint(AP_TRAVEL, AP.ring)] as const;

/**
 * How far the disc has to stand off a bite to show `k` of itself, as a
 * fraction of the journey from that bite to the middle.
 *
 * Two equal circles at centre distance `2ru` overlap by
 * `(2/π)(acos u − u√(1−u²))` of one of them, so the visible lune is the rest.
 * That expression is monotonic in `u` and has no closed-form inverse worth
 * writing, so it is bisected — twenty-eight halvings, once per render of a
 * panel that renders when the day changes.
 *
 * Driving the disc by *area* rather than linearly in phase is the one place
 * this drawing improves on the mechanism it is copying. A real complication
 * turns at a constant rate and therefore shows a crescent close to twice as
 * full as the sky's — a famous and forgivable error on a wrist, and not one
 * to reproduce two centimetres from a caption printing the true figure.
 */
function apStandoff(k: number): number {
  const visible = (u: number) => 1 - (2 / Math.PI) * (Math.acos(u) - u * Math.sqrt(1 - u * u));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (visible(mid) < k) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The slot: outer arc across, a round cap, the inner arc back, a round cap. */
const AP_WINDOW = (() => {
  const lo = apPoint(-AP_TRAVEL, AP_OUTER);
  const ro = apPoint(AP_TRAVEL, AP_OUTER);
  const ri = apPoint(AP_TRAVEL, AP_INNER);
  const li = apPoint(-AP_TRAVEL, AP_INNER);
  return (
    `M ${lo.x} ${lo.y}` +
    ` A ${AP_OUTER} ${AP_OUTER} 0 0 1 ${ro.x} ${ro.y}` +
    ` A ${AP.h} ${AP.h} 0 0 1 ${ri.x} ${ri.y}` +
    ` A ${AP_INNER} ${AP_INNER} 0 0 0 ${li.x} ${li.y}` +
    ` A ${AP.h} ${AP.h} 0 0 1 ${lo.x} ${lo.y} Z`
  );
})();

/** The slot with a bite taken out of each end. `evenodd`, so the bites are
 *  holes: this clips the disc, never the sky. */
const AP_LIT =
  AP_WINDOW +
  AP_ENDS.map(
    (c) =>
      ` M ${c.x - AP.r} ${c.y} a ${AP.r} ${AP.r} 0 1 0 ${2 * AP.r} 0 a ${AP.r} ${AP.r} 0 1 0 ${-2 * AP.r} 0 Z`,
  ).join("");

/** The viewBox, measured off the slot rather than guessed: the round caps are
 *  its widest points, and the lower of the cap and the inner arc its lowest. */
const AP_BOX = (() => {
  const cap = AP_ENDS[0];
  const left = cap.x - AP.h;
  const top = Math.min(apPoint(0, AP_OUTER).y, cap.y - AP.h);
  const bottom = Math.max(apPoint(0, AP_INNER).y, cap.y + AP.h);
  const pad = 2;
  return `${left - pad} ${top - pad} ${2 * (AP.cx - left) + 2 * pad} ${bottom - top + 2 * pad}`;
})();

/** A few fixed stars, in band coordinates: angle from the middle, and how far
 *  out. Fixed, because a sky that reshuffles itself on every render is a fault
 *  you can see; a constellation is a place. */
const STARS: ReadonlyArray<{ a: number; rad: number; r: number; o: number }> = [
  { a: -0.15, rad: 312, r: 1.1, o: 0.5 },
  { a: -0.09, rad: 288, r: 0.8, o: 0.34 },
  { a: -0.03, rad: 306, r: 1.2, o: 0.58 },
  { a: 0.03, rad: 283, r: 0.9, o: 0.4 },
  { a: 0.08, rad: 316, r: 1.3, o: 0.55 },
  { a: 0.13, rad: 294, r: 0.9, o: 0.42 },
  { a: 0.17, rad: 308, r: 1, o: 0.48 },
];

/** The maria, as three soft blots. Enough that the disc reads as the moon
 *  rather than as a hole in the sky, and not so much that it reads as a face. */
const MARIA: ReadonlyArray<{ x: number; y: number; r: number; o: number }> = [
  { x: -7, y: -6, r: 8, o: 0.1 },
  { x: 6, y: 4, r: 6, o: 0.08 },
  { x: 3, y: -9, r: 4, o: 0.07 },
];

/**
 * The terminator, drawn rather than masked: a circle of `rx = r|1 − 2k|`
 * over the lit half, filled with the sky when the moon is a crescent and
 * with the moon when it is gibbous. `k = 0.5` collapses it to nothing,
 * which is exactly the straight edge a quarter moon has.
 */
function Disc({ phase, lit, dark }: { phase: MoonPhase; lit: string; dark: string }) {
  const { c, r } = MINIMAL;
  const half = phase.waxing
    ? `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} Z`
    : `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} Z`;
  return (
    <>
      <circle cx={c} cy={c} r={r} fill={dark} />
      <path d={half} fill={lit} />
      <ellipse
        cx={c}
        cy={c}
        rx={r * Math.abs(1 - 2 * phase.illumination)}
        ry={r}
        fill={phase.illumination > 0.5 ? lit : dark}
      />
      {/* The circumference, so a new moon is still a disc and not an absence
          — the same argument the favicon makes with the same two shapes. */}
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
    </>
  );
}

function Minimal({ phase }: { phase: MoonPhase }) {
  return (
    <svg viewBox="0 0 100 100" className="h-[62px] w-[62px]" role="presentation">
      <Disc phase={phase} lit="#ffffff" dark="#000000" />
    </svg>
  );
}

function Aperture({ phase }: { phase: MoonPhase }) {
  // New moon dead in a bite, full dead centre. Which bite it is standing off
  // is the whole of waxing versus waning: entering from the left, the left
  // limb is the one still covered.
  const standoff = apStandoff(phase.illumination) * AP_TRAVEL;
  const at = apPoint(phase.waxing ? -AP_TRAVEL + standoff : AP_TRAVEL - standoff, AP.ring);

  return (
    <svg viewBox={AP_BOX} className="h-auto w-full" role="presentation">
      <defs>
        <clipPath id="moon-aperture">
          <path d={AP_WINDOW} />
        </clipPath>
        {/* The disc's own clip: the slot, less the two bites. */}
        <clipPath id="moon-lit" clipRule="evenodd">
          <path d={AP_LIT} clipRule="evenodd" />
        </clipPath>
        <radialGradient id="moon-sky" cx="50%" cy="100%" r="100%">
          <stop offset="0%" stopColor="#17213c" />
          <stop offset="100%" stopColor="#070b16" />
        </radialGradient>
        <radialGradient id="moon-disc" cx="36%" cy="32%" r="74%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#cdd2dc" />
        </radialGradient>
      </defs>

      <g clipPath="url(#moon-aperture)">
        {/* Sized off the band rather than off the viewBox: the viewBox has a
            negative origin, so a bare `width`/`height` rect misses one end. */}
        <rect
          x={AP_O.x - AP_OUTER}
          y={AP_O.y - AP_OUTER}
          width={2 * AP_OUTER}
          height={2 * AP_OUTER}
          fill="url(#moon-sky)"
        />
        {STARS.map((s) => {
          const p = apPoint(s.a, s.rad);
          return <circle key={s.a} cx={p.x} cy={p.y} r={s.r} fill="#fff" opacity={s.o} />;
        })}
        {/* Two elements, not one: `clip-path` resolves in the user space the
            element's own `transform` establishes, so a clip and a translate on
            the same node would drag the bites along with the disc. */}
        <g clipPath="url(#moon-lit)">
          <g transform={`translate(${at.x} ${at.y})`}>
            <circle r={AP.r} fill="url(#moon-disc)" />
            {MARIA.map((m) => (
              <circle
                key={`${m.x}-${m.y}`}
                cx={m.x}
                cy={m.y}
                r={m.r}
                fill="#5b6478"
                opacity={m.o}
              />
            ))}
          </g>
        </g>
      </g>

      {/* The cut edge. Without it the sky is a shape floating on black; with
          it the sky is behind something. */}
      <path d={AP_WINDOW} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
    </svg>
  );
}

/** `full in 3 days`, and the two days that have words of their own. */
function nextPhaseText(day: Date, phase: MoonPhase): string {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  // Whichever of the two is ahead: a waxing moon is on its way to full, a
  // waning one to new. Naming the far one would be counting down to something
  // the picture is currently walking away from.
  const target = phase.waxing ? "full" : "new";
  const at = nextPhase(noon, phase.waxing ? 0.5 : 0);
  const days = daysBetween(day, startOfDay(at));
  if (days <= 0) return `${target} today`;
  if (days === 1) return `${target} tomorrow`;
  return `${target} in ${days} days`;
}

export default function MoonPanel({ day, style }: { day: Date; style: MoonStyle }) {
  if (style === "off") return null;
  const phase = moonForDay(day);
  const percent = Math.round(phase.illumination * 100);

  return (
    <section className="flex w-full shrink-0 flex-col gap-2">
      <span className="label text-ink-3">Moon</span>
      <div
        className={
          style === "minimal" ? "flex items-center gap-3" : "flex flex-col items-stretch gap-2"
        }
      >
        {style === "minimal" ? <Minimal phase={phase} /> : <Aperture phase={phase} />}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="label truncate text-ink-2">{phase.name}</span>
          <span className="caption tabular-nums">
            {percent}% · {nextPhaseText(day, phase)}
          </span>
        </div>
      </div>
    </section>
  );
}
