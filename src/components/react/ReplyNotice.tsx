/* ------------------------------------------------------------------ *
 * The booking's reply — one quiet line over the stage.
 *
 * Booking a received slot is only half the exchange: circal posts nothing,
 * so the receiver carries the answer back down the same road the offer
 * arrived on. This line is that hand-over — the saved event as a link the
 * sender's circal seeds an editor from, and as an `.ics` for a sender on any
 * other calendar. `BackupNudge`'s shape exactly, for `SlotsNotice`'s reason:
 * a third voice over the stage would be a status bar.
 * ------------------------------------------------------------------ */

import { Download, Link, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE, MODE_MS } from "@/lib/motion";
import { ActionPill } from "@/components/react/ui/primitives";

export function ReplyNotice({
  onCopy,
  onIcs,
  onDismiss,
}: {
  /** The saved event onto the clipboard as a `#e=` link, disclosure toast
   *  included — the shell's own share verb, not a second spelling of it. */
  onCopy: () => void;
  /** The same event as a downloaded `.ics` file. */
  onIcs: () => void;
  onDismiss: () => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={reducedMotion ? { duration: 0 } : { duration: MODE_MS / 1000, ease: EASE }}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 py-1.5">
        <span className="caption truncate">Booked · send it back so both calendars agree</span>
        <ActionPill
          icon={<Link size={14} strokeWidth={1.75} />}
          label="Copy link"
          onClick={onCopy}
        />
        <ActionPill icon={<Download size={14} strokeWidth={1.75} />} label=".ics" onClick={onIcs} />
        <ActionPill icon={<X size={14} strokeWidth={1.75} />} label="Hide" onClick={onDismiss} />
      </div>
    </motion.div>
  );
}
