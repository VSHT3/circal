/* ------------------------------------------------------------------ *
 * The week: seven dials, arranged for size.
 *
 * Every face at the same rotation, so a ten o'clock meeting sits at the same
 * angle on all seven and a recurring thing is a shape that repeats across the
 * week. That is the one question the rest of the app cannot answer — the year
 * ring says how *busy* a day is and never *when* — and angle-is-time answers
 * it for nothing.
 *
 * The seven were a single row for one release and it did not work: a seventh
 * of a landscape window is a 210px face, where an arc is a few pixels of
 * colour with nothing to place it against and nothing that can be pointed at.
 * `weekLayout` now takes whichever arrangement makes the face biggest — two
 * rows in a landscape window, which is nearly twice the diameter — and the
 * face spends it on the dial's own scale: half-hour ticks and the four hours
 * it is navigated by, above `WEEK_SCALE_FACE`.
 *
 * Pointing at an arc names it, in the one readout under the grid. That is the
 * whole interaction budget and it is deliberate: seven faces of drag targets
 * is seven chances to edit the wrong day, so an arc here opens and never
 * moves, and everywhere else on a face is the day it belongs to.
 * ------------------------------------------------------------------ */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { clipToDay, colorOf, dayAgenda, dayLoad, spanLabel, type Occurrence } from "@/lib/events";
import {
  WEEK_CAPTION_H,
  WEEK_DAYS,
  WEEK_META_H,
  WEEK_SCALE_FACE,
  weekDays,
  weekFaceCentre,
} from "@/lib/week";
import {
  MONTHS,
  WEEKDAYS,
  dayKey,
  daysBetween,
  formatDayRange,
  formatDuration,
  formatTimeShort,
  fromDayKey,
  isSameDay,
} from "@/lib/time";
import { EASE, MOOD_MS } from "@/lib/motion";
import { THEME_PALETTES } from "@/lib/theme";
import { cue } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import type { Clock } from "@/lib/time";
import type { Calendar } from "@/lib/events";
import type { WeekViewProps } from "@/components/react/types";
import Face, { GHOST_ALPHA, SLOT_ALPHA, type FaceGhost } from "./Face";
import { useHotkeys } from "./hooks";

/**
 * How much a face grows under the pointer, as a fraction of its own size.
 *
 * The year ring's grammar at a different count: pointing at a day makes it the
 * subject. Small, because the faces sit on a fixed pitch and cannot push each
 * other aside the way 365 marks can — the growth has to happen inside the cell
 * or the whole grid lurches, so it is scaled about the face's own centre and
 * the gutter absorbs it.
 */
const GROW = 0.05;

/** One day of the grid, and everything about it the readout needs. */
interface WeekDay {
  date: Date;
  today: boolean;
  occurrences: Occurrence[];
  /** The ones with no span on a revolution, which is why they need their own
   *  mark: `dayAgenda` hands them over with everything else and `Face` draws
   *  nothing at all for them. */
  allDay: Occurrence[];
  booked: number;
  /** What the waking window has left, `dayLoad`'s other half — the balancing
   *  figure the readout exists to print, in the centre panel's own voice so
   *  "free" keeps one meaning across faces. */
  free: number;
  /** Timed events plus all-day ones: what the readout counts. */
  count: number;
  /** Free time received from a link, clipped to this face — the dial's own
   *  overlay at strip size, so the whole shared week is read at once. `at` is
   *  the slot's place in the payload, so a tap can hand back the *original*
   *  span rather than the day's clipped minutes. */
  slots: (FaceGhost & { at: number })[] | null;
}

/** What the pointer is on: a face, and possibly one arc of it. */
interface Subject {
  index: number;
  key: string | null;
}

/** The mark of the event about to exist on a face: the all-day dot it will
 *  become, plus its place in the run where the run is longer than a day. */
interface GhostMark {
  color: string;
  opacity: number;
  label: string | null;
}

export default function WeekView({
  stage,
  now,
  selected,
  events,
  calendars,
  tasks,
  settings,
  onSelectDay,
  onOpenEvent,
  pending,
  slots,
  onBookSlot,
  onCreateSpan,
  dragging,
  onDropTask,
}: WeekViewProps) {
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<Subject | null>(null);

  /**
   * Both keyed by day rather than by instant, and that is what keeps the grid
   * off the shell's minute tick: seven agendas do not change between 10:17 and
   * 10:18, and rebuilding them sixty times an hour would repack every lane on
   * all seven faces for a hand that moved a quarter of a degree. The same
   * trick `LifeView` plays with `todayKey`.
   */
  const fromKey = stage ? dayKey(stage.from) : "";
  const todayKey = dayKey(now);

  /**
   * Seven days' agendas. The same `dayAgenda` the dial reads, seven times over
   * — a week that packed its lanes differently from the day you open out of it
   * would repack every arc on the way in.
   */
  const week = useMemo<WeekDay[]>(() => {
    if (!fromKey) return [];
    const waking = { from: settings.wakingFrom, to: settings.wakingTo };
    const slotInk = THEME_PALETTES[settings.theme].ghost;
    return weekDays(fromDayKey(fromKey)).map((date) => {
      const { all } = dayAgenda(events, calendars, date, tasks);
      const load = dayLoad(all, waking);
      const arcs = (slots ?? []).flatMap((span, at) => {
        const arc = clipToDay(span, date);
        return arc && arc.end > arc.start
          ? [{ ...arc, color: slotInk, opacity: SLOT_ALPHA, at }]
          : [];
      });
      return {
        date,
        today: dayKey(date) === todayKey,
        occurrences: all,
        allDay: all.filter((occ) => occ.event.allDay),
        booked: load?.booked ?? 0,
        free: load?.free ?? waking.to - waking.from,
        count: all.length,
        slots: arcs.length > 0 ? arcs : null,
      };
    });
  }, [
    events,
    calendars,
    tasks,
    slots,
    fromKey,
    todayKey,
    settings.wakingFrom,
    settings.wakingTo,
    settings.theme,
  ]);

  /**
   * Once the grid scrolls, the day you arrived on has to be the day you can
   * see. ⌘E out of a Thursday and landing above it is the view answering a
   * question nobody asked.
   *
   * Not smooth: this fires on arrival and on a jump, and a grid that slides in
   * from Monday every time it opens is an animation the view did not earn.
   * Scrolling is an external system, which is what this effect is for.
   */
  const selectedFace = useRef<HTMLButtonElement>(null);
  const selectedKey = dayKey(selected);
  useEffect(() => {
    selectedFace.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedKey, fromKey]);

  /**
   * A press, a drag, a release across the faces — the ring's and the life
   * grid's own grammar, at the one scale that was missing it. A press that
   * never left its face is still a click; anything wider is a run of whole
   * days, handed to `onCreateSpan` exactly as the other two faces hand it
   * over — the editor cannot tell which face drew the draft, and must not
   * be able to.
   *
   * `run.from` is the anchor and never moves once the press starts, so
   * nothing else needs to remember it. Held in state rather than a ref: the
   * faces it covers have to re-render to grow, mark themselves and draw the
   * ghost below, unlike the life grid's run, which paints on a canvas
   * nothing here has.
   *
   * Above the early return with every other hook, because that is where
   * hooks live: the strip renders nothing until the shell has measured it.
   */
  const [run, setRun] = useState<{ from: number; to: number } | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  // Escape abandons a run in flight, exactly as it does on the dial and the
  // life grid: a drag is the one thing on this strip you can start by
  // accident, and before this the only way out of a press was to let go,
  // which committed it. The pointer stays captured on purpose — the two
  // handlers below bail on a missing run, so the release that follows does
  // nothing, no cue because nothing happened.
  useHotkeys({ escape: () => setRun(null) }, run !== null);

  if (!stage || week.length === 0) return null;
  const { layout } = stage;

  const subject = active ? week[active.index] : null;
  const peeked =
    active?.key != null
      ? (week[active.index].occurrences.find((o) => o.key === active.key) ?? null)
      : null;
  const selectedIndex = week.findIndex((d) => isSameDay(d.date, selected));
  /** Where a face is big enough to carry the dial's scale. See the constant. */
  const detailed = layout.size >= WEEK_SCALE_FACE;

  /** Crossing into a face is the same event as crossing a day on the year
   *  ring, so it makes the same sound. On enter only — a move inside one face
   *  is not a crossing, and a cue per pointer event is noise. */
  const enter = (index: number) => {
    if (index === active?.index) return;
    setActive({ index, key: null });
    cue("slide", { sound: settings.tickSound, haptics: settings.tickHaptics });
  };

  /**
   * Which of the seven faces a point in the panel's own content box is
   * nearest to — resolved from `weekLayout`'s own centres, never the DOM.
   * `week.ts` belongs to another slice this round, so this stays local
   * rather than becoming a fifth export there for the one caller that wants
   * it: seven comparisons against numbers this view already has.
   */
  const faceAt = (x: number, y: number): number => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < WEEK_DAYS; i++) {
      const c = weekFaceCentre(layout, i);
      const dist = Math.hypot(x - c.x, y - c.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  };

  const beginRun = (e: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (e.button !== 0) return;
    // The keyboard never reaches this: a synthetic pointerdown has no button
    // press behind it, and `PointerEvent.button` on one is `-1`, not `0`.
    e.currentTarget.setPointerCapture(e.pointerId);
    setRun({ from: index, to: index });
  };
  const extendRun = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!run) return;
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const at = faceAt(e.clientX - rect.left, e.clientY - rect.top);
    // Bail on an identical run: a pointer crossing one face fires a dozen
    // moves and each one that changes state re-renders all seven.
    if (at === run.to) return;
    setRun({ from: run.from, to: at });
  };
  const endRun = () => {
    if (!run) return;
    setRun(null);
    const lo = Math.min(run.from, run.to);
    const hi = Math.max(run.from, run.to);
    if (lo === hi) {
      onSelectDay(week[lo].date);
      return;
    }
    onCreateSpan(week[lo].date, hi - lo + 1);
  };
  /** The run's two ends as slots, or `null` — precomputed once rather than
   *  per face below. */
  const runRange = run ? ([Math.min(run.from, run.to), Math.max(run.from, run.to)] as const) : null;
  /** The run, in the readout's own terms — both ends as dates and the day
   *  count, mirroring the year ring's own span readout. */
  const runSpan = runRange
    ? {
        from: week[runRange[0]].date,
        to: week[runRange[1]].date,
        days: runRange[1] - runRange[0] + 1,
      }
    : null;
  /**
   * What a covered face carries: the mark an all-day event will get, in the
   * middle the now-hand leaves empty — a run of whole days *is* that many
   * all-day days, so the preview is the mark itself rather than a drawing
   * the release throws away. Grey while the run is live (there is no colour
   * to show yet, the dial's own rule for a range still under the pointer),
   * the draft's colour once the editor has one — `pending`, the year ring's
   * and the life grid's own handover, so the range survives the modal
   * arriving. `Day i/n` is `spanLabel`'s voice; a single day says nothing a
   * dot does not.
   */
  const ghostAt = (d: WeekDay, i: number): GhostMark | null => {
    if (runRange) {
      if (i < runRange[0] || i > runRange[1]) return null;
      const days = runRange[1] - runRange[0] + 1;
      return {
        color: THEME_PALETTES[settings.theme].ghost,
        opacity: GHOST_ALPHA,
        label: days > 1 ? `Day ${i - runRange[0] + 1}/${days}` : null,
      };
    }
    if (!pending || d.date < pending.from || d.date > pending.to) return null;
    const days = daysBetween(pending.from, pending.to) + 1;
    return {
      color: pending.color,
      opacity: 1,
      label: days > 1 ? `Day ${daysBetween(pending.from, d.date) + 1}/${days}` : null,
    };
  };

  return (
    <div className="relative h-full w-full">
      <div
        className={cn("absolute inset-0", layout.scrolls && "no-scrollbar overflow-y-auto")}
        onPointerLeave={() => setActive(null)}
      >
        <div
          ref={fieldRef}
          className="relative"
          style={{ height: layout.scrolls ? layout.groupHeight : "100%" }}
        >
          {week.map((d, i) => {
            const centre = weekFaceCentre(layout, i);
            const on = runRange ? i >= runRange[0] && i <= runRange[1] : active?.index === i;
            /**
             * What the pointer found inside this face — an arc, an all-day
             * mark, or nothing at all now it has left one.
             *
             * The functional update is not decoration: a pointer crossing
             * straight from one face's arc onto the next face fires that arc's
             * leave *after* the new face's enter, and a plain `setActive`
             * would hand the subject back to the face it had left.
             */
            const peek = (key: string | null) =>
              setActive((prev) => (key === null && prev?.index !== i ? prev : { index: i, key }));
            return (
              <button
                key={d.date.getTime()}
                ref={i === selectedIndex ? selectedFace : undefined}
                type="button"
                className="absolute rounded-[14px] outline-none focus-visible:ring-1 focus-visible:ring-(--ring-40)"
                style={{
                  left: centre.x - layout.size / 2,
                  top: centre.y - layout.size / 2 - WEEK_CAPTION_H,
                  width: layout.size,
                  height: WEEK_CAPTION_H + layout.size,
                }}
                aria-label={`${WEEKDAYS[d.date.getDay()]}, ${MONTHS[d.date.getMonth()]} ${d.date.getDate()}, ${
                  d.count === 1 ? "1 event" : `${d.count} events`
                }`}
                onPointerEnter={() => enter(i)}
                onPointerDown={(e) => beginRun(e, i)}
                onPointerMove={extendRun}
                onPointerUp={() => {
                  // A dragged task released here names this day, nothing
                  // narrower — the strip stays read-only about minutes. The
                  // shell hears the same release next and puts the row down.
                  if (dragging) {
                    onDropTask(d.date);
                    return;
                  }
                  endRun();
                }}
                onPointerCancel={() => setRun(null)}
                onFocus={() => enter(i)}
                onBlur={() => setActive(null)}
                // One control, whose meaning is whatever it is pointing at:
                // an arc opens, the rest of the face is the day. A second
                // button over the arcs is what the markup would otherwise
                // need, and a control inside a control is not a thing HTML
                // has. The keyboard never lands on an arc, so Enter is always
                // the day — which is the answer this face's tab stop is for.
                onClick={(e) => {
                  // Only the keyboard's click: a pointer press is the gesture
                  // above, and a mouse-originated click's `detail` is never 0.
                  if (e.detail !== 0) return;
                  if (peeked && on) onOpenEvent(peeked);
                  else onSelectDay(d.date);
                }}
              >
                <FaceCaption
                  day={d.date}
                  today={d.today}
                  selected={i === selectedIndex}
                  active={on}
                />
                <motion.div
                  className="relative"
                  style={{ height: layout.size }}
                  animate={{ scale: on && !reducedMotion ? 1 + GROW : 1 }}
                  transition={{ duration: reducedMotion ? 0 : MOOD_MS / 1000, ease: EASE }}
                >
                  <Face
                    day={d.date}
                    now={now}
                    occurrences={d.occurrences}
                    calendars={calendars}
                    clock={settings.clock}
                    theme={settings.theme}
                    slots={d.slots}
                    // The booking tap: `at` points back into the payload, so
                    // the draft covers the slot's own instants rather than
                    // this face's clipped minutes.
                    onSlot={(i) => {
                      const arc = d.slots?.[i];
                      if (arc && slots) onBookSlot(slots[arc.at]);
                    }}
                    track
                    ticks={detailed}
                    numerals={detailed ? "quarters" : "none"}
                    // No AM/PM under them: 13.5 units is four pixels here.
                    meridiem={false}
                    // Today alone. On a past day the ramp is a full bright
                    // ring, which answers "all of it" — a question nobody
                    // asked — at the cost of shouting down the arcs beside it.
                    elapsed={d.today}
                    hand={d.today}
                    inheritMarks={settings.inheritMarks}
                    hovered={!run && active && on ? active.key : null}
                    // Hover only: this is what puts a hit stroke on the arc,
                    // and there is deliberately no `onGrab` behind it.
                    onHover={peek}
                  />
                  {/* An all-day event draws no arc — it has no span on a
                      revolution — so on the dial it lives in the interior and
                      here it would live nowhere at all. The face's middle is
                      empty and the now-hand stops well short of it, so that is
                      where it goes: the same dot the mini-month uses, with the
                      name beside it wherever the face is big enough to print
                      one. */}
                  <AllDayMarks
                    occurrences={d.allDay}
                    calendars={calendars}
                    size={layout.size}
                    named={detailed}
                    peeked={!run && active && on ? active.key : null}
                    onPeek={peek}
                    ghost={ghostAt(d, i)}
                  />
                </motion.div>
              </button>
            );
          })}

          <div
            className="absolute inset-x-0"
            style={{ top: layout.groupTop + layout.groupHeight - WEEK_META_H }}
          >
            <Readout
              week={week}
              from={stage.from}
              subject={subject}
              peeked={peeked}
              run={runSpan}
              calendars={calendars}
              clock={settings.clock}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The weekday and the date over each face, and the whole of which day is
 * which.
 *
 * Three letters and a numeral: the grid is read across, so the label has to be
 * identifiable at a glance rather than legible as prose, and a full weekday at
 * this pitch collides with its neighbour.
 *
 * The selected day is a filled pill round the caption — the mini-month's own
 * mark, and deliberately the same one, since the two surfaces answer the same
 * question. It was a ring outside the face for one release, on the argument
 * that which day you came from is not a fact about the day: true, and it drew
 * a second circle round a dial that already has a rim, a track and a row of
 * numerals, which read as the face having been printed twice. Nothing about
 * the selection belongs on the instrument.
 *
 * Today is named in white, which is what the ramp and the hand on its face are
 * already saying.
 */
function FaceCaption({
  day,
  today,
  selected,
  active,
}: {
  day: Date;
  today: boolean;
  selected: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-center justify-center" style={{ height: WEEK_CAPTION_H }}>
      <span
        className={cn(
          "flex items-baseline gap-1.5 rounded-full px-2 py-[2px] transition-colors",
          selected && "bg-ink",
        )}
      >
        <span
          className={cn(
            "label text-[10.5px] transition-colors",
            selected ? "text-void" : today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
          )}
        >
          {WEEKDAYS[day.getDay()].slice(0, 3)}
        </span>
        <span
          className={cn(
            "text-[12px] tabular-nums transition-colors",
            selected ? "text-void" : today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
          )}
        >
          {day.getDate()}
        </span>
      </span>
    </div>
  );
}

/**
 * The day's all-day events, in the middle of the face.
 *
 * They have no span on a revolution — that is what all-day *means* here — so
 * `Face` draws nothing for them, and on the dial they live in the interior
 * instead. This face has no interior, but it does have an empty middle: the
 * now-hand stops at `HAND_INNER`, so the central two fifths of the disc are
 * free on every face including today's.
 *
 * A dot and the name, where the face can hold the name; bare dots below that,
 * because 10.5px of title in a 65px disc is not a title. Two of them, then a
 * count — a face carrying five all-day events is a fact about that day, and
 * printing all five is a list where the grid wanted a mark.
 */
function AllDayMarks({
  occurrences,
  calendars,
  size,
  named,
  peeked,
  onPeek,
  ghost,
}: {
  occurrences: Occurrence[];
  calendars: Calendar[];
  /** The face's diameter: what decides how much room the middle has. */
  size: number;
  named: boolean;
  peeked: string | null;
  onPeek: (key: string | null) => void;
  /** The event about to exist here — the run being drawn, or the open
   *  editor's draft — as the mark it is about to become. */
  ghost: GhostMark | null;
}) {
  if (occurrences.length === 0 && !ghost) return null;
  const shown = occurrences.slice(0, named ? 2 : 4);
  const rest = occurrences.length - shown.length;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className={cn("flex", named ? "flex-col items-center gap-[3px]" : "items-center gap-[5px]")}
        // Inside the disc the now-hand leaves empty: `HAND_INNER` is 205 of
        // the viewBox's 500-unit radius, so two fifths of the diameter is the
        // widest a row here can be without running under the hand's pip.
        style={{ maxWidth: size * 0.4 }}
      >
        {shown.map((occ) => {
          const color = colorOf(occ.event, calendars);
          return (
            <span
              key={occ.key}
              className="pointer-events-auto flex max-w-full cursor-pointer items-center gap-[5px]"
              onPointerEnter={() => onPeek(occ.key)}
              onPointerLeave={() => onPeek(null)}
            >
              <span
                className="size-[5px] shrink-0 rounded-full transition-opacity"
                style={{ backgroundColor: color, opacity: peeked === occ.key ? 1 : 0.85 }}
              />
              {named && (
                <span
                  className={cn(
                    "truncate text-[10.5px] leading-none transition-colors",
                    peeked === occ.key ? "text-ink" : "text-ink-2",
                  )}
                >
                  {occ.event.title || "Untitled"}
                </span>
              )}
            </span>
          );
        })}
        {rest > 0 && <span className="label shrink-0 text-[9px] text-ink-3">+{rest}</span>}
        {ghost && (
          <span
            className="flex max-w-full items-center gap-[5px]"
            style={{ opacity: ghost.opacity }}
          >
            <span
              className="size-[5px] shrink-0 rounded-full"
              style={{ backgroundColor: ghost.color }}
            />
            {named && ghost.label && (
              <span className="truncate text-[10.5px] leading-none text-ink-2">{ghost.label}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One readout for seven faces, in three moods.
 *
 * At rest it names the week and what is in it; over a face it names the day;
 * over an arc it names the event, which is the whole reason the arcs take a
 * pointer at all. An arc at this size cannot print its own name — the label
 * rides inside a 14-unit stroke, which is five pixels here — so the name is
 * printed once, in real pixels, where there is room for it.
 *
 * One line rather than seven captions: the grid's whole argument is the
 * comparison between the faces, and seven copies of a sentence is the loudest
 * thing that could sit under it.
 */
function Readout({
  week,
  from,
  subject,
  peeked,
  run,
  calendars,
  clock,
}: {
  week: WeekDay[];
  from: Date;
  subject: WeekDay | null;
  peeked: Occurrence | null;
  /** The run being dragged, both ends inclusive, or `null`. Takes the whole
   *  readout over `subject` and `peeked` alike while it is live: a card
   *  naming one end of a run — or one arc under a face the pointer is not
   *  even on anymore, once the capture has it — is a second answer to a
   *  question that has one. */
  run: { from: Date; to: Date; days: number } | null;
  calendars: Calendar[];
  clock: Clock;
}) {
  const head = run
    ? formatDayRange(run.from, run.to)
    : subject
      ? `${WEEKDAYS[subject.date.getDay()].slice(0, 3)} ${subject.date.getDate()}`
      : formatDayRange(from, week[week.length - 1].date);

  return (
    <div className="flex items-center justify-center gap-2.5 px-4" style={{ height: WEEK_META_H }}>
      <span className="label shrink-0 text-[11px] text-ink-2">{head}</span>
      <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline" />
      {run ? (
        <span className="caption tabular-nums">
          {run.days} day{run.days === 1 ? "" : "s"}
        </span>
      ) : peeked ? (
        <>
          <span
            aria-hidden="true"
            className="size-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: colorOf(peeked.event, calendars) }}
          />
          <span className="max-w-[38ch] truncate text-[13px] text-ink">
            {peeked.event.title || "Untitled"}
          </span>
          <span className="caption shrink-0 tabular-nums">{when(peeked, clock)}</span>
        </>
      ) : (
        <Load
          count={subject ? subject.count : week.reduce((sum, d) => sum + d.count, 0)}
          booked={subject ? subject.booked : week.reduce((sum, d) => sum + d.booked, 0)}
          free={subject ? subject.free : week.reduce((sum, d) => sum + d.free, 0)}
        />
      )}
    </div>
  );
}

/** When the pointed-at occurrence is, in the voice the rest of the app uses:
 *  a task is one instant, an all-day event has none, and a day of a longer
 *  span says which day it is rather than a clock time from three days ago. */
function when(occ: Occurrence, clock: Clock): string {
  if (occ.task && occ.start.getTime() === occ.end.getTime())
    return `${formatTimeShort(occ.start, clock)} DUE`;
  const span = spanLabel(occ);
  if (occ.event.allDay) return span ?? "All day";
  const times = `${formatTimeShort(occ.start, clock)} – ${formatTimeShort(occ.end, clock)}`;
  return span ? `${span} · ${times}` : `${times} · ${formatDuration(occ.endMin - occ.startMin)}`;
}

/**
 * The rest mood of the readout: what the day — or, with no face under the
 * pointer, the week — is made of. The booked/free pair is the centre panel's
 * totals line at strip size, same function (`dayLoad`), same two windows
 * (whole revolution / waking), so "free" means one thing across faces; that
 * pair is what makes the strip an instrument for balancing a week rather
 * than seven pictures of days. The free clause yields below `sm`, where the
 * summed sentence no longer fits beside its head.
 */
function Load({ count, booked, free }: { count: number; booked: number; free: number }) {
  return (
    <span className="caption tabular-nums">
      {count === 0 ? "Nothing" : count === 1 ? "1 event" : `${count} events`}
      {booked > 0 && (
        <>
          <span className="text-ink-4"> · </span>
          {formatDuration(booked)} booked
        </>
      )}
      <span aria-hidden="true" className="hidden text-ink-4 sm:inline">
        {" · "}
      </span>
      <span className="hidden sm:inline">{formatDuration(free)} free</span>
    </span>
  );
}
