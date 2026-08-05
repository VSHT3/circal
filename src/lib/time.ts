/* ------------------------------------------------------------------ *
 * Dates, day arithmetic and the app's formatting voice.
 *
 * The whole product is "one day = one revolution", so the currency here is
 * *minutes since local midnight* (0…1440). Everything that touches the dial
 * converts to that first; nothing downstream ever reasons about a Date.
 * ------------------------------------------------------------------ */

export const MINUTES_PER_DAY = 1440;

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

/* -------------------------------- formatting ------------------------------ */

/** `10:50` + a separate `AM` so the readout can style them differently. */
export function splitTime(d: Date): { time: string; suffix: "AM" | "PM" } {
  let h = d.getHours();
  const suffix = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return { time: `${h}:${`${d.getMinutes()}`.padStart(2, "0")}`, suffix };
}

export function formatTime(d: Date): string {
  const { time, suffix } = splitTime(d);
  return `${time} ${suffix}`;
}

/** `10:45 AM` → but drops `:00`, so 1 PM reads `1 PM`. Used in dense lists. */
export function formatTimeShort(d: Date): string {
  const h = d.getHours() % 12 || 12;
  const suffix = d.getHours() < 12 ? "AM" : "PM";
  return d.getMinutes() === 0
    ? `${h} ${suffix}`
    : `${h}:${`${d.getMinutes()}`.padStart(2, "0")} ${suffix}`;
}

/** `WEDNESDAY · AUG 5` — the header. Caller applies the letterspacing. */
export function formatDayHeader(d: Date): { weekday: string; date: string } {
  return {
    weekday: WEEKDAYS[d.getDay()],
    date: `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`,
  };
}

/** Relative label for the date row of the editor: Today / Tomorrow / Aug 12. */
export function formatRelativeDay(d: Date, today = new Date()): string {
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
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
