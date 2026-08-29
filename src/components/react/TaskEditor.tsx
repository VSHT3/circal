/* ------------------------------------------------------------------ *
 * A task, as a thing you can name.
 *
 * One column at 330px on `CalendarEditor`'s frame — the same Escape/⌘↵
 * capture, the same footer — because a third modal with a third row
 * grid is a third product. Rows: title, due (day/time/day-only),
 * estimate, priority, calendar, colour, mark, done, the plans as a
 * small list with a remove on each, notes. Convert rebuilds the task
 * as an event and commits once (TASKS.md §10).
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { X, Clock as ClockIcon } from "lucide-react";
import { ESTIMATE_MAX, type Plan, type Task } from "@/lib/tasks";
import { PALETTE, colorOf } from "@/lib/events";
import {
  atMinutes,
  dayKey,
  formatRelativeDay,
  formatTimeShort,
  fromDayKey,
  minutesOfDay,
} from "@/lib/time";
import {
  ColorPicker,
  DateField,
  FieldRow as Row,
  IconButton,
  Kbd,
  MOD,
  NumberField,
  Segmented,
  Select,
  Switch,
  TimeField,
} from "@/components/react/ui/primitives";
import { MarkPicker } from "@/components/react/MarkPicker";
import { useFocusTrap } from "@/components/react/hooks";
import type { TaskEditorProps } from "@/components/react/types";

/** The three priorities, in the order the model numbers them. */
const PRIORITIES = [
  { id: "0", label: "Normal" },
  { id: "1", label: "High" },
  { id: "2", label: "Urgent" },
] as const;

export default function TaskEditor({
  target,
  seedDue,
  calendars,
  defaultCalendar,
  clock,
  onSave,
  onDelete,
  onConvert,
  onClose,
}: TaskEditorProps) {
  const reducedMotion = useReducedMotion();
  const dialog = useFocusTrap<HTMLDivElement>(true);

  const [title, setTitle] = useState(target?.title ?? "");
  const [notes, setNotes] = useState(target?.notes ?? "");
  const [calendarId, setCalendarId] = useState(target?.calendarId ?? defaultCalendar);
  const [due, setDue] = useState(target?.due ?? seedDue);
  // A new task's deadline is a day, not a minute: "due Friday" is the
  // ordinary deadline, and the Day only switch is how the rare timed one
  // is asked for. `seedDue` still carries ⌘N's hour, so flipping the
  // switch lands on a sensible minute rather than midnight.
  const [dueAllDay, setDueAllDay] = useState(target?.dueAllDay ?? true);
  const [estimate, setEstimate] = useState<number | null>(target?.estimate ?? null);
  const [priority, setPriority] = useState<Task["priority"]>(target?.priority ?? 0);
  const [color, setColor] = useState(target?.color ?? "");
  const [icon, setIcon] = useState(target?.icon ?? "");
  const [plans, setPlans] = useState<Plan[]>(target?.plans ?? []);
  const [done, setDone] = useState(target?.done ?? false);
  /** The footer's verbs swap for the question, the calendar card's own move. */
  const [confirming, setConfirming] = useState(false);
  /** The mark browser is a full-screen grid over this card, so Escape belongs
   *  to it before it belongs to the card — the calendar card's own seam. */
  const [browsing, setBrowsing] = useState(false);
  const [markQuery, setMarkQuery] = useState("");

  /** A task on a subscription cannot exist — a feed's records are somebody
   *  else's — so the picker offers only calendars of one's own. */
  const writable = calendars.filter((c) => !c.feed);
  /** What `""` falls back to, so the swatch row can say what "follow the
   *  calendar" currently means. */
  const calendarColor = calendars.find((c) => c.id === calendarId)?.color ?? PALETTE[0];

  function draft(): Omit<Task, "id" | "updatedAt"> {
    return {
      title: title.trim() || "New task",
      notes,
      calendarId,
      icon,
      color,
      due,
      dueAllDay,
      estimate,
      priority,
      plans,
      done,
    };
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Everything is off while the grid is over the card, ⌘↵ included: a save
      // committed from under a surface the user is still working in is the
      // shell's own `busy` bug, one layer in.
      if (browsing) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setBrowsing(false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Captured at `window`, so stopping here keeps the press from also
        // reaching the shell's Escape — the calendar card's own reasoning.
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onSave(draft());
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

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
          aria-label={target ? "Edit task" : "New task"}
          className="relative flex max-h-[86vh] w-[330px] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
          initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          {/* The header is the pip being coloured, at the size it will be
              worn — the calendar card's own rule about previews. */}
          <div className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-3">
            <span
              aria-hidden
              className="size-[9px] shrink-0 rounded-full"
              style={{ backgroundColor: colorOf({ color, calendarId }, calendars) }}
            />
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New task"
              aria-label="Task title"
              className="w-full min-w-0 border-none bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-ink-3"
            />
          </div>

          <div className="no-scrollbar min-h-0 overflow-y-auto">
            <Row label="Due">
              <DateField
                label="Due date"
                className="shrink-0"
                value={dayKey(new Date(due))}
                onChange={(next) => {
                  if (!next) return;
                  // The day moves, the minute stays — `atMinutes` rebuilds the
                  // instant on the picked day's own midnight, so a due time
                  // survives a date change across a DST boundary.
                  setDue(atMinutes(fromDayKey(next), minutesOfDay(new Date(due))).getTime());
                }}
              />
              <Switch checked={dueAllDay} onChange={setDueAllDay} label="Due on the day, no time" />
              <span className="label text-ink-3">Day only</span>
            </Row>

            {!dueAllDay && (
              <Row label="Time">
                <ClockIcon size={14} className="shrink-0 text-ink-2" />
                <TimeField
                  label="Due time"
                  clock={clock}
                  value={new Date(due)}
                  onCommit={(minutes) => setDue(atMinutes(new Date(due), minutes).getTime())}
                />
              </Row>
            )}

            <Row label="Estimate">
              {/* `0` is the field's spelling of "no idea": a zero-minute
                  estimate estimates nothing, and null must stay reachable —
                  the auto-scheduler skips what it cannot size. */}
              <NumberField
                label="Estimate in minutes"
                value={estimate ?? 0}
                min={0}
                max={ESTIMATE_MAX}
                suffix="min"
                onChange={(next) => setEstimate(next > 0 ? next : null)}
              />
              {estimate === null && <span className="label text-ink-3">No idea yet</span>}
            </Row>

            <Row label="Priority">
              <Segmented
                value={String(priority)}
                onChange={(next) => setPriority(Number(next) as Task["priority"])}
                options={PRIORITIES.map((p) => ({ id: p.id, label: p.label }))}
              />
            </Row>

            <Row label="Calendar">
              <Select
                label="Calendar"
                value={calendarId}
                onChange={setCalendarId}
                options={writable.map((c) => ({ value: c.id, label: c.name }))}
              />
            </Row>

            {/* `fallback` because a task's `""` means "follow the calendar",
                the event's own reading — omitted only where nothing sits
                above to inherit from. */}
            <Row label="Color">
              <ColorPicker value={color} fallback={calendarColor} onChange={setColor} />
            </Row>

            <Row label="Mark" align="top">
              <MarkPicker
                icon={icon}
                color={colorOf({ color, calendarId }, calendars)}
                noneLabel="Follow the calendar"
                onChange={setIcon}
                query={markQuery}
                onQuery={setMarkQuery}
                browsing={browsing}
                onBrowse={setBrowsing}
              />
            </Row>

            {/* Only when there are any: an empty list would be a row offering
                to remove nothing. The blocks themselves are placed by the
                drag and the Schedule verb; here they can only be taken away —
                removal is draft state, so Cancel gives every block back. */}
            {plans.length > 0 && (
              <Row label="Planned" align="top">
                <span className="flex w-full min-w-0 flex-col gap-1">
                  {plans.map((plan, index) => (
                    <span
                      key={`${plan.start}-${index}`}
                      className="flex items-center gap-1.5 text-[13px] text-ink"
                    >
                      <span className="truncate tabular-nums">
                        {formatRelativeDay(new Date(plan.start))}{" "}
                        {formatTimeShort(new Date(plan.start), clock)} –{" "}
                        {formatTimeShort(new Date(plan.end), clock)}
                      </span>
                      <IconButton
                        label="Remove this block"
                        className="ml-auto size-6"
                        onClick={() => setPlans((rest) => rest.filter((_, i) => i !== index))}
                      >
                        <X size={12} strokeWidth={1.75} />
                      </IconButton>
                    </span>
                  ))}
                </span>
              </Row>
            )}

            <Row label="Done">
              <Switch checked={done} onChange={setDone} label="Done" />
            </Row>

            <Row label="Notes" align="top" last>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                aria-label="Notes"
                placeholder="Notes"
                className="w-full resize-none rounded-[8px] bg-surface-2 px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
              />
            </Row>
          </div>

          {confirming ? (
            <div className="border-t border-hairline px-3.5 py-3">
              <span className="label text-ink-2">Delete this task</span>
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
                  className="ml-auto flex h-8 items-center rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-danger transition-colors hover:bg-(--veil-10)"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1 border-t border-hairline px-3 py-2.5">
              {target && (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] text-danger transition-colors hover:bg-(--veil-06)"
                  >
                    Delete
                  </button>
                  {/* The Convert verb, both editors' pair: builds the other
                      record and commits once. Quiet, because it is a rare
                      answer to "what is this", not a working control. */}
                  <button
                    type="button"
                    onClick={() => onConvert(draft())}
                    className="flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] whitespace-nowrap text-ink-2 transition-colors hover:bg-(--veil-06) hover:text-ink"
                  >
                    To event
                  </button>
                </>
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
                  onClick={() => onSave(draft())}
                  className="flex h-8 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-(--veil-10)"
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
