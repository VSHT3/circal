import { motion, useReducedMotion } from "motion/react";
import { EASE } from "@/lib/motion";
import { useFocusTrap } from "@/components/react/hooks";
import { ActionPill, Kbd, MOD } from "@/components/react/ui/primitives";

export default function TeachingCard({ onDismiss }: { onDismiss: () => void }) {
  const reducedMotion = useReducedMotion();
  const dialog = useFocusTrap<HTMLDivElement>(true);

  return (
    <div className="absolute inset-0 z-50 flex overflow-y-auto bg-void p-4">
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="teaching-title"
        aria-describedby="teaching-description"
        tabIndex={-1}
        className="m-auto w-[420px] max-w-full shrink-0 rounded-[14px] border border-hairline bg-surface p-4"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: EASE }}
        onKeyDown={(event) => {
          // The mounted views keep window listeners even while their DOM is inert.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
          }
        }}
      >
        <h1 id="teaching-title" className="text-[17px] font-medium text-ink">
          Start with your day
        </h1>
        <p id="teaching-description" className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          Each turn of the dial is one day. Your events are the arcs around its rim.
        </p>

        <div className="mt-4 space-y-4 text-[13px] leading-relaxed text-ink-2">
          <section aria-labelledby="teaching-palette">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="teaching-palette" className="font-medium text-ink">
                Open the command palette
              </h2>
              <span className="flex items-center gap-1">
                <Kbd>{MOD}</Kbd>
                <Kbd>P</Kbd>
              </span>
            </div>
            <p className="mt-1">Add an event or task, search your calendar, or jump to a date.</p>
          </section>

          <section aria-labelledby="teaching-views">
            <h2 id="teaching-views" className="font-medium text-ink">
              Choose a view
            </h2>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-2">
              {[
                ["Day", "D"],
                ["Week", "E"],
                ["Year", "Y"],
                ["Life", "L"],
              ].map(([name, key]) => (
                <div key={key} className="flex flex-wrap items-center justify-between gap-1">
                  <dt>{name}</dt>
                  <dd className="flex items-center gap-1">
                    <Kbd>{MOD}</Kbd>
                    <Kbd>{key}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="teaching-events">
            <h2 id="teaching-events" className="font-medium text-ink">
              Draw and adjust events
            </h2>
            <p className="mt-1">
              Drag a blank part of the day’s rim to make an event. Drag an arc to move it, or drag
              either end to resize it.
            </p>
          </section>

          <section aria-labelledby="teaching-tasks">
            <h2 id="teaching-tasks" className="font-medium text-ink">
              Put tasks on the calendar
            </h2>
            <p className="mt-1">
              Drag a task from the sidebar onto the dial or a day in Week view. On touch, use the
              Schedule button beside the task.
            </p>
          </section>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          <ActionPill
            label="Start using circal"
            icon={<span>Start using circal</span>}
            onClick={onDismiss}
            className="h-9 w-full justify-center bg-ink text-[13.5px] font-medium text-void hover:bg-ink hover:text-void hover:opacity-90"
          />
          <a
            href="/tour/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-9 items-center justify-center rounded-[8px] text-[13px] text-ink-2 underline underline-offset-4 hover:text-ink pointer-coarse:min-h-10"
            aria-label="Show me around (opens in a new tab)"
          >
            Show me around
          </a>
        </div>
      </motion.div>
    </div>
  );
}
