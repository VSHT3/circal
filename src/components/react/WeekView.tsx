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

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { colorOf, dayAgenda, dayLoad, spanLabel, type Occurrence } from "@/lib/events";
import { WEEK_CAPTION_H, WEEK_META_H, WEEK_SCALE_FACE, weekDays, weekFaceCentre } from "@/lib/week";
import {
  MONTHS,
  WEEKDAYS,
  dayKey,
  formatDayRange,
  formatDuration,
  formatTimeShort,
  fromDayKey,
  isSameDay,
} from "@/lib/time";
import { EASE, MOOD_MS } from "@/lib/motion";
import { cue } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import type { Clock } from "@/lib/time";
import type { Calendar } from "@/lib/events";
import type { WeekViewProps } from "@/components/react/types";
import Face from "./Face";

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
  booked: number;
  /** Timed events plus all-day ones: what the readout counts. */
  count: number;
}

/** What the pointer is on: a face, and possibly one arc of it. */
interface Subject {
  index: number;
  key: string | null;
}

export default function WeekView({
  stage,
  now,
  selected,
  events,
  calendars,
  settings,
  onSelectDay,
  onOpenEvent,
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
    return weekDays(fromDayKey(fromKey)).map((date) => {
      const { all } = dayAgenda(events, calendars, date);
      const load = dayLoad(all);
      return {
        date,
        today: dayKey(date) === todayKey,
        occurrences: all,
        booked: load?.booked ?? 0,
        count: all.length,
      };
    });
  }, [events, calendars, fromKey, todayKey]);

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

  return (
    <div className="relative h-full w-full">
      <div
        className={cn("absolute inset-0", layout.scrolls && "no-scrollbar overflow-y-auto")}
        onPointerLeave={() => setActive(null)}
      >
        <div className="relative" style={{ height: layout.scrolls ? layout.groupHeight : "100%" }}>
          {week.map((d, i) => {
            const centre = weekFaceCentre(layout, i);
            const on = active?.index === i;
            return (
              <button
                key={d.date.getTime()}
                ref={i === selectedIndex ? selectedFace : undefined}
                type="button"
                className="absolute rounded-[14px] outline-none focus-visible:ring-1 focus-visible:ring-white/40"
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
                onFocus={() => enter(i)}
                onBlur={() => setActive(null)}
                // One control, whose meaning is whatever it is pointing at:
                // an arc opens, the rest of the face is the day. A second
                // button over the arcs is what the markup would otherwise
                // need, and a control inside a control is not a thing HTML
                // has. The keyboard never lands on an arc, so Enter is always
                // the day — which is the answer this face's tab stop is for.
                onClick={() => (peeked && on ? onOpenEvent(peeked) : onSelectDay(d.date))}
              >
                <FaceCaption day={d.date} today={d.today} active={on} />
                <motion.div
                  className="relative"
                  style={{ height: layout.size }}
                  animate={{ scale: on && !reducedMotion ? 1 + GROW : 1 }}
                  transition={{ duration: reducedMotion ? 0 : MOOD_MS / 1000, ease: EASE }}
                >
                  {/* The selected day is a halo *outside* the face rather than
                      a brighter rim on it: which day you came from is not a
                      fact about the day, the same argument the life grid makes
                      about its own dot. Outside also keeps it clear of the
                      track, which is 85% of this box and would otherwise be
                      wearing two rings a pixel apart. */}
                  {i === selectedIndex && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/12"
                    />
                  )}
                  <Face
                    day={d.date}
                    now={now}
                    occurrences={d.occurrences}
                    calendars={calendars}
                    clock={settings.clock}
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
                    hovered={active && on ? active.key : null}
                    // Hover only: this is what puts a hit stroke on the arc,
                    // and there is deliberately no `onGrab` behind it. The
                    // functional update is not decoration: a pointer crossing
                    // straight from one face's arc onto the next face fires
                    // that arc's leave *after* the new face's enter, and a
                    // plain `setActive` would hand the subject back.
                    onHover={(key) =>
                      setActive((prev) =>
                        key === null && prev?.index !== i ? prev : { index: i, key },
                      )
                    }
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
 * The weekday and the date over each face.
 *
 * Three letters and a numeral: the grid is read across, so the label has to be
 * identifiable at a glance rather than legible as prose, and a full weekday at
 * this pitch collides with its neighbour. Today is the one that is named in
 * white — it is the only face carrying a ramp and a hand, and the caption
 * agreeing with them costs nothing.
 */
function FaceCaption({ day, today, active }: { day: Date; today: boolean; active: boolean }) {
  return (
    <div className="flex items-baseline justify-center gap-1.5" style={{ height: WEEK_CAPTION_H }}>
      <span
        className={cn(
          "label text-[10.5px] transition-colors",
          today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
        )}
      >
        {WEEKDAYS[day.getDay()].slice(0, 3)}
      </span>
      <span
        className={cn(
          "text-[12px] tabular-nums transition-colors",
          today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
        )}
      >
        {day.getDate()}
      </span>
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
  calendars,
  clock,
}: {
  week: WeekDay[];
  from: Date;
  subject: WeekDay | null;
  peeked: Occurrence | null;
  calendars: Calendar[];
  clock: Clock;
}) {
  const head = subject
    ? `${WEEKDAYS[subject.date.getDay()].slice(0, 3)} ${subject.date.getDate()}`
    : formatDayRange(from, week[week.length - 1].date);

  return (
    <div className="flex items-center justify-center gap-2.5 px-4" style={{ height: WEEK_META_H }}>
      <span className="label shrink-0 text-[11px] text-ink-2">{head}</span>
      <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline" />
      {peeked ? (
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
        />
      )}
    </div>
  );
}

/** When the pointed-at occurrence is, in the voice the rest of the app uses:
 *  a task is one instant, an all-day event has none, and a day of a longer
 *  span says which day it is rather than a clock time from three days ago. */
function when(occ: Occurrence, clock: Clock): string {
  if (occ.event.task) return `${formatTimeShort(occ.start, clock)} DUE`;
  const span = spanLabel(occ);
  if (occ.event.allDay) return span ?? "All day";
  const times = `${formatTimeShort(occ.start, clock)} – ${formatTimeShort(occ.end, clock)}`;
  return span ? `${span} · ${times}` : `${times} · ${formatDuration(occ.endMin - occ.startMin)}`;
}

function Load({ count, booked }: { count: number; booked: number }) {
  return (
    <span className="caption tabular-nums">
      {count === 0 ? "Nothing" : count === 1 ? "1 event" : `${count} events`}
      {booked > 0 && (
        <>
          <span className="text-ink-4"> · </span>
          {formatDuration(booked)} booked
        </>
      )}
    </span>
  );
}
