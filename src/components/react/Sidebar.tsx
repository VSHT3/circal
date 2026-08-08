/* ------------------------------------------------------------------ *
 * Left panel: mini month picker, the calendars — visibility, and the
 * card that makes and edits them — and the selected day's agenda.
 * Collapses to zero width so the dial re-centres.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { colorOf, occurrencesOn, spanLabel, statusOf } from "@/lib/events";
import {
  addMonths,
  formatDuration,
  formatRelativeDay,
  formatTimeShort,
  isSameDay,
  WEEKDAYS,
} from "@/lib/time";
import { EASE } from "@/lib/motion";
import type { SidebarProps } from "@/components/react/types";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/react/ui/primitives";
import { CalendarMark } from "@/components/react/ui/icons";

// Monday-first week order — the reference app never starts a row on Sunday.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Sidebar({
  open,
  day,
  now,
  occurrences,
  events,
  calendars,
  clock,
  actions,
}: SidebarProps) {
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
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i));
  }, [displayMonth]);

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
            className="fade-y no-scrollbar flex h-full w-[260px] flex-col gap-5 overflow-y-auto p-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: EASE }}
          >
            <section className="flex w-full shrink-0 flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="label text-ink-2">
                  {displayMonth.toLocaleString(undefined, { month: "long" })}{" "}
                  {displayMonth.getFullYear()}
                </span>
                <div className="flex items-center gap-0.5">
                  <IconButton
                    label="Previous month"
                    onClick={() => setDisplayMonth((m) => addMonths(m, -1))}
                  >
                    <ChevronLeft size={13} strokeWidth={1.75} />
                  </IconButton>
                  <IconButton
                    label="Next month"
                    onClick={() => setDisplayMonth((m) => addMonths(m, 1))}
                  >
                    <ChevronRight size={13} strokeWidth={1.75} />
                  </IconButton>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-y-1">
                {WEEK_ORDER.map((i) => (
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
                <span className="label text-ink-3">Calendars</span>
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

            <section className="flex w-full shrink-0 flex-col gap-1">
              <span className="label text-ink-3">{formatRelativeDay(day, now)}</span>
              {occurrences.length === 0 ? (
                <span className="label text-ink-4">Nothing scheduled</span>
              ) : (
                occurrences.map((occ) => {
                  const status = statusOf(occ, now);
                  const color = colorOf(occ.event, calendars);
                  const durationMin = (occ.end.getTime() - occ.start.getTime()) / 60_000;
                  const span = spanLabel(occ);
                  const timeLabel = occ.event.allDay
                    ? "ALL DAY"
                    : `${formatTimeShort(occ.start, clock)}–${formatTimeShort(occ.end, clock)}`;
                  // A row inside one day reads `9:00–10:00 · 1h`. A row inside a
                  // longer span leads with where in it you are, and spends the
                  // second slot on the span's own clock times rather than on a
                  // duration — `120h` is a true thing to say about five days and
                  // a useless one, and an all-day span has no times to print at
                  // all, so it says nothing twice.
                  const meta = span
                    ? occ.event.allDay
                      ? null
                      : timeLabel
                    : formatDuration(durationMin);
                  return (
                    <button
                      key={occ.key}
                      type="button"
                      onClick={() => actions.openEvent(occ.event)}
                      className={cn(
                        "flex items-stretch gap-2 rounded-[8px] px-1.5 py-1 text-left transition-colors hover:bg-white/6",
                        status === "past" && "opacity-40",
                      )}
                    >
                      <span
                        className="w-[2px] shrink-0 self-stretch rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-1.5">
                          {status === "now" && (
                            <span
                              className="size-[5px] shrink-0 animate-pulse rounded-full"
                              style={{ backgroundColor: color }}
                            />
                          )}
                          <span className="truncate text-[13px] text-ink">{occ.event.title}</span>
                        </span>
                        <span className="label text-[10px] text-ink-3">
                          {span ?? (status === "now" ? "NOW" : timeLabel)}
                          {meta && (
                            <>
                              {" "}
                              <span className="text-ink-4">·</span> {meta}
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
