/* ------------------------------------------------------------------ *
 * The event editor — a modal card holding one local draft. Nothing is
 * written back to the store until Save; Cancel/Escape just discards it.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Calendar as CalendarIcon, Clock as ClockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  NEVER,
  PALETTE,
  colorOf,
  instantKey,
  REPEATS,
  REPEAT_LABELS,
  repeatUnit,
  repeats,
  toggleDoneKey,
  type CalEvent,
  type Repeat,
} from "@/lib/events";
import { describeRule, isExpressible, nthLabel } from "@/lib/describe";
import { DEFAULT_DURATION, MIN_DURATION, defaultStart } from "@/lib/quickadd";
import {
  WEEKDAYS,
  addDays,
  atMinutes,
  dayKey,
  daysBetween,
  formatRelativeDay,
  fromDayKey,
  minutesOfDay,
  startOfDay,
} from "@/lib/time";
import { placeName } from "@/lib/travel";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/components/react/hooks";
import {
  ColorPicker,
  DateField,
  FieldRow as Row,
  Kbd,
  MOD,
  NumberField,
  Select,
  TimeField,
  Toggle,
  openDatePicker,
} from "@/components/react/ui/primitives";
import { CalendarMark } from "@/components/react/ui/icons";
import { MarkPicker } from "@/components/react/MarkPicker";
import { ScopeChoices } from "@/components/react/ScopePrompt";
import type { EditScope, EventEditorProps } from "@/components/react/types";

/**
 * A day, as a value you can click, printed in the app's relative voice.
 *
 * The editor's own rather than the shared `DateField`: that one is a chip on
 * `bg-surface-2`, and these two sit in a row beside the `TimeField`s and have
 * to read as the same kind of control. The invisible `input[type=date]` and
 * the explicit `showPicker` are the same trick for the same reason — clicking
 * the field of a date input opens nothing in Chrome or Safari.
 */
function DayField({
  value,
  onChange,
  label,
}: {
  value: Date;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <span className="relative inline-flex min-w-0 rounded-[6px] px-1 py-0.5 transition-colors focus-within:bg-white/8 hover:bg-white/6">
      <span className="truncate">{formatRelativeDay(value)}</span>
      <input
        type="date"
        aria-label={label}
        value={dayKey(value)}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => openDatePicker(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          openDatePicker(e.currentTarget);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </span>
  );
}

/**
 * The seven weekdays a weekly rule can name, Monday first — the same week the
 * life grid's columns are, so "a week" means one thing in this app.
 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function DayChip({
  day,
  active,
  onToggle,
}: {
  day: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={WEEKDAYS[day]}
      onClick={onToggle}
      className={cn(
        "size-[26px] shrink-0 rounded-full text-[11px] font-medium transition-colors",
        active ? "bg-ink text-void" : "bg-surface-2 text-ink-2 hover:text-ink",
      )}
    >
      {WEEKDAYS[day][0]}
    </button>
  );
}

/** The last instant of `day`, which is what `until` bounds a series with —
 *  an occurrence starting that afternoon is inside the day it names. */
function endOfDay(day: Date): number {
  const end = startOfDay(day);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * What a native date field is naming, or `null` while it is not naming
 * anything. `input[type=date]` reports a cleared field and a half-typed one
 * identically, and `fromDayKey` would turn either into an Invalid Date.
 */
function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const picked = fromDayKey(value);
  return Number.isNaN(picked.getTime()) ? null : picked;
}

export default function EventEditor({
  target,
  clock,
  calendars,
  onSave,
  onDelete,
  onClose,
  onDraftChange,
}: EventEditorProps) {
  const [draft, setDraft] = useState<Omit<CalEvent, "id">>(target.draft);
  const reducedMotion = useReducedMotion();
  /** A subscribed feed's event: shown in full, editable in no part. */
  const readOnly = target.readOnly === true;
  // Mounted only while it is open, so the trap is always armed.
  const dialog = useFocusTrap<HTMLDivElement>(true);

  // Re-seed during render when a genuinely different event is handed in —
  // React's documented "adjust state when props change" pattern. An effect
  // here would render the old draft once before correcting it, and would fire
  // on every parent re-render, wiping whatever the user was typing.
  const identity = `${target.id}:${target.draft.start}`;
  const [seeded, setSeeded] = useState(identity);
  if (seeded !== identity) {
    setSeeded(identity);
    setDraft(target.draft);
  }

  /**
   * Every change to the draft, and the one place it is reported upward so the
   * face behind the modal can draw it.
   *
   * Merged off the render's own `draft` rather than through the updater form,
   * because the shell has to be told the same value the field is about to
   * show and a prop cannot be called from inside an updater — those must stay
   * pure. Safe because no handler here patches twice in one event; if one ever
   * needs to, it must merge both partials into a single call.
   */
  function patch(next: Partial<Omit<CalEvent, "id">>) {
    const merged = { ...draft, ...next };
    setDraft(merged);
    onDraftChange(merged);
  }

  /**
   * A repeating event cannot be saved or deleted until it has said what the
   * edit means, so both presses raise the question rather than committing. Every
   * other target — a one-off, a fresh draft, an already-detached override — has
   * exactly one answer and is never asked for it.
   */
  const repeating = repeats(draft);
  const scoped = !readOnly && target.id !== null && repeating;
  const [pending, setPending] = useState<"save" | "delete" | null>(null);

  /**
   * Whether the full-screen mark grid is up. Held here rather than inside the
   * picker because the key is taken here: Escape belongs to whatever is on
   * top, and every modal in this app claims it on a `window` capture listener,
   * which fire in the order they were added — so this one always wins and a
   * listener inside the picker could only ever close the card as well. The
   * shell holds the life grid's drawn run for exactly the same reason.
   */
  const [browsing, setBrowsing] = useState(false);
  const [markQuery, setMarkQuery] = useState("");

  function save(scope: EditScope) {
    onSave(
      { ...draft, title: draft.title.trim() || (draft.task ? "New task" : "New event") },
      scope,
    );
  }

  function askOrSave() {
    if (scoped) setPending("save");
    else save("all");
  }

  function askOrDelete() {
    if (scoped) setPending("delete");
    else onDelete("all");
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // Everything is off while the mark grid is over this card, ⌘↵ and ⌘⌫
      // included: a save or a delete committed from under a surface the user
      // is still working in is the shell's own `busy` bug, one layer in.
      if (browsing) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setBrowsing(false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Captured at `window`, so stopping here keeps the press from also
        // reaching the shell's own Escape — which by then would see a closed
        // editor and go on to take Escape's next meaning.
        e.stopPropagation();
        // The question is a step inside the editor, not a second modal: Escape
        // backs out of it and leaves the edit on screen, because closing here
        // would discard work the user has not yet been allowed to save.
        if (pending) setPending(null);
        else onClose();
      } else if (readOnly) {
        return;
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        askOrSave();
      } else if (mod && e.key === "Backspace" && target.id) {
        e.preventDefault();
        askOrDelete();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, target.id, readOnly, pending, scoped, browsing, onClose, onDelete]);

  const calendar = calendars.find((c) => c.id === draft.calendarId);

  /**
   * The last day the draft actually covers. `end` is exclusive, so an event
   * finishing at midnight ends on the day before the instant names it — and
   * every edit below that has to think about "the far end of this span" wants
   * that day rather than the instant.
   */
  const lastDay = startOfDay(new Date(draft.end - 1));

  function handleDateChange(value: string) {
    const picked = parseDay(value);
    if (!picked) return;
    // The first date moves the whole event: its span is set by the second one.
    const delta = daysBetween(new Date(draft.start), picked);
    if (delta === 0) return;
    patch({
      start: addDays(new Date(draft.start), delta).getTime(),
      end: addDays(new Date(draft.end), delta).getTime(),
    });
  }

  function handleEndDateChange(value: string) {
    const picked = parseDay(value);
    if (!picked) return;
    // The field names the last day the event *touches*, so the edit is a shift
    // of `end` by however far that day moved. One expression covers both
    // kinds: a timed span keeps the clock time it ended at, and an all-day one
    // keeps its exclusive midnight.
    const delta = daysBetween(lastDay, picked);
    if (delta === 0) return;
    const next = addDays(new Date(draft.end), delta).getTime();
    // The picker will happily name a day before the start. That is not a span,
    // and refusing it is better than silently dragging the start along.
    if (next < draft.start + MIN_DURATION * 60_000) return;
    patch({ end: next });
  }

  function handleStartTime(minutes: number) {
    const next = atMinutes(new Date(draft.start), minutes).getTime();
    patch({ start: next, end: next + (draft.end - draft.start) });
  }

  function handleEndTime(minutes: number) {
    // Anchored to the *last* day the event covers rather than to its first, so
    // retyping one time on a multi-day span does not collapse it. Rolled
    // forward when that would put it before the start — which is how
    // 11 PM → 1 AM stays one event on a span only a day long.
    let next = atMinutes(lastDay, minutes);
    if (next.getTime() < draft.start + MIN_DURATION * 60_000) next = addDays(next, 1);
    patch({ end: next.getTime() });
  }

  /**
   * The two clock times this event had before All-day was switched on, so
   * switching it back off returns them rather than resetting to 9–10am. Times
   * rather than a duration, because the span in *days* is the date row's to
   * own now and reapplying a stored duration would overrule it.
   *
   * A ref rather than state: nothing renders from it, and it must survive the
   * `patch` without causing a second render. `null` until All-day is switched
   * on from a timed event, which is the only moment there is anything to
   * remember.
   */
  const timedSpan = useRef<{ startMin: number; endMin: number } | null>(null);

  /**
   * The span this event had before it was turned into a task, so turning the
   * switch back off returns it rather than inventing an hour. Same argument
   * as `timedSpan` above and the same shape — a ref, because nothing renders
   * from it and it must survive a `patch` without causing a second render.
   */
  const taskSpan = useRef<number>(DEFAULT_DURATION * 60_000);

  function handleAllDayToggle(next: boolean) {
    const firstDay = startOfDay(new Date(draft.start));
    if (next) {
      if (!draft.allDay) {
        timedSpan.current = {
          startMin: minutesOfDay(new Date(draft.start)),
          endMin: minutesOfDay(new Date(draft.end)),
        };
      }
      // The span in days survives the toggle. Collapsing a five-day trip onto
      // its first day because somebody flipped a switch is deleting four days.
      patch({ allDay: true, start: firstDay.getTime(), end: addDays(lastDay, 1).getTime() });
    } else {
      const remembered = timedSpan.current ?? { startMin: 9 * 60, endMin: 10 * 60 };
      const start = atMinutes(firstDay, remembered.startMin).getTime();
      let end = atMinutes(lastDay, remembered.endMin);
      if (end.getTime() < start + MIN_DURATION * 60_000) end = addDays(end, 1);
      patch({ allDay: false, start, end: end.getTime() });
    }
  }

  /**
   * Event ⇄ task. A task is a moment, so the whole conversion is `end` —
   * collapsed onto `start` one way, given its remembered width back the
   * other. All-day goes with it, because "all day" and "one minute" are two
   * answers to the same question and a control that can hold both is a
   * control that lies.
   */
  function handleTaskToggle(next: boolean) {
    if (next) {
      if (!draft.allDay) taskSpan.current = Math.max(draft.end - draft.start, 60_000);
      // An all-day event turned into a task is due at the hour a new draft
      // would open on, not at midnight: midnight is where an all-day event's
      // instant happens to sit, and nobody means "00:00" by it.
      const firstDay = startOfDay(new Date(draft.start));
      const start = draft.allDay
        ? atMinutes(firstDay, defaultStart(firstDay, 0)).getTime()
        : draft.start;
      patch({ task: true, allDay: false, start, end: start });
    } else {
      patch({ task: false, doneKeys: [], end: draft.start + taskSpan.current });
    }
  }

  /**
   * Which occurrence the Done switch is about: the one that was opened, not
   * the series' seed. A weekly task edited from next Tuesday's pip has to
   * tick next Tuesday — `doneKeys` holds instants, and the seed's instant is
   * a different Tuesday.
   */
  const doneAt = target.occurrenceStart ?? draft.start;
  const done = draft.doneKeys.includes(instantKey(doneAt));

  function handleDoneToggle() {
    patch({ doneKeys: toggleDoneKey(draft.doneKeys, doneAt) });
  }

  /* ------------------------------ recurrence ------------------------------ */

  const seed = new Date(draft.start);
  /** Whether the three rows below can actually spell this rule — false for
   *  whatever a subscription sent that they have no control for. */
  const expressible = isExpressible(draft, seed);
  /** Empty `byDay` means "the seed's own weekday" — the chips show that. */
  const activeDays = draft.byDay.length > 0 ? draft.byDay.map((w) => w.day) : [seed.getDay()];

  function handleRepeatChange(repeat: Repeat) {
    // A weekday list belongs to the frequency that named it: carried across,
    // a weekly BYDAY becomes a monthly position nobody chose. The bound and
    // the interval survive, because they are about the same series either way.
    patch(repeat === "never" ? { ...NEVER } : { repeat, byDay: [] });
  }

  function toggleWeekday(day: number) {
    const next = activeDays.includes(day)
      ? activeDays.filter((d) => d !== day)
      : [...activeDays, day].sort((a, b) => a - b);
    // A weekly rule with no weekday is not a rule; the last one cannot be
    // taken off, which is also why there is no error to show.
    if (next.length > 0) patch({ byDay: next.map((d) => ({ day: d, nth: 0 })) });
  }

  /** The seed's own monthly position — "Second" for its second Tuesday. */
  const seedNth = Math.floor((seed.getDate() - 1) / 7) + 1;

  function handleMonthlyMode(value: string) {
    const nth = Number(value);
    patch({ byDay: nth === 0 ? [] : [{ day: seed.getDay(), nth }] });
  }

  function handleEndsChange(value: string) {
    // A year out: long enough to be a real bound, short enough that nobody
    // picked it by accident and forgot.
    patch({ until: value === "never" ? 0 : endOfDay(addDays(seed, 365)) });
  }

  /** "Day N", the seed's own positional weekday, or the last one — the three
   *  shapes a monthly rule can take from here. */
  const monthlyValue = draft.byDay.length === 0 ? "0" : String(draft.byDay[0].nth);
  const monthlyModes = [
    { value: "0", label: `Day ${seed.getDate()}` },
    { value: String(seedNth), label: nthLabel(seedNth, seed.getDay()) },
    { value: "-1", label: nthLabel(-1, seed.getDay()) },
  ];

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 grid place-items-center">
        <motion.div
          aria-hidden
          onClick={onClose}
          className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.18 }}
        />
        <motion.div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label={
            readOnly ? "Event" : `${target.id ? "Edit" : "New"} ${draft.task ? "task" : "event"}`
          }
          className="relative flex max-h-[86vh] w-[330px] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
          initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          {/* header */}
          <div className="flex items-center gap-2.5 border-b border-hairline px-3.5 py-3">
            <span
              aria-hidden
              className="size-[9px] shrink-0 rounded-full"
              style={{ backgroundColor: draft.color || (calendar?.color ?? PALETTE[0]) }}
            />
            {/* Focus must move into a modal on open (WAI-ARIA dialog pattern).
                Read-only, the disabled title cannot take it and the Close
                button below claims it instead. */}
            <input
              autoFocus
              disabled={readOnly}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder={draft.task ? "New task" : "New event"}
              aria-label={draft.task ? "Task title" : "Event title"}
              className="w-full min-w-0 border-none bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-ink-3 disabled:opacity-100"
            />
          </div>

          {/* A `disabled` fieldset is the whole read-only implementation: it
              cascades to every control under it, including the ones nested two
              components deep, which no prop-threading would reach. */}
          <fieldset
            disabled={readOnly}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              readOnly && "opacity-75",
            )}
          >
            <div className="no-scrollbar flex-1 overflow-y-auto">
              {/* Two dates, the way the Time row is two times — the second one
                  is the last day the event covers, and it is the only control
                  in the app that can make an event span several. Both are
                  always shown: on a single-day event they simply name the same
                  day, and hiding the one that reaches the state is worse than
                  printing it twice. */}
              <Row label="Date">
                <CalendarIcon size={14} className="shrink-0 text-ink-2" />
                <DayField
                  label="First day"
                  value={new Date(draft.start)}
                  onChange={handleDateChange}
                />
                {/* A task has one day, so it has one date field. The second
                    one names the last day a span covers, and a moment does not
                    have one to name. */}
                {!draft.task && (
                  <>
                    <span className="text-ink-3">–</span>
                    <DayField label="Last day" value={lastDay} onChange={handleEndDateChange} />
                  </>
                )}
              </Row>

              <Row label={draft.task ? "Due" : "Time"} disabled={draft.allDay}>
                <ClockIcon size={14} className="shrink-0 text-ink-2" />
                <TimeField
                  label={draft.task ? "Due time" : "Start time"}
                  clock={clock}
                  value={new Date(draft.start)}
                  disabled={draft.allDay}
                  onCommit={handleStartTime}
                />
                {!draft.task && (
                  <>
                    <span className="text-ink-3">–</span>
                    <TimeField
                      label="End time"
                      clock={clock}
                      value={new Date(draft.end)}
                      disabled={draft.allDay}
                      onCommit={handleEndTime}
                    />
                  </>
                )}
              </Row>

              {/* Hours read against another clock, and an event that does not
                  say so is a wrong answer that looks right. Every zoned event,
                  not only a subscription's: a floating event stamped by the
                  travel notice is one the user chose to leave on the clock it
                  was written on, and this row is where that choice is legible
                  afterwards. Still print-only — there is no picker, because a
                  zone arrives on an event from a feed's own TZID or from that
                  one answer, and never from a field. */}
              {draft.tzid && (
                <p className="caption -mt-1 px-3.5 pb-2">Times in {placeName(draft.tzid)}</p>
              )}

              <Row label="Where">
                <input
                  value={draft.location}
                  onChange={(e) => patch({ location: e.target.value })}
                  placeholder="Add location"
                  aria-label="Location"
                  className="w-full min-w-0 border-none bg-transparent text-ink outline-none placeholder:text-ink-3"
                />
              </Row>

              <Row label="Calendar">
                <CalendarMark
                  icon={calendar?.icon ?? ""}
                  color={calendar?.color ?? PALETTE[0]}
                  size={14}
                />
                <Select
                  value={draft.calendarId}
                  onChange={(next) => patch({ calendarId: next })}
                  options={calendars.map((c) => ({ value: c.id, label: c.name }))}
                  label="Calendar"
                  className="flex-1"
                />
              </Row>

              <Row label="Color">
                <ColorPicker
                  value={draft.color}
                  fallback={calendar?.color ?? PALETTE[0]}
                  onChange={(color) => patch({ color })}
                />
              </Row>

              {/* Under Color because it is the same kind of answer about the
                  same event, and `""` means the same thing in both: follow the
                  calendar. The two are read apart, though — `markOf` and
                  `colorOf` — so an event may borrow one and override the
                  other, and the mark only inherits at all when the setting
                  says so. */}
              <Row label="Mark" align="top">
                <MarkPicker
                  icon={draft.icon}
                  color={colorOf(draft, calendars)}
                  noneLabel="Follow the calendar"
                  onChange={(icon) => patch({ icon })}
                  query={markQuery}
                  onQuery={setMarkQuery}
                  browsing={browsing}
                  onBrowse={setBrowsing}
                />
              </Row>

              {/* One row, three switches, and the first two are exclusive by
                  construction: "all day" and "one minute" are two answers to
                  the same question about width, so each turns the other off
                  rather than sitting beside it greyed out.

                  `Toggle` rather than `Switch`, unlike every other row in this
                  modal: those get their word from the row's own label, and a
                  row with three switches in it has one label and three
                  meanings. */}
              <Row label="Kind" align="top">
                <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {!draft.task && (
                    <Toggle label="All-day" checked={draft.allDay} onChange={handleAllDayToggle} />
                  )}
                  <Toggle
                    label="Task"
                    name="A moment rather than a span"
                    checked={draft.task}
                    onChange={handleTaskToggle}
                  />
                  {/* Only for an event that exists. A draft has no occurrence
                      to tick — it is not on any day yet — and a switch whose
                      state is discarded on Cancel is a switch that lied. */}
                  {draft.task && target.id !== null && (
                    <Toggle label="Done" checked={done} onChange={handleDoneToggle} />
                  )}
                </span>
              </Row>

              {/* The rule, one line per question, and only the questions the
                  chosen frequency actually raises. A monthly series does not
                  get asked which weekdays; a one-off is asked nothing. */}
              <Row label="Repeat" align={repeating ? "top" : "center"}>
                {!expressible ? (
                  <span>{describeRule(draft)}</span>
                ) : (
                  <>
                    <Select
                      value={draft.repeat}
                      onChange={handleRepeatChange}
                      options={REPEATS.map((r) => ({ value: r, label: REPEAT_LABELS[r] }))}
                      label="Repeat"
                    />

                    {repeating && (
                      <span className="flex items-center gap-2">
                        <span className="label text-ink-3">Every</span>
                        <NumberField
                          value={draft.interval}
                          onChange={(interval) => patch({ interval })}
                          label="Repeat interval"
                          suffix={repeatUnit(draft.repeat, draft.interval)}
                          min={1}
                          max={99}
                        />
                      </span>
                    )}

                    {draft.repeat === "weekly" && (
                      <span className="flex items-center gap-1">
                        {WEEK_ORDER.map((day) => (
                          <DayChip
                            key={day}
                            day={day}
                            active={activeDays.includes(day)}
                            onToggle={() => toggleWeekday(day)}
                          />
                        ))}
                      </span>
                    )}

                    {draft.repeat === "monthly" && (
                      <span className="flex items-center gap-2">
                        <span className="label text-ink-3">On</span>
                        <Select
                          value={monthlyValue}
                          onChange={handleMonthlyMode}
                          options={monthlyModes}
                          label="Monthly on"
                        />
                      </span>
                    )}

                    {repeating && (
                      <span className="flex items-center gap-2">
                        <span className="label text-ink-3">Ends</span>
                        <Select
                          value={draft.until > 0 ? "on" : "never"}
                          onChange={handleEndsChange}
                          options={[
                            { value: "never", label: "Never" },
                            { value: "on", label: "On" },
                          ]}
                          label="Repeat ends"
                        />
                        {draft.until > 0 && (
                          <DateField
                            value={dayKey(new Date(draft.until))}
                            onChange={(next) =>
                              next && patch({ until: endOfDay(fromDayKey(next)) })
                            }
                            label="Repeat until"
                            min={dayKey(seed)}
                          />
                        )}
                      </span>
                    )}
                  </>
                )}
              </Row>

              <Row label="URL" last>
                <input
                  type="url"
                  value={draft.url}
                  onChange={(e) => patch({ url: e.target.value })}
                  placeholder="Add URL"
                  aria-label="URL"
                  className="w-full min-w-0 border-none bg-transparent text-ink outline-none placeholder:text-ink-3"
                />
              </Row>
            </div>

            {/* notes */}
            <div className="border-t border-hairline px-3.5 py-3">
              <span className="label text-ink-3">Notes</span>
              <textarea
                rows={4}
                value={draft.notes}
                onChange={(e) => patch({ notes: e.target.value })}
                placeholder="Add notes"
                aria-label="Notes"
                className="mt-1.5 [field-sizing:content] min-h-[68px] w-full resize-none border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
              />
            </div>
          </fieldset>

          {/* The footer is one of two things: the ordinary row of verbs, or the
              question a repeating event has to answer before anything is
              written. It replaces that row rather than sitting above it — two
              rows of verbs, one of them now inert, is a footer that lies. */}
          {pending ? (
            <div className="border-t border-hairline">
              <ScopeChoices
                heading={pending === "save" ? "Save this change to" : "Delete"}
                danger={pending === "delete"}
                onPick={pending === "save" ? save : onDelete}
                onCancel={() => setPending(null)}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
              {readOnly ? (
                <>
                  <span className="label text-ink-4">
                    {calendar?.name ?? "Subscription"} · read only
                  </span>
                  <button
                    autoFocus
                    type="button"
                    onClick={onClose}
                    className="ml-auto flex h-8 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-white/10"
                  >
                    Close
                    <Kbd>esc</Kbd>
                  </button>
                </>
              ) : (
                <>
                  {target.id && (
                    <button
                      type="button"
                      onClick={askOrDelete}
                      className="flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] text-danger transition-colors hover:bg-white/6"
                    >
                      Delete
                      <Kbd>{MOD}</Kbd>
                      <Kbd>⌫</Kbd>
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-3">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-1 text-[14px] text-ink-2 transition-colors hover:text-ink"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={askOrSave}
                      className="flex h-8 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-white/10"
                    >
                      Save
                      <Kbd>{MOD}</Kbd>
                      <Kbd>↵</Kbd>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
