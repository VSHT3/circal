/* ------------------------------------------------------------------ *
 * RFC 5545 recurrence: the rule, and the instants it generates.
 *
 * Split out of `events.ts` because it is the one part of the domain that is
 * somebody else's specification rather than this app's idea. Everything here
 * answers to §3.3.10 (RRULE), §3.8.5.1 (EXDATE) and §3.8.5.2 (RDATE), and the
 * shape of the code follows the shape of the spec — a set generated per
 * period, expanded and limited by the BY* parts, then narrowed by BYSETPOS.
 *
 * Two properties this file is responsible for:
 *
 * 1. **It never invents a date.** A rule this cannot represent is refused at
 *    the parser rather than approximated here, because a meeting on the wrong
 *    day looks exactly like a meeting on the right one.
 * 2. **It is bounded.** A `SECONDLY` rule names 86,400 instants a day and a
 *    hostile feed is a real thing, so every entry point caps what it returns.
 * ------------------------------------------------------------------ */

import { addDays, addMonths, dayKey, daysBetween, daysInMonth, startOfDay } from "./time";

/**
 * Every frequency RFC 5545 defines. The editor offers the five a person
 * actually picks; the sub-daily three arrive only from a subscription, and are
 * expanded rather than dropped, because a feed is precisely the data we do not
 * control.
 */
export const FREQUENCIES = [
  "never",
  "secondly",
  "minutely",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export type Repeat = (typeof FREQUENCIES)[number];

/** The frequencies the editor offers. Nobody schedules their own life by the
 *  second, and a picker that says so is a picker with three dead rows in it. */
export const REPEATS = ["never", "daily", "weekly", "monthly", "yearly"] as const;

/** Bare frequencies, because the row that prints them also prints an interval
 *  beside them: "Every week — every 2 weeks" reads as a fault. */
export const REPEAT_LABELS: Record<Repeat, string> = {
  never: "Never",
  secondly: "Secondly",
  minutely: "Minutely",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

const UNITS: Record<Repeat, string> = {
  never: "",
  secondly: "second",
  minutely: "minute",
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** The unit an `interval` counts, singular at one. */
export function repeatUnit(repeat: Repeat, n: number): string {
  return n === 1 ? UNITS[repeat] : `${UNITS[repeat]}s`;
}

/**
 * One BYDAY entry. `nth` of `0` means every such weekday in the period;
 * `3` is the third from the start and `-1` the last — RFC allows both, and a
 * rule this cannot spell is a meeting that lands on the wrong day.
 */
export interface WeekdayRule {
  /** `0` = Sunday, matching `Date.getDay()`. */
  day: number;
  nth: number;
}

/**
 * A recurrence rule, plus the two properties that edit the set it generates.
 *
 * Every BY* part is a list, empty meaning "not stated" — which is not the same
 * as "none", since an unstated part defers to the seed. The distinction is the
 * whole of §3.3.10's behaviour and collapsing it is how a rule quietly starts
 * meaning something else.
 */
export interface Recurrence {
  repeat: Repeat;
  /** Fire every nth period. `1` = every one, and never less. */
  interval: number;
  /**
   * The last instant an occurrence may *start*, epoch ms, inclusive. `0` =
   * forever. RRULE's COUNT is walked into one of these on the way in: two ways
   * to bound one series is one too many, and they name the same series.
   */
  until: number;
  /** Which weekday a week starts on, for weekly intervals and BYWEEKNO. RFC's
   *  default is Monday, and it is the week the life grid draws too. */
  wkst: number;
  /** 1–12. */
  byMonth: number[];
  /** ±1–53, against `wkst`-aligned weeks. */
  byWeekNo: number[];
  /** ±1–366. */
  byYearDay: number[];
  /** ±1–31. */
  byMonthDay: number[];
  byDay: WeekdayRule[];
  byHour: number[];
  byMinute: number[];
  bySecond: number[];
  /** Which of the period's own occurrences to keep: `-1` is "the last working
   *  day of the month" once BYDAY has produced all five of them. */
  bySetPos: number[];
  /**
   * Days or instants the series skips, as *local* keys — `YYYY-MM-DD` for a
   * whole day, `YYYY-MM-DDTHH:mm:ss` for one instant. Local because every
   * other day-identity in this app is (see `dayKey`), and the two forms are
   * exactly EXDATE's own two value types.
   */
  exdates: string[];
  /** Extra instants bolted onto the series, in the same two forms. */
  rdates: string[];
}

/** An event that happens once. Every construction site spreads this. */
export const NEVER: Recurrence = {
  repeat: "never",
  interval: 1,
  until: 0,
  wkst: 1,
  byMonth: [],
  byWeekNo: [],
  byYearDay: [],
  byMonthDay: [],
  byDay: [],
  byHour: [],
  byMinute: [],
  bySecond: [],
  bySetPos: [],
  exdates: [],
  rdates: [],
};

/** The recurrence fields alone, copied out of anything carrying them — an
 *  importer hands one over whole rather than restating sixteen fields. */
export function recurrenceOf(source: Recurrence): Recurrence {
  return {
    repeat: source.repeat,
    interval: source.interval,
    until: source.until,
    wkst: source.wkst,
    byMonth: [...source.byMonth],
    byWeekNo: [...source.byWeekNo],
    byYearDay: [...source.byYearDay],
    byMonthDay: [...source.byMonthDay],
    byDay: source.byDay.map((d) => ({ ...d })),
    byHour: [...source.byHour],
    byMinute: [...source.byMinute],
    bySecond: [...source.bySecond],
    bySetPos: [...source.bySetPos],
    exdates: [...source.exdates],
    rdates: [...source.rdates],
  };
}

/** Does this rule generate anything beyond its seed? */
export function repeats(rule: Recurrence): boolean {
  return rule.repeat !== "never" || rule.rdates.length > 0;
}

/* ---------------------------------- keys ---------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DDTHH:mm:ss`, local — the identity of one occurrence. */
export function instantKey(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** An EXDATE/RDATE key back to an instant. A bare day resolves against the
 *  seed's time of day, which is what a DATE-valued EXDATE means. */
export function keyToInstant(key: string, seed: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) {
    return new Date(y, mo - 1, d, seed.getHours(), seed.getMinutes(), seed.getSeconds()).getTime();
  }
  return new Date(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/* -------------------------------- calendar -------------------------------- */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/**
 * How many instants any one call may return. A `SECONDLY` rule names 86,400 a
 * day; a dial can say nothing with that, and a feed is not obliged to be
 * reasonable. Truncating is visible in a way that a frozen tab is not.
 */
const MAX_INSTANTS = 512;

/** How many periods a COUNT walk will step before giving up. */
const WALK_CAP = 2000;

const isLeap = (y: number) => new Date(y, 1, 29).getMonth() === 1;
const daysInYear = (y: number) => (isLeap(y) ? 366 : 365);

/** The start of the `wkst`-aligned week containing `d`. */
function weekStart(d: Date, wkst: number): Date {
  const day = startOfDay(d);
  return addDays(day, -((day.getDay() - wkst + 7) % 7));
}

/** `day` of month `m`, or `null` when that month is too short for it. */
function monthDayOf(y: number, m: number, day: number): Date | null {
  const total = daysInMonth(y, m);
  const date = day > 0 ? day : total + 1 + day;
  return date >= 1 && date <= total ? new Date(y, m, date) : null;
}

/**
 * The start of week `n` of `year`. Week 1 is the one holding at least four
 * days of the new year — ISO 8601's rule, generalised to whatever `wkst` says
 * a week starts on. `null` for a week the year does not have.
 */
function weekNoStart(year: number, n: number, wkst: number): Date | null {
  const firstWeek = (y: number) => {
    const jan1 = new Date(y, 0, 1);
    const into = (jan1.getDay() - wkst + 7) % 7;
    // More than three days of this week belong to the old year, so the new
    // year's first week is the next one.
    return addDays(jan1, into > 3 ? 7 - into : -into);
  };
  const start = firstWeek(year);
  const total = Math.round(daysBetween(start, firstWeek(year + 1)) / 7);
  const index = n > 0 ? n : total + 1 + n;
  return index >= 1 && index <= total ? addDays(start, (index - 1) * 7) : null;
}

/** Every date in `[from, to)` whose weekday is `day`. */
function weekdaysIn(from: Date, to: Date, day: number): Date[] {
  const out: Date[] = [];
  let cursor = addDays(from, (day - from.getDay() + 7) % 7);
  while (cursor < to) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** BYDAY resolved inside one span: `nth` counts from its start, or from its
 *  end when negative, and `0` takes every one. */
function byDayWithin(rules: WeekdayRule[], from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (const rule of rules) {
    const all = weekdaysIn(from, to, rule.day);
    if (rule.nth === 0) out.push(...all);
    else {
      const hit = rule.nth > 0 ? all[rule.nth - 1] : all[all.length + rule.nth];
      if (hit) out.push(hit);
    }
  }
  return out;
}

const sortDates = (dates: Date[]) =>
  [...new Map(dates.map((d) => [d.getTime(), d])).values()].sort(
    (a, b) => a.getTime() - b.getTime(),
  );

/* ------------------------------ the BY* cascade ---------------------------- */

/** BYMONTH as a *limit*, which is what it is at every frequency below yearly. */
function inMonths(rule: Recurrence, d: Date): boolean {
  return rule.byMonth.length === 0 || rule.byMonth.includes(d.getMonth() + 1);
}

/** BYMONTHDAY as a limit, honouring negative dates counted from month end. */
function onMonthDays(rule: Recurrence, d: Date): boolean {
  if (rule.byMonthDay.length === 0) return true;
  const total = daysInMonth(d.getFullYear(), d.getMonth());
  return rule.byMonthDay.some((n) => (n > 0 ? n : total + 1 + n) === d.getDate());
}

/** BYDAY as a limit. Ordinals are meaningless in this position (RFC forbids
 *  them below monthly), so only the weekday is read. */
function onWeekdays(rule: Recurrence, d: Date): boolean {
  return rule.byDay.length === 0 || rule.byDay.some((w) => w.day === d.getDay());
}

function onYearDays(rule: Recurrence, d: Date): boolean {
  if (rule.byYearDay.length === 0) return true;
  const len = daysInYear(d.getFullYear());
  const doy = daysBetween(new Date(d.getFullYear(), 0, 1), d) + 1;
  return rule.byYearDay.some((n) => (n > 0 ? n : len + 1 + n) === doy);
}

/**
 * The days one period contributes, before the clock is put on them.
 *
 * This is §3.3.10's expand/limit table, read down the column for `repeat`:
 * a part that expands multiplies the set, one that limits filters it, and one
 * that is absent defers to the seed.
 */
function daysOfPeriod(rule: Recurrence, seed: Date, period: Date): Date[] {
  const y = period.getFullYear();

  if (rule.repeat === "daily") {
    // Everything limits at this frequency; nothing below the day expands here.
    const d = startOfDay(period);
    return inMonths(rule, d) && onMonthDays(rule, d) && onWeekdays(rule, d) ? [d] : [];
  }

  if (rule.repeat === "weekly") {
    const from = weekStart(period, rule.wkst);
    const to = addDays(from, 7);
    const days =
      rule.byDay.length > 0 ? byDayWithin(rule.byDay, from, to) : [seedDayIn(seed, from)];
    return sortDates(days.filter((d) => inMonths(rule, d)));
  }

  if (rule.repeat === "monthly") {
    if (!inMonths(rule, period)) return [];
    const m = period.getMonth();
    const from = new Date(y, m, 1);
    const to = new Date(y, m + 1, 1);

    const fromMonthDay = rule.byMonthDay
      .map((n) => monthDayOf(y, m, n))
      .filter((d): d is Date => d !== null);
    const fromWeekday = rule.byDay.length > 0 ? byDayWithin(rule.byDay, from, to) : [];

    // Both present is an intersection — "the 13th, if it is a Friday".
    if (rule.byMonthDay.length > 0 && rule.byDay.length > 0) {
      const wanted = new Set(fromWeekday.map((d) => d.getTime()));
      return sortDates(fromMonthDay.filter((d) => wanted.has(d.getTime())));
    }
    if (rule.byMonthDay.length > 0) return sortDates(fromMonthDay);
    if (rule.byDay.length > 0) return sortDates(fromWeekday);

    const own = monthDayOf(y, m, seed.getDate());
    return own ? [own] : [];
  }

  return yearlyDays(rule, seed, y);
}

/** The seed's weekday, placed inside the week starting at `from`. */
function seedDayIn(seed: Date, from: Date): Date {
  return addDays(from, (seed.getDay() - from.getDay() + 7) % 7);
}

/**
 * A year's days. Yearly is the only frequency where BYMONTH, BYWEEKNO and
 * BYYEARDAY expand rather than limit, so the branches below are ordered the
 * way RFC orders the parts — coarsest expansion first, and the rest applied
 * to whatever it produced.
 */
function yearlyDays(rule: Recurrence, seed: Date, y: number): Date[] {
  const months = rule.byMonth.length > 0 ? rule.byMonth.map((m) => m - 1) : null;

  // BYYEARDAY names days outright; nothing above it can expand further.
  if (rule.byYearDay.length > 0) {
    const len = daysInYear(y);
    const days = rule.byYearDay
      .map((n) => (n > 0 ? n : len + 1 + n))
      .filter((n) => n >= 1 && n <= len)
      .map((n) => new Date(y, 0, n));
    return sortDates(days.filter((d) => inMonths(rule, d) && onWeekdays(rule, d)));
  }

  // BYWEEKNO takes whole weeks, and BYDAY picks inside them.
  if (rule.byWeekNo.length > 0) {
    const wanted = rule.byDay.length > 0 ? rule.byDay.map((w) => w.day) : [seed.getDay()];
    const days: Date[] = [];
    for (const n of rule.byWeekNo) {
      const from = weekNoStart(y, n, rule.wkst);
      if (!from) continue;
      for (let i = 0; i < 7; i++) {
        const d = addDays(from, i);
        if (wanted.includes(d.getDay())) days.push(d);
      }
    }
    return sortDates(days.filter((d) => inMonths(rule, d)));
  }

  // BYDAY alone counts its ordinals against the whole year: `20MO` is the
  // twentieth Monday of it, not the twentieth of some month.
  if (rule.byDay.length > 0 && rule.byMonthDay.length === 0 && months === null) {
    return sortDates(byDayWithin(rule.byDay, new Date(y, 0, 1), new Date(y + 1, 0, 1)));
  }

  // Anything below the month, inside the months BYMONTH named — or every
  // month, when it named none but something under it expands.
  if (rule.byDay.length > 0 || rule.byMonthDay.length > 0) {
    const list = months ?? [...Array(12).keys()];
    const days: Date[] = [];
    for (const m of list) {
      days.push(
        ...daysOfPeriod({ ...rule, repeat: "monthly", byMonth: [] }, seed, new Date(y, m, 1)),
      );
    }
    return sortDates(days);
  }

  // Nothing under the month: BYMONTH alone, else the seed's own date.
  const list = months ?? [seed.getMonth()];
  return sortDates(list.map((m) => monthDayOf(y, m, seed.getDate())).filter((d): d is Date => !!d));
}

/** The clock the period's days are given. All three expand at every frequency
 *  from daily upwards, and an unstated one is the seed's own. */
function clockOf(rule: Recurrence, seed: Date): { h: number; m: number; s: number }[] {
  const hours = rule.byHour.length > 0 ? rule.byHour : [seed.getHours()];
  const minutes = rule.byMinute.length > 0 ? rule.byMinute : [seed.getMinutes()];
  const seconds = rule.bySecond.length > 0 ? rule.bySecond : [seed.getSeconds()];
  const out: { h: number; m: number; s: number }[] = [];
  for (const h of hours) for (const m of minutes) for (const s of seconds) out.push({ h, m, s });
  return out;
}

/** BYSETPOS: keep only the named positions of the period's own set. */
function applySetPos(rule: Recurrence, instants: number[]): number[] {
  if (rule.bySetPos.length === 0) return instants;
  const picked = rule.bySetPos
    .map((n) => (n > 0 ? instants[n - 1] : instants[instants.length + n]))
    .filter((t): t is number => t !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/* ------------------------------- generation -------------------------------- */

/** Is `period` one the interval actually lands on, counted from the seed's? */
function onInterval(rule: Recurrence, seed: Date, period: Date): boolean {
  const every = Math.max(1, Math.trunc(rule.interval));
  if (every === 1) return true;
  switch (rule.repeat) {
    case "daily":
      return daysBetween(seed, period) % every === 0;
    case "weekly":
      return (
        Math.round(daysBetween(weekStart(seed, rule.wkst), weekStart(period, rule.wkst)) / 7) %
          every ===
        0
      );
    case "monthly":
      return (
        ((period.getFullYear() - seed.getFullYear()) * 12 + period.getMonth() - seed.getMonth()) %
          every ===
        0
      );
    default:
      return (period.getFullYear() - seed.getFullYear()) % every === 0;
  }
}

/** One period's whole set, in order — which is what BYSETPOS needs to exist. */
function periodInstants(rule: Recurrence, seed: Date, period: Date): number[] {
  if (!onInterval(rule, seed, period)) return [];
  const clock = clockOf(rule, seed);
  const out: number[] = [];
  for (const day of daysOfPeriod(rule, seed, period)) {
    for (const { h, m, s } of clock) {
      out.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s).getTime());
    }
  }
  out.sort((a, b) => a - b);
  return applySetPos(rule, out);
}

/**
 * The periods that could put an instant inside `[from, to)`. One period per
 * frequency, plus its predecessor for `weekly`, `monthly` and `yearly` —
 * BYSETPOS aside, a period only ever contributes to days inside itself, but a
 * window that straddles two of them needs both.
 */
function periodsOver(rule: Recurrence, from: number, to: number): Date[] {
  const first = startOfDay(new Date(from));
  const last = startOfDay(new Date(to - 1));
  const out: Date[] = [];
  const seen = new Set<number>();
  const push = (d: Date) => {
    if (!seen.has(d.getTime())) {
      seen.add(d.getTime());
      out.push(d);
    }
  };

  for (let d = first; d <= last; d = addDays(d, 1)) {
    switch (rule.repeat) {
      case "daily":
        push(d);
        break;
      case "weekly":
        push(weekStart(d, rule.wkst));
        break;
      case "monthly":
        push(new Date(d.getFullYear(), d.getMonth(), 1));
        break;
      default:
        push(new Date(d.getFullYear(), 0, 1));
    }
  }
  return out;
}

/** Sub-daily rules are pure arithmetic on the seed instant, so they are
 *  stepped rather than expanded by period — and every BY* part below the
 *  frequency expands while everything above it limits. */
function subDailyInstants(rule: Recurrence, seed: Date, from: number, to: number): number[] {
  const unit =
    rule.repeat === "hourly" ? HOUR_MS : rule.repeat === "minutely" ? MINUTE_MS : SECOND_MS;
  const step = unit * Math.max(1, Math.trunc(rule.interval));
  const seedMs = seed.getTime();
  if (to <= seedMs) return [];

  const out: number[] = [];
  const first = Math.max(0, Math.ceil((from - seedMs) / step));
  for (let k = first; out.length < MAX_INSTANTS; k++) {
    const base = seedMs + k * step;
    if (base >= to) break;
    for (const t of subDailyClock(rule, base)) {
      if (t < from || t >= to) continue;
      const d = new Date(t);
      if (!inMonths(rule, d) || !onYearDays(rule, d)) continue;
      if (!onMonthDays(rule, d) || !onWeekdays(rule, d)) continue;
      if (rule.byHour.length > 0 && !rule.byHour.includes(d.getHours())) continue;
      if (rule.repeat !== "hourly" && rule.byMinute.length > 0) {
        if (!rule.byMinute.includes(d.getMinutes())) continue;
      }
      if (rule.repeat === "secondly" && rule.bySecond.length > 0) {
        if (!rule.bySecond.includes(d.getSeconds())) continue;
      }
      out.push(t);
    }
  }
  return applySetPos(
    rule,
    [...new Set(out)].sort((a, b) => a - b),
  );
}

/** The parts that expand *below* a sub-daily frequency. */
function subDailyClock(rule: Recurrence, base: number): number[] {
  const d = new Date(base);
  const minutes = rule.repeat === "hourly" && rule.byMinute.length > 0 ? rule.byMinute : [null];
  const seconds = rule.repeat !== "secondly" && rule.bySecond.length > 0 ? rule.bySecond : [null];
  const out: number[] = [];
  for (const m of minutes) {
    for (const s of seconds) {
      const at = new Date(d);
      if (m !== null) at.setMinutes(m);
      if (s !== null) at.setSeconds(s);
      out.push(at.getTime());
    }
  }
  return out;
}

/* --------------------------------- the set --------------------------------- */

/** Is this instant excluded, by whole day or by name? */
function excluded(rule: Recurrence, at: number): boolean {
  if (rule.exdates.length === 0) return false;
  const d = new Date(at);
  return rule.exdates.includes(dayKey(d)) || rule.exdates.includes(instantKey(d));
}

/**
 * Every start this rule puts inside `[from, to)`, in order.
 *
 * The seed is an instance only when the rule actually generates it. RFC
 * §3.8.5.3 calls DTSTART the first instance, but it also requires DTSTART to
 * be synchronised with the rule, and the two readings only differ for a rule
 * that contradicts its own seed. This editor can *write* that contradiction —
 * the weekday chips let you deselect the day the event is on — and an event
 * that then refuses to leave that day is a bug the user has no way to fix. A
 * synchronised rule generates its seed anyway, so nothing else changes.
 *
 * RDATE is added whatever the rule says, including when there is no rule at
 * all. EXDATE subtracts last, from everything.
 */
export function startsBetween(
  rule: Recurrence,
  seedMs: number,
  from: number,
  to: number,
): number[] {
  const seed = new Date(seedMs);
  const found = new Set<number>();

  if (rule.repeat === "never" && seedMs >= from && seedMs < to) found.add(seedMs);

  for (const key of rule.rdates) {
    const at = keyToInstant(key, seed);
    if (at !== null && at >= from && at < to) found.add(at);
  }

  if (rule.repeat !== "never") {
    const generated =
      rule.repeat === "hourly" || rule.repeat === "minutely" || rule.repeat === "secondly"
        ? subDailyInstants(rule, seed, from, to)
        : periodsOver(rule, from, to).flatMap((p) => periodInstants(rule, seed, p));

    for (const at of generated) {
      // UNTIL bounds the generated set only: an RDATE past it was named
      // explicitly and is not the rule running on.
      if (at < seedMs || at < from || at >= to) continue;
      if (rule.until > 0 && at > rule.until) continue;
      found.add(at);
    }
  }

  return [...found]
    .filter((at) => !excluded(rule, at))
    .sort((a, b) => a - b)
    .slice(0, MAX_INSTANTS);
}

/**
 * Where an RRULE `COUNT` lands, as the `until` this model stores instead.
 *
 * Counting is by the *rule*, before EXDATE: RFC subtracts exceptions from the
 * generated set, so an excluded day still spends one of the count. Walks
 * period by period rather than day by day — a yearly rule would otherwise cost
 * three hundred and sixty-five probes per instance.
 *
 * `null` for a count this refuses to walk, which the caller reads as
 * unbounded. Over-running a bound shows occurrences that should have stopped;
 * guessing one too early deletes them, and only the second loses data.
 */
export function countedUntil(rule: Recurrence, seedMs: number, count: number): number | null {
  if (rule.repeat === "never" || count < 1 || count > WALK_CAP) return null;
  const seed = new Date(seedMs);

  if (rule.repeat === "hourly" || rule.repeat === "minutely" || rule.repeat === "secondly") {
    // Bounded by construction: step a day at a time and take what falls out.
    let seen = 0;
    let day = startOfDay(seed);
    for (let step = 0; step < WALK_CAP; step++) {
      const hits = subDailyInstants(rule, seed, day.getTime(), addDays(day, 1).getTime());
      for (const at of hits) {
        if (at < seedMs) continue;
        if (++seen === count) return at;
      }
      day = addDays(day, 1);
    }
    return null;
  }

  const every = Math.max(1, Math.trunc(rule.interval));
  let seen = 0;
  for (let step = 0; step < WALK_CAP; step++) {
    const period = periodStart(rule, seed, step * every);
    for (const at of periodInstants(rule, seed, period)) {
      if (at < seedMs) continue;
      if (++seen === count) return at;
    }
  }
  return null;
}

/** The period `offset` periods after the seed's own. */
function periodStart(rule: Recurrence, seed: Date, offset: number): Date {
  switch (rule.repeat) {
    case "daily":
      return addDays(startOfDay(seed), offset);
    case "weekly":
      return addDays(weekStart(seed, rule.wkst), offset * 7);
    case "monthly":
      return addMonths(new Date(seed.getFullYear(), seed.getMonth(), 1), offset);
    default:
      return new Date(seed.getFullYear() + offset, 0, 1);
  }
}
