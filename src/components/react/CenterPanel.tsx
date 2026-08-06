/* ------------------------------------------------------------------ *
 * What sits inside the ring: the readout and the day's agenda.
 *
 * HTML rather than SVG text, because this is the one place with real
 * typography (mixed weights, a scrolling list, hover targets). It is pinned to
 * the dial's centre and scaled by `u` — pixels per SVG user unit — so the
 * whole assembly stays in proportion with the ring at any window size.
 *
 * The division of labour with the ring: the ring says what *shape* the day is,
 * the centre says the one sentence. So the readout has moods — the range being
 * drawn, the arc under the pointer, the time, the date — and the card leads
 * with the next thing rather than printing three rows of equal grey.
 * ------------------------------------------------------------------ */

import { WAKING, colorOf, freeGaps, statusOf, type Calendar, type Occurrence } from "@/lib/events";
import {
  MINUTES_PER_DAY,
  MONTHS,
  atMinutes,
  formatDuration,
  formatTimeShort,
  isSameDay,
  splitTime,
  type Clock,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TotalsPosition } from "@/lib/store";

export interface CenterPanelProps {
  day: Date;
  now: Date;
  occurrences: Occurrence[];
  calendars: Calendar[];
  /** Pixels per SVG user unit. */
  u: number;
  clock: Clock;
  /** Whether to print what the day is made of, and where on the stage. */
  totals: boolean;
  totalsAt: TotalsPosition;
  /** Live drag-to-create range, in minutes since midnight. */
  drag: { start: number; end: number } | null;
  hovered: string | null;
  onHover: (key: string | null) => void;
  onOpen: (occ: Occurrence) => void;
}

/** Height of one agenda row, in SVG user units. The card is sized in these. */
const ROW_H = 18;
/** Rows the card shows before it scrolls. */
const VISIBLE_ROWS = 3;
/** How close the next thing has to be before its dot is cocked. */
const IMMINENT_MS = 5 * 60_000;

/**
 * How the eight outer places resolve against the stage. `center` is absent
 * on purpose: it is not a corner of anything, it hangs under the card, and it
 * is rendered there rather than here.
 *
 * The stage is the whole view panel, not the dial's square, so the corners
 * are the window's corners — which on any wide window is the empty black the
 * circle never reaches.
 */
const CORNERS: Record<Exclude<TotalsPosition, "center">, string> = {
  "top-left": "items-start justify-start",
  top: "items-start justify-center",
  "top-right": "items-start justify-end",
  left: "items-center justify-start",
  right: "items-center justify-end",
  "bottom-left": "items-end justify-start",
  bottom: "items-end justify-center",
  "bottom-right": "items-end justify-end",
};

/**
 * The wait, as the headline prints it. Whole minutes until the last one, and
 * seconds only inside it: a stopwatch in the middle of a clock is noise. It
 * rounds *down*, because a countdown that overstates the time you have is
 * worse than useless.
 */
function untilText(ms: number): string {
  if (ms < 60_000) return `in ${Math.max(1, Math.floor(ms / 1000))}s`;
  return `in ${formatDuration(Math.floor(ms / 60_000))}`;
}

/**
 * What the day is made of. Booked is measured against the whole revolution —
 * a six o'clock run is time spoken for — while free is measured against
 * `WAKING`, since the hours you would not book in were never on offer.
 *
 * Both come out of `freeGaps`, which already merges overlaps: two events on
 * the same hour are one hour booked, not two.
 */
function dayLoad(occurrences: Occurrence[]): { booked: number; free: number } | null {
  if (!occurrences.some((occ) => !occ.event.allDay)) return null;
  const idle = (from: number, to: number) =>
    freeGaps(occurrences, 1, from, to).reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  return {
    booked: MINUTES_PER_DAY - idle(0, MINUTES_PER_DAY),
    free: idle(WAKING.from, WAKING.to),
  };
}

export default function CenterPanel({
  day,
  now,
  occurrences,
  calendars,
  u,
  clock,
  totals,
  totalsAt,
  drag,
  hovered,
  onHover,
  onOpen,
}: CenterPanelProps) {
  const today = isSameDay(day, now);

  /**
   * The arc under the pointer, when it is one that has a span to report. An
   * all-day occurrence has no arc and no two instants to print, so pointing at
   * its row leaves the readout saying what it was saying.
   */
  const peeked = occurrences.find((occ) => occ.key === hovered && !occ.event.allDay) ?? null;

  // The readout answers "where am I", and that is a different question while
  // dragging (the range being drawn), while pointing at an arc (that arc's
  // span), on today (the time) and on any other day (the date). The first two
  // are the same question asked twice, so they are printed the same way.
  const span = drag ?? (peeked ? { start: peeked.startMin, end: peeked.endMin } : null);
  let value: string;
  let suffix: string;
  if (drag && drag.end - drag.start >= MINUTES_PER_DAY) {
    // A ring drawn from midnight back round to midnight is the gesture for
    // "this day", and it lands as an all-day event — so the readout says what
    // is about to be created rather than `12 AM – 12 AM · 24h`.
    value = "All day";
    suffix = "";
  } else if (span) {
    const from = formatTimeShort(atMinutes(day, span.start), clock);
    const to = formatTimeShort(atMinutes(day, span.end), clock);
    value = `${from} – ${to}`;
    suffix = formatDuration(span.end - span.start);
  } else if (today) {
    const parts = splitTime(now, clock);
    value = parts.time;
    suffix = parts.suffix;
  } else {
    value = `${day.getDate()}`;
    suffix = MONTHS[day.getMonth()].slice(0, 3).toUpperCase();
  }

  // On today the card is a "now and next" strip, not a log — an event that has
  // already ended is behind the hand and belongs in the sidebar. Except the one
  // being pointed at: the readout is printing its span, and a span with no name
  // beside it is half an answer.
  const rows = today
    ? occurrences.filter((occ) => occ.end > now || occ.key === hovered)
    : occurrences;

  /**
   * The one row that is the answer. Timed, because an all-day event is context
   * rather than the next thing, and never a past one — pointing at this
   * morning must not promote it.
   */
  const headline =
    today && !drag
      ? (rows.find((occ) => !occ.event.allDay && statusOf(occ, now) !== "past")?.key ?? null)
      : null;

  const load = totals && !drag ? dayLoad(occurrences) : null;
  /**
   * The line itself, built once and placed twice: under the card when the
   * position is `center`, in a corner of the stage otherwise.
   */
  const totalsLine = load ? (
    <span
      className="font-mono font-medium text-ink-3 uppercase"
      style={{ fontSize: `${9.5 * u}px`, letterSpacing: "0.16em" }}
    >
      {formatDuration(load.booked)} booked · {formatDuration(load.free)} free
    </span>
  ) : null;
  const centred = totalsAt === "center" ? totalsLine : null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The readout is the hub, and the largest thing on the face: dead
          centre, nothing crossing it. The shadow only separates it from the
          dial's glow.

          A span shrinks it, and the size is transitioned on the same curve and
          duration as an arc's stroke: point at an arc and the arc thickens
          while the clock shrinks into its span, in one beat. */}
      <div
        className="absolute top-1/2 left-1/2 flex items-baseline whitespace-nowrap"
        style={{
          transform: "translate(-50%, -50%)",
          gap: `${8 * u}px`,
          textShadow: `0 0 ${16 * u}px #000`,
        }}
      >
        <span
          className="font-medium text-ink"
          style={{
            fontSize: `${span ? 32 * u : 54 * u}px`,
            letterSpacing: "-0.03em",
            fontVariantNumeric: "tabular-nums",
            transition: "font-size 140ms var(--ease)",
          }}
        >
          {value}
        </span>
        {suffix && (
          <span
            className="font-medium text-ink-2"
            style={{
              fontSize: `${span ? 18 * u : 26 * u}px`,
              transition: "font-size 140ms var(--ease)",
            }}
          >
            {suffix}
          </span>
        )}
      </div>

      {!drag && (rows.length > 0 || centred) && (
        <div
          className="absolute top-1/2 left-1/2 flex flex-col items-center"
          style={{
            // Clears the readout, which owns the centre.
            transform: `translate(-50%, ${56 * u}px)`,
            width: `${226 * u}px`,
            gap: `${5 * u}px`,
          }}
        >
          {rows.length > 0 && (
            <div
              className={cn(
                "no-scrollbar pointer-events-auto w-full overflow-y-auto",
                // Only when there is something below to scroll to. A permanent
                // fade dims the last row of a list that already fits, which
                // reads as a rendering fault rather than as "there is more".
                rows.length > VISIBLE_ROWS && "fade-b",
              )}
              style={{
                maxHeight: `${(ROW_H * VISIBLE_ROWS + 8) * u}px`,
                padding: `${4 * u}px`,
                // A pool of darkness, not a card: the slab's edges were the
                // hardest line inside the dial, and the ring is supposed to be
                // the only edge on the face. No backdrop-filter — combined with
                // a mask Chromium paints the blurred backdrop far outside the
                // box.
                background:
                  "radial-gradient(closest-side, rgba(0,0,0,0.94), rgba(0,0,0,0.82) 62%, transparent)",
              }}
            >
              {rows.map((occ) => {
                const status = statusOf(occ, now);
                const color = colorOf(occ.event, calendars);
                // An all-day event is context, not a thing in progress: it is
                // "All day", never "Now … ends in 10h", which is a countdown
                // to midnight dressed as an appointment.
                const running = today && !occ.event.allDay && status === "now";
                const lead = occ.key === headline;
                const until = occ.start.getTime() - now.getTime();
                // Cocked, not pulsing: the pulse already means "this one is
                // running", and two ways of saying different things with the
                // same signal is one way of saying neither.
                const imminent = lead && !running && until <= IMMINENT_MS;

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
                      height: `${ROW_H * u}px`,
                      gap: `${6 * u}px`,
                      paddingInline: `${6 * u}px`,
                    }}
                  >
                    <span
                      className={cn("shrink-0 rounded-full", running && "animate-pulse")}
                      style={{
                        width: `${(lead ? 5.5 : 4.5) * u}px`,
                        height: `${(lead ? 5.5 : 4.5) * u}px`,
                        background: color,
                        opacity: running || lead ? 1 : 0.75,
                        boxShadow: imminent
                          ? `0 0 0 ${1.2 * u}px #000, 0 0 0 ${2.4 * u}px ${color}59`
                          : undefined,
                      }}
                    />
                    {/* The headline spends its width on the name and the wait.
                        What time it starts is on the ring — that is what the
                        ring is for — and how long until it is not. */}
                    {!lead && (
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
                    )}
                    <span
                      className={cn(
                        "truncate font-mono font-medium text-ink uppercase",
                        lead && "leading-none",
                      )}
                      style={{
                        fontSize: `${(lead ? 13 : 10.5) * u}px`,
                        letterSpacing: lead ? "0.04em" : "0.08em",
                      }}
                    >
                      {occ.event.title}
                    </span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 font-mono",
                        // The wait is the headline's whole point, so it is not
                        // printed at the meta column's usual whisper.
                        lead ? "text-ink-2" : "text-ink-3",
                      )}
                      style={{ fontSize: `${10 * u}px` }}
                    >
                      {running
                        ? `ends in ${formatDuration((occ.end.getTime() - now.getTime()) / 60000)}`
                        : lead
                          ? untilText(until)
                          : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {centred}
        </div>
      )}

      {/* Anywhere but the centre, the line leaves the card and takes a corner
          of the stage — which on any window wider than it is tall is black the
          circle never reaches. Padded off the edge, because a line flush to a
          window edge reads as something that fell off. */}
      {totalsLine && !centred && (
        <div
          className={cn(
            "absolute inset-0 flex p-4",
            CORNERS[totalsAt as Exclude<TotalsPosition, "center">],
          )}
        >
          {totalsLine}
        </div>
      )}
    </div>
  );
}
