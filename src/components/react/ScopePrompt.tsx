/* ------------------------------------------------------------------ *
 * The question a repeating event is asked before an edit lands: only
 * this one, this and all future, or the whole series.
 *
 * One set of answers, two containers. The editor asks it in its own
 * footer, because the edit it is about is already on screen there and a
 * modal over a modal is a stack nobody can read. A drag on the dial has
 * no modal to sit in and gets its own card, which then has to say what
 * it is asking about — the gesture is over by the time it appears.
 *
 * Both go through `ScopeChoices`: two copies of a three-way question
 * drift into two vocabularies, which is how "Only this one" ends up
 * meaning one thing in the editor and another on the face.
 * ------------------------------------------------------------------ */

import { motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/components/react/hooks";
import { Kbd } from "@/components/react/ui/primitives";
import type { EditScope, ScopeChoicesProps, ScopeDialogProps } from "@/components/react/types";

/**
 * The three answers, narrowest first: the safe one is the shortest reach, and
 * the one that rewrites a year of history is the furthest.
 */
const SCOPES: { scope: EditScope; label: string }[] = [
  { scope: "one", label: "Only this one" },
  { scope: "future", label: "This and all future" },
  { scope: "all", label: "The whole series" },
];

export function ScopeChoices({ heading, danger, onPick, onCancel }: ScopeChoicesProps) {
  return (
    <div className="px-3.5 py-3">
      <span className="label text-ink-3">{heading}</span>
      <div className="mt-2 flex flex-col gap-1">
        {SCOPES.map(({ scope, label }, i) => (
          <button
            key={scope}
            // Focus must move into the question when it opens, and it lands on
            // the narrowest answer — the one that costs least to pick by
            // accident.
            autoFocus={i === 0}
            type="button"
            onClick={() => onPick(scope)}
            className={cn(
              "flex h-9 items-center rounded-[9px] border border-hairline bg-surface-2 px-3 text-left text-[14px] transition-colors hover:bg-white/10",
              danger ? "text-danger" : "text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="mt-2.5 flex items-center gap-1.5 px-1 text-[14px] text-ink-2 transition-colors hover:text-ink"
      >
        Cancel
        <Kbd>esc</Kbd>
      </button>
    </div>
  );
}

/** The same question with a card around it, for a gesture that has already
 *  finished — a drag on the dial, which has no panel of its own to ask in. */
export function ScopeDialog({
  title,
  detail,
  heading,
  danger,
  onPick,
  onCancel,
}: ScopeDialogProps) {
  const reducedMotion = useReducedMotion();
  // Mounted only while it is open, so the trap is always armed.
  const dialog = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Captured at `window`, so stopping here keeps the press from also
      // reaching the shell's own Escape, which by then would take its next
      // meaning — leaving ambient, or clearing a lit life grid.
      e.stopPropagation();
      onCancel();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <motion.div
        aria-hidden
        onClick={onCancel}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.18 }}
      />
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="relative w-[300px] overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
        initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
      >
        {/* What the answer is about. The arc behind this is already sitting
            where the drag left it, but the card covers a third of the face and
            the readout under it, so it says the span itself. */}
        <div className="border-b border-hairline px-3.5 py-3">
          <div className="truncate text-[15px] font-medium text-ink">{title}</div>
          <div className="mt-0.5 text-[13px] text-ink-2">{detail}</div>
        </div>
        <ScopeChoices heading={heading} danger={danger} onPick={onPick} onCancel={onCancel} />
      </motion.div>
    </div>
  );
}
