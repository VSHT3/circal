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

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  colorOf,
  dayLoad,
  spanLabel,
  statusOf,
  type Calendar,
  type Occurrence,
} from "@/lib/events";
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
import { EASE, MODE_MS, MOOD_MS } from "@/lib/motion";
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
  /**
   * Read from across a room rather than from a chair. The centre keeps its
   * moods and its hierarchy and changes size: the time at nearly twice the
   * type, and one row under it instead of three, because the second and third
   * rows are for a surface you are working on.
   */
  ambient: boolean;
  /** Whether to print what the day is made of, and where on the stage. */
  totals: boolean;
  totalsAt: TotalsPosition;
  /** The window "free" is measured against — `Settings.wakingFrom`/
   *  `wakingTo`, threaded rather than read from a whole `settings` because
   *  this panel is otherwise a dozen narrow props and a setting the totals
   *  line does not otherwise need is not a reason to convert it. */
  waking: { from: number; to: number };
  /** Live drag-to-create range, in minutes since midnight. */
  drag: { start: number; end: number } | null;
  hovered: string | null;
  onHover: (key: string | null) => void;
  onOpen: (occ: Occurrence) => void;
  /** Tick a task off, or back on. Only ever called for `occ.event.task`. */
  onToggleDone: (occ: Occurrence) => void;
}

/** Height of one agenda row, in SVG user units. The card is sized in these. */
const ROW_H = 18;
/**
 * How much bigger everything inside the ring gets in ambient — and it is one
 * `scale()` on the pair of them rather than a size apiece.
 *
 * Two reasons. The hierarchy between the readout, the name and the wait is
 * the design, and a second table of numbers would drift from the first within
 * two changes. And a mode change and a pointer both want the readout's size:
 * as two font-size transitions on one element they can only have one
 * duration, and the two want different ones. On separate properties they can
 * each have their own — the mood stays paired with the arc it answers, and
 * the mode stays paired with the chrome it arrives with.
 */
const AMBIENT_SCALE = 1.55;
/**
 * The two beats, as the CSS shorthand every inline style here reaches for.
 *
 * On `--ease-size` rather than `--ease`: everything they drive is a size, and
 * the pointer curve puts two thirds of its travel in the first quarter of its
 * time — which on type this large is a bang followed by a settle however long
 * you give it.
 */
const MOOD = `${MOOD_MS}ms var(--ease-size)`;
const MODE = `${MODE_MS}ms var(--ease-size)`;
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

export default function CenterPanel({
  day,
  now,
  occurrences,
  calendars,
  u,
  clock,
  ambient,
  totals,
  totalsAt,
  waking,
  drag,
  hovered,
  onHover,
  onOpen,
  onToggleDone,
}: CenterPanelProps) {
  const today = isSameDay(day, now);
  const reducedMotion = useReducedMotion();
  /** The mood, as one factor on the pair below rather than on every size. */
  const scale = ambient ? AMBIENT_SCALE : 1;

  /**
   * The arc under the pointer, when it is one that has a span to report. An
   * all-day occurrence has no arc and no two instants to print, so pointing at
   * its row leaves the readout saying what it was saying.
   */
  const peeked = occurrences.find((occ) => occ.key === hovered && !occ.event.allDay) ?? null;
  /** And of those, the ones that are a moment rather than a span. A task has
   *  one instant, so `01:15 – 01:15 · 0m` is three ways of saying nothing. */
  const peekedTask = peeked?.event.task ? peeked : null;

  // The readout answers "where am I", and that is a different question while
  // dragging (the range being drawn), while pointing at an arc (that arc's
  // span), on today (the time) and on any other day (the date). The first two
  // are the same question asked twice, so they are printed the same way.
  const span =
    drag ?? (peeked && !peekedTask ? { start: peeked.startMin, end: peeked.endMin } : null);
  /** Whether the readout is answering about something else rather than about
   *  now, which is what it shrinks for. */
  const aside = span !== null || peekedTask !== null;
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
  } else if (peekedTask) {
    value = formatTimeShort(peekedTask.start, clock);
    suffix = "DUE";
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

  /**
   * What the card actually shows. Ambient keeps exactly one line — the one
   * you would want from across the room — and that is the headline, unless
   * the pointer is on an arc, in which case it is that one: the readout is
   * printing a span, and a span with no name beside it is half an answer.
   */
  const shown = ambient ? rows.filter((occ) => occ.key === (hovered ?? headline)) : rows;

  const load = totals && !drag ? dayLoad(occurrences, waking) : null;
  /**
   * The line itself, built once and placed twice: under the card when the
   * position is `center`, in a corner of the stage otherwise.
   */
  const totalsLine = load ? (
    <motion.span
      key="totals"
      className="font-mono font-medium text-ink-3 uppercase"
      style={{ fontSize: `${9.5 * u}px`, letterSpacing: "0.16em" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : MOOD_MS / 1000, ease: EASE }}
    >
      {formatDuration(load.booked)} booked · {formatDuration(load.free)} free
    </motion.span>
  ) : null;
  const centred = totalsAt === "center" ? totalsLine : null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The mood, as one transform on the whole middle. It scales about the
          stage's centre, which is the dial's — so the readout stays on it and
          the card's clearance under it grows with the type it is clearing.

          One composited property on the same beat as the chrome withdrawing,
          rather than a dozen sizes on a beat of their own: those two speeds
          are what made arriving in ambient read as a snap and then a crawl. */}
      <div
        className="absolute inset-0"
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "center",
          transition: `${MODE} transform`,
        }}
      >
        {/* The readout is the hub, and the largest thing on the face: dead
            centre, nothing crossing it. The shadow only separates it from the
            dial's glow.

            A span shrinks it, on the same curve and duration as an arc's
            stroke: point at an arc and the arc thickens while the clock
            shrinks into its span, in one beat. */}
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
              fontSize: `${(aside ? 32 : 54) * u}px`,
              letterSpacing: "-0.03em",
              fontVariantNumeric: "tabular-nums",
              transition: `${MOOD} font-size`,
            }}
          >
            {value}
          </span>
          {suffix && (
            <span
              className="font-medium text-ink-2"
              style={{
                fontSize: `${(aside ? 18 : 26) * u}px`,
                transition: `${MOOD} font-size`,
              }}
            >
              {suffix}
            </span>
          )}
        </div>

        {/* The card as a whole comes and goes too — a drag starting takes it
          away, and on an empty day there is nothing to take. Both were cuts,
          and a cut beside a readout that is gliding into its span reads as
          the card having crashed rather than left. */}
        <AnimatePresence initial={false}>
          {!drag && (shown.length > 0 || centred) && (
            <motion.div
              key="card"
              className="absolute top-1/2 left-1/2 flex flex-col items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : MOOD_MS / 1000, ease: EASE }}
              style={{
                // Clears the readout, which owns the centre.
                transform: `translate(-50%, ${56 * u}px)`,
                // The width a name is truncated at: past about here it runs out
                // under the drag annulus. The one thing ambient still changes
                // for itself, because the column it needs is not 1.55× the one
                // three rows share — it is one row's worth of sentence.
                width: `${(ambient ? 190 : 226) * u}px`,
                gap: `${5 * u}px`,
                transition: `${MODE} width`,
              }}
            >
              {shown.length > 0 && (
                <div
                  className={cn(
                    "no-scrollbar pointer-events-auto overflow-y-auto",
                    // One row wants to be as wide as it is: left full-width, the
                    // wait ends up an inch from the name and the pair stops
                    // reading as a sentence.
                    ambient ? "w-max" : "w-full",
                    // Only when there is something below to scroll to. A permanent
                    // fade dims the last row of a list that already fits, which
                    // reads as a rendering fault rather than as "there is more".
                    shown.length > VISIBLE_ROWS && "fade-b",
                  )}
                  style={{
                    maxHeight: `${(ROW_H * (ambient ? 1 : VISIBLE_ROWS) + 8) * u}px`,
                    padding: `${4 * u}px`,
                    // A pool of darkness, not a card: the slab's edges were the
                    // hardest line inside the dial, and the ring is supposed to be
                    // the only edge on the face. No backdrop-filter — combined with
                    // a mask Chromium paints the blurred backdrop far outside the
                    // box.
                    //
                    // It stays on in ambient. `closest-side` sizes it to whatever
                    // box it is in, and a `background-image` is the one thing here
                    // that cannot be interpolated — dropping it for one mood is a
                    // pop where everything around it glides.
                    background:
                      "radial-gradient(closest-side, rgba(0,0,0,0.94), rgba(0,0,0,0.82) 62%, transparent)",
                    transition: `${MODE} max-height`,
                  }}
                >
                  <AnimatePresence initial={false}>
                    {shown.map((occ) => {
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
                      // Where this day sits in a span longer than one, and null
                      // for everything else. It outranks both the start time and
                      // "Now": on the third morning of a five-day trip, neither a
                      // clock time from three days ago nor the word "now" is the
                      // thing you came to the interior to read.
                      const span = spanLabel(occ);

                      return (
                        // The row's own height is the wrapper's, so one leaving
                        // closes the space it took instead of the ones below it
                        // jumping up. Rows come and go for three reasons — an event
                        // ending, a mode changing, a pointer landing on a past arc —
                        // and all three used to be a cut.
                        <motion.div
                          key={occ.key}
                          className="w-full overflow-hidden"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: ROW_H * u }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{
                            duration: reducedMotion ? 0 : MOOD_MS / 1000,
                            ease: EASE,
                          }}
                        >
                          <div
                            onMouseEnter={() => onHover(occ.key)}
                            onMouseLeave={() => onHover(null)}
                            className={cn(
                              "flex h-full w-full items-center rounded-[6px] transition-colors",
                              hovered === occ.key && "bg-white/8",
                              today && status === "past" && "opacity-45",
                            )}
                            style={{
                              // Wider in ambient: the row is as wide as its content
                              // there, so the gap is the only thing separating the
                              // name from the wait, rather than a column of space.
                              gap: `${(ambient ? 9 : 6) * u}px`,
                              paddingInline: `${6 * u}px`,
                              transition: `${MOOD} gap, ${MOOD} padding-inline`,
                            }}
                          >
                            {/* A row is a button unless it also has to carry a
                          tick, and then it is two: a control inside a control
                          is not a thing HTML has, and a task whose row opened
                          the editor every time you tried to complete it would
                          be a task nobody completes. */}
                            <button
                              type="button"
                              onClick={() => onOpen(occ)}
                              className="flex h-full min-w-0 flex-1 items-center"
                              style={{
                                gap: `${(ambient ? 9 : 6) * u}px`,
                                transition: `${MOOD} gap`,
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
                                  transition: `${MOOD} width, ${MOOD} height, ${MOOD} opacity`,
                                }}
                              />
                              {/* The headline spends its width on the name and the
                          wait. What time it starts is on the ring — that is
                          what the ring is for — and how long until it is not.

                          That holds for a multi-day span too, though not for
                          the same reason: its arc is a whole turn with nothing
                          to read off, but its wait already says `ends in 45h`,
                          which is the fact. A `DAY 2/4` column here costs
                          `Sleeper train` most of its letters — measured, not
                          guessed — and a name is worth more than a position
                          the row below the fold already prints. */}
                              {!lead && (
                                <span
                                  className="shrink-0 font-mono font-medium text-ink-2 uppercase"
                                  style={{
                                    fontSize: `${10.5 * u}px`,
                                    letterSpacing: "0.1em",
                                    transition: `${MOOD} font-size`,
                                  }}
                                >
                                  {span ??
                                    (running
                                      ? "Now"
                                      : occ.event.allDay
                                        ? "All day"
                                        : formatTimeShort(occ.start, clock).replace(" ", "\u2009"))}
                                </span>
                              )}
                              <span
                                className={cn(
                                  "truncate font-mono font-medium text-ink uppercase",
                                  lead && "leading-none",
                                  // The strike is the primary signal that a task
                                  // is done — the pip beside it is the control,
                                  // and a control is not an announcement.
                                  occ.done && "text-ink-3 line-through",
                                )}
                                style={{
                                  fontSize: `${(lead ? 13 : 10.5) * u}px`,
                                  letterSpacing: lead ? "0.04em" : "0.08em",
                                  transition: `${MOOD} font-size`,
                                }}
                              >
                                {occ.event.title}
                              </span>
                              <span
                                className={cn(
                                  "ml-auto shrink-0 font-mono",
                                  // The wait is the headline's whole point, so it is
                                  // not printed at the meta column's usual whisper.
                                  lead ? "text-ink-2" : "text-ink-3",
                                )}
                                style={{ fontSize: `${10 * u}px`, transition: `${MOOD} font-size` }}
                              >
                                {running
                                  ? `ends in ${formatDuration((occ.end.getTime() - now.getTime()) / 60000)}`
                                  : lead
                                    ? untilText(until)
                                    : ""}
                              </span>
                            </button>
                            {occ.event.task && (
                              <button
                                type="button"
                                aria-pressed={occ.done}
                                aria-label={
                                  occ.done
                                    ? `Mark “${occ.event.title}” not done`
                                    : `Mark “${occ.event.title}” done`
                                }
                                onClick={() => onToggleDone(occ)}
                                className="grid shrink-0 place-items-center rounded-full transition-colors hover:bg-white/10"
                                style={{ width: `${13 * u}px`, height: `${13 * u}px` }}
                              >
                                {/* Filled while it stands, hollow once it is
                            done — the same two shapes the pip on the rim
                            takes, so the mark you tick and the mark you see
                            on the face are one mark. */}
                                <span
                                  className="rounded-full"
                                  style={{
                                    width: `${7 * u}px`,
                                    height: `${7 * u}px`,
                                    background: occ.done ? "transparent" : color,
                                    boxShadow: occ.done ? `inset 0 0 0 ${1.4 * u}px ${color}` : "",
                                    opacity: occ.done ? 0.8 : 1,
                                  }}
                                />
                              </button>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}

              <AnimatePresence initial={false}>{centred}</AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Anywhere but the centre, the line leaves the card and takes a corner
          of the stage — which on any window wider than it is tall is black the
          circle never reaches. Padded off the edge, because a line flush to a
          window edge reads as something that fell off. */}
      {totalsAt !== "center" && (
        <div
          className={cn(
            "absolute inset-0 flex p-4",
            CORNERS[totalsAt as Exclude<TotalsPosition, "center">],
          )}
        >
          <AnimatePresence initial={false}>{totalsLine}</AnimatePresence>
        </div>
      )}
    </div>
  );
}
