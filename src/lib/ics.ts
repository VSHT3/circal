/* ------------------------------------------------------------------ *
 * RFC 5545 (iCalendar) serialise / parse, no dependencies.
 *
 * Two directions, two different postures. `toIcs` is exact: circal fully
 * controls the shape of what it writes, so it always emits UTC instants,
 * escapes strictly and folds at the wire limit. `fromIcs` is tolerant:
 * it reads calendars circal never produced (Google, Apple, Fastmail…), so
 * an unreadable VEVENT is skipped rather than thrown on, and the handful
 * of date forms other producers actually use (UTC, TZID, floating,
 * VALUE=DATE, DURATION-instead-of-DTEND) all get a fallback.
 * ------------------------------------------------------------------ */

import { dayKey, fromDayKey, zonedToUtc } from "./time";
import { NEVER, countedUntil, type CalEvent, type Recurrence, type Repeat } from "./events";

/** A VEVENT reduced to what circal models. `uid` is kept so a re-import of
 *  the same feed replaces rather than duplicates. */
export interface IcsEvent extends Recurrence {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  url: string;
  notes: string;
}

/* --------------------------------- text ----------------------------------- */

/** RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, a newline
 *  becomes literal `\n`. Applies to the VALUE only — never to a property
 *  name or its params. */
function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** The inverse of `escapeText`. `\N` is a documented alias for `\n` some
 *  producers use; an unrecognised escape keeps its backslash rather than
 *  dropping it, since a tolerant parser should never eat data it can't
 *  explain. */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === "n" || next === "N") out += "\n";
      else if (next === "\\") out += "\\";
      else if (next === ";") out += ";";
      else if (next === ",") out += ",";
      else out += c + next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** Folds one logical property line at 75 octets, as RFC 5545 §3.1 requires.
 *  Iterates by code point (not UTF-16 code unit) so an astral character —
 *  an emoji in a summary — never gets split across the fold, and measures
 *  each one in UTF-8 bytes since that's what the octet limit counts. */
const MAX_OCTETS = 75;
const encoder = new TextEncoder();

function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first line gets the full budget; continuation lines reserve one
  // octet for the leading space that marks them as a continuation.
  let budget = MAX_OCTETS;
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length;
    if (currentBytes + chBytes > budget) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
      budget = MAX_OCTETS - 1;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current) chunks.push(current);
  return chunks.map((c, i) => (i === 0 ? c : " " + c)).join("\r\n");
}

/* --------------------------------- dates ----------------------------------- */

function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The `VALUE=DATE` form. Local, because an all-day event's date is the one
 *  the user is looking at and not the one UTC happens to be having. */
function dateStamp(d: Date): string {
  return dayKey(d).replace(/-/g, "");
}

/* ------------------------------- recurrence -------------------------------- */

/** RFC 5545's two-letter weekdays, indexed by `Date.getDay()`. */
const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * The RRULE for an event, or `null` when it happens once.
 *
 * UNTIL takes the value type of DTSTART (§3.3.10) — a DATE for an all-day
 * series, a UTC datetime for a timed one. Mixing the two is the part of this
 * property strict consumers reject outright.
 */
function rruleOf(event: CalEvent): string | null {
  if (event.repeat === "never") return null;
  const seed = new Date(event.start);
  const parts = [`FREQ=${event.repeat.toUpperCase()}`];

  if (event.interval > 1) parts.push(`INTERVAL=${event.interval}`);
  if (event.repeat === "weekly" && event.byDay.length > 0) {
    parts.push(`BYDAY=${event.byDay.map((d) => ICS_DAYS[d]).join(",")}`);
  }
  if (event.repeat === "monthly" && event.nth !== 0) {
    parts.push(`BYDAY=${event.nth}${ICS_DAYS[event.byDay[0] ?? seed.getDay()]}`);
  }
  if (event.until > 0) {
    const until = new Date(event.until);
    parts.push(`UNTIL=${event.allDay ? dateStamp(until) : utcStamp(until)}`);
  }
  return parts.join(";");
}

/**
 * EXDATE: the instants the skipped occurrences would have started at. The
 * store keeps day keys, so the seed's time of day goes back on each one —
 * a bare date against a timed DTSTART is the same value-type mismatch as
 * above, in reverse.
 */
function exdateOf(event: CalEvent): string | null {
  if (event.repeat === "never" || event.exdates.length === 0) return null;
  const days = [...event.exdates].sort();
  if (event.allDay) {
    return `EXDATE;VALUE=DATE:${days.map((key) => key.replace(/-/g, "")).join(",")}`;
  }
  const seed = new Date(event.start);
  const stamps = days.map((key) => {
    const day = fromDayKey(key);
    day.setHours(seed.getHours(), seed.getMinutes(), 0, 0);
    return utcStamp(day);
  });
  return `EXDATE:${stamps.join(",")}`;
}

/* -------------------------------- serialise -------------------------------- */

/** `name` becomes X-WR-CALNAME. */
export function toIcs(events: CalEvent[], name: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//circal//circal 1.0//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];

  const stamp = utcStamp(new Date());
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.id}@circal.app`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(new Date(event.start))}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(new Date(event.end))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(event.start))}`);
      lines.push(`DTEND:${utcStamp(new Date(event.end))}`);
    }
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    const rrule = rruleOf(event);
    if (rrule) lines.push(`RRULE:${rrule}`);
    const exdate = exdateOf(event);
    if (exdate) lines.push(exdate);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/* ---------------------------------- parse ----------------------------------- */

interface ParsedLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

type PropEntry = { params: Record<string, string>; value: string };

/** Splits `NAME;PARAM=VALUE;PARAM="quoted:value":VALUE` on the first colon
 *  that isn't inside a quoted param value — a param value may itself
 *  contain a colon (a quoted TZID URI, in principle), but property values
 *  never appear before it. */
function splitLine(line: string): ParsedLine | null {
  let inQuotes = false;
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx === -1) return null;

  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq).toUpperCase();
    let val = parts[i].slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

/** Support the common `PnDTnHnMnS` subset — the only shape circal (or any
 *  mainstream producer) actually emits for a DURATION standing in for a
 *  missing DTEND. Weeks (`PnW`) are deliberately unsupported: nothing that
 *  writes events without a DTEND uses them. */
function parseDuration(value: string): number | null {
  const m = /^([+-]?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const days = Number(m[2] ?? 0);
  const hours = Number(m[3] ?? 0);
  const minutes = Number(m[4] ?? 0);
  const seconds = Number(m[5] ?? 0);
  return sign * (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** DTSTART/DTEND → an instant plus whether it read as an all-day date. */
function parseDateProp(prop: PropEntry | undefined): { ms: number; allDay: boolean } | null {
  if (!prop) return null;
  const { params, value } = prop;

  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number);
    return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  }

  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc) {
    const [y, mo, d, h, mi, s] = utc.slice(1).map(Number);
    return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  }

  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!local) return null;
  const [y, mo, d, h, mi, s] = local.slice(1).map(Number);

  const tzid = params.TZID;
  if (tzid) {
    try {
      // Cheap validity probe: Intl throws on a TZID it doesn't recognise,
      // and that's the only signal it gives — there's no `isValidTimeZone`.
      new Intl.DateTimeFormat("en-US", { timeZone: tzid });
      return { ms: zonedToUtc(y, mo, d, h, mi, tzid), allDay: false };
    } catch {
      // Fall through: treat it as floating local time instead of throwing.
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

/**
 * One VEVENT's properties. EXDATE is kept apart because it is the one
 * property here that legitimately appears on several lines of the same
 * component, and a flat map would keep only the last of them — which is a
 * series quietly gaining back every occurrence it was told to skip.
 */
interface Block {
  props: Record<string, PropEntry>;
  exdates: PropEntry[];
}

/** `FREQ=WEEKLY;BYDAY=TU,TH` → a lookup. */
function parseRuleParts(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

const DAY_TOKEN = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;

/** `TU,TH` → days `[2, 4]`; `3TH` → day `[4]` at position 3. */
function parseByDay(value: string): { days: number[]; position: number } {
  const days: number[] = [];
  let position = 0;
  for (const token of value.toUpperCase().split(",")) {
    const m = DAY_TOKEN.exec(token.trim());
    if (!m) continue;
    const day = ICS_DAYS.indexOf(m[2] as (typeof ICS_DAYS)[number]);
    if (!days.includes(day)) days.push(day);
    if (m[1] && position === 0) position = Number(m[1]);
  }
  return { days: days.sort((a, b) => a - b), position };
}

/** A monthly position this model can actually draw: the five weeks a month
 *  has, forwards or backwards. Anything else is read as "no position". */
function usablePosition(position: number): number {
  const n = Math.trunc(position);
  return n >= -5 && n <= 5 ? n : 0;
}

/** UNTIL, in either value type. A DATE means "through that whole day", so it
 *  resolves to the day's last instant rather than its first — an occurrence
 *  starting that afternoon is still inside the bound. */
function parseUntil(raw: string): number {
  const parsed = parseDateProp({ params: {}, value: raw.trim() });
  if (!parsed) return 0;
  return parsed.allDay ? parsed.ms + 86_400_000 - 1 : parsed.ms;
}

/** The excluded days, as the local day keys the store speaks. */
function parseExdates(entries: PropEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    for (const raw of entry.value.split(",")) {
      const parsed = parseDateProp({ params: entry.params, value: raw.trim() });
      if (!parsed) continue;
      const key = dayKey(new Date(parsed.ms));
      if (!out.includes(key)) out.push(key);
    }
  }
  return out.sort();
}

/**
 * RRULE + EXDATE → the rule this app stores. Anything it cannot represent
 * honestly is dropped back to "happens once" rather than approximated: a
 * rule rendered on the wrong days is worse than an event rendered once, and
 * only one of the two is visible as a mistake.
 */
function readRecurrence(block: Block, start: number): Recurrence {
  const rrule = block.props.RRULE?.value;
  if (!rrule) return { ...NEVER };

  const parts = parseRuleParts(rrule);
  const freq = parts.FREQ?.toUpperCase();
  // SECONDLY, MINUTELY and HOURLY have no honest form on a day-keyed dial,
  // and a missing FREQ is not a rule at all.
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return { ...NEVER };
  }

  const repeat = freq.toLowerCase() as Repeat;
  const interval = Math.max(1, Math.trunc(Number(parts.INTERVAL)) || 1);
  const parsedDays = parts.BYDAY ? parseByDay(parts.BYDAY) : { days: [], position: 0 };

  let byDay: number[] = [];
  let nth = 0;
  if (repeat === "weekly") {
    // The whole point of the property: FREQ=WEEKLY;BYDAY=TU,TH is two
    // meetings a week, and reading only FREQ loses one of them.
    byDay = parsedDays.days;
  } else if (repeat === "monthly" && parsedDays.days.length > 0) {
    // BYSETPOS is the other spelling of "the third Thursday". A BYDAY with no
    // position at all means *every* Thursday of the month — a weekly rule in
    // a monthly hat — which is left on the day of the month rather than
    // guessed at.
    const position = usablePosition(parsedDays.position || Number(parts.BYSETPOS));
    if (position !== 0) {
      byDay = [parsedDays.days[0]];
      nth = position;
    }
  }

  const rule: Recurrence = {
    repeat,
    interval,
    until: parts.UNTIL ? parseUntil(parts.UNTIL) : 0,
    byDay,
    nth,
    exdates: parseExdates(block.exdates),
  };
  // COUNT and UNTIL are mutually exclusive in a valid rule; if a producer
  // sends both, the explicit date wins.
  if (rule.until === 0 && parts.COUNT) {
    rule.until = countedUntil(rule, start, Math.trunc(Number(parts.COUNT))) ?? 0;
  }
  return rule;
}

function buildEvent(block: Block): IcsEvent | null {
  const { props } = block;
  const dtstart = parseDateProp(props.DTSTART);
  if (!dtstart) return null;

  let end: number;
  const dtend = parseDateProp(props.DTEND);
  if (dtend) {
    end = dtend.ms;
  } else {
    const duration = props.DURATION ? parseDuration(props.DURATION.value) : null;
    end = dtstart.ms + (duration ?? (dtstart.allDay ? 86_400_000 : 3_600_000));
  }

  const uidValue = props.UID?.value;
  const uid = uidValue
    ? unescapeText(uidValue)
    : typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${dtstart.ms}-${Math.random().toString(36).slice(2)}`;

  return {
    uid,
    title: props.SUMMARY ? unescapeText(props.SUMMARY.value) : "",
    start: dtstart.ms,
    end,
    allDay: dtstart.allDay,
    location: props.LOCATION ? unescapeText(props.LOCATION.value) : "",
    url: props.URL ? unescapeText(props.URL.value) : "",
    notes: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : "",
    ...readRecurrence(block, dtstart.ms),
  };
}

/** Tolerant parse. Returns `name` from X-WR-CALNAME (or "" when absent) and
 *  every VEVENT it could read; a VEVENT it cannot read is skipped, never
 *  thrown on. */
export function fromIcs(text: string): { name: string; events: IcsEvent[] } {
  // Unfold first: a CRLF (or bare LF, for feeds that skip the wire line
  // ending) followed by a single space or tab continues the previous
  // logical line.
  const lines = text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r\n|\n|\r/)
    .filter((l) => l.length > 0);

  let name = "";
  const events: IcsEvent[] = [];
  // Block nesting, tracked generically: a property belongs to the open
  // VEVENT only while VEVENT is the innermost block, so a VALARM (or
  // anything else) nested inside one can't leak its own properties in or
  // prematurely close it.
  const stack: string[] = [];
  let current: Block | null = null;

  for (const raw of lines) {
    const parsed = splitLine(raw);
    if (!parsed) continue;
    const { name: propName, params, value } = parsed;

    if (propName === "BEGIN") {
      const block = value.toUpperCase();
      stack.push(block);
      if (block === "VEVENT" && current === null) current = { props: {}, exdates: [] };
      continue;
    }
    if (propName === "END") {
      const opened = stack.pop();
      if (opened === "VEVENT" && value.toUpperCase() === "VEVENT" && current !== null) {
        const event = buildEvent(current);
        if (event) events.push(event);
        current = null;
      }
      continue;
    }

    if (current !== null && stack[stack.length - 1] === "VEVENT") {
      if (propName === "EXDATE") current.exdates.push({ params, value });
      else current.props[propName] = { params, value };
    } else if (current === null && propName === "X-WR-CALNAME") {
      name = unescapeText(value);
    }
  }

  return { name, events };
}
