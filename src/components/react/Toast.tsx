/* ------------------------------------------------------------------ *
 * The only thing in the app that speaks in prose.
 *
 * Bottom centre, over the dial's dead space, gone in four seconds. It exists
 * because a store that cannot report a failed write is a store that loses data
 * silently — everything else it says (exported, imported, undone) is a bonus
 * from having a channel at all.
 * ------------------------------------------------------------------ */

import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { dismissNotice, useNotice } from "@/lib/notify";
import { cn } from "@/lib/utils";

const DISMISS_MS = 4200;

export default function Toast() {
  const notice = useNotice();
  const reducedMotion = useReducedMotion();
  const seq = notice?.seq;

  useEffect(() => {
    if (seq === undefined) return;
    const timer = window.setTimeout(dismissNotice, DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [seq]);

  return (
    <AnimatePresence>
      {notice && (
        <motion.button
          // Keyed on the sequence, not the text: the same message twice must
          // replay the entrance rather than sit there looking ignored.
          key={notice.seq}
          type="button"
          onClick={dismissNotice}
          className={cn(
            "fixed bottom-6 left-1/2 z-[70] max-w-[80vw] rounded-[10px] border px-3.5 py-2 text-[13px]",
            "border-hairline bg-surface text-ink shadow-[0_20px_50px_-16px_rgba(0,0,0,0.9)]",
            notice.tone === "error" && "text-danger",
          )}
          initial={reducedMotion ? false : { opacity: 0, y: 10, x: "-50%" }}
          animate={{ opacity: 1, y: 0, x: "-50%" }}
          exit={reducedMotion ? { opacity: 0, x: "-50%" } : { opacity: 0, y: 6, x: "-50%" }}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          {notice.text}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
