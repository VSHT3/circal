/* ------------------------------------------------------------------ *
 * ⌘P palette — jump to a date, find an event, run a command. Every
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
  CircleDot,
  Clock3,
  Download,
  Grid2x2,
  Grid3x3,
  Hourglass,
  Maximize,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  SettingsIcon,
  Undo2,
  Upload,
} from "lucide-react";
import { useFocusTrap } from "@/components/react/hooks";
import { Kbd } from "@/components/react/ui/primitives";
import { CalendarMark } from "@/components/react/ui/icons";
import type { CommandPaletteProps } from "@/components/react/types";
import { colorOf, freeGaps, markOf, scoreEvent, WAKING, type CalEvent } from "@/lib/events";
import { fuzzyScore } from "@/lib/fuzzy";
import { parseDate, parseQuickAdd, parseSlot, repeatPhrase } from "@/lib/quickadd";
import {
  MINUTES_PER_DAY,
  addDays,
  atMinutes,
  formatDuration,
  formatRelativeDay,
  formatTimeShort,
  isSameDay,
  minutesOfDay,
  MONTHS,
  snap,
  WEEKDAYS,
} from "@/lib/time";
import { cn } from "@/lib/utils";

const EASE = [0.32, 0.72, 0, 1] as const;

/* `fuzzyScore` is still the row matcher below — an event's own score lives in
   `scoreEvent`, shared with the life grid's search. */

/** One row in the flattened, keyboard-navigable result list. */
interface Row {
  id: string;
  icon?: ReactNode;
  /** A calendar's own glyph, in whatever colour the row resolved: the shape
   *  says which calendar, the colour still says which event. Takes the slot
   *  `icon` would have used, because a row has one thing on its left. */
  mark?: { icon: string; color: string };
  title: string;
  meta?: ReactNode;
  run: () => void;
}

interface Group {
  title: string;
  rows: Row[];
}

const CHROME_ICON_PROPS = { size: 15, strokeWidth: 1.75 as const, className: "text-ink-3" };

export default function CommandPalette({
  open,
  onClose,
  day,
  now,
  view,
  sidebarOpen,
  ambient,
  events,
  calendars,
  occurrences,
  clock,
  actions,
  inheritMarks,
  onSearchLife,
}: CommandPaletteProps) {
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dialog = useFocusTrap<HTMLDivElement>(open);

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
  /** Typing at the life grid: the query is lighting the field behind us. */
  const threading = view === "life" && q !== "";

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
          // `goDay` already lands on the day view.
          actions.goDay(jumpDate);
          onClose();
        },
      },
    ];
  }, [jumpDate, actions, onClose]);

  /**
   * Quick-add: the whole line as one event, above everything else. It is safe
   * at the top because `parseQuickAdd` returns nothing unless the line names
   * more than a title — a plain search never grows a create row, and a bare
   * date is a jump rather than an all-day event with no name.
   */
  const createRows: Row[] = useMemo(() => {
    const parsed = parseQuickAdd(query, day, now);
    if (!parsed) return [];
    const { title, day: on, startMin, endMin, allDay, repeat } = parsed;
    // Printed before it is committed: this row creates without a review step,
    // so what it resolved to — the day, the span, the rule — has to be visible
    // in the row itself.
    const when = allDay
      ? "ALL DAY"
      : `${formatTimeShort(atMinutes(on, startMin), clock)} – ${formatTimeShort(atMinutes(on, endMin), clock)}`;
    const rule = repeat ? ` · ${repeatPhrase(repeat)}` : "";
    return [
      {
        id: "create",
        icon: <Plus {...CHROME_ICON_PROPS} />,
        title: `Create “${title}”`,
        meta: (
          <span className="label text-ink-3">{`${formatRelativeDay(on, now)} · ${when}${rule}`}</span>
        ),
        run: () => {
          actions.quickAdd(parsed);
          onClose();
        },
      },
    ];
  }, [query, day, now, clock, actions, onClose]);

  /**
   * Free slots on the selected day. The dial already makes gaps the most
   * legible thing on the face; this only makes them addressable — and each
   * row opens a draft already filling the slot it names.
   */
  const freeRows: Row[] = useMemo(() => {
    const wanted = parseSlot(query);
    if (wanted === null || wanted <= 0) return [];

    // A slot that started twenty minutes ago is not free, it is late.
    const earliest = isSameDay(day, now) ? snap(minutesOfDay(now) + 7.5, 15) : 0;
    const waking = { from: Math.max(WAKING.from, earliest), to: WAKING.to };
    const whole = { from: earliest, to: MINUTES_PER_DAY };

    // Waking hours first; only offer 6 AM or 11 PM when the day has nothing else.
    let gaps = freeGaps(occurrences, wanted, waking.from, waking.to);
    if (gaps.length === 0) gaps = freeGaps(occurrences, wanted, whole.from, whole.to);

    return gaps.slice(0, 5).map((gap) => ({
      id: `free-${gap.start}`,
      icon: <Hourglass {...CHROME_ICON_PROPS} />,
      title: `${formatTimeShort(atMinutes(day, gap.start), clock)} – ${formatTimeShort(atMinutes(day, gap.end), clock)}`,
      meta: <span className="label text-ink-3">{formatDuration(gap.end - gap.start)} free</span>,
      run: () => {
        actions.newEventAt(gap.start, Math.min(gap.start + wanted, gap.end));
        onClose();
      },
    }));
  }, [query, occurrences, day, now, clock, actions, onClose]);

  /**
   * Every event, ranked rather than filtered. `scoreEvent` answers "how well
   * does this event match", so the sort is score first and nearness to the day
   * on screen second — which is exactly the old order when the query is empty,
   * because an empty query scores every candidate the same.
   */
  const eventRows: Row[] = useMemo(() => {
    return events
      .map((event) => ({ event, score: scoreEvent(event, q) }))
      .filter((row): row is { event: CalEvent; score: number } => row.score !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Math.abs(a.event.start - day.getTime()) - Math.abs(b.event.start - day.getTime()),
      )
      .slice(0, 8)
      .map(({ event }) => ({
        id: `event-${event.id}`,
        mark: { icon: markOf(event, calendars, inheritMarks), color: colorOf(event, calendars) },
        title: event.title,
        meta: (
          <span className="label text-ink-3">
            {event.allDay
              ? "ALL DAY"
              : `${formatRelativeDay(new Date(event.start))} ${formatTimeShort(new Date(event.start), clock)}`}
          </span>
        ),
        run: () => {
          actions.goDay(new Date(event.start));
          actions.openEvent(event);
          onClose();
        },
      }));
  }, [events, q, day, calendars, clock, actions, onClose, inheritMarks]);

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
        id: "cmd-new-task",
        icon: <CircleDot {...CHROME_ICON_PROPS} />,
        title: "New task",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>N</Kbd>
          </>
        ),
        run: () => {
          actions.newTask();
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
        id: "cmd-life-view",
        icon: <Grid3x3 {...CHROME_ICON_PROPS} />,
        title: "Life view",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>L</Kbd>
          </>
        ),
        run: () => {
          actions.setView("life");
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
        id: "cmd-ambient",
        icon: <Maximize {...CHROME_ICON_PROPS} />,
        title: ambient ? "Leave ambient mode" : "Ambient mode",
        meta: <Kbd>F</Kbd>,
        run: () => {
          actions.toggleAmbient();
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
      {
        id: "cmd-settings",
        icon: <SettingsIcon {...CHROME_ICON_PROPS} />,
        title: "Settings",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>,</Kbd>
          </>
        ),
        run: () => {
          actions.openSettings();
          onClose();
        },
      },
      {
        id: "cmd-undo",
        icon: <Undo2 {...CHROME_ICON_PROPS} />,
        title: "Undo",
        meta: (
          <>
            <Kbd>⌘</Kbd>
            <Kbd>Z</Kbd>
          </>
        ),
        run: () => {
          actions.undo();
          onClose();
        },
      },
      {
        id: "cmd-export-ics",
        icon: <Download {...CHROME_ICON_PROPS} />,
        title: "Export events as .ics",
        run: () => {
          actions.exportIcs();
          onClose();
        },
      },
      {
        id: "cmd-export-json",
        icon: <Download {...CHROME_ICON_PROPS} />,
        title: "Save a backup",
        run: () => {
          actions.exportBackup();
          onClose();
        },
      },
      {
        id: "cmd-import",
        icon: <Upload {...CHROME_ICON_PROPS} />,
        title: "Import a file…",
        run: () => {
          actions.importFile();
          onClose();
        },
      },
      // Only offered once there is something to refresh.
      ...(calendars.some((c) => c.feed)
        ? [
            {
              id: "cmd-refresh-feeds",
              icon: <RefreshCw {...CHROME_ICON_PROPS} />,
              title: "Refresh subscriptions",
              run: () => {
                actions.refreshFeeds();
                onClose();
              },
            },
          ]
        : []),
      ...calendars.map((cal) => ({
        id: `cmd-cal-${cal.id}`,
        mark: { icon: cal.icon, color: cal.color },
        title: cal.visible ? `Hide ${cal.name}` : `Show ${cal.name}`,
        run: () => {
          actions.toggleCalendar(cal.id);
          onClose();
        },
      })),
      // The only keyboard path to a calendar's name and colour: the sidebar's
      // pencil is a pointer affordance, and the sidebar is not on screen at
      // all on a phone.
      {
        id: "cmd-new-calendar",
        icon: <Plus {...CHROME_ICON_PROPS} />,
        title: "New calendar…",
        run: () => {
          actions.newCalendar();
          onClose();
        },
      },
      ...calendars.map((cal) => ({
        id: `cmd-cal-edit-${cal.id}`,
        mark: { icon: cal.icon, color: cal.color },
        title: `Edit ${cal.name}…`,
        run: () => {
          actions.editCalendar(cal.id);
          onClose();
        },
      })),
    ];
    // Ranked, not filtered, and only once there is a query: with the box empty
    // this list's own order is the answer — New event first, calendars last.
    if (!q) return base;
    return base
      .map((row, index) => ({ row, index, score: fuzzyScore(row.title, q) }))
      .filter((hit): hit is { row: Row; index: number; score: number } => hit.score !== null)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((hit) => hit.row);
  }, [q, day, sidebarOpen, ambient, calendars, clock, actions, onClose]);

  const groups: Group[] = useMemo(
    () =>
      [
        { title: "Create", rows: createRows },
        { title: "Jump", rows: jumpRows },
        { title: "Free time", rows: freeRows },
        { title: "Events", rows: eventRows },
        { title: "Commands", rows: commandRows },
      ].filter((g) => g.rows.length > 0),
    [createRows, jumpRows, freeRows, eventRows, commandRows],
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
      // The shell listens for Escape on `window`, and by the time the event
      // gets there this close has already re-rendered it — so it would read
      // the palette as shut and take Escape's *next* meaning (leaving ambient)
      // in the same press. A key the panel handled stops at the panel.
      e.stopPropagation();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
      // ⌘P is a toggle, and the shell's copy of it is off while a panel is up.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn(
            "fixed inset-0 z-[60] flex items-start justify-center pt-[18vh]",
            // Searching the life grid means the answer is *behind* this
            // overlay: a 2px blur is wider than a dot, so it would sand the
            // thread off the field the query just lit. Thinner scrim, no
            // blur, for exactly that case.
            threading ? "bg-black/35" : "bg-black/50 backdrop-blur-[2px]",
          )}
          onClick={onClose}
          role="presentation"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
        >
          <motion.div
            ref={dialog}
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
                  if (view === "life") onSearchLife(e.target.value);
                }}
                placeholder="Search, jump to a date, find 45m free, run a command…"
                aria-label="Search, jump to a date, find free time, run a command"
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
                          {row.mark ? (
                            <span className="grid w-[15px] shrink-0 place-items-center">
                              <CalendarMark icon={row.mark.icon} color={row.mark.color} size={13} />
                            </span>
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
