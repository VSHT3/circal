/* ------------------------------------------------------------------ *
 * What sits inside the ring: the readout and the day's agenda.
 *
 * HTML rather than SVG text, because this is the one place with real
 * typography (mixed weights, a scrolling list, hover targets). It is pinned to
 * the dial's centre and scaled by `u` — pixels per SVG user unit — so the
 * whole assembly stays in proportion with the ring at any window size.
 * ------------------------------------------------------------------ */

import { colorOf, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import {
  MONTHS,
  atMinutes,
  formatDuration,
  formatTimeShort,
  isSameDay,
  splitTime,
  type Clock,
} from "@/lib/time";
import { cn } from "@/lib/utils";

export interface CenterPanelProps {
  day: Date;
  now: Date;
  occurrences: Occurrence[];
  calendars: Calendar[];
  /** Pixels per SVG user unit. */
  u: number;
  clock: Clock;
  /** Live drag-to-create range, in minutes since midnight. */
  drag: { start: number; end: number } | null;
  hovered: string | null;
  onHover: (key: string | null) => void;
  onOpen: (occ: Occurrence) => void;
}

export default function CenterPanel({
  day,
  now,
  occurrences,
  calendars,
  u,
  clock,
  drag,
  hovered,
  onHover,
  onOpen,
}: CenterPanelProps) {
  const today = isSameDay(day, now);

  // The readout answers "where am I", and that is a different question while
  // dragging (the range being drawn), on today (the time) and on any other
  // day (the date).
  let value: string;
  let suffix: string;
  if (drag) {
    const from = formatTimeShort(atMinutes(day, drag.start), clock);
    const to = formatTimeShort(atMinutes(day, drag.end), clock);
    value = `${from} – ${to}`;
    suffix = formatDuration(drag.end - drag.start);
  } else if (today) {
    const parts = splitTime(now, clock);
    value = parts.time;
    suffix = parts.suffix;
  } else {
    value = `${day.getDate()}`;
    suffix = MONTHS[day.getMonth()].slice(0, 3).toUpperCase();
  }

  // On today the card is a "now and next" strip, not a log — an event that has
  // already ended is behind the hand and belongs in the sidebar.
  const rows = today ? occurrences.filter((occ) => occ.end > now) : occurrences;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The readout is the hub: dead centre, with the now-hand passing under
          it. The shadow is what keeps the digits legible where they cross. */}
      <div
        className="absolute top-1/2 left-1/2 flex items-baseline whitespace-nowrap"
        style={{
          transform: "translate(-50%, -50%)",
          gap: `${7 * u}px`,
          textShadow: `0 0 ${14 * u}px #000, 0 0 ${5 * u}px #000`,
        }}
      >
        <span
          className="font-medium text-ink"
          style={{ fontSize: `${drag ? 26 * u : 40 * u}px`, letterSpacing: "-0.02em" }}
        >
          {value}
        </span>
        {suffix && (
          <span
            className="font-medium text-ink-2"
            style={{ fontSize: `${drag ? 16 * u : 21 * u}px` }}
          >
            {suffix}
          </span>
        )}
      </div>

      {rows.length > 0 && !drag && (
        <div
          className="fade-y no-scrollbar pointer-events-auto absolute top-1/2 left-1/2 overflow-y-auto"
          style={{
            // Clears the readout, which now owns the centre.
            transform: `translate(-50%, ${46 * u}px)`,
            width: `${212 * u}px`,
            maxHeight: `${52 * u}px`,
            borderRadius: `${11 * u}px`,
            padding: `${4 * u}px`,
            // No backdrop-filter here: combined with `.fade-y`'s mask Chromium
            // paints the blurred backdrop over a box far larger than the card,
            // which shows up as a grey rectangle in the middle of the dial.
            background: "rgba(17,17,19,0.92)",
          }}
        >
          {rows.map((occ) => {
            const status = statusOf(occ, now);
            const color = colorOf(occ.event, calendars);
            const running = today && status === "now";

            return (
              <button
                key={occ.key}
                type="button"
                onClick={() => onOpen(occ)}
                onMouseEnter={() => onHover(occ.key)}
                onMouseLeave={() => onHover(null)}
                className={cn(
                  "flex w-full items-center rounded-[6px] transition-colors",
                  hovered === occ.key && "bg-white/8",
                  today && status === "past" && "opacity-45",
                )}
                style={{
                  height: `${18 * u}px`,
                  gap: `${6 * u}px`,
                  paddingInline: `${6 * u}px`,
                }}
              >
                <span
                  className={cn("shrink-0 rounded-full", running && "animate-pulse")}
                  style={{
                    width: `${4.5 * u}px`,
                    height: `${4.5 * u}px`,
                    background: color,
                    opacity: running ? 1 : 0.75,
                  }}
                />
                <span
                  className="shrink-0 font-mono font-medium text-ink-2 uppercase"
                  style={{ fontSize: `${10.5 * u}px`, letterSpacing: "0.1em" }}
                >
                  {running
                    ? "Now"
                    : occ.event.allDay
                      ? "All day"
                      : formatTimeShort(occ.start, clock).replace(" ", "\u2009")}
                </span>
                <span
                  className="truncate font-mono font-medium text-ink uppercase"
                  style={{ fontSize: `${10.5 * u}px`, letterSpacing: "0.08em" }}
                >
                  {occ.event.title}
                </span>
                <span
                  className="ml-auto shrink-0 font-mono text-ink-3"
                  style={{ fontSize: `${10 * u}px` }}
                >
                  {running
                    ? `ends in ${formatDuration((occ.end.getTime() - now.getTime()) / 60000)}`
                    : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
