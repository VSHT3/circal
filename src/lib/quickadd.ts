/* ------------------------------------------------------------------ *
 * One typed line → one event.
 *
 * The palette's parsers used to live inside `CommandPalette.tsx`, one per
 * question it could answer: a whole query is a date (jump), or a whole query
 * is a duration (find free time). Quick-add asks a third question — *this
 * sentence is an event* — and a sentence is not one of those forms, it is
 * several of them with a name in front.
 *
 * So they live here, whole-phrase matchers as before, plus a scanner that
 * peels them off the end of a sentence: `parseQuickAdd` reads right to left,
 * because the title is the only free-text field and it is always the prefix.
 * Anything a matcher claims is not the title; whatever is left is.
 *
 * Pure, and local-time throughout — the only date it ever builds is one the
 * user is looking at.
 * ------------------------------------------------------------------ */

import {
  MINUTES_PER_DAY,
  MONTHS,
  WEEKDAYS,
  addDays,
  daysInMonth,
  isSameDay,
  minutesOfDay,
  parseClock,
  snap,
  startOfDay,
} from "@/lib/time";

const WEEKDAYS_LOWER = WEEKDAYS.map((w) => w.toLowerCase());
const MONTHS_LOWER = MONTHS.map((m) => m.toLowerCase());

/** What a bare "free" means. */
const DEFAULT_SLOT = 30;

/**
 * An event that names a start and nothing else. The same hour `ics.ts` gives a
 * VEVENT with no DTEND, and the same hour ⌘N opens with — one default, or two
 * ways of adding an event disagree about what an event is.
 */
export const DEFAULT_DURATION = 60;

/** The longest a date phrase gets: `in 3 days`. */
const DATE_WORDS = 3;

/**
 * A preposition left dangling by the token it introduced — `lunch at 1pm`,
 * `run for 40m`. Only ever stripped from the very end of what is left, so a
 * title that happens to contain one keeps it. `to` is deliberately absent: it
 * appears in titles far more often than in times ("go to gym"), which is why a
 * range is written with a dash.
 */
const FILLER = new Set(["at", "on", "from", "for", "@"]);

/**
 * Resolves free-text into a date, relative to `reference` (the day the
 * palette was opened on). Order matters: literal words first, then
 * unambiguous structured formats, then the loosest one (a bare number).
 */
export function parseDate(raw: string, reference: Date): Date | null {
  const query = raw.trim().toLowerCase();
  if (!query) return null;

  const base = startOfDay(reference);

  if (query === "today") return base;
  if (query === "tomorrow") return addDays(base, 1);
  if (query === "yesterday") return addDays(base, -1);

  const weekdayIndex = WEEKDAYS_LOWER.findIndex((w) => w === query || w.slice(0, 3) === query);
  if (weekdayIndex !== -1) {
    const delta = (weekdayIndex - base.getDay() + 7) % 7 || 7;
    return addDays(base, delta);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const dom = Number(iso[3]);
    if (month >= 0 && month < 12 && dom >= 1 && dom <= daysInMonth(year, month)) {
      return new Date(year, month, dom);
    }
    return null;
  }

  const resolveMonthDay = (monthStr: string, domStr: string): Date | null => {
    const monthIndex = MONTHS_LOWER.findIndex((m) => m === monthStr || m.slice(0, 3) === monthStr);
    const dom = Number(domStr);
    if (monthIndex === -1 || dom < 1 || dom > daysInMonth(reference.getFullYear(), monthIndex))
      return null;
    const year = reference.getFullYear();
    const candidate = new Date(year, monthIndex, dom);
    return candidate.getTime() < base.getTime() ? new Date(year + 1, monthIndex, dom) : candidate;
  };

  const monthDay = /^([a-z]+)\s+(\d{1,2})$/.exec(query);
  if (monthDay) {
    const resolved = resolveMonthDay(monthDay[1], monthDay[2]);
    if (resolved) return resolved;
  }

  const dayMonth = /^(\d{1,2})\s+([a-z]+)$/.exec(query);
  if (dayMonth) {
    const resolved = resolveMonthDay(dayMonth[2], dayMonth[1]);
    if (resolved) return resolved;
  }

  const relative = /^([+-])(\d+)$/.exec(query);
  if (relative) {
    return addDays(base, Number(relative[2]) * (relative[1] === "-" ? -1 : 1));
  }

  const inDays = /^in\s+(\d+)\s+days?$/.exec(query);
  if (inDays) return addDays(base, Number(inDays[1]));

  const bareDay = /^(\d{1,2})$/.exec(query);
  if (bareDay) {
    const dom = Number(bareDay[1]);
    if (dom < 1 || dom > 31) return null;
    let year = reference.getFullYear();
    let month = reference.getMonth();
    if (dom > daysInMonth(year, month)) return null;
    let candidate = new Date(year, month, dom);
    if (candidate.getTime() < base.getTime()) {
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      if (dom > daysInMonth(year, month)) return null;
      candidate = new Date(year, month, dom);
    }
    return candidate;
  }

  return null;
}

/** A length of time, unit required: `45m`, `1h`, `1h30`, `2h 15m`, `90min`. */
export function parseDurationToken(raw: string): number | null {
  const query = raw.trim().toLowerCase();
  if (!query) return null;

  const hours = /^(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(?:m|min|mins)?$/.exec(query);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);

  const minutes = /^(\d{1,3})\s*(?:m|min|mins|minute|minutes)$/.exec(query);
  if (minutes) return Number(minutes[1]);

  return null;
}

/**
 * A slot for the free-time search. Looser than `parseDurationToken` at one end
 * and stricter at the other: it takes the word `free` on its own, and it is
 * the only form in which a bare number means minutes — everywhere else a bare
 * number is a day of the month or an hour.
 */
export function parseSlot(raw: string): number | null {
  const query = raw.trim().toLowerCase();
  if (!query) return null;
  if (query === "free") return DEFAULT_SLOT;

  const bare = /^free\s+(\d{1,3})$/.exec(query);
  if (bare) return Number(bare[1]);

  return parseDurationToken(query.replace(/^free\s*/, ""));
}

/** A start, and an end when the phrase named one. */
interface Span {
  startMin: number;
  /** `null` when only an instant was given — the caller decides how long. */
  endMin: number | null;
}

/**
 * `9`, `1pm`, `13:15`, `1045`, or a range of two of those joined by a dash.
 * Times without a meridiem read on the twenty-four hour clock, exactly as
 * `parseClock` does in the editor: one parser, one meaning, whatever the face
 * happens to be called.
 */
function parseSpan(token: string): Span | null {
  const range = /^(.+?)[-–—](.+)$/.exec(token);
  if (range) {
    const from = parseClock(range[1]);
    const to = parseClock(range[2]);
    if (from === null || to === null) return null;
    // `22:00-01:00` is a night, not a mistake: an end at or before the start is
    // tomorrow's, and a span past 1440 is exactly how the dial already draws
    // an event through midnight.
    return { startMin: from, endMin: to > from ? to : to + MINUTES_PER_DAY };
  }

  const at = parseClock(token);
  return at === null ? null : { startMin: at, endMin: null };
}

/**
 * The hour a draft opens on when nothing said one: the next quarter hour on
 * today, a plausible working hour on any other day — a draft that opens at
 * 00:00 is never right. Pulled back so the span still ends inside the day.
 *
 * It lives beside the parser rather than in the shell because quick-add has to
 * *print* the hour it is about to use, before you press Enter; ⌘N and the
 * palette must therefore agree on it, and there is one copy to agree with.
 */
export function defaultStart(on: Date, durationMin: number, now = new Date()): number {
  const start = isSameDay(on, now) ? snap(minutesOfDay(now) + 7.5, 15) : 9 * 60;
  return Math.min(start, Math.max(0, MINUTES_PER_DAY - durationMin));
}

/** An event, as a sentence resolved it. Minutes since local midnight of `day`. */
export interface QuickAdd {
  title: string;
  /** Local midnight of the day it lands on. */
  day: Date;
  startMin: number;
  /** May run past `MINUTES_PER_DAY` — an event through midnight ends tomorrow. */
  endMin: number;
  /** The rule `draftEvent` will apply, resolved early so the row can say so. */
  allDay: boolean;
}

/**
 * `lunch tomorrow 1pm 45m` → an event. `null` when the line is not one.
 *
 * Two rules earn their keep here:
 *
 * - **Something other than a title must be named.** A bare word is a search,
 *   and the palette already answers that; offering to create an event from
 *   every keystroke would put a row under every query in the app.
 * - **Nothing is invented.** A day with no time is an all-day event, because
 *   that is what was said. A duration names a length but not a start, and
 *   there `defaultStart` already has the app's answer.
 */
export function parseQuickAdd(input: string, reference: Date, now = new Date()): QuickAdd | null {
  // A hyphen is joined only between two digits, so `13:15 - 14:00` is one
  // token while `one-on-one` and `check - in` are left alone.
  const tokens = input
    .trim()
    .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1-$2")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;

  /** Everything not yet claimed ends at `end`; the title is what is left. */
  let end = tokens.length;
  const phrase = (from: number, to: number) => tokens.slice(from, to).join(" ");

  /**
   * The longest trailing 1…`words` phrase `read` accepts, consumed. Longest
   * first, so `1h 30m` beats `30m` and `12 sep` beats `sep`.
   */
  function claim<T>(words: number, read: (value: string) => T | null): T | null {
    for (let n = Math.min(words, end); n >= 1; n--) {
      const value = read(phrase(end - n, end));
      if (value !== null) {
        end -= n;
        while (end > 0 && FILLER.has(tokens[end - 1].toLowerCase())) end -= 1;
        return value;
      }
    }
    return null;
  }

  let day = startOfDay(reference);
  let dated = false;
  let span: Span | null = null;
  let duration: number | null = null;

  while (end > 0) {
    // Duration before time: `1h30` is ninety minutes, and `130` is half past
    // one — the same digits, and only the unit tells them apart.
    if (duration === null) {
      const value = claim(2, (p) => {
        const minutes = parseDurationToken(p);
        return minutes !== null && minutes > 0 ? minutes : null;
      });
      if (value !== null) {
        duration = value;
        continue;
      }
    }
    if (span === null) {
      const value = claim(2, parseSpan);
      if (value !== null) {
        span = value;
        continue;
      }
    }
    // Date last, so a bare number in a sentence is an hour rather than a day
    // of the month: the title already said what this is, and `14` reads as a
    // time beside it. A day of the month still has `14 sep` and `2026-09-14`.
    if (!dated) {
      const value = claim(DATE_WORDS, (p) => parseDate(p, reference));
      if (value !== null) {
        day = startOfDay(value);
        dated = true;
        continue;
      }
    }
    break;
  }

  const title = phrase(0, end).trim();
  if (!title) return null;
  if (!dated && span === null && duration === null) return null;

  let startMin: number;
  let endMin: number;
  if (span) {
    startMin = span.startMin;
    // A range that named both ends wins over a duration: `1pm-2pm 30m` is an
    // hour with a redundant word in it, not half an hour.
    endMin = span.endMin ?? startMin + (duration ?? DEFAULT_DURATION);
  } else if (duration !== null) {
    startMin = defaultStart(day, duration, now);
    endMin = startMin + duration;
  } else {
    startMin = 0;
    endMin = MINUTES_PER_DAY;
  }

  return { title, day, startMin, endMin, allDay: endMin - startMin >= MINUTES_PER_DAY };
}
