/* ------------------------------------------------------------------ *
 * Left panel: mini month picker, the calendars — visibility, and the
 * card that makes and edits them — and the moon.
 *
 * No agenda. The dial's interior answers the day, and the day is on screen
 * beside this column: a second list of the same occurrences two hundred
 * pixels to its left was the same fact twice, and it was the fact this
 * column had least room for.
 *
 * Collapses to zero width so the dial re-centres.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { colorOf, occurrencesOn } from "@/lib/events";
import { addMonths, isSameDay, weekOffset, WEEKDAYS } from "@/lib/time";
import { EASE } from "@/lib/motion";
import type { SidebarProps } from "@/components/react/types";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/react/ui/primitives";
import { useFocusTrap } from "@/components/react/hooks";
import { CalendarMark } from "@/components/react/ui/icons";
import MoonPanel from "@/components/react/MoonPanel";

/**
 * The column's width, in pixels, and the shell needs the number: it decides
 * `push` against `drawer` by asking whether taking this much off the stage
 * would start costing the dial. Kept in step with the `w-[260px]` below by
 * hand — the same bargain `LIFE_META_H` strikes with its CSS.
 */
export const SIDEBAR_W = 260;

export default function Sidebar({
  open,
  mode,
  day,
  now,
  events,
  calendars,
  moon,
  weekStart,
  actions,
}: SidebarProps) {
  const drawer = mode === "drawer";
  /**
   * A drawer covers the face, so it is modal whatever we call it: it takes
   * the focus and gives it back. Never in `push` mode, where the column sits
   * beside the dial and both are usable at once.
   */
  const dialog = useFocusTrap<HTMLDivElement>(open && drawer);
  const reducedMotion = useReducedMotion();
  // The mini month follows the selected day, but can also be paged on its own.
  // Resetting during render (React's "adjust state when props change") keeps
  // both true without an effect that renders the stale month first.
  const [displayMonth, setDisplayMonth] = useState(
    () => new Date(day.getFullYear(), day.getMonth(), 1),
  );
  const [seeded, setSeeded] = useState(day);
  if (seeded !== day) {
    setSeeded(day);
    setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
  }

  const cells = useMemo(() => {
    const year = displayMonth.getFullYear();
    const month = displayMonth.getMonth();
    const offset = weekOffset(new Date(year, month, 1), weekStart);
    return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
  }, [displayMonth, weekStart]);

  /** The header letters, cut on the same weekday the grid above is — a row
   *  that always read Mon-first regardless of the setting would agree with
   *  the numerals only one week start out of three. */
  const weekOrder = useMemo(
    () => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7),
    [weekStart],
  );

  const body = (
    <div className="fade-y no-scrollbar flex h-full w-[260px] flex-col gap-5 overflow-y-auto p-3">
      <section className="flex w-full shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="label text-ink-2">
            {displayMonth.toLocaleString(undefined, { month: "long" })} {displayMonth.getFullYear()}
          </span>
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Previous month"
              onClick={() => setDisplayMonth((m) => addMonths(m, -1))}
            >
              <ChevronLeft size={13} strokeWidth={1.75} />
            </IconButton>
            <IconButton label="Next month" onClick={() => setDisplayMonth((m) => addMonths(m, 1))}>
              <ChevronRight size={13} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-y-1">
          {weekOrder.map((i) => (
            <span key={i} className="label text-center text-[9px] text-ink-4">
              {WEEKDAYS[i][0]}
            </span>
          ))}
          {cells.map((cellDate) => {
            const inMonth = cellDate.getMonth() === displayMonth.getMonth();
            const isToday = isSameDay(cellDate, now);
            const isSelected = isSameDay(cellDate, day);
            const dots = occurrencesOn(events, calendars, cellDate).slice(0, 3);
            return (
              <button
                key={cellDate.toISOString()}
                type="button"
                onClick={() => actions.goDay(cellDate)}
                className={cn(
                  "flex h-7 flex-col items-center justify-center gap-[2px] rounded-[7px] transition-colors hover:bg-white/8",
                  isSelected && "bg-ink text-void hover:bg-ink",
                  !isSelected && isToday && "text-accent",
                  !isSelected && !isToday && inMonth && "text-ink-2",
                  !isSelected && !isToday && !inMonth && "text-ink-4",
                )}
              >
                <span className="text-[11px] leading-none">{cellDate.getDate()}</span>
                {/* The dot row is always there, empty or not. Mounted
                          only when a day carries something, the numeral rose
                          by half a dot on exactly those days and the month
                          read as a ragged line — the dots are the signal, the
                          shift was an artefact of them. */}
                <span className="flex h-[3px] items-center gap-[2px]">
                  {dots.map((occ) => (
                    <span
                      key={occ.key}
                      className="size-[3px] rounded-full"
                      style={{
                        backgroundColor: isSelected
                          ? "currentColor"
                          : colorOf(occ.event, calendars),
                      }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex w-full shrink-0 flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="label text-ink-2">Calendars</span>
          <IconButton label="New calendar" onClick={actions.newCalendar} className="size-6">
            <Plus size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
        {/* Two verbs on one row, so it cannot be one button: the row is
                  the visibility switch and the pencil opens the calendar
                  itself. The pencil is hidden until the row is pointed at or
                  something in it takes focus — a column of them reads as a
                  toolbar, and this list is mostly used for its switches. */}
        {calendars.map((calendar) => (
          <div key={calendar.id} className="group flex items-center gap-1">
            <button
              type="button"
              role="switch"
              aria-checked={calendar.visible}
              onClick={() => actions.toggleCalendar(calendar.id)}
              className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-1.5 transition-colors hover:bg-white/6"
            >
              <span
                className={cn(
                  "grid w-[15px] place-items-center",
                  !calendar.visible && "opacity-25",
                )}
              >
                <CalendarMark icon={calendar.icon} color={calendar.color} size={14} />
              </span>
              <span
                className={cn(
                  "truncate text-[12.5px]",
                  calendar.visible ? "text-ink" : "text-ink-3",
                )}
              >
                {calendar.name}
              </span>
            </button>
            <IconButton
              label={`Edit ${calendar.name}`}
              onClick={() => actions.editCalendar(calendar.id)}
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Pencil size={12} strokeWidth={1.75} />
            </IconButton>
          </div>
        ))}
      </section>

      {/* Last, and quiet. The mini-month is navigation and the calendar
                list is data; this is the one thing in the column that is
                neither — so it sits at the foot of it, the way a complication
                sits at the foot of a dial. It reads the *selected* day, which
                is what makes it worth having: arrowing through a week walks
                the moon through its week. */}
      {moon && <MoonPanel day={day} />}
    </div>
  );

  // A drawer, because pushing would cost the dial more than the column is
  // worth: it lies over the face, on its own scrim, and slides rather than
  // squeezing. It stays inside the row below the top bar, so the button that
  // opened it is still the button that closes it — no header of its own, and
  // no second verb to explain.
  if (drawer) {
    return (
      <>
        <AnimatePresence>
          {open && (
            <motion.div
              key="scrim"
              role="presentation"
              onClick={actions.toggleSidebar}
              className="absolute inset-0 z-20 bg-black/50"
              initial={reducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reducedMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
            />
          )}
        </AnimatePresence>
        <div
          ref={dialog}
          // The trap moves focus onto the container when the dialog has
          // nothing to autofocus, and a `div` cannot take it without this.
          tabIndex={-1}
          inert={!open}
          role="dialog"
          aria-modal="true"
          aria-label="Sidebar"
          className={cn(
            "absolute inset-y-0 left-0 z-30 w-[260px] border-r border-hairline bg-void transition-transform duration-[220ms]",
            !open && "-translate-x-full",
          )}
        >
          {body}
        </div>
      </>
    );
  }

  return (
    <div
      // `inert`, not `aria-hidden`: the panel is held mounted while it leaves,
      // and for those 180 ms `aria-hidden` would be sitting over live tab
      // stops — a keyboard user tabbing into controls nobody can see. `inert`
      // takes the focus and the accessibility tree together, which is the one
      // thing "this column is closed" actually means.
      inert={!open}
      className={cn(
        "h-full shrink-0 border-r border-hairline bg-void transition-[width] duration-[220ms]",
        open ? "w-[260px]" : "w-0 overflow-hidden",
      )}
    >
      {/* Held mounted while it leaves, so the column's 220 ms of width has
          something in it to clip. Unmounted on the frame the toggle flips, the
          panel emptied first and then the black gap closed, which reads as two
          things going wrong rather than one thing sliding away. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="h-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: EASE }}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
