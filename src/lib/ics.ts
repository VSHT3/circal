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
import {
  MAX_INTERVAL,
  SIGNED_MAX,
  UNSIGNED_RANGE,
  countedUntil,
  instantKey,
  keyToInstant,
  recurrenceOf,
  splitRule,
} from "./recur";
import {
  FREQUENCIES,
  NEVER,
  type CalEvent,
  type Recurrence,
  type Repeat,
  type WeekdayRule,
} from "./events";

/** A VEVENT reduced to what circal models. `uid` is kept so a re-import of
 *  the same feed replaces rather than duplicates. */
export interface IcsEvent extends Recurrence {
  uid: string;
  /**
   * Set when this VEVENT carries a RECURRENCE-ID: the local key it names —
   * `instantKey()` for a datetime value, `dayKey()` for `VALUE=DATE` — the
   * same two forms `exdates`/`rdates` use.
   * `""` on an ordinary VEVENT, and `""` on an override that carried
   * `RANGE=THISANDFUTURE` — that one is not an override at all by the time
   * `fromIcs` returns, it is the tail of a split series. See
   * `linkThisAndFuture`. Linking an ordinary override to the series sharing
   * its UID is still the consumer's job.
   */
  recurrenceId: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  url: string;
  notes: string;
  /**
   * circal's own two extensions, read back off `X-CIRCAL-TASK` and
   * `X-CIRCAL-DONE`. RFC 5545 §3.8.8.2 is the sanctioned way to carry
   * something the standard has no property for, and a task here is a VEVENT
   * of zero length rather than a VTODO: it has a day and a minute, which is
   * the half of VTODO circal models, and every consumer that ignores the X-
   * lines still shows it on the right day at the right time.
   *
   * `false` / `[]` for every VEVENT circal did not write.
   */
  task: boolean;
  doneKeys: string[];
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
 * Emitted in §3.3.10's own part order — FREQ, INTERVAL, WKST, the BY* parts
 * in the ABNF's own sequence, UNTIL last — because that is the order a
 * strict consumer's own writer would use, and diffing against one is how a
 * malformed rule gets noticed. Only a non-empty / non-default part is
 * written; COUNT never is, since the model only ever stores `until`.
 */
function rruleOf(event: CalEvent): string | null {
  if (event.repeat === "never") return null;
  const parts = [`FREQ=${event.repeat.toUpperCase()}`];

  if (event.interval > 1) parts.push(`INTERVAL=${event.interval}`);
  if (event.wkst !== 1) parts.push(`WKST=${ICS_DAYS[event.wkst]}`);
  if (event.byMonth.length > 0) parts.push(`BYMONTH=${event.byMonth.join(",")}`);
  if (event.byWeekNo.length > 0) parts.push(`BYWEEKNO=${event.byWeekNo.join(",")}`);
  if (event.byYearDay.length > 0) parts.push(`BYYEARDAY=${event.byYearDay.join(",")}`);
  if (event.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${event.byMonthDay.join(",")}`);
  if (event.byDay.length > 0) {
    // The ordinal is only printed when the entry has one — a bare weekday
    // means "every such day in the period", and `0TH` is not RFC syntax.
    parts.push(
      `BYDAY=${event.byDay.map((d) => (d.nth !== 0 ? `${d.nth}${ICS_DAYS[d.day]}` : ICS_DAYS[d.day])).join(",")}`,
    );
  }
  if (event.byHour.length > 0) parts.push(`BYHOUR=${event.byHour.join(",")}`);
  if (event.byMinute.length > 0) parts.push(`BYMINUTE=${event.byMinute.join(",")}`);
  if (event.bySecond.length > 0) parts.push(`BYSECOND=${event.bySecond.join(",")}`);
  if (event.bySetPos.length > 0) parts.push(`BYSETPOS=${event.bySetPos.join(",")}`);
  if (event.until > 0) {
    // UNTIL takes DTSTART's value type (§3.3.10) — a DATE for an all-day
    // series, a UTC datetime for a timed one. Mixing the two is the part of
    // this property strict consumers reject outright.
    const until = new Date(event.until);
    parts.push(`UNTIL=${event.allDay ? dateStamp(until) : utcStamp(until)}`);
  }
  return parts.join(";");
}

/**
 * EXDATE/RDATE lines for one property, grouped by the value type each key
 * already names: a day key (`YYYY-MM-DD`) goes on one `VALUE=DATE` line, an
 * instant key (`YYYY-MM-DDTHH:mm:ss`) on one plain line as a UTC datetime.
 * RFC lets the property repeat, but never mixes value types on a line.
 */
function recurDateLines(name: "EXDATE" | "RDATE", keys: string[], seed: Date): string[] {
  const days = keys.filter((k) => !k.includes("T")).sort();
  const instants = keys.filter((k) => k.includes("T")).sort();

  const lines: string[] = [];
  if (days.length > 0) {
    lines.push(`${name};VALUE=DATE:${days.map((k) => k.replace(/-/g, "")).join(",")}`);
  }
  if (instants.length > 0) {
    const stamps = instants
      .map((k) => keyToInstant(k, seed))
      .filter((ms): ms is number => ms !== null)
      .map((ms) => utcStamp(new Date(ms)));
    if (stamps.length > 0) lines.push(`${name}:${stamps.join(",")}`);
  }
  return lines;
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
    // An override shares its series' UID and carries RECURRENCE-ID instead
    // of one of its own — but only when that series is actually in this
    // export; one pointing at nothing (its parent deleted, or never synced)
    // prints as an ordinary standalone VEVENT rather than a dangling one.
    const overrides =
      event.seriesId && event.seriesKey ? events.find((e) => e.id === event.seriesId) : undefined;
    const uid = overrides ? `${overrides.id}@circal.app` : `${event.id}@circal.app`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(new Date(event.start))}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(new Date(event.end))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(event.start))}`);
      // No DTEND on a task. §3.6.1 requires DTEND to be strictly later than
      // DTSTART, and the same section says a DATE-TIME DTSTART on its own
      // means an event that ends when it starts — so the spec-legal spelling
      // of a zero-length event is to leave the property out.
      if (!event.task) lines.push(`DTEND:${utcStamp(new Date(event.end))}`);
    }
    if (overrides) {
      // Matches this VEVENT's own DTSTART value type, as RFC requires.
      const at = keyToInstant(event.seriesKey, new Date(event.start));
      if (at !== null) {
        lines.push(
          event.allDay
            ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(new Date(at))}`
            : `RECURRENCE-ID:${utcStamp(new Date(at))}`,
        );
      }
    }
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.url) lines.push(`URL:${escapeText(event.url)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    const rrule = rruleOf(event);
    if (rrule) lines.push(`RRULE:${rrule}`);
    const seed = new Date(event.start);
    lines.push(...recurDateLines("EXDATE", event.exdates, seed));
    lines.push(...recurDateLines("RDATE", event.rdates, seed));
    // One comma list rather than a line each, which is what EXDATE's own
    // multi-value form does — and a done key contains no comma, so it needs
    // no escaping beyond that.
    if (event.task) lines.push("X-CIRCAL-TASK:TRUE");
    if (event.doneKeys.length > 0) lines.push(`X-CIRCAL-DONE:${event.doneKeys.join(",")}`);
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
 * One VEVENT's properties. EXDATE and RDATE are kept apart because they are
 * the two properties here that legitimately appear on several lines of the
 * same component, and a flat map would keep only the last of each — which
 * is a series quietly gaining back every occurrence it was told to skip, or
 * losing every extra date it was given.
 */
interface Block {
  props: Record<string, PropEntry>;
  exdates: PropEntry[];
  rdates: PropEntry[];
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

/** `TU,TH` → every such weekday; `3TH` / `-1FR` → one signed ordinal each.
 *  RFC bounds the ordinal to ±53 — a year holds at most 53 of any one
 *  weekday — and a token past that, or naming a day this can't read, is
 *  dropped rather than guessed at. */
function parseByDay(value: string): WeekdayRule[] {
  const out: WeekdayRule[] = [];
  for (const token of value.toUpperCase().split(",")) {
    const m = DAY_TOKEN.exec(token.trim());
    if (!m) continue;
    const day = ICS_DAYS.indexOf(m[2] as (typeof ICS_DAYS)[number]);
    const nth = m[1] ? Math.trunc(Number(m[1])) : 0;
    if (Math.abs(nth) > 53) continue;
    out.push({ day, nth });
  }
  return out;
}

/** RFC 5545's weekday token → `Date.getDay()` index, falling back to Monday
 *  — RFC's own default, and the week the life grid draws too — when WKST is
 *  absent or unrecognised. */
function parseWkst(raw: string | undefined): number {
  if (!raw) return 1;
  const idx = ICS_DAYS.indexOf(raw.toUpperCase() as (typeof ICS_DAYS)[number]);
  return idx === -1 ? 1 : idx;
}

/** A comma list of unsigned RFC integers within `[lo, hi]` — BYMONTH and the
 *  three clock parts, none of which RFC lets go negative. An entry outside
 *  the range is dropped rather than clamped into it: inventing a different
 *  month or hour is worse than leaving that one entry unset. */
function parseIntListRanged(value: string, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (const raw of value.split(",")) {
    const n = Math.trunc(Number(raw.trim()));
    if (Number.isFinite(n) && n >= lo && n <= hi) out.push(n);
  }
  return out;
}

/** A comma list of signed RFC ordinals within `±[1, max]` — BYWEEKNO,
 *  BYYEARDAY, BYMONTHDAY, BYSETPOS, all of which count from the far end of
 *  their period when negative and forbid `0` on either side. */
function parseSignedList(value: string, max: number): number[] {
  const out: number[] = [];
  for (const raw of value.split(",")) {
    const n = Math.trunc(Number(raw.trim()));
    if (Number.isFinite(n) && n !== 0 && Math.abs(n) <= max) out.push(n);
  }
  return out;
}

/** UNTIL, in either value type. A DATE means "through that whole day", so it
 *  resolves to the day's last instant rather than its first — an occurrence
 *  starting that afternoon is still inside the bound. */
function parseUntil(raw: string): number {
  const parsed = parseDateProp({ params: {}, value: raw.trim() });
  if (!parsed) return 0;
  return parsed.allDay ? parsed.ms + 86_400_000 - 1 : parsed.ms;
}

/** A single date/date-time property → the local key EXDATE, RDATE and
 *  RECURRENCE-ID all speak: `dayKey()` for a whole day, `instantKey()` for
 *  one instant. `""` when the property is absent or unreadable. */
function propKey(prop: PropEntry | undefined): string {
  const parsed = parseDateProp(prop);
  if (!parsed) return "";
  return parsed.allDay ? dayKey(new Date(parsed.ms)) : instantKey(parsed.ms);
}

/**
 * EXDATE/RDATE values → local keys. Both may appear on several lines and
 * each holds a comma list, which is why this reads the whole accumulator
 * rather than one property. A `VALUE=PERIOD` entry (RDATE only) is
 * start/end or start/duration; only the start half identifies an occurrence,
 * so the rest is dropped on the way in.
 */
function parseDateList(entries: PropEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    for (const raw of entry.value.split(",")) {
      const token = entry.params.VALUE === "PERIOD" ? raw.trim().split("/")[0] : raw.trim();
      const key = propKey({ params: entry.params, value: token });
      if (key && !out.includes(key)) out.push(key);
    }
  }
  return out.sort();
}

/**
 * RRULE + EXDATE/RDATE → the rule this app stores. A FREQ this cannot read —
 * missing, or one of the eight tokens misspelled — is dropped back to
 * "happens once" rather than approximated: a rule rendered on the wrong days
 * is worse than an event rendered once, and only one of the two is visible
 * as a mistake. Every other part is best-effort: unknown parts are ignored,
 * and a value outside its RFC range is dropped rather than failing the
 * VEVENT.
 */
function readRecurrence(block: Block, start: number): Recurrence {
  // EXDATE and RDATE are properties of the VEVENT, not of the RRULE, and
  // RFC 5545 allows a series made of RDATEs alone. The model handles that —
  // `repeats()` is true for rdates with `repeat: "never"`, and
  // `startsBetween` adds them whatever the frequency — so dropping them with
  // the rule lost dates a producer had named explicitly.
  const dates = {
    exdates: parseDateList(block.exdates),
    rdates: parseDateList(block.rdates),
  };

  const rrule = block.props.RRULE?.value;
  if (!rrule) return { ...NEVER, ...dates };

  const parts = parseRuleParts(rrule);
  const freq = parts.FREQ?.toLowerCase();
  if (!freq || freq === "never" || !FREQUENCIES.includes(freq as Repeat)) {
    return { ...NEVER, ...dates };
  }
  const repeat = freq as Repeat;

  const rule: Recurrence = {
    repeat,
    // Same ceiling a stored rule gets: a producer sending INTERVAL=100000 is
    // corrupt or hostile, and `recur.ts` owns which of clamp-or-refuse this
    // app answers with.
    interval: Math.min(MAX_INTERVAL, Math.max(1, Math.trunc(Number(parts.INTERVAL)) || 1)),
    until: parts.UNTIL ? parseUntil(parts.UNTIL) : 0,
    wkst: parseWkst(parts.WKST),
    // Every bound comes off `recur.ts`'s table — this parser reads strings
    // rather than JSON, but what a legal BYMONTHDAY is cannot depend on that.
    byMonth: parts.BYMONTH ? parseIntListRanged(parts.BYMONTH, ...UNSIGNED_RANGE.byMonth) : [],
    byWeekNo: parts.BYWEEKNO ? parseSignedList(parts.BYWEEKNO, SIGNED_MAX.byWeekNo) : [],
    byYearDay: parts.BYYEARDAY ? parseSignedList(parts.BYYEARDAY, SIGNED_MAX.byYearDay) : [],
    byMonthDay: parts.BYMONTHDAY ? parseSignedList(parts.BYMONTHDAY, SIGNED_MAX.byMonthDay) : [],
    byDay: parts.BYDAY ? parseByDay(parts.BYDAY) : [],
    byHour: parts.BYHOUR ? parseIntListRanged(parts.BYHOUR, ...UNSIGNED_RANGE.byHour) : [],
    byMinute: parts.BYMINUTE ? parseIntListRanged(parts.BYMINUTE, ...UNSIGNED_RANGE.byMinute) : [],
    bySecond: parts.BYSECOND ? parseIntListRanged(parts.BYSECOND, ...UNSIGNED_RANGE.bySecond) : [],
    bySetPos: parts.BYSETPOS ? parseSignedList(parts.BYSETPOS, SIGNED_MAX.bySetPos) : [],
    ...dates,
  };
  // COUNT and UNTIL are mutually exclusive in a valid rule; if a producer
  // sends both, the explicit date wins. Counting reads the rule as parsed
  // above, before EXDATE, same as `countedUntil`'s own contract wants.
  if (rule.until === 0 && parts.COUNT) {
    rule.until = countedUntil(rule, start, Math.trunc(Number(parts.COUNT))) ?? 0;
  }
  return rule;
}

/**
 * FNV-1a, base 36. Small, fast, and stable across runs — which is the whole
 * point wherever it is used: an id derived from a record's own content is the
 * same id the next time that record is read, and `Math.random()` is not.
 */
export function fnv1a(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * A stable synthetic UID for a VEVENT that did not bring one.
 *
 * Over the properties that identify an occurrence in practice. A hash rather
 * than the fields themselves because this ends up in a DOM key, and a SUMMARY
 * can be any length and contain anything.
 */
function derivedUid(block: Block["props"], start: number, end: number): string {
  const source = [
    start,
    end,
    block.SUMMARY?.value ?? "",
    block.LOCATION?.value ?? "",
    block["RECURRENCE-ID"]?.value ?? "",
  ].join("|");
  return `${fnv1a(source)}@circal.local`;
}

function buildEvent(block: Block): IcsEvent | null {
  const { props } = block;
  const dtstart = parseDateProp(props.DTSTART);
  if (!dtstart) return null;

  const task = props["X-CIRCAL-TASK"]?.value.toUpperCase() === "TRUE";
  let end: number;
  const dtend = parseDateProp(props.DTEND);
  if (dtend) {
    end = dtend.ms;
  } else {
    const duration = props.DURATION ? parseDuration(props.DURATION.value) : null;
    // §3.6.1: a DATE-TIME DTSTART with neither DTEND nor DURATION is an event
    // that ends at the instant it starts — which is exactly what a task is,
    // and why circal writes one that way rather than emitting `DTEND` equal to
    // `DTSTART` (the RFC requires DTEND to be strictly later). The hour-long
    // fallback stays for everybody else's VEVENTs: it is what a reader expects
    // of a meeting sent without an end, and reading *those* as zero-length
    // would collapse them onto the rim.
    const fallback = task ? 0 : dtstart.allDay ? 86_400_000 : 3_600_000;
    end = dtstart.ms + (duration ?? fallback);
  }

  // A UID is required by RFC 5545, so this fallback only fires on a
  // non-conforming feed — which is to say, on exactly the feeds nobody can
  // fix. It must be *derived*, never generated: a random id here is a new id
  // on every pull, and `feeds.ts` builds the event's key from it, so React
  // remounted every arc each refresh — hover dropped, selection dropped, and
  // the arc under the pointer vanished and came back beneath it.
  const uidValue = props.UID?.value;
  const uid = uidValue ? unescapeText(uidValue) : derivedUid(props, dtstart.ms, end);

  return {
    uid,
    // `RANGE=THISANDFUTURE` is handled after every VEVENT is read, in
    // `linkThisAndFuture`, because it is a fact about two of them.
    recurrenceId: propKey(props["RECURRENCE-ID"]),
    title: props.SUMMARY ? unescapeText(props.SUMMARY.value) : "",
    start: dtstart.ms,
    end,
    allDay: dtstart.allDay,
    location: props.LOCATION ? unescapeText(props.LOCATION.value) : "",
    url: props.URL ? unescapeText(props.URL.value) : "",
    notes: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : "",
    task,
    doneKeys: (props["X-CIRCAL-DONE"]?.value ?? "")
      .split(",")
      .filter((k) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(k)),
    ...readRecurrence(block, dtstart.ms),
  };
}

/** RFC 5545 §3.8.4.4: the only RANGE value the standard defines. */
const THIS_AND_FUTURE = "THISANDFUTURE";

/** One VEVENT, plus the two things about its source block that only matter
 *  once every other VEVENT has been read. */
interface Parsed {
  event: IcsEvent;
  /** `RECURRENCE-ID;RANGE=THISANDFUTURE` — a series split, not an override. */
  future: boolean;
  /** The block carried an RRULE of its own. */
  ruled: boolean;
}

function mergeKeys(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/**
 * `RANGE=THISANDFUTURE` — "this occurrence and every one after it" — which is
 * two series rather than one patched occurrence, exactly as `splitRule` and
 * `store.splitSeries` already model it. Done here rather than in a consumer
 * because `feeds.ts` and `backup.ts` each link overrides themselves, and one
 * of them getting it wrong is a series that draws twice.
 *
 * The promoted tail stops being an override: it takes a uid of its own
 * (`uid#recurrence-id`, stable across pulls because both halves are) or the
 * key of a series it collides with in both consumers' maps. Without an RRULE
 * of its own it continues the parent's rule from its own DTSTART, which is
 * what the range means; with one, it is a whole series and brings its own
 * lists. Either way the parent's future EXDATEs and RDATEs move across with
 * `splitRule`, or the tail resurrects days the sender had already skipped.
 *
 * Chained splits fold left: the second cut is measured against the first
 * cut's tail, because by then that is the series generating the instant. And
 * an ordinary override past a cut is re-pointed at the tail — the rule
 * `store.splitSeries` applies for the same reason, since an override left on
 * the head suppresses nothing and the day draws both it and the tail's arc.
 */
function linkThisAndFuture(parsed: Parsed[]): IcsEvent[] {
  // Nothing mainstream emits one, so this is the shape of the common case.
  if (!parsed.some((p) => p.future)) return parsed.map((p) => p.event);

  const byUid = new Map<string, Parsed[]>();
  for (const p of parsed) {
    const group = byUid.get(p.event.uid);
    if (group) group.push(p);
    else byUid.set(p.event.uid, [p]);
  }

  const dropped = new Set<Parsed>();
  for (const [uid, group] of byUid) {
    let head = group.find((p) => p.event.recurrenceId === "");
    if (!head) continue;
    const seed = new Date(head.event.start);
    const splits = group
      .filter((p) => p.future && p.event.recurrenceId !== "")
      .map((p) => ({ p, at: keyToInstant(p.event.recurrenceId, seed) }))
      // A key that spells nothing cannot say where to cut; it stays an
      // ordinary override, which is what this reader did with it before.
      .filter((s): s is { p: Parsed; at: number } => s.at !== null)
      .sort((a, b) => a.at - b.at);
    if (splits.length === 0) continue;

    const cuts: { at: number; uid: string }[] = [];
    for (const { p, at } of splits) {
      const parent = head.event;
      const split = splitRule(parent, parent.start, at);
      // A cut at or before the series' own first instant leaves a head that
      // generates nothing. The tail takes the uid instead of standing beside a
      // dead series — `App.effectiveScope` folds the same case into "all".
      const absorbs = at <= parent.start;
      p.event = {
        ...p.event,
        uid: absorbs ? uid : `${uid}#${p.event.recurrenceId}`,
        recurrenceId: "",
        ...(p.ruled
          ? recurrenceOf(p.event)
          : {
              ...recurrenceOf(parent),
              exdates: mergeKeys(split.tail.exdates, p.event.exdates),
              rdates: mergeKeys(split.tail.rdates, p.event.rdates),
            }),
      };
      if (absorbs) dropped.add(head);
      else head.event = { ...parent, ...split.head };
      cuts.push({ at, uid: p.event.uid });
      head = p;
    }

    for (const p of group) {
      if (dropped.has(p) || p.event.recurrenceId === "") continue;
      const at = keyToInstant(p.event.recurrenceId, seed);
      if (at === null) continue;
      let owner = "";
      for (const cut of cuts) if (cut.at <= at) owner = cut.uid;
      if (owner) p.event = { ...p.event, uid: owner };
    }
  }

  return parsed.filter((p) => !dropped.has(p)).map((p) => p.event);
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
  const read: Parsed[] = [];
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
      if (block === "VEVENT" && current === null) current = { props: {}, exdates: [], rdates: [] };
      continue;
    }
    if (propName === "END") {
      const opened = stack.pop();
      if (opened === "VEVENT" && value.toUpperCase() === "VEVENT" && current !== null) {
        const event = buildEvent(current);
        if (event) {
          const range = current.props["RECURRENCE-ID"]?.params.RANGE;
          read.push({
            event,
            future: event.recurrenceId !== "" && range?.toUpperCase().trim() === THIS_AND_FUTURE,
            ruled: current.props.RRULE !== undefined,
          });
        }
        current = null;
      }
      continue;
    }

    if (current !== null && stack[stack.length - 1] === "VEVENT") {
      if (propName === "EXDATE") current.exdates.push({ params, value });
      else if (propName === "RDATE") current.rdates.push({ params, value });
      else current.props[propName] = { params, value };
    } else if (current === null && propName === "X-WR-CALNAME") {
      name = unescapeText(value);
    }
  }

  return { name, events: linkThisAndFuture(read) };
}
