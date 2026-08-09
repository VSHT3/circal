/* ------------------------------------------------------------------ *
 * The week: seven dials, not seven columns.
 *
 * Every face at the same rotation, so a ten o'clock meeting sits at the same
 * angle on all seven and a recurring thing is a radial column across the
 * strip. That is the one question the rest of the app cannot answer — the year
 * ring says how *busy* a day is and never *when* — and angle-is-time answers
 * it for nothing.
 *
 * A reduced face: track, arcs, and the ramp and hand on today alone. No
 * numerals (twenty-four of them at this size is a grey fringe), no zone ring,
 * no interior. One shared readout under the strip in the centre panel's voice,
 * printed once rather than seven times.
 *
 * Read-only, and deliberately: seven faces of drag targets is seven chances to
 * edit the wrong day, and the dial is one keystroke away. A face is a button —
 * seven tab stops is an order somebody can use, which is why this needs none
 * of the `sr-only` listbox machinery the year ring and the life grid do.
 * ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { dayAgenda, dayLoad, type Occurrence } from "@/lib/events";
import { WEEK_CAPTION_H, WEEK_META_H, weekDays, weekFaceCentre } from "@/lib/week";
import {
  MONTHS,
  WEEKDAYS,
  dayKey,
  formatDayRange,
  formatDuration,
  fromDayKey,
  isSameDay,
} from "@/lib/time";
import { EASE, MOOD_MS } from "@/lib/motion";
import { cue } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import type { WeekViewProps } from "@/components/react/types";
import Face from "./Face";

/**
 * How much a face grows under the pointer, as a fraction of its own size.
 *
 * The year ring's grammar at a different count: pointing at a day makes it the
 * subject. Small, because seven faces at a fixed pitch cannot push each other
 * aside the way 365 marks can — the growth has to happen inside the cell or
 * the whole strip lurches, so it is scaled about the face's own centre and the
 * gutter absorbs it.
 */
const GROW = 0.06;

/** One day of the strip, and everything about it the readout needs. */
interface WeekDay {
  date: Date;
  today: boolean;
  occurrences: Occurrence[];
  booked: number;
  /** Timed events plus all-day ones: what the readout counts. */
  count: number;
}

function dayCaption(d: Date): { weekday: string; date: string } {
  return { weekday: WEEKDAYS[d.getDay()].slice(0, 3), date: `${d.getDate()}` };
}

export default function WeekView({
  stage,
  now,
  selected,
  events,
  calendars,
  settings,
  onSelectDay,
}: WeekViewProps) {
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);

  /**
   * Both keyed by day rather than by instant, and that is what keeps the
   * strip off the shell's minute tick: seven agendas do not change between
   * 10:17 and 10:18, and rebuilding them sixty times an hour would repack
   * every lane on all seven faces for a hand that moved a quarter of a degree.
   * The same trick `LifeView` plays with `todayKey`.
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
   * Once the strip scrolls, the day you arrived on has to be the day you can
   * see. ⌘E out of a Thursday and landing on Monday-and-a-half is the view
   * answering a question nobody asked.
   *
   * Not smooth: this fires on arrival and on a jump, and a strip that slides
   * in from Monday every time it opens is an animation the view did not earn.
   * Scrolling is an external system, which is what this effect is for.
   */
  const selectedFace = useRef<HTMLButtonElement>(null);
  const selectedKey = dayKey(selected);
  useEffect(() => {
    selectedFace.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selectedKey, fromKey]);

  if (!stage || week.length === 0) return null;
  const { layout } = stage;

  const subject = active !== null ? week[active] : null;
  const selectedIndex = week.findIndex((d) => isSameDay(d.date, selected));

  /** Crossing into a face is the same event as crossing a day on the year
   *  ring, so it makes the same sound. Set on enter only — a move inside one
   *  face is not a crossing, and a cue per pointer event is noise. */
  const enter = (index: number) => {
    if (index === active) return;
    setActive(index);
    cue("slide", { sound: settings.tickSound, haptics: settings.tickHaptics });
  };

  return (
    <div className="relative h-full w-full">
      <div
        className={cn(
          "absolute inset-x-0",
          // Scroll-snapped rather than wrapped: a 4+3 block of circles is the
          // grid this view exists not to be.
          layout.scrolls && "no-scrollbar snap-x snap-mandatory overflow-x-auto",
        )}
        style={{ top: layout.groupTop, height: WEEK_CAPTION_H + layout.size }}
        onPointerLeave={() => setActive(null)}
      >
        <div className="relative h-full" style={{ width: layout.scrolls ? "max-content" : "100%" }}>
          {week.map((d, i) => {
            const centre = weekFaceCentre(layout, i);
            const on = active === i;
            return (
              <button
                key={d.date.getTime()}
                ref={i === selectedIndex ? selectedFace : undefined}
                type="button"
                className="absolute snap-center rounded-[14px] outline-none focus-visible:ring-1 focus-visible:ring-white/40"
                style={{
                  left: centre.x - layout.size / 2,
                  top: 0,
                  width: layout.size,
                  height: WEEK_CAPTION_H + layout.size,
                }}
                aria-label={`${WEEKDAYS[d.date.getDay()]}, ${MONTHS[d.date.getMonth()]} ${d.date.getDate()}, ${
                  d.count === 1 ? "1 event" : `${d.count} events`
                }`}
                onPointerEnter={() => enter(i)}
                onFocus={() => enter(i)}
                onBlur={() => setActive(null)}
                onClick={() => onSelectDay(d.date)}
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
                    // Today alone. On a past day the ramp is a full bright
                    // ring, which answers "all of it" — a question nobody
                    // asked — at the cost of shouting down the arcs beside it.
                    elapsed={d.today}
                    hand={d.today}
                    inheritMarks={settings.inheritMarks}
                  />
                </motion.div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Outside the scroll container: inside one it would centre itself on
          content that is wider than the window the moment the strip scrolls,
          and carry the sentence off the side with it. */}
      <div
        className="absolute inset-x-0"
        style={{ top: layout.groupTop + WEEK_CAPTION_H + layout.size }}
      >
        <Readout week={week} from={stage.from} subject={subject} />
      </div>
    </div>
  );
}

/**
 * The weekday and the date over each face.
 *
 * Three letters and a numeral: the strip is read across, so the label has to
 * be identifiable at a glance rather than legible as prose, and a full weekday
 * at this pitch collides with its neighbour. Today is the one that is named in
 * white — it is the only face carrying a ramp and a hand, and the caption
 * agreeing with them costs nothing.
 */
function FaceCaption({ day, today, active }: { day: Date; today: boolean; active: boolean }) {
  const { weekday, date } = dayCaption(day);
  return (
    <div className="flex items-baseline justify-center gap-1.5" style={{ height: WEEK_CAPTION_H }}>
      <span
        className={cn(
          "label text-[10.5px] transition-colors",
          today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
        )}
      >
        {weekday}
      </span>
      <span
        className={cn(
          "text-[12px] tabular-nums transition-colors",
          today ? "text-ink" : active ? "text-ink-2" : "text-ink-3",
        )}
      >
        {date}
      </span>
    </div>
  );
}

/**
 * One readout for seven faces, in two moods.
 *
 * At rest it names the week and what is in it; under a pointer it names the
 * day. Same shape either way, and one line rather than seven captions, because
 * the strip's whole argument is the comparison between the faces and seven
 * copies of a sentence is the loudest thing that could sit under it.
 */
function Readout({
  week,
  from,
  subject,
}: {
  week: WeekDay[];
  from: Date;
  subject: WeekDay | null;
}) {
  const total = week.reduce((sum, d) => sum + d.count, 0);
  const booked = week.reduce((sum, d) => sum + d.booked, 0);

  const head = subject
    ? `${WEEKDAYS[subject.date.getDay()]} · ${MONTHS[subject.date.getMonth()].slice(0, 3)} ${subject.date.getDate()}`
    : formatDayRange(from, week[week.length - 1].date);
  const count = subject ? subject.count : total;
  const load = subject ? subject.booked : booked;

  return (
    <div className="flex items-center justify-center gap-2.5" style={{ height: WEEK_META_H }}>
      <span className="label text-[11px] text-ink-2">{head}</span>
      <span aria-hidden="true" className="h-3 w-px bg-hairline" />
      <span className="caption tabular-nums">
        {count === 0 ? "Nothing" : count === 1 ? "1 event" : `${count} events`}
        {load > 0 && (
          <>
            <span className="text-ink-4"> · </span>
            {formatDuration(load)} booked
          </>
        )}
      </span>
    </div>
  );
}
