/* ------------------------------------------------------------------ *
 * The received free time, named — one quiet line over the stage.
 *
 * A link's ghost arcs arrive on the face with nothing saying whose hours
 * they are, and translucent white arcs a reader cannot account for read as
 * a rendering fault. This is the accounting: what the overlay is, which
 * days it covers, and the one way to take it down. `BackupNudge`'s shape
 * exactly — a line rather than a dialog, top edge so it clears the readout,
 * no layout reserved when it is away — because the second notice over the
 * stage must not invent a second voice.
 * ------------------------------------------------------------------ */

import { X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE, MODE_MS } from "@/lib/motion";
import { formatDayRange, startOfDay } from "@/lib/time";
import { ActionPill } from "@/components/react/ui/primitives";

export function SlotsNotice({
  slots,
  onDismiss,
}: {
  /** Sorted ascending — `decodeSlots` refuses anything else. */
  slots: { start: number; end: number }[];
  onDismiss: () => void;
}) {
  const reducedMotion = useReducedMotion();
  // The days the overlay covers, off the spans themselves: first start to
  // last end, `end - 1` because it is exclusive and a slot ending at
  // midnight must not name the day after it.
  const from = startOfDay(new Date(slots[0].start));
  const to = startOfDay(new Date(slots[slots.length - 1].end - 1));
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={reducedMotion ? { duration: 0 } : { duration: MODE_MS / 1000, ease: EASE }}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 py-1.5">
        <span className="caption truncate">
          Someone's free time · {formatDayRange(from, to)} · tap a slot to book it
        </span>
        <ActionPill icon={<X size={14} strokeWidth={1.75} />} label="Hide" onClick={onDismiss} />
      </div>
    </motion.div>
  );
}
