/* ------------------------------------------------------------------ *
 * ⌘Y — the whole year on one screen. Twelve compact month grids, no
 * scrolling; a memoised density map keeps 365 `occurrencesOn` calls off
 * the render path.
 * ------------------------------------------------------------------ */

import { useMemo } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { YearViewProps } from "@/components/react/types";
import { type Calendar, type CalEvent } from "@/lib/events";
import { dayColors, mondayOffset } from "@/lib/life";
import { MONTHS, WEEKDAYS, daysInMonth, dayKey, isSameDay } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Monday-first initials row — sliced from `WEEKDAYS`, never a hardcoded set. */
const WEEKDAY_INITIALS = [1, 2, 3, 4, 5, 6, 0].map((i) => WEEKDAYS[i][0]);

/** Up to 3 distinct calendar colours per day, keyed by `dayKey` — `dayColors`
 *  is the same per-day core the life grid draws from, so a recurring event
 *  lands on the same days here as it would there. */
function buildDensityMap(year: number, events: CalEvent[], calendars: Calendar[]) {
  const map = new Map<string, string[]>();
  for (let month = 0; month < 12; month++) {
    const total = daysInMonth(year, month);
    for (let day = 1; day <= total; day++) {
      const date = new Date(year, month, day);
      const colors = dayColors(events, calendars, date, 3);
      if (colors.length === 0) continue;
      map.set(dayKey(date), colors);
    }
  }
  return map;
}

interface MonthCell {
  date: Date | null;
}

function monthCells(year: number, month: number): MonthCell[] {
  const offset = mondayOffset(new Date(year, month, 1));
  const total = daysInMonth(year, month);
  const cells: MonthCell[] = [];
  for (let i = 0; i < offset; i++) cells.push({ date: null });
  for (let day = 1; day <= total; day++) cells.push({ date: new Date(year, month, day) });
  return cells;
}

function MonthBlock({
  year,
  month,
  today,
  selected,
  density,
  onSelectDay,
}: {
  year: number;
  month: number;
  today: Date;
  selected: Date;
  density: Map<string, string[]>;
  onSelectDay: (day: Date) => void;
}) {
  const cells = useMemo(() => monthCells(year, month), [year, month]);
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  return (
    <div>
      <div className={cn("label mb-2 text-[11px]", isCurrentMonth ? "text-accent" : "text-ink-2")}>
        {MONTHS[month]}
      </div>
      <div className="grid grid-cols-7 gap-y-px">
        {WEEKDAY_INITIALS.map((initial, i) => (
          <div
            key={i}
            className="label flex h-4 w-[34px] items-center justify-center text-[9px] text-ink-4"
          >
            {initial}
          </div>
        ))}
        {cells.map((cell, i) => {
          if (!cell.date) return <div key={i} className="h-[30px] w-[34px]" />;
          const date = cell.date;
          const isSelected = isSameDay(date, selected);
          const isToday = isSameDay(date, today);
          const weekday = date.getDay();
          const isWeekend = weekday === 0 || weekday === 6;
          const colors = density.get(dayKey(date)) ?? [];

          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelectDay(date)}
              aria-label={`${WEEKDAYS[weekday]}, ${MONTHS[month]} ${date.getDate()}, ${year}`}
              className={cn(
                "flex h-[30px] w-[34px] flex-col items-center justify-center gap-[2px] rounded-[7px] text-[12.5px] tabular-nums transition-colors",
                isSelected
                  ? "bg-ink text-void"
                  : isToday
                    ? "font-medium text-accent ring-1 ring-accent/40"
                    : isWeekend
                      ? "text-ink-4"
                      : "text-ink-3 hover:bg-white/8 hover:text-ink",
              )}
            >
              <span>{date.getDate()}</span>
              <span className="flex h-[3px] items-center justify-center gap-[2px]">
                {colors.map((color, ci) => (
                  <span
                    key={ci}
                    className="h-[3px] w-[3px] rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function YearView({
  year,
  today,
  selected,
  events,
  calendars,
  onSelectDay,
}: YearViewProps) {
  const reducedMotion = useReducedMotion();
  const density = useMemo(
    () => buildDensityMap(year, events, calendars),
    [year, events, calendars],
  );

  return (
    <motion.div
      className="grid h-full w-full place-items-center overflow-hidden bg-void"
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      {/* Four across, three down: at a desktop aspect ratio six columns leave
          the bottom half of the window empty. */}
      <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-x-12 gap-y-7 px-8 py-6 sm:grid-cols-3 lg:grid-cols-4 lg:grid-rows-3">
        {MONTHS.map((_, month) => (
          <MonthBlock
            key={month}
            year={year}
            month={month}
            today={today}
            selected={selected}
            density={density}
            onSelectDay={onSelectDay}
          />
        ))}
      </div>
    </motion.div>
  );
}
