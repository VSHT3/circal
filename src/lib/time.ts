/* ------------------------------------------------------------------ *
 * Dates, day arithmetic and the app's formatting voice.
 *
 * The whole product is "one day = one revolution", so the currency here is
 * *minutes since local midnight* (0…1440). Everything that touches the dial
 * converts to that first; nothing downstream ever reasons about a Date.
 * ------------------------------------------------------------------ */

export const MINUTES_PER_DAY = 1440;

/** Wide enough to step clear of any DST transition — they are never a day apart. */
const DAY_MS = 86_400_000;

/**
 * How the app names an hour. Lives here rather than in `dial.ts` because it
 * governs every printed time — the readout, the agenda, the editor — and the
 * dial's two faces are just the same choice made visible.
 */
export type Clock = "12h" | "24h";

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/* ---------------------------------- day ---------------------------------- */

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Monday-first weekday: 0 for Monday, 6 for Sunday.
 *
 * The app's one answer to "which day of the week is this". The life grid's
 * columns are built on it (a year starts as many blank slots in as its 1
 * January is deep into its own week), the mini-month's grid is, and so is the
 * week strip — three surfaces you navigate between, which have to agree about
 * where a week starts or the moves between them stop lining up.
 */
export function mondayOffset(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * The Monday on or before `d`, at local midnight.
 *
 * Steps with `addDays` rather than subtracting milliseconds: a week that
 * crosses a DST transition is 167 or 169 hours long, and a millisecond walk
 * lands an hour off midnight — which keys the wrong day west of UTC.
 */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -mondayOffset(d));
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + n, 1);
  out.setDate(Math.min(d.getDate(), daysInMonth(out.getFullYear(), out.getMonth())));
  return out;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Whole days from one date to another, by calendar date rather than by elapsed
 * time: `Math.round` because a day that crosses a DST boundary is 23 or 25
 * hours long, and floor would call it a day short.
 */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

/** `YYYY-MM-DD` in *local* time — `toISOString()` would shift the day in any
 *  timezone west of UTC, which is exactly where a day-keyed store breaks. */
export function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fromDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Minutes since local midnight of *that same date*. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function atMinutes(day: Date, minutes: number): Date {
  const out = startOfDay(day);
  out.setMinutes(Math.round(minutes));
  return out;
}

/* ------------------------------- time zones ------------------------------- */

/**
 * Zone arithmetic, built on `Intl` rather than a tz database.
 *
 * Two callers need it and neither can use `Date`'s local-only accessors: the
 * dial's second-timezone ring has to know where another zone's hours fall on
 * *this* day's face, and the ICS parser has to read a `TZID=…` wall time back
 * into an instant. `Intl.DateTimeFormat` already ships the whole IANA table,
 * so the only thing missing is the inverse direction, which is `zonedToUtc`.
 */

/**
 * Whether `value` names a zone `Intl` recognises — the one validity test a
 * zone gets anywhere in this app. Throwing is the only signal the platform
 * gives (there is no membership list cheap enough to probe per property), so
 * `ics.ts`'s reader and `backup.ts`'s route through this rather than each
 * keeping its own copy of the same try/catch.
 */
export function isZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `Intl.DateTimeFormat` construction is expensive and these are hot. */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let fmt = ZONE_FORMATTERS.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    ZONE_FORMATTERS.set(zone, fmt);
  }
  return fmt;
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields `zone` is showing at the instant `at`. Not exported:
 *  `zoneOffset` is the only thing that has ever needed them. */
function zoneParts(at: Date, zone: string): ZoneParts {
  const out: Record<string, number> = {};
  for (const part of zoneFormatter(zone).formatToParts(at)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? at.getFullYear(),
    month: out.month ?? at.getMonth() + 1,
    day: out.day ?? at.getDate(),
    // `hourCycle: "h23"` still emits 24 for midnight in some engines.
    hour: (out.hour ?? at.getHours()) % 24,
    minute: out.minute ?? at.getMinutes(),
    second: out.second ?? at.getSeconds(),
  };
}

/** Minutes `zone` runs ahead of UTC at the instant `at`. Negative west of it. */
export function zoneOffset(at: Date, zone: string): number {
  const p = zoneParts(at, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Wall-clock fields *in `zone`* → the instant they name. The inverse of
 * `zoneParts`, and the piece `Intl` does not provide.
 *
 * Two candidate offsets rather than two passes: the offset in force a day
 * before the wall time, and the one a day after. A DST transition is never
 * within a day of another, so those two bracket every case, and exactly one
 * of them is the answer.
 *
 * The earlier pass-based version was direction-dependent and quietly wrong
 * west of UTC. It converged from the naive UTC reading, so which side of a
 * spring-forward gap it landed on depended on the sign of the offset: Berlin
 * resolved 02:30 on a gap day to 03:30 (correct), while Los Angeles resolved
 * it to 01:30 — an hour *before* the gap, and an hour earlier than the user
 * asked for.
 *
 * The two ambiguous cases, decided the way every calendar decides them:
 *  - **Spring forward.** The wall time does not exist. Neither candidate reads
 *    back, and the pre-transition offset is taken, which lands on the instant
 *    immediately after the gap.
 *  - **Fall back.** The wall time happens twice. Both candidates read back,
 *    and the pre-transition offset is taken, which is the first of the two.
 *
 * The trailing `second` (default `0`) exists for `instantOfWall`: a
 * sub-daily rule's own seconds must survive the round trip through wall
 * time, and a truncated one would land the read-back instant up to
 * fifty-nine seconds off the source.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
  second = 0,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = naive - zoneOffset(new Date(naive - DAY_MS), zone) * 60_000;
  const after = naive - zoneOffset(new Date(naive + DAY_MS), zone) * 60_000;

  const reads = (at: number) => {
    const p = zoneParts(new Date(at), zone);
    return (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    );
  };

  if (reads(before)) return before;
  if (reads(after)) return after;
  return before;
}

/**
 * The wall clock `zone` is showing at `at`, as a *local* `Date` — its
 * `getFullYear`/`getHours`/… read like `zone`'s own clock even though the
 * engine still thinks they are this machine's. Built off `zoneParts` rather
 * than an offset sum, because a wall clock is six fields and an offset is
 * one number, and going through the `Date` constructor once is what makes
 * `getDay()` and every calendar function downstream agree with what `zone`
 * would actually print.
 *
 * Paired with `instantOfWall`, its exact inverse. A recurrence rule read
 * from another zone's calendar is that rule walked over *that zone's* wall
 * clock — its own DST transitions, on its own dates, not this machine's —
 * so the whole of zone support for recurrence is this: shift into wall
 * time with `wallClockIn`, walk `startsBetween` over it exactly as if it
 * were the local rule it now looks like, and shift the result back with
 * `instantOfWall`.
 */
export function wallClockIn(at: Date | number, zone: string): Date {
  const p = zoneParts(new Date(at), zone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * The inverse of `wallClockIn`: a wall-clock `Date` — one whose fields are
 * to be read as `zone`'s own clock, not this machine's — back to the
 * instant it names. `zonedToUtc` already carries the ambiguous-hour rules
 * a DST transition needs; the trailing second is `wall.getSeconds()`,
 * or a sub-daily rule loses them to `zonedToUtc`'s default of `:00`.
 */
export function instantOfWall(wall: Date, zone: string): number {
  return zonedToUtc(
    wall.getFullYear(),
    wall.getMonth() + 1,
    wall.getDate(),
    wall.getHours(),
    wall.getMinutes(),
    zone,
    wall.getSeconds(),
  );
}

/**
 * The city half of an IANA name: `Asia/Tokyo` → `Tokyo`,
 * `America/Argentina/Buenos_Aires` → `Buenos Aires`.
 *
 * The city, not the abbreviation. `JST` is only legible if you already know
 * it, and half the world's zones have no abbreviation at all — the platform
 * hands back `GMT+5:45` for Kathmandu, which says nothing a relative offset
 * does not already say better.
 */
export function zoneCity(zone: string): string {
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

/** The region half: `Asia/Tokyo` → `Asia`, `UTC` → `""`. */
function zoneRegion(zone: string): string {
  const parts = zone.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/").replace(/_/g, " ") : "";
}

/**
 * How a zone is named in a picker: `Tokyo · Asia`.
 *
 * City first, and that ordering is the whole point. A native `<select>`'s
 * type-ahead matches from the *start* of the option text, and nobody looking
 * for Tokyo types "Asia" — leading with the continent turns four hundred
 * entries into a scroll.
 */
export function zoneLabel(zone: string): string {
  const region = zoneRegion(zone);
  return region ? `${zoneCity(zone)} · ${region}` : zoneCity(zone);
}

/**
 * A signed hour offset, for one zone measured against another: `+7`, `-3`,
 * `+5:45`, `same`. Whole hours drop the `:00` — most offsets are whole hours
 * and `+7:00` is three characters of noise on a dial rim.
 */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "same";
  const sign = minutes < 0 ? "−" : "+";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${sign}${hours}` : `${sign}${hours}:${`${rest}`.padStart(2, "0")}`;
}

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Every zone the platform knows, for the picker. `supportedValuesOf` is the
 * only way to get the list without shipping one; the fallback keeps the
 * control usable on an engine that lacks it.
 */
export function allZones(): string[] {
  if ("supportedValuesOf" in Intl && typeof Intl.supportedValuesOf === "function") {
    const supported = Intl.supportedValuesOf("timeZone");
    if (supported.length) return supported;
  }
  return ["UTC", localZone()];
}

/* -------------------------------- formatting ------------------------------ */

/**
 * The readout's two halves, so it can style them differently. On the
 * twenty-four hour clock there is no half-day to name, so the suffix is empty
 * and the hour is zero-padded — `07:15`, `13:15`.
 */
export function splitTime(d: Date, clock: Clock = "12h"): { time: string; suffix: string } {
  const minutes = `${d.getMinutes()}`.padStart(2, "0");
  if (clock === "24h") {
    return { time: `${`${d.getHours()}`.padStart(2, "0")}:${minutes}`, suffix: "" };
  }
  const h = d.getHours();
  return { time: `${h % 12 || 12}:${minutes}`, suffix: h < 12 ? "AM" : "PM" };
}

export function formatTime(d: Date, clock: Clock = "12h"): string {
  const { time, suffix } = splitTime(d, clock);
  return suffix ? `${time} ${suffix}` : time;
}

/**
 * The dense-list form. On the twelve-hour clock it drops `:00`, so 1 PM reads
 * `1 PM`; the twenty-four hour clock keeps `HH:MM` throughout, because a bare
 * `13` does not read as a time.
 */
export function formatTimeShort(d: Date, clock: Clock = "12h"): string {
  if (clock === "24h") return formatTime(d, clock);
  const h = d.getHours() % 12 || 12;
  const suffix = d.getHours() < 12 ? "AM" : "PM";
  return d.getMinutes() === 0
    ? `${h} ${suffix}`
    : `${h}:${`${d.getMinutes()}`.padStart(2, "0")} ${suffix}`;
}

/** `AUG` — the three letters every date row in the app names a month by. */
function shortMonth(d: Date): string {
  return MONTHS[d.getMonth()].slice(0, 3);
}

/** `WEDNESDAY · AUG 5` — the header. Caller applies the letterspacing. */
export function formatDayHeader(d: Date): { weekday: string; date: string } {
  return { weekday: WEEKDAYS[d.getDay()], date: `${shortMonth(d)} ${d.getDate()}` };
}

/** Relative label for the date row of the editor: Today / Tomorrow / Aug 12. */
export function formatRelativeDay(d: Date, today = new Date()): string {
  const diff = daysBetween(today, d);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return `${shortMonth(d)} ${d.getDate()}`;
}

/**
 * `8 – 14 Aug`, `28 Aug – 3 Sep` — a run of whole days, both ends inclusive,
 * as the year ring prints the range being dragged.
 *
 * The month is named once when the two ends share it and the year only when
 * they do not, so the common case is the shortest thing that is unambiguous:
 * the face is already telling you which year you are in.
 */
export function formatDayRange(from: Date, to: Date): string {
  const a = `${from.getDate()} ${shortMonth(from)}`;
  const b = `${to.getDate()} ${shortMonth(to)}`;
  if (from.getFullYear() !== to.getFullYear()) {
    return `${a} ${from.getFullYear()} – ${b} ${to.getFullYear()}`;
  }
  if (from.getMonth() === to.getMonth()) return `${from.getDate()} – ${b}`;
  return `${a} – ${b}`;
}

/** `40m`, `1h`, `2h 15m` — durations in the agenda and the "ends in" meta. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * A typed clock string → minutes since midnight. `<input type="time">` was the
 * obvious control here and the wrong one: it renders in the *browser's* UI
 * locale, so half the world would see a 24-hour field in an app whose every
 * other label is `10:45 AM`. This backs a plain text field instead and accepts
 * what people actually type: `10:45 AM`, `10:45am`, `1045`, `9p`, `13:00`.
 */
export function parseClock(value: string): number | null {
  const match = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(?:([ap])\.?m?\.?)?\s*$/i.exec(value);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

/** Round to the nearest `step` minutes — the dial's drag granularity. */
export function snap(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
