/* ------------------------------------------------------------------ *
 * The selected day's moon, in the sidebar or on the dial.
 *
 * The astronomy, in the app's own greyscale: the lit part of the moon and
 * nothing else — no circumference, no dark limb, so a new moon is nothing
 * at all. There was a second register for a while
 * — the disc riding behind a watchmaker's aperture, in night blue with
 * stars — and it was the only chrome in circal that was neither
 * greyscale nor flat. One question, one answer, in this app's voice.
 * ------------------------------------------------------------------ */

import { moonForDay, nextPhase, type MoonPhase } from "@/lib/moon";
import { THEME_PALETTES, type ThemeName } from "@/lib/theme";
import { daysBetween, startOfDay } from "@/lib/time";

/** The disc, in the drawing's own units. */
const DISC = { c: 50, r: 44 } as const;

/**
 * The terminator, drawn rather than masked: a circle of `rx = r|1 − 2k|`
 * over the lit half, filled with the shadow when the moon is a crescent and
 * with the moon when it is gibbous. `k = 0.5` collapses it to nothing,
 * which is exactly the straight edge a quarter moon has.
 */
function Disc({ phase, theme }: { phase: MoonPhase; theme: ThemeName }) {
  const P = THEME_PALETTES[theme];
  const { c, r } = DISC;
  const half = phase.waxing
    ? `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} Z`
    : `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} Z`;
  return (
    <>
      <path d={half} fill={P.moonLit} />
      <ellipse
        cx={c}
        cy={c}
        rx={r * Math.abs(1 - 2 * phase.illumination)}
        ry={r}
        fill={phase.illumination > 0.5 ? P.moonLit : P.void}
      />
    </>
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

export default function MoonPanel({
  day,
  theme,
  compact = false,
  u = 1,
}: {
  day: Date;
  theme: ThemeName;
  compact?: boolean;
  /** Dial-centre units follow the readout; perimeter placement uses pixels. */
  u?: number;
}) {
  const phase = moonForDay(day);
  const percent = Math.round(phase.illumination * 100);

  return (
    <section
      aria-label="Moon"
      className={
        compact ? "pointer-events-none max-w-full shrink-0" : "flex w-full shrink-0 flex-col gap-2"
      }
    >
      {!compact && <span className="label text-ink-2">Moon</span>}
      <div className="flex items-center" style={{ gap: compact ? `${8 * u}px` : "12px" }}>
        <svg
          viewBox="0 0 100 100"
          className="shrink-0"
          style={{
            width: compact ? `${28 * u}px` : "62px",
            height: compact ? `${28 * u}px` : "62px",
          }}
          role="presentation"
        >
          <Disc phase={phase} theme={theme} />
        </svg>
        <div className="flex min-w-0 flex-col" style={{ gap: compact ? `${2 * u}px` : "4px" }}>
          <span
            className="label truncate text-ink-2"
            style={
              compact
                ? { fontSize: `${10 * u}px`, letterSpacing: "0.1em", lineHeight: 1.3 }
                : undefined
            }
          >
            {phase.name}
          </span>
          <span
            className="caption whitespace-nowrap tabular-nums"
            style={compact ? { fontSize: `${9 * u}px`, lineHeight: 1.3 } : undefined}
          >
            {percent}% · {nextPhaseText(day, phase)}
          </span>
        </div>
      </div>
    </section>
  );
}
