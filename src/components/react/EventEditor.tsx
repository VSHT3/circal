/* ------------------------------------------------------------------ *
 * The event editor — a modal card holding one local draft. Nothing is
 * written back to the store until Save; Cancel/Escape just discards it.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Calendar as CalendarIcon, Clock as ClockIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  NEVER,
  PALETTE,
  REPEATS,
  REPEAT_LABELS,
  repeatUnit,
  type CalEvent,
  type Repeat,
} from "@/lib/events";
import {
  WEEKDAYS,
  addDays,
  atMinutes,
  dayKey,
  formatRelativeDay,
  formatTime,
  fromDayKey,
  minutesOfDay,
  parseClock,
  startOfDay,
  type Clock,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  DateField,
  FieldRow as Row,
  Kbd,
  NumberField,
  Select,
  Switch,
  openDatePicker,
} from "@/components/react/ui/primitives";
import type { EventEditorProps } from "@/components/react/types";

const MIN_DURATION_MIN = 5;
const DAY_MS = 86_400_000;

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

export default function EventEditor({
  target,
  clock,
  calendars,
  onSave,
  onDelete,
  onClose,
}: EventEditorProps) {
  const [draft, setDraft] = useState<Omit<CalEvent, "id">>(target.draft);
  const reducedMotion = useReducedMotion();
  /** A subscribed feed's event: shown in full, editable in no part. */
  const readOnly = target.readOnly === true;

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

  function patch(next: Partial<Omit<CalEvent, "id">>) {
    setDraft((d) => ({ ...d, ...next }));
  }

  function commit() {
    onSave({ ...draft, title: draft.title.trim() || "New event" });
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (readOnly) {
        return;
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (mod && e.key === "Backspace" && target.id) {
        e.preventDefault();
        onDelete();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, target.id, readOnly, onClose, onDelete]);

  const calendar = calendars.find((c) => c.id === draft.calendarId);

  function handleDateChange(value: string) {
    if (!value) return;
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return;
    const picked = startOfDay(new Date(y, m - 1, d));
    const deltaDays = Math.round(
      (picked.getTime() - startOfDay(new Date(draft.start)).getTime()) / DAY_MS,
    );
    if (deltaDays === 0) return;
    patch({
      start: addDays(new Date(draft.start), deltaDays).getTime(),
      end: addDays(new Date(draft.end), deltaDays).getTime(),
    });
  }

  function handleStartTime(minutes: number) {
    const next = atMinutes(new Date(draft.start), minutes).getTime();
    patch({ start: next, end: next + (draft.end - draft.start) });
  }

  function handleEndTime(minutes: number) {
    // The end is anchored to the *start's* day, then rolled forward if that
    // would put it before the start — that is how 11 PM → 1 AM stays one event.
    let next = atMinutes(new Date(draft.start), minutes);
    if (next.getTime() < draft.start + MIN_DURATION_MIN * 60_000) next = addDays(next, 1);
    patch({ end: next.getTime() });
  }

  function handleAllDayToggle(next: boolean) {
    const day = startOfDay(new Date(draft.start));
    if (next) {
      patch({ allDay: true, start: day.getTime(), end: addDays(day, 1).getTime() });
    } else {
      patch({
        allDay: false,
        start: atMinutes(day, 9 * 60).getTime(),
        end: atMinutes(day, 10 * 60).getTime(),
      });
    }
  }

  /* ------------------------------ recurrence ------------------------------ */

  const seed = new Date(draft.start);
  const repeating = draft.repeat !== "never";
  /** Empty `byDay` means "the seed's own weekday" — the chips show that. */
  const activeDays = draft.byDay.length > 0 ? draft.byDay : [seed.getDay()];

  function handleRepeatChange(repeat: Repeat) {
    // A weekday list belongs to the frequency that named it: carried across,
    // a weekly BYDAY becomes a monthly position nobody chose. The bound and
    // the interval survive, because they are about the same series either way.
    patch(repeat === "never" ? { ...NEVER } : { repeat, byDay: [], nth: 0 });
  }

  function toggleWeekday(day: number) {
    const next = activeDays.includes(day)
      ? activeDays.filter((d) => d !== day)
      : [...activeDays, day].sort((a, b) => a - b);
    // A weekly rule with no weekday is not a rule; the last one cannot be
    // taken off, which is also why there is no error to show.
    if (next.length > 0) patch({ byDay: next });
  }

  function handleMonthlyMode(value: string) {
    const nth = Number(value);
    patch(nth === 0 ? { nth: 0, byDay: [] } : { nth, byDay: [seed.getDay()] });
  }

  function handleEndsChange(value: string) {
    // A year out: long enough to be a real bound, short enough that nobody
    // picked it by accident and forgot.
    patch({ until: value === "never" ? 0 : endOfDay(addDays(seed, 365)) });
  }

  /** The three monthly shapes, plus whatever a subscription actually sent. */
  const monthlyModes = [0, Math.floor((seed.getDate() - 1) / 7) + 1, -1, draft.nth]
    .filter((nth, i, all) => all.indexOf(nth) === i)
    .map((nth) => ({
      value: String(nth),
      label: nth === 0 ? `Day ${seed.getDate()}` : nthLabel(nth, draft.byDay[0] ?? seed.getDay()),
    }));

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
              <Row label="Date">
                <CalendarIcon size={14} className="shrink-0 text-ink-2" />
                <span>{formatRelativeDay(new Date(draft.start))}</span>
                <input
                  type="date"
                  aria-label="Date"
                  value={dayKey(new Date(draft.start))}
                  onChange={(e) => handleDateChange(e.target.value)}
                  onClick={(e) => openDatePicker(e.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    openDatePicker(e.currentTarget);
                  }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
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
                      value={String(draft.nth)}
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
                        onChange={(next) => next && patch({ until: endOfDay(fromDayKey(next)) })}
                        label="Repeat until"
                        min={dayKey(seed)}
                      />
                    )}
                  </span>
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

          {/* footer */}
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
                    onClick={onDelete}
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
                    onClick={commit}
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
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
