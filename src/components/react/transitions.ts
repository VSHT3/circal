/* ------------------------------------------------------------------ *
 * The transitions between the four views — the whole table, and nothing
 * else. Pure configuration: no shell state, no store, no hooks. It reads
 * a `ViewFlow` and answers with what a panel does when it arrives and
 * when it leaves.
 *
 * Out of `App.tsx` because two hundred lines of motion config is not
 * shell logic, and because the four predicates below are the statement
 * of which pairs of views are geometrically related — which is the
 * argument the app is making and deserves to be readable on its own.
 * ------------------------------------------------------------------ */

import type { RefObject } from "react";
import { EASE, UNROLL_IN_MS, UNROLL_OUT_MS } from "@/lib/motion";
import type { ViewFlow } from "./types";

/**
 * Day ⇄ life is the one pair that *zooms*, because it is the one pair where
 * the same thing is drawn at two scales: the dial *is* the dot it lands on.
 */
function zoomsOut(flow: ViewFlow): boolean {
  return flow.from === "day" && flow.to === "life";
}

function zoomsIn(flow: ViewFlow): boolean {
  return flow.from === "life" && flow.to === "day";
}

/**
 * Year ⇄ life *unrolls*, on a stricter identity still: a year in day order
 * round a circle is a row of the life grid rolled up. `YearView` draws both
 * halves on its own canvas and holds its unmount open with `usePresence`, so
 * all the shell has to do here is keep the panels out of the way — no fade
 * over the top of a transition that is already showing you the whole thing.
 *
 * Day ⇄ year is neither, and crossfades: a day is not a magnified year and it
 * is not a rolled-up one either.
 */
function unrollsOut(flow: ViewFlow): boolean {
  return flow.from === "year" && flow.to === "life";
}

function unrollsIn(flow: ViewFlow): boolean {
  return flow.from === "life" && flow.to === "year";
}

/**
 * Day ⇄ week zooms too, and on the same identity: the grid's face for the day
 * you are on *is* the dial, a few times smaller. Crossfading it would be the
 * one transition in the app that throws away a geometric relationship it has.
 *
 * It is a separate pair from the life zoom because the distance is different by
 * two orders of magnitude — 1 → ~0.4 rather than 1 → 0.008 — so it takes one
 * eased tween where `ZOOM_STEPS`' geometric ladder would read as a stutter.
 * Week ⇄ year and week ⇄ life are crossfades: a week is not a magnified year
 * and a row of the life grid is not seven dials.
 */
function stepsOut(flow: ViewFlow): boolean {
  return flow.from === "day" && flow.to === "week";
}

function stepsIn(flow: ViewFlow): boolean {
  return flow.from === "week" && flow.to === "day";
}

/**
 * The dial's scale, from full to the size of one dot, in five geometric steps.
 *
 * Interpolating scale linearly is what makes most "zoom" animations feel
 * wrong: apparent size is linear in scale, so the thing hangs at full size and
 * then vanishes in the last few frames. Equal *ratios* between keyframes give
 * a constant rate of zoom — every step is a third of what came before — and
 * the uneven `times` spend the last stretch of the duration on the smallest
 * step, which is the settle.
 */
const ZOOM_STEPS = [1, 0.3, 0.09, 0.027, 0.008] as const;
const ZOOM_OUT_TIMES = [0, 0.34, 0.58, 0.79, 1] as const;
const ZOOM_IN_TIMES = [0, 0.21, 0.42, 0.66, 1] as const;
/** Long, and deliberately so: it is a change of scale of two orders of
 *  magnitude, and at half a second that reads as a glitch rather than as a
 *  move. Both halves are timed against the life view's wave. */
const ZOOM_OUT = { duration: 0.85, ease: "linear" as const, times: [...ZOOM_OUT_TIMES] };
const ZOOM_IN = { duration: 0.8, delay: 0.3, ease: "linear" as const, times: [...ZOOM_IN_TIMES] };

/**
 * The week's step, which is a zoom of about three times rather than of two
 * orders of magnitude — so one eased tween, not a ladder. The dial holds full
 * opacity for most of the way and gives up only at the end, over the face it
 * has landed on: it is the same day at two sizes, and the handover should read
 * as one shape settling rather than as two pictures crossing.
 */
const STEP_MS = 0.52;
const STEP_OUT = {
  duration: STEP_MS,
  ease: EASE,
  opacity: { duration: STEP_MS, times: [0, 0.72, 1], ease: "linear" as const },
};
const STEP_IN = {
  duration: STEP_MS,
  ease: EASE,
  opacity: { duration: STEP_MS, times: [0, 0.3, 1], ease: "linear" as const },
};

/**
 * What a panel does when it arrives and when it leaves.
 *
 * Only `exit` is a *variant*, and it is the one that has to be: a panel that
 * is leaving has props frozen at its last render, which is one render too
 * early to know what is arriving, so the answer is resolved from the flow
 * *ref* at the moment the exit starts.
 *
 * `initial` and `active` are the opposite case, and take the flow by value:
 * they are resolved during the render that schedules them and handed over as
 * plain objects. As variant labels they were re-resolved on every render of
 * whichever panel carried them — including the panel on its way out, which by
 * then reads a flow saying the *other* panel is arriving. So the leaving panel
 * started the arriving one's `active` on itself, which cancelled its own
 * `exit` and left it mounted at full opacity for ever: ⌘E then ⌘D put a dial
 * on top of a week strip that never went away. Frozen props are what stop
 * that — the object the leaving panel holds is the one it resolved before the
 * flow moved, so there is nothing for motion to re-run.
 */
export const PANEL = {
  initial: (flow: ViewFlow) => {
    if (zoomsIn(flow)) return { opacity: 0, scale: ZOOM_STEPS[ZOOM_STEPS.length - 1] };
    if (stepsIn(flow)) {
      // Already the size and in the place of the face it is growing out of,
      // so the first frame of the dial *is* the last frame of that face.
      const { scale, dx, dy } = flow.face;
      return { opacity: 0, scale, x: dx, y: dy };
    }
    // The ring arrives already drawn, on the canvas, exactly over the dots it
    // is lifting off. Fading it up would dim the one frame that has to match.
    if (unrollsIn(flow)) return { opacity: 1, scale: 1 };
    return { opacity: 0, scale: 1 };
  },
  active: (flow: ViewFlow) => {
    if (zoomsIn(flow)) {
      // The dial grows out of the dot it left from, fading up early so it is
      // a dial arriving rather than a dot inflating.
      return {
        opacity: [0, 1, 1, 1, 1],
        scale: [...ZOOM_STEPS].reverse(),
        transition: ZOOM_IN,
      };
    }
    if (stepsIn(flow)) {
      return { opacity: [0, 1, 1], scale: 1, x: 0, y: 0, transition: STEP_IN };
    }
    if (unrollsIn(flow)) return { opacity: 1, scale: 1, transition: { duration: 0 } };
    return {
      opacity: 1,
      scale: 1,
      // Arriving over a dial that is collapsing: wait for it, or the two
      // fades cross in the middle and both look like ghosts.
      //
      // Arriving under an unrolling ring costs more waiting still. The ring
      // is the same greys the grid is, so against thirty thousand dots the
      // whole movement is invisible — it has to happen on black, and the grid
      // comes up as the days settle onto it.
      //
      // The week is the exception, and waits for nothing: the dial is landing
      // *on* one of its faces, so that face has to already be there.
      transition: {
        duration: stepsOut(flow) ? STEP_MS : 0.45,
        delay: unrollsOut(flow) ? 0.44 : zoomsOut(flow) ? 0.18 : 0,
        ease: EASE,
      },
    };
  },
  exit: (flow: RefObject<ViewFlow>) => {
    if (zoomsOut(flow.current)) {
      // Held opaque until it is genuinely small: a dial that fades while it
      // is still large looks like it is being switched off, not moved.
      return {
        opacity: [1, 1, 0.9, 0.5, 0],
        scale: [...ZOOM_STEPS],
        pointerEvents: "none" as const,
        transition: ZOOM_OUT,
      };
    }
    if (stepsOut(flow.current)) {
      // Scaled and translated rather than scaled about a `transform-origin`,
      // because the origin on this panel belongs to the life zoom — see
      // `originPoint`, which is what corrects `dx`/`dy` for it.
      const { scale, dx, dy } = flow.current.face;
      return {
        opacity: [1, 1, 0],
        scale,
        x: dx,
        y: dy,
        pointerEvents: "none" as const,
        transition: STEP_OUT,
      };
    }
    if (unrollsOut(flow.current)) {
      // Neither fades nor shrinks: the canvas inside is drawing the whole
      // transition, and a fade over it would only take contrast off it.
      // `usePresence` in `YearView` is what actually holds the unmount.
      return {
        opacity: 1,
        scale: 1,
        pointerEvents: "none" as const,
        transition: { duration: UNROLL_OUT_MS / 1000 },
      };
    }
    // The week leaving under a dial that is growing out of one of its faces
    // keeps its scale: shrinking by 3% would drag that face out from under
    // the shape claiming to be it. Everything else settles back as it goes.
    return {
      opacity: 0,
      scale: stepsIn(flow.current) ? 1 : 0.97,
      pointerEvents: "none" as const,
      // Leaving under a ring rolling up: gone by the time the row it lifted
      // off would be missed, and not before.
      transition: {
        duration: unrollsIn(flow.current)
          ? UNROLL_IN_MS / 1600
          : stepsIn(flow.current)
            ? STEP_MS
            : 0.3,
        ease: EASE,
      },
    };
  },
} as const;
