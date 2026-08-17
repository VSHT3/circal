/* ------------------------------------------------------------------ *
 * The travel notice — the one question a moved device has to ask.
 *
 * Shaped like the life view's `BirthPrompt` and for the same reason: it is
 * not a modal over a working dial, it is the screen until it is answered.
 * Both answers are legitimate, so neither is styled as the safe one, and
 * there is no third way out — "keep them as they are" *is* the do-nothing
 * answer, and a dismiss would leave the app knowing the device had moved
 * and drawing the day as though it had not.
 *
 * Cities, never IANA names: `Europe/Berlin` is a database key and a person
 * who has just landed is owed the name of the place they left. It also says
 * plainly what has happened rather than announcing a fault — the events are
 * at the instants they always were, which is *why* they moved on the clock —
 * and it proves it with the one line nobody can argue with: what a 09:00
 * event written back there reads as here, on this reader's own face.
 * ------------------------------------------------------------------ */

import { motion, useReducedMotion } from "motion/react";
import { EASE } from "@/lib/motion";
import { placeName, type TravelNotice } from "@/lib/travel";
import { formatOffset, formatTimeShort, zoneOffset, zonedToUtc, type Clock } from "@/lib/time";

/** The hour the illustration is written for. Nine in the morning is the hour
 *  everybody's example meeting is at, and it is far enough from midnight that
 *  no plausible pair of zones lands the answer on another date, which would
 *  need a second sentence to explain. */
const EXAMPLE_HOUR = 9;

export function TravelPrompt({
  notice,
  now,
  clock,
  onMove,
  onKeep,
}: {
  notice: TravelNotice;
  now: Date;
  clock: Clock;
  onMove: () => void;
  onKeep: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const from = placeName(notice.from);
  const to = placeName(notice.to);
  /** Measured against the place they came from, not against UTC: you are the
   *  origin of this dial, which is the same rule the second ring's caption
   *  reads by. */
  const delta = zoneOffset(now, notice.to) - zoneOffset(now, notice.from);
  /** The illustration, resolved rather than described: today's 09:00 in the
   *  old place, printed on this reader's own clock. */
  const shifted = formatTimeShort(
    new Date(
      zonedToUtc(
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        EXAMPLE_HOUR,
        0,
        notice.from,
      ),
    ),
    clock,
  );

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/85 p-6">
      <motion.div
        className="w-[400px] max-w-full rounded-[14px] border border-hairline bg-surface p-4"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: EASE }}
      >
        <div className="text-[17px] font-medium text-ink">You have moved</div>
        {/* A tag, so `.label`: three words at the same weight as the row
            labels this app names things with. The prose below is a sentence
            and takes `.caption`. */}
        <div className="label mt-1 text-[10px] text-ink-3">
          {from} → {to} · {formatOffset(delta)}
        </div>

        <p className="caption mt-3 leading-relaxed">
          This browser was last open in {from}. Your events are at the same instants they always
          were, so they now read on {to}&rsquo;s clock: something you wrote for 09:00 in {from} is
          drawn at {shifted} here.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <button
              type="button"
              onClick={onMove}
              className="h-9 w-full rounded-[9px] bg-ink text-[13.5px] font-medium text-void transition-opacity hover:opacity-90"
            >
              Move them with me
            </button>
            <p className="caption mt-1.5">
              Keep the hours, change the moments. 09:00 becomes 09:00 in {to}.
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={onKeep}
              className="h-9 w-full rounded-[9px] border border-hairline bg-surface-2 text-[13.5px] font-medium text-ink transition-colors hover:bg-white/10"
            >
              Keep them as they are
            </button>
            <p className="caption mt-1.5">
              Keep the moments, change the hours. Those events go on saying they are {from} times.
            </p>
          </div>
        </div>

        <p className="caption mt-3 text-ink-3">Either way, one undo puts it back.</p>
      </motion.div>
    </div>
  );
}
