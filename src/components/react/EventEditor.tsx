/* ------------------------------------------------------------------ *
 * The event editor — a modal card holding one local draft. Nothing is
 * written back to the store until Save; Cancel/Escape just discards it.
 * ------------------------------------------------------------------ */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Calendar as CalendarIcon, Clock as ClockIcon, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  NEVER,
  PALETTE,
  PARTSTAT_LABELS,
  REMIND_INHERIT,
  REMIND_SILENT,
  ownLead,
  colorOf,
  REPEATS,
  REPEAT_LABELS,
  repeatUnit,
  repeats,
  type CalEvent,
  type Repeat,
} from "@/lib/events";
import { describeRule, isExpressible, nthLabel } from "@/lib/describe";
import { MIN_DURATION } from "@/lib/quickadd";
import { REMIND_LEADS, leadOf, remindLabel } from "@/lib/remind";
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
  Segmented,
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
    <span className="relative inline-flex min-w-0 rounded-[6px] px-1 py-0.5 transition-colors focus-within:bg-(--veil-08) hover:bg-(--veil-06)">
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

/**
 * The chips a verb's shortcut is advertised with, and the one thing in the
 * footer that goes when the card is a single column.
 *
 * Four verbs, two of them carrying two chips each, measure about 397px against
 * the 306px a 330px card leaves — which is what wrapped "Share link" onto two
 * lines and clipped Save's own chips off the right edge. Something had to go,
 * and the chips are the honest choice: ⌘↵ and ⌘⌫ still work, all four verbs
 * keep their words, and a card that narrow is most often on a phone, where a
 * chip advertises a key the reader does not have. Hidden rather than dropped,
 * so this is one footer that is wider on a desktop and not two footers.
 */
function Chord({ keys }: { keys: string[] }) {
  return (
    <span className="hidden items-center gap-1.5 md:flex">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
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

/**
 * How many guests are shown before the list starts scrolling. Five rows is
 * about a hundred pixels inside a card whose whole body is already bounded by
 * `86vh` — enough that most invitations show whole, and short enough that a
 * forty-person meeting cannot walk the Save button off the bottom of the
 * screen. The fade is applied only past this count, because a fade over a list
 * that already fits dims its own last row and reads as a rendering fault.
 */
const GUEST_ROWS = 5;

/** One row's height: 14px of text on this card's own leading plus the `gap-1`
 *  under it. Multiplied rather than written as a `max-h-[105px]` class so the
 *  height and the fade's threshold cannot come to disagree about where the
 *  list stops. */
const GUEST_ROW_H = 21;

/**
 * Who asked, and who is coming — the read half of an invitation, and nothing
 * else.
 *
 * Display only, on purpose and permanently. Accepting or declining is a
 * message, and circal has no channel that could carry one to an organiser —
 * no mail, no CalDAV, and the cloud copy is a sealed box, not a relay — so
 * there is no verb here, no button, and no control to add a guest: an empty
 * guest-list editor on an event you wrote yourself would be a promise the app
 * cannot keep. It renders only when a file actually named somebody, which is
 * why nothing above it has to reason about an empty state.
 *
 * A `<ul>` because that is what it is, and because a list of names read out as
 * a list is the one accessible affordance this block can honestly offer.
 *
 * The organiser sits outside the scrolling list rather than at the top of it:
 * it is the one name that answers "who is asking", so it must not be the row
 * that scrolls away. It is told apart by a `.label` tag beside it and by
 * keeping full `ink` where the guests are `ink-2` — greyscale both, since
 * colour on this face belongs to events.
 *
 * The count is the honest half. `attendeeCount` is what the file named, so the
 * remainder printed here is measured against the invitation rather than against
 * the truncated list that survived the cap.
 */
function Guests({
  organizer,
  attendees,
  attendeeCount,
}: Pick<CalEvent, "organizer" | "attendees" | "attendeeCount">) {
  if (!organizer && attendees.length === 0) return null;
  const hidden = Math.max(attendeeCount - attendees.length, 0);
  return (
    <Row label="Guests" align="top">
      {organizer && (
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          {/* The name when there is one, the mailbox when there is not — never
              both, because a 320px column has room for one of them and the
              name is the answer to "who". The address stays reachable as the
              row's own title, since it is the only copy of it on screen. */}
          <span className="truncate" title={organizer.address}>
            {organizer.name || organizer.address}
          </span>
          <span className="label shrink-0 text-ink-3">Organiser</span>
        </span>
      )}
      {attendees.length > 0 && (
        <ul
          className={cn(
            "no-scrollbar flex min-w-0 flex-col gap-1 overflow-y-auto",
            attendees.length > GUEST_ROWS && "fade-y",
          )}
          style={{ maxHeight: `${GUEST_ROWS * GUEST_ROW_H}px` }}
        >
          {attendees.map((guest) => (
            <li key={guest.address} className="flex items-baseline justify-between gap-2">
              <span className="truncate text-ink-2" title={guest.address}>
                {guest.name || guest.address}
              </span>
              {/* A tag, so `.label`: three words of vocabulary at a label's
                  weight, not a sentence. It says what they answered and
                  nothing about what you could answer. */}
              <span className="label shrink-0 text-ink-3">{PARTSTAT_LABELS[guest.status]}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <span className="caption tabular-nums">
          and {hidden} {hidden === 1 ? "other" : "others"}
        </span>
      )}
    </Row>
  );
}

export default function EventEditor({
  target,
  settings,
  calendars,
  onSave,
  onDelete,
  onShare,
  onClose,
  onDraftChange,
}: EventEditorProps) {
  // Destructured on the body's first line, so every reader below reads
  // exactly as it did when these arrived as props of their own.
  const { clock, remind, remindLead } = settings;
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

  /**
   * The draft as it would be written. A blank title becomes the same word
   * Save gives it, so the link and the event a receiver ends up with cannot
   * be called two different things.
   */
  function named(): Omit<CalEvent, "id"> {
    return { ...draft, title: draft.title.trim() || "New event" };
  }

  function save(scope: EditScope) {
    onSave(named(), scope);
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

  /* ------------------------------- reminder ------------------------------- */

  /**
   * Inherit, the offered leads, and never — plus this event's own lead when
   * it is not one this app offers, which is how a `VALARM` of seven minutes
   * from another calendar stays visible and editable instead of vanishing
   * out of a `Select` that has no option for it. `ownLead` is asked rather
   * than the number compared, because which of the three states an event is
   * in is a question with exactly one answerer.
   */
  const own = ownLead(draft);
  /**
   * What inheriting would actually do, now that the chain runs event →
   * calendar → setting: `leadOf` is asked with the event's own answer
   * withheld, so this option's caption and the reminder that fires cannot
   * disagree. The word names the level that answers — a calendar with an
   * opinion is "Follow calendar" — and the caption stays honest about the
   * two ways nothing fires: "off" when reminders are switched off at all,
   * "never" when the calendar itself asked for silence.
   */
  const inherited = leadOf(
    { remindLead: REMIND_INHERIT, calendarId: draft.calendarId },
    calendars,
    remindLead,
  );
  const viaCalendar = calendar !== undefined && calendar.remindLead !== REMIND_INHERIT;
  const remindOptions = [
    {
      value: String(REMIND_INHERIT),
      label: `${viaCalendar ? "Follow calendar" : "Follow settings"} · ${
        !remind ? "off" : inherited === null ? "never" : remindLabel(inherited)
      }`,
    },
    ...REMIND_LEADS.map((minutes) => ({ value: String(minutes), label: remindLabel(minutes) })),
    ...(own !== null && !REMIND_LEADS.includes(own)
      ? [{ value: String(own), label: remindLabel(own) }]
      : []),
    { value: String(REMIND_SILENT), label: "Never" },
  ];

  /* --------------------------------- share -------------------------------- */

  /**
   * The event as a link, on the clipboard.
   *
   * It is a verb about one event, so it belongs on the surface where exactly
   * one event is the subject — this footer, beside the other two verbs that
   * act on the whole thing. The palette was the other candidate and its slot
   * is taken: a row can only carry one `alt`, and that one is `Duplicate`, so
   * sharing would have had to become a row of its own, which either doubles
   * the result list or guesses which match it meant. The dial was the third,
   * and a keystroke that silently puts a link to your calendar on the
   * clipboard is not a keystroke this app should have.
   *
   * Only for an event that exists: a draft nobody has saved has no meaning to
   * hand to somebody else. Present on a read-only target too, because sharing
   * is copying rather than editing — a subscription's event is somebody
   * else's data, but the link is a copy of what is already on this screen.
   *
   * There is no keyboard shortcut on purpose. ⌘↵ and ⌘⌫ are here because they
   * are the two presses a form is expected to answer; a third would be a
   * chord to remember for something you do once a week.
   */
  const shareRow = target.id ? (
    <button
      type="button"
      onClick={() => onShare(named())}
      // Icon only in a single column, where the words are the difference
      // between a footer that fits and one that wraps. The label is the same
      // string either way, so the button says the same thing to a screen
      // reader at both widths.
      aria-label="Share link"
      className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] whitespace-nowrap text-ink-2 transition-colors hover:bg-(--veil-06) hover:text-ink"
    >
      <Link2 size={14} strokeWidth={1.75} />
      <span className="hidden md:inline">Share link</span>
    </button>
  ) : null;

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
          aria-label={readOnly ? "Event" : `${target.id ? "Edit" : "New"} event`}
          className="relative flex max-h-[86vh] w-[330px] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)] md:w-[672px]"
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
              components deep, which no prop-threading would reach.

              The scroll container is a plain `div` *around* it, and that is a
              browser fact rather than a preference: a `<fieldset>` lays its
              children out in an anonymous box that sizes to content and
              ignores the height flexbox handed the fieldset, so a fieldset
              asked to be the scroll parent silently is not one. Measured at
              390×844, where the notes band ran a hundred pixels past the card
              and the footer painted over it. Height is constrained on a real
              box; the fieldset sits inside as a block, only ever as tall as
              what it holds. */}
          <div className="no-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto">
            <fieldset disabled={readOnly} className={cn("min-w-0", readOnly && "opacity-75")}>
              {/* Two columns on anything wider than a phone, along a seam the
                card already had: the event itself — when it is, where, who,
                how it behaves in time — and then how it is filed and
                described. Stacked at 330px it is exactly the card it was, in
                exactly the order it was.

                Width is what earned it, twice over. Thirteen rows in one 330px
                column scrolls on every laptop, so the fields were behind a
                fold on the one surface whose whole point is seeing the draft
                while you edit it; and the footer's four verbs never fitted
                across 306px either. Two columns of 335 answers both and keeps
                every inline row above the 320px floor those rows are written
                to wrap at.

                Both halves scroll as one, which is the point of the container
                being outside them: two independently scrolling halves of one
                form is two scrollbars and a Save button that can be in two
                places. */}
              <div className="md:grid md:grid-cols-2">
                {/* The event itself. `URL` sits under `Where` because the two are
                  one question — a room or a link — and it is where a join link
                  was always going to be looked for.

                  `[&>*:last-child]:border-b-0`, on both columns, drops the
                  hairline a run of rows would otherwise leave hanging: under
                  the notes band in two columns, and under the next column's
                  own top border in one. */}
                <div className="min-w-0 [&>*:last-child]:border-b-0">
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

                  <Row label="URL">
                    <input
                      type="url"
                      value={draft.url}
                      onChange={(e) => patch({ url: e.target.value })}
                      placeholder="Add URL"
                      aria-label="URL"
                      className="w-full min-w-0 border-none bg-transparent text-ink outline-none placeholder:text-ink-3"
                    />
                  </Row>

                  {/* Where, then the link, then who — and then every control,
                  uninterrupted. This block is the one thing in the card that
                  cannot be edited, so it sits at the end of the run of facts
                  (day, time, zone, place, link) rather than among the pickers
                  beside it, where a row that does nothing when pressed would
                  read as one that is broken. It is absent entirely on
                  everything the user wrote, since nothing here mints a guest
                  list. */}
                  <Guests
                    organizer={draft.organizer}
                    attendees={draft.attendees}
                    attendeeCount={draft.attendeeCount}
                  />

                  {/* One row, one switch. `Toggle` rather than `Switch`: the
                  row's label is "Type" and the switch needs its own word. */}
                  <Row label="Type" align="top">
                    <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Toggle
                        label="All-day"
                        checked={draft.allDay}
                        onChange={handleAllDayToggle}
                      />
                    </span>
                  </Row>

                  {/* Two states, so a `Segmented` and not a switch: "Busy" and
                  "Free" are both answers a user can mean, where a switch has
                  one word and an off position that has to be guessed at.

                  Wraps like every other inline row: a 320px column is the
                  narrowest this card is read in. */}
                  <Row label="Shows as">
                    <span className="flex flex-wrap items-center gap-2">
                      <Segmented
                        value={draft.free ? "free" : "busy"}
                        onChange={(next) => patch({ free: next === "free" })}
                        options={[
                          { id: "busy", label: "Busy" },
                          { id: "free", label: "Free" },
                        ]}
                      />
                    </span>
                  </Row>

                  {/* One row, three states, and the default one reads as
                  inheritance rather than as a number — somebody who changes
                  the global lead later should not find events quietly holding
                  the old one, and a row printing "10m before" as its default
                  is exactly that trap. The current setting rides along after
                  the word, so with reminders switched off the inherited option
                  reads `Follow settings · off` and the row states the fact
                  itself. That is where it belongs: the paragraph that used to
                  sit under the control said what one option already said, and
                  three lines of prose in a column this narrow is the loudest
                  thing in the card for the least it could be telling you.

                  Shown while reminders are switched off. Hiding it is the
                  tidier answer and the wrong one: an imported event's own
                  alarm is data this row is the only view of, and a field that
                  becomes invisible when a preference is off is a field the
                  user cannot find out they have.

                  Not on an all-day event: `dueReminders` never fires one —
                  there is no minute to count down to — so a lead here would
                  be a control with no effect. Whatever an import put on the draft is
                  left alone rather than reset; it is the sender's statement,
                  and it travels back out. */}
                  {!draft.allDay && (
                    <Row label="Remind">
                      <Select
                        value={String(draft.remindLead)}
                        onChange={(next) => patch({ remindLead: Number(next) })}
                        options={remindOptions}
                        label="How much warning"
                      />
                    </Row>
                  )}

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
                            <span className="label text-ink-2">Every</span>
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
                            <span className="label text-ink-2">On</span>
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
                            <span className="label text-ink-2">Ends</span>
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
                </div>

                {/* Which calendar it is filed under, and what it looks like on
                  the face. `colorOf` and `markOf` are already one family of
                  answers about the same event and the calendar is what they
                  both inherit from, so the three of them are the column. */}
                <div className="min-w-0 border-t border-hairline md:flex md:flex-col md:border-t-0 md:border-l [&>*:last-child]:border-b-0">
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
                  <Row label="Mark" fill>
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
                </div>
              </div>
              {/* Notes span both columns, and are the one thing in the card that
                gains by it: prose in a 335px column wraps every five words, and
                a paragraph is the only field here that is read rather than
                scanned. It is also what balances the two, since a textarea on
                one side is 130px the other side has nothing to answer with. */}
              <div className="border-t border-hairline px-3.5 py-3">
                <span className="label text-ink-2">Notes</span>
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
          </div>

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
                  <span className="label min-w-0 truncate text-ink-4">
                    {calendar?.name ?? "Subscription"} · read only
                  </span>
                  {shareRow}
                  <button
                    autoFocus
                    type="button"
                    onClick={onClose}
                    className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-(--veil-10)"
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
                      className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-2 py-1 text-[14px] text-danger transition-colors hover:bg-(--veil-06)"
                    >
                      Delete
                      <Chord keys={[MOD, "⌫"]} />
                    </button>
                  )}
                  {shareRow}
                  <div className="ml-auto flex shrink-0 items-center gap-3">
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
                      className="flex h-8 items-center gap-1.5 rounded-[9px] border border-hairline bg-surface-2 px-3 text-[14px] text-ink transition-colors hover:bg-(--veil-10)"
                    >
                      Save
                      <Chord keys={[MOD, "↵"]} />
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
