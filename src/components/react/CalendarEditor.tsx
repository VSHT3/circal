/* ------------------------------------------------------------------ *
 * A calendar, as a thing you can make.
 *
 * Colour is the only category encoding this product has, and until this
 * card existed the user could not mint one: the three seeded calendars
 * were the whole taxonomy, and everything else was a per-event override.
 * Two fields, because a calendar *is* two fields — a name and a colour.
 *
 * A subscription opens here too. Its events are somebody else's and stay
 * read-only, but what it is called and what colour it wears on the face
 * are local facts about your dial, so both are editable and the rename
 * survives every pull after it (see `store.setFeedEvents`).
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { PALETTE } from "@/lib/events";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/components/react/hooks";
import { ColorPicker, FieldRow as Row, Kbd, MOD } from "@/components/react/ui/primitives";
import { CalendarMark, MarkPicker } from "@/components/react/ui/icons";
import type { CalendarEditorProps } from "@/components/react/types";

/** What deleting costs, in a sentence. The count is the point: a calendar
 *  holding nothing is a label, and a label going away needs no warning. */
function removalNote(holds: number, into: string): string {
  if (holds === 0) return "It holds nothing.";
  return holds === 1 ? `Its one event moves to ${into}.` : `Its ${holds} events move to ${into}.`;
}

export default function CalendarEditor({
  target,
  removal,
  onSave,
  onDelete,
  onClose,
}: CalendarEditorProps) {
  const reducedMotion = useReducedMotion();
  const dialog = useFocusTrap<HTMLDivElement>(true);

  const [name, setName] = useState(target?.name ?? "");
  const [color, setColor] = useState(target?.color ?? PALETTE[0]);
  const [icon, setIcon] = useState(target?.icon ?? "");
  /** Confirming a delete replaces the footer's verbs rather than stacking a
   *  second card on this one — the same swap the event editor's scope question
   *  makes, and for the same reason. */
  const [confirming, setConfirming] = useState(false);

  const feed = target?.feed;
  const trimmed = name.trim();
  const valid = trimmed.length > 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        // Captured at `window`, so stopping here keeps the press from also
        // reaching the shell's Escape, which by then would take its next
        // meaning — leaving ambient, or clearing a lit life grid.
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (trimmed) onSave(trimmed, color, icon);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, onSave, trimmed, color, icon]);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 grid place-items-center">
        <motion.div
          aria-hidden
          onClick={onClose}
          className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.18 }}
        />
        <motion.div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label={target ? "Edit calendar" : "New calendar"}
          className="relative flex w-[330px] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
          initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          {/* The header is the mark being chosen, at the size it will be worn.
              A preview somewhere else in the card would be a second place to
              look while picking. */}
          <div className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-3">
            <CalendarMark icon={icon} color={color} size={16} />
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New calendar"
              aria-label="Calendar name"
              className="w-full min-w-0 border-none bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-ink-3"
            />
          </div>

          <Row label="Color">
            <ColorPicker value={color} onChange={setColor} />
          </Row>

          <Row label="Mark" align="top" last={!feed}>
            <MarkPicker
              icon={icon}
              color={color}
              noneLabel="No mark, just the colour"
              onChange={setIcon}
            />
          </Row>

          {/* A subscription says so, and says where from: the one fact about
              this calendar that is not editable is the only one worth
              printing. */}
          {feed && (
            <Row label="Feed" last>
              <span className="truncate text-[13px] text-ink-2" title={feed.url}>
                {feed.url}
              </span>
            </Row>
          )}

          {confirming && removal ? (
            <div className="border-t border-hairline px-3.5 py-3">
              <span className="label text-ink-3">
                {feed ? "Remove this subscription" : "Delete this calendar"}
              </span>
              <p className="mt-1 text-[13px] text-ink-2">
                {feed
                  ? "Its events are a mirror and go with it."
                  : removalNote(removal.holds, removal.into)}
              </p>
              <div className="mt-2.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="px-1 text-[14px] text-ink-2 transition-colors hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  autoFocus
                  type="button"
                  onClick={onDelete}
                  className="ml-auto flex h-8 items-center rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-danger transition-colors hover:bg-white/10"
                >
                  {feed ? "Remove" : "Delete"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
              {target && (
                <button
                  type="button"
                  disabled={!removal}
                  title={
                    removal
                      ? undefined
                      : "The last calendar stays — every event needs somewhere to be"
                  }
                  onClick={() => setConfirming(true)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] text-danger transition-colors hover:bg-white/6",
                    "disabled:pointer-events-none disabled:opacity-35",
                  )}
                >
                  {feed ? "Remove" : "Delete"}
                </button>
              )}
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-1 text-[14px] text-ink-2 transition-colors hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!valid}
                  onClick={() => onSave(trimmed, color, icon)}
                  className="flex h-8 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-35"
                >
                  {target ? "Save" : "Create"}
                  <Kbd>{MOD}</Kbd>
                  <Kbd>↵</Kbd>
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
