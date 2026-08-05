/* ------------------------------------------------------------------ *
 * ⌘K palette — jump to a date, find an event, run a command. Every
 * result is flattened into one keyboard-navigable list regardless of
 * which group it renders under.
 * ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CalendarSearch,
  Circle,
  Clock3,
  Grid2x2,
  PanelLeft,
  Plus,
  Search,
} from "lucide-react";
import { Kbd } from "@/components/react/ui/primitives";
import type { CommandPaletteProps } from "@/components/react/types";
import { colorOf, type CalEvent } from "@/lib/events";
import {
  addDays,
  daysInMonth,
  formatRelativeDay,
  formatTimeShort,
  MONTHS,
  startOfDay,
  WEEKDAYS,
} from "@/lib/time";
import { cn } from "@/lib/utils";

const EASE = [0.32, 0.72, 0, 1] as const;
const WEEKDAYS_LOWER = WEEKDAYS.map((w) => w.toLowerCase());
const MONTHS_LOWER = MONTHS.map((m) => m.toLowerCase());

/** One row in the flattened, keyboard-navigable result list. */
interface Row {
  id: string;
  icon?: ReactNode;
  dot?: string;
  title: string;
  meta?: ReactNode;
  run: () => void;
}

interface Group {
  title: string;
  rows: Row[];
}

/**
 * Resolves free-text into a date, relative to `reference` (the day the
 * palette was opened on). Order matters: literal words first, then
 * unambiguous structured formats, then the loosest one (a bare number).
 */
function parseDate(raw: string, reference: Date): Date | null {
  const query = raw.trim().toLowerCase();
  if (!query) return null;

  const base = startOfDay(reference);

  if (query === "today") return base;
  if (query === "tomorrow") return addDays(base, 1);
  if (query === "yesterday") return addDays(base, -1);

  const weekdayIndex = WEEKDAYS_LOWER.findIndex((w) => w === query || w.slice(0, 3) === query);
  if (weekdayIndex !== -1) {
    const delta = (weekdayIndex - base.getDay() + 7) % 7 || 7;
    return addDays(base, delta);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const dom = Number(iso[3]);
    if (month >= 0 && month < 12 && dom >= 1 && dom <= daysInMonth(year, month)) {
      return new Date(year, month, dom);
    }
    return null;
  }

  const resolveMonthDay = (monthStr: string, domStr: string): Date | null => {
    const monthIndex = MONTHS_LOWER.findIndex((m) => m === monthStr || m.slice(0, 3) === monthStr);
    const dom = Number(domStr);
    if (monthIndex === -1 || dom < 1 || dom > daysInMonth(reference.getFullYear(), monthIndex))
      return null;
    const year = reference.getFullYear();
    const candidate = new Date(year, monthIndex, dom);
    return candidate.getTime() < base.getTime() ? new Date(year + 1, monthIndex, dom) : candidate;
  };

  const monthDay = /^([a-z]+)\s+(\d{1,2})$/.exec(query);
  if (monthDay) {
    const resolved = resolveMonthDay(monthDay[1], monthDay[2]);
    if (resolved) return resolved;
  }

  const dayMonth = /^(\d{1,2})\s+([a-z]+)$/.exec(query);
  if (dayMonth) {
    const resolved = resolveMonthDay(dayMonth[2], dayMonth[1]);
    if (resolved) return resolved;
  }

  const relative = /^([+-])(\d+)$/.exec(query);
  if (relative) {
    return addDays(base, Number(relative[2]) * (relative[1] === "-" ? -1 : 1));
  }

  const inDays = /^in\s+(\d+)\s+days?$/.exec(query);
  if (inDays) return addDays(base, Number(inDays[1]));

  const bareDay = /^(\d{1,2})$/.exec(query);
  if (bareDay) {
    const dom = Number(bareDay[1]);
    if (dom < 1 || dom > 31) return null;
    let year = reference.getFullYear();
    let month = reference.getMonth();
    if (dom > daysInMonth(year, month)) return null;
    let candidate = new Date(year, month, dom);
    if (candidate.getTime() < base.getTime()) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      if (dom > daysInMonth(year, month)) return null;
      candidate = new Date(year, month, dom);
    }
    return candidate;
  }

  return null;
}

const CHROME_ICON_PROPS = { size: 15, strokeWidth: 1.75 as const, className: "text-ink-3" };

export default function CommandPalette({
  open,
  onClose,
  day,
  sidebarOpen,
  events,
  calendars,
  clock,
  actions,
}: CommandPaletteProps) {
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Reset during render on the open transition rather than in an effect: an
  // effect would paint last session's query for one frame before clearing it.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setHighlighted(0);
    }
  }

  const q = query.trim().toLowerCase();

  const jumpDate = useMemo(() => parseDate(query, day), [query, day]);
  const jumpRows: Row[] = useMemo(() => {
    if (!jumpDate) return [];
    const label = `Jump to ${WEEKDAYS[jumpDate.getDay()]}, ${MONTHS[jumpDate.getMonth()]} ${jumpDate.getDate()}`;
    return [
      {
        id: "jump",
        icon: <CalendarSearch {...CHROME_ICON_PROPS} />,
        title: label,
        run: () => {
          actions.goDay(jumpDate);
          actions.setView("day");
          onClose();
        },
      },
    ];
  }, [jumpDate, actions, onClose]);

  const eventRows: Row[] = useMemo(() => {
    const matches = (e: CalEvent) =>
      e.title.toLowerCase().includes(q) ||
      e.location.toLowerCase().includes(q) ||
      e.notes.toLowerCase().includes(q);
    return events
      .filter(matches)
      .sort((a, b) => Math.abs(a.start - day.getTime()) - Math.abs(b.start - day.getTime()))
      .slice(0, 8)
      .map((event) => ({
        id: `event-${event.id}`,
        dot: colorOf(event, calendars),
        title: event.title,
        meta: (
          <span className="label text-ink-3">
            {event.allDay
              ? "ALL DAY"
              : `${formatRelativeDay(new Date(event.start))} ${formatTimeShort(new Date(event.start))}`}
          </span>
        ),
        run: () => {
          actions.goDay(new Date(event.start));
          actions.openEvent(event);
          onClose();
        },
      }));
  }, [events, q, day, calendars, actions, onClose]);

  const commandRows: Row[] = useMemo(() => {
    const base: Row[] = [
      {
        id: "cmd-new-event",
        icon: <Plus {...CHROME_ICON_PROPS} />,
        title: "New event",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>N</Kbd>
          </>
        ),
        run: () => {
          actions.newEvent();
          onClose();
        },
      },
      {
        id: "cmd-go-today",
        icon: <CalendarDays {...CHROME_ICON_PROPS} />,
        title: "Go to today",
        run: () => {
          actions.goToday();
          onClose();
        },
      },
      {
        id: "cmd-day-view",
        icon: <Circle {...CHROME_ICON_PROPS} />,
        title: "Day view",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>D</Kbd>
          </>
        ),
        run: () => {
          actions.setView("day");
          onClose();
        },
      },
      {
        id: "cmd-year-view",
        icon: <Grid2x2 {...CHROME_ICON_PROPS} />,
        title: "Year view",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>Y</Kbd>
          </>
        ),
        run: () => {
          actions.setView("year");
          onClose();
        },
      },
      {
        id: "cmd-tomorrow",
        icon: <ArrowRight {...CHROME_ICON_PROPS} />,
        title: "Tomorrow",
        run: () => {
          actions.goDay(addDays(day, 1));
          onClose();
        },
      },
      {
        id: "cmd-yesterday",
        icon: <ArrowLeft {...CHROME_ICON_PROPS} />,
        title: "Yesterday",
        run: () => {
          actions.goDay(addDays(day, -1));
          onClose();
        },
      },
      {
        id: "cmd-toggle-sidebar",
        icon: <PanelLeft {...CHROME_ICON_PROPS} />,
        title: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        run: () => {
          actions.toggleSidebar();
          onClose();
        },
      },
      {
        id: "cmd-clock",
        icon: <Clock3 {...CHROME_ICON_PROPS} />,
        title: clock === "12h" ? "Use the 24-hour dial (00–23)" : "Use the 12-hour dial (AM/PM)",
        run: () => {
          actions.setClock(clock === "12h" ? "24h" : "12h");
          onClose();
        },
      },
      ...calendars.map((cal) => ({
        id: `cmd-cal-${cal.id}`,
        dot: cal.color,
        title: cal.visible ? `Hide ${cal.name}` : `Show ${cal.name}`,
        run: () => {
          actions.toggleCalendar(cal.id);
          onClose();
        },
      })),
    ];
    return base.filter((row) => row.title.toLowerCase().includes(q));
  }, [q, day, sidebarOpen, calendars, clock, actions, onClose]);

  const groups: Group[] = useMemo(
    () =>
      [
        { title: "Jump", rows: jumpRows },
        { title: "Events", rows: eventRows },
        { title: "Commands", rows: commandRows },
      ].filter((g) => g.rows.length > 0),
    [jumpRows, eventRows, commandRows],
  );

  const flatItems = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    flatItems.forEach((row, i) => map.set(row.id, i));
    return map;
  }, [flatItems]);

  useEffect(() => {
    itemRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatItems.length > 0) setHighlighted((i) => (i + 1) % flatItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatItems.length > 0)
        setHighlighted((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      flatItems[highlighted]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[18vh] backdrop-blur-[2px]"
          onClick={onClose}
          role="presentation"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-[520px] max-w-[90vw] overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
          >
            <div className="flex h-12 items-center gap-3 border-b border-hairline px-4">
              <Search size={15} className="shrink-0 text-ink-3" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlighted(0);
                }}
                placeholder="Search events, jump to a date, run a command…"
                aria-label="Search events, jump to a date, run a command"
                aria-controls="cmdk-listbox"
                aria-activedescendant={
                  flatItems[highlighted] ? `cmdk-option-${highlighted}` : undefined
                }
                role="combobox"
                aria-expanded
                aria-autocomplete="list"
                className="h-full flex-1 text-[15px] text-ink placeholder:text-ink-3"
              />
            </div>

            {flatItems.length === 0 ? (
              <div className="label py-8 text-center text-ink-4">No results</div>
            ) : (
              <div
                id="cmdk-listbox"
                role="listbox"
                className="no-scrollbar max-h-[46vh] overflow-y-auto py-1.5"
              >
                {groups.map((group) => (
                  <div key={group.title}>
                    <div className="label px-4 py-1.5 text-ink-4">{group.title}</div>
                    {group.rows.map((row) => {
                      const idx = indexById.get(row.id) ?? -1;
                      const active = idx === highlighted;
                      return (
                        // Keyboard control lives on the combobox input above
                        // (↑/↓/⏎); a focusable option would break that pattern.
                        // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- ARIA combobox option
                        <div
                          key={row.id}
                          ref={(el) => {
                            itemRefs.current[idx] = el;
                          }}
                          id={`cmdk-option-${idx}`}
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          onMouseEnter={() => setHighlighted(idx)}
                          onClick={row.run}
                          className={cn(
                            "mx-1.5 flex h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-4 text-[13.5px] text-ink transition-colors",
                            active && "bg-white/8",
                          )}
                        >
                          {row.dot ? (
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: row.dot }}
                            />
                          ) : (
                            row.icon
                          )}
                          <span className="truncate">{row.title}</span>
                          {row.meta && (
                            <span className="ml-auto flex shrink-0 items-center gap-1">
                              {row.meta}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
