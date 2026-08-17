/* ------------------------------------------------------------------ *
 * The backup nudge — one quiet line over the stage.
 *
 * A calendar lives in one browser's `localStorage`, and "Clear site data"
 * erases it with no warning. The macOS app and any Chromium browser answer
 * that with a live mirror; Safari and Firefox have no File System Access API
 * and no way to hold a file handle at all, so for those the only possible
 * answer is to notice that no backup has been saved in a long time and say so.
 *
 * This is that notice, and deliberately a line rather than a dialog: nothing
 * in circal has ever interrupted the user, and the whole risk of this feature
 * is that it starts — a modal would be a far bigger change of character. It
 * offers the same export the settings panel uses and a way to dismiss, sits at
 * the top edge so it never covers the dial's readout, and reserves no layout
 * when it is away, so its arrival and departure move nothing.
 * ------------------------------------------------------------------ */

import { Download, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE, MODE_MS } from "@/lib/motion";
import { ActionPill } from "@/components/react/ui/primitives";

export function BackupNudge({
  onBackup,
  onDismiss,
}: {
  onBackup: () => void;
  onDismiss: () => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      // Over the stage, pinned to the top so it clears the readout at the
      // centre. `pointer-events-none` on the frame, re-enabled on the pill:
      // the line must not eat a click meant for the arc beneath it.
      className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={reducedMotion ? { duration: 0 } : { duration: MODE_MS / 1000, ease: EASE }}
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-[10px] border border-hairline bg-surface px-3 py-1.5">
        <span className="caption truncate">No backup saved in a while</span>
        <ActionPill
          icon={<Download size={14} strokeWidth={1.75} />}
          label="Back up now"
          onClick={onBackup}
        />
        <ActionPill icon={<X size={14} strokeWidth={1.75} />} label="Dismiss" onClick={onDismiss} />
      </div>
    </motion.div>
  );
}
