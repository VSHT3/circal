/* ------------------------------------------------------------------ *
 * The event editor — a modal card holding one local draft. Nothing is
 * written back to the store until Save; Cancel/Escape just discards it.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Calendar as CalendarIcon, Clock as ClockIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  NEVER,
  PALETTE,
  REPEATS,
  REPEAT_LABELS,
  repeatUnit,
  repeats,
  type CalEvent,
  type Recurrence,
  type Repeat,
} from "@/lib/events";
import {
  MONTHS,
  WEEKDAYS,
  addDays,
  atMinutes,
  dayKey,
  daysBetween,
  formatRelativeDay,
  formatTime,
  fromDayKey,
  minutesOfDay,
  parseClock,
  startOfDay,
  type Clock,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/components/react/hooks";
import {
  DateField,
  FieldRow as Row,
  Kbd,
  NumberField,
  Select,
  Switch,
  openDatePicker,
} from "@/components/react/ui/primitives";
import type { EditScope, EventEditorProps } from "@/components/react/types";

const MIN_DURATION_MIN = 5;

/**
 * The three answers, narrowest first: the safe one is the shortest reach, and
 * the one that rewrites a year of history is the furthest.
 */
const SCOPES: { scope: EditScope; label: string }[] = [
  { scope: "one", label: "Only this one" },
  { scope: "future", label: "This and all future" },
  { scope: "all", label: "The whole series" },
];

/**
 * A twelve-hour clock field. Free text while focused, normalised on blur or
 * Enter; ↑/↓ nudge by five minutes so keyboard-only editing is not a retype.
 */
function TimeField({
  value,
  clock,
  onCommit,
  label,
  disabled,
}: {
  value: Date;
  clock: Clock;
  onCommit: (minutes: number) => void;
  label: string;
  disabled?: boolean;
}) {
  // `null` means "not being typed in" — the field then simply renders the
  // draft. That keeps the two in sync without an effect that copies props
  // into state on every re-render.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? formatTime(value, clock);

  function commit(raw: string) {
    const minutes = parseClock(raw);
    if (minutes !== null) onCommit(minutes);
    setTyped(null);
  }

  function nudge(delta: number) {
    const base = parseClock(text) ?? minutesOfDay(value);
    onCommit((Math.round(base) + delta + 1440) % 1440);
    setTyped(null);
  }

  return (
    <input
      aria-label={label}
      disabled={disabled}
      value={text}
      spellCheck={false}
      onFocus={(e) => {
        setTyped(formatTime(value, clock));
        e.currentTarget.select();
      }}
      onChange={(e) => setTyped(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          commit(text);
          e.currentTarget.blur();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          nudge(e.key === "ArrowUp" ? 5 : -5);
        }
      }}
      className={cn(
        "rounded-[6px] px-1 py-0.5 text-ink tabular-nums transition-colors hover:bg-white/6 focus:bg-white/8",
        clock === "24h" ? "w-[56px]" : "w-[76px]",
      )}
    />
  );
}

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
 * One swatch. A plain `<button>` for the presets, and for "custom" a hidden
 * `<input type="color">` filling the same circle — the OS picker is better
 * than anything hand-rolled and it is already keyboard- and screen-reader-
 * addressable.
 */
function Swatch({
  color,
  selected,
  label,
  onSelect,
  children,
}: {
  color: string;
  selected: boolean;
  label: string;
  onSelect?: () => void;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative grid size-[22px] place-items-center rounded-full transition-shadow",
        selected && "ring-2 ring-ink/70 ring-offset-2 ring-offset-[var(--surface)]",
      )}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        onClick={onSelect}
        className="size-[18px] rounded-full"
        style={{ background: color }}
      />
      {children}
    </span>
  );
}

/** Presets, the calendar default, and an any-colour picker. */
function ColorPicker({
  value,
  fallback,
  onChange,
}: {
  value: string;
  fallback: string;
  onChange: (color: string) => void;
}) {
  const custom = value !== "" && !PALETTE.includes(value as (typeof PALETTE)[number]);
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <Swatch
        color={fallback}
        selected={value === ""}
        label="Use the calendar's colour"
        onSelect={() => onChange("")}
      />
      {/* A divider, so "inherit the calendar" reads as a different kind of
          choice from the ten literal colours next to it. */}
      <span aria-hidden className="h-4 w-px bg-white/15" />
      {PALETTE.map((preset) => (
        <Swatch
          key={preset}
          color={preset}
          selected={value === preset}
          label={preset}
          onSelect={() => onChange(preset)}
        />
      ))}
      <Swatch
        color={custom ? value : "conic-gradient(#ff9fb4,#ffdf8c,#8bf0b8,#8ecbff,#c79bff,#ff9fb4)"}
        selected={custom}
        label="Custom colour"
      >
        <input
          type="color"
          aria-label="Custom colour"
          value={custom ? value : fallback}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </Swatch>
    </div>
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

const ORDINALS = ["", "First", "Second", "Third", "Fourth", "Fifth"];

/** How a monthly position reads: `Third Thursday`, `Last Thursday`. */
function nthLabel(nth: number, weekday: number): string {
  const name = WEEKDAYS[weekday];
  if (nth > 0) return `${ORDINALS[nth] ?? nth} ${name}`;
  return nth === -1 ? `Last ${name}` : `${ORDINALS[-nth] ?? -nth} last ${name}`;
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

/**
 * Can the rows below actually spell this rule? A subscription's RRULE can
 * carry BYWEEKNO, BYSETPOS, a sub-daily FREQ, or a BY* combination none of
 * them offers — the three rows are a dial, not a parser, and forcing such a
 * rule onto the nearest checkbox is how an import quietly becomes a
 * different meeting. `describeRule` is what stands in when this is false.
 */
function isExpressible(rule: Recurrence, seed: Date): boolean {
  if (!(REPEATS as readonly string[]).includes(rule.repeat)) return false;
  if (
    rule.byMonth.length > 0 ||
    rule.byWeekNo.length > 0 ||
    rule.byYearDay.length > 0 ||
    rule.byHour.length > 0 ||
    rule.byMinute.length > 0 ||
    rule.bySecond.length > 0 ||
    rule.bySetPos.length > 0
  ) {
    return false;
  }
  if (rule.repeat === "daily" || rule.repeat === "yearly") {
    return rule.byMonthDay.length === 0 && rule.byDay.length === 0;
  }
  if (rule.repeat === "weekly") {
    return rule.byMonthDay.length === 0 && rule.byDay.every((w) => w.nth === 0);
  }
  if (rule.repeat === "monthly") {
    if (rule.byMonthDay.length > 0 || rule.byDay.length > 1) return false;
    if (rule.byDay.length === 0) return true;
    const [w] = rule.byDay;
    const seedNth = Math.floor((seed.getDate() - 1) / 7) + 1;
    return w.day === seed.getDay() && (w.nth === seedNth || w.nth === -1);
  }
  return true; // "never"
}

const POSITIONS = ["", "first", "second", "third", "fourth", "fifth"];

/** `13` → "13th". A date has to read as a date inside a sentence. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** `3` → "third", `-1` → "last", `-2` → "second from last". */
function positionWord(n: number): string {
  if (n > 0) return POSITIONS[n] ?? ordinal(n);
  return n === -1 ? "last" : `${POSITIONS[-n] ?? ordinal(-n)} from last`;
}

/** `-3` → "3rd from last", counted from the end of the month as RFC does. */
function monthDayWord(n: number): string {
  return n > 0 ? ordinal(n) : `${ordinal(-n)} from last`;
}

function joinWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The sentence a rule reads as when it cannot be edited here — "Every 2 weeks
 * on Tue and Thu until 1 Jan 2027".
 *
 * It has to be a sentence rather than a dump of the parts, because it is the
 * only thing standing between the reader and a rule they cannot see: "taking
 * the -1 of those" tells somebody nothing they did not already fear.
 */
function describeRule(rule: Recurrence): string {
  const every = rule.interval > 1 ? `${rule.interval} ` : "";
  const parts = [`Every ${every}${repeatUnit(rule.repeat, rule.interval)}`];

  if (rule.byMonth.length > 0) {
    parts.push(`in ${joinWords(rule.byMonth.map((m) => MONTHS[m - 1].slice(0, 3)))}`);
  }
  if (rule.byWeekNo.length > 0) {
    parts.push(
      `in week${rule.byWeekNo.length > 1 ? "s" : ""} ${joinWords(rule.byWeekNo.map(String))}`,
    );
  }
  if (rule.byYearDay.length > 0) {
    parts.push(`on the ${joinWords(rule.byYearDay.map(monthDayWord))} day of the year`);
  }

  const days = rule.byDay.map((w) =>
    w.nth === 0
      ? WEEKDAYS[w.day].slice(0, 3)
      : `${positionWord(w.nth)} ${WEEKDAYS[w.day].slice(0, 3)}`,
  );
  const dates = rule.byMonthDay.map(monthDayWord);

  // BYSETPOS is an adjective on the days the rule just produced — "the last of
  // Mon, Tue, Wed, Thu and Fri" — never a clause bolted on after them.
  if (rule.bySetPos.length > 0 && days.length + dates.length > 0) {
    const pick = joinWords(rule.bySetPos.map(positionWord));
    parts.push(`on the ${pick} of ${joinWords([...dates, ...days])}`);
  } else {
    if (dates.length > 0) parts.push(`on the ${joinWords(dates)}`);
    if (days.length > 0) parts.push(`on ${joinWords(days)}`);
    if (rule.bySetPos.length > 0) {
      parts.push(`keeping the ${joinWords(rule.bySetPos.map(positionWord))}`);
    }
  }

  if (rule.byHour.length > 0 || rule.byMinute.length > 0 || rule.bySecond.length > 0) {
    parts.push("at set times");
  }
  if (rule.until > 0) {
    const until = new Date(rule.until);
    parts.push(
      `until ${until.getDate()} ${MONTHS[until.getMonth()].slice(0, 3)} ${until.getFullYear()}`,
    );
  }
  return parts.join(" ");
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

  function save(scope: EditScope) {
    onSave({ ...draft, title: draft.title.trim() || "New event" }, scope);
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
  }, [draft, target.id, readOnly, pending, scoped, onClose, onDelete]);

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
    if (next < draft.start + MIN_DURATION_MIN * 60_000) return;
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
    if (next.getTime() < draft.start + MIN_DURATION_MIN * 60_000) next = addDays(next, 1);
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
      if (end.getTime() < start + MIN_DURATION_MIN * 60_000) end = addDays(end, 1);
      patch({ allDay: false, start, end: end.getTime() });
    }
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
          aria-label={readOnly ? "Event" : target.id ? "Edit event" : "New event"}
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
              placeholder="New event"
              aria-label="Event title"
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
                <span className="text-ink-3">–</span>
                <DayField label="Last day" value={lastDay} onChange={handleEndDateChange} />
              </Row>

              <Row label="Time" disabled={draft.allDay}>
                <ClockIcon size={14} className="shrink-0 text-ink-2" />
                <TimeField
                  label="Start time"
                  clock={clock}
                  value={new Date(draft.start)}
                  disabled={draft.allDay}
                  onCommit={handleStartTime}
                />
                <span className="text-ink-3">–</span>
                <TimeField
                  label="End time"
                  clock={clock}
                  value={new Date(draft.end)}
                  disabled={draft.allDay}
                  onCommit={handleEndTime}
                />
              </Row>

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
                <span
                  aria-hidden
                  className="size-[9px] shrink-0 rounded-full"
                  style={{ backgroundColor: calendar?.color ?? PALETTE[0] }}
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

              <Row label="All-day">
                <Switch checked={draft.allDay} onChange={handleAllDayToggle} label="All-day" />
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
            <div className="border-t border-hairline px-3.5 py-3">
              <span className="label text-ink-3">
                {pending === "save" ? "Save this change to" : "Delete"}
              </span>
              <div className="mt-2 flex flex-col gap-1">
                {SCOPES.map(({ scope, label }, i) => (
                  <button
                    key={scope}
                    autoFocus={i === 0}
                    type="button"
                    onClick={() => (pending === "save" ? save(scope) : onDelete(scope))}
                    className={cn(
                      "flex h-9 items-center rounded-[9px] border border-hairline bg-surface-2 px-3 text-left text-[14px] transition-colors hover:bg-white/10",
                      pending === "delete" ? "text-danger" : "text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="mt-2.5 flex items-center gap-1.5 px-1 text-[14px] text-ink-2 transition-colors hover:text-ink"
              >
                Cancel
                <Kbd>esc</Kbd>
              </button>
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
                      <Kbd>⌘</Kbd>
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
                      <Kbd>⌘</Kbd>
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
