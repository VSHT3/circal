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

import { dayKey, zonedToUtc } from "./time";
import type { CalEvent, Repeat } from "./events";

/** A VEVENT reduced to what circal models. `uid` is kept so a re-import of
 *  the same feed replaces rather than duplicates. */
export interface IcsEvent {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  url: string;
  notes: string;
  repeat: Repeat;
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
      lines.push(`DTSTART;VALUE=DATE:${dayKey(new Date(event.start)).replace(/-/g, "")}`);
      lines.push(`DTEND;VALUE=DATE:${dayKey(new Date(event.end)).replace(/-/g, "")}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(event.start))}`);
      lines.push(`DTEND:${utcStamp(new Date(event.end))}`);
    }
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    if (event.repeat !== "never") lines.push(`RRULE:FREQ=${event.repeat.toUpperCase()}`);
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

type Props = Record<string, PropEntry>;

function buildEvent(props: Props): IcsEvent | null {
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

  let repeat: Repeat = "never";
  const rrule = props.RRULE?.value;
  if (rrule) {
    const freq = /(?:^|;)FREQ=([A-Z]+)/.exec(rrule)?.[1];
    if (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY") {
      repeat = freq.toLowerCase() as Repeat;
    }
  }

  return {
    uid,
    title: props.SUMMARY ? unescapeText(props.SUMMARY.value) : "",
    start: dtstart.ms,
    end,
    allDay: dtstart.allDay,
    location: props.LOCATION ? unescapeText(props.LOCATION.value) : "",
    url: props.URL ? unescapeText(props.URL.value) : "",
    notes: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : "",
    repeat,
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
  let current: Props | null = null;

  for (const raw of lines) {
    const parsed = splitLine(raw);
    if (!parsed) continue;
    const { name: propName, params, value } = parsed;

    if (propName === "BEGIN") {
      const block = value.toUpperCase();
      stack.push(block);
      if (block === "VEVENT" && current === null) current = {};
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
      current[propName] = { params, value };
    } else if (current === null && propName === "X-WR-CALNAME") {
      name = unescapeText(value);
    }
  }

  return { name, events };
}
