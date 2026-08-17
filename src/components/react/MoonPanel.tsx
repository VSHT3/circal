/* ------------------------------------------------------------------ *
 * The sidebar's moon.
 *
 * The astronomy, in the app's own greyscale: the lit part of the moon and
 * nothing else — no circumference, no dark limb, so a new moon is nothing
 * at all. There was a second register for a while
 * — the disc riding behind a watchmaker's aperture, in night blue with
 * stars — and it was the only chrome in circal that was neither
 * greyscale nor flat. One question, one answer, in this app's voice.
 *
 * Not on by default. This is the one thing in circal that draws
 * something the calendar does not contain.
 * ------------------------------------------------------------------ */

import { moonForDay, nextPhase, type MoonPhase } from "@/lib/moon";
import { daysBetween, startOfDay } from "@/lib/time";

/** The disc, in the drawing's own units. */
const DISC = { c: 50, r: 44 } as const;

/**
 * The shadow is the void itself — `#000000`, the sidebar's own background.
 * Nothing of the moon is drawn but the part the sun is on: no circumference,
 * no dark limb, so a new moon is nothing at all and a crescent is a crescent
 * rather than a disc with a crescent on it. It still needs a *fill* rather
 * than a hole, because the terminator occludes the lit half by being painted
 * over it.
 */
const SHADOW = "#000000";

/**
 * The terminator, drawn rather than masked: a circle of `rx = r|1 − 2k|`
 * over the lit half, filled with the shadow when the moon is a crescent and
 * with the moon when it is gibbous. `k = 0.5` collapses it to nothing,
 * which is exactly the straight edge a quarter moon has.
 */
function Disc({ phase }: { phase: MoonPhase }) {
  const { c, r } = DISC;
  const half = phase.waxing
    ? `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} Z`
    : `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} Z`;
  return (
    <>
      <path d={half} fill="#ffffff" />
      <ellipse
        cx={c}
        cy={c}
        rx={r * Math.abs(1 - 2 * phase.illumination)}
        ry={r}
        fill={phase.illumination > 0.5 ? "#ffffff" : SHADOW}
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

export default function MoonPanel({ day }: { day: Date }) {
  const phase = moonForDay(day);
  const percent = Math.round(phase.illumination * 100);

  return (
    <section className="flex w-full shrink-0 flex-col gap-2">
      <span className="label text-ink-2">Moon</span>
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 100 100" className="h-[62px] w-[62px]" role="presentation">
          <Disc phase={phase} />
        </svg>
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
