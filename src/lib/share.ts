/* ------------------------------------------------------------------ *
 * One event, inside a link.
 *
 * The circal-to-circal handover: the whole event travels in the URL, so
 * there is nothing stored, nothing to expire and nothing to serve.
 * `.ics` is still the answer for every other calendar — this is the path
 * that keeps a rule, a mark and a colour intact between two circals.
 *
 * **The payload belongs in the fragment, never the query string.** A
 * fragment is never sent to a server; a query string is sent on every
 * click and lands in a log. This app has exactly one route — `/api/feed`
 * — and no server-side state at all, so an event in a query string would
 * quietly break that promise for whoever pasted the link. `shareFragment`
 * and `shareToken` are the only two places the fragment's spelling lives,
 * so nothing downstream can decide to put it somewhere else.
 *
 * **The link is not private.** This is an encoding, not encryption:
 * anyone holding the link holds the event. That is exactly what makes the
 * feature work and it is fatal if a user assumes otherwise, so the surface
 * that mints one says so out loud (see `EventEditor`'s Share row) rather
 * than leaving it to this comment.
 *
 * Format, and what compactness cost. A link that wraps three times in a
 * chat window is a link people stop sending, so the record is
 * **positional**: field names are longer than most of the values they
 * would label, and JSON of a `CalEvent` plus base64 is about ten times
 * this for the same event. Numbers are base36, an instant is seconds
 * rather than milliseconds (nothing in this app writes a sub-minute
 * instant — the dial snaps to fifteen and `parseClock` to one), a
 * duration is a delta off the start rather than a second absolute
 * instant, and every trailing empty field is dropped, so an ordinary
 * timed event is four fields. What was paid for it: the record is
 * unreadable by eye, and a field can never be *reordered* — only
 * appended — which is what the version token is for. The body is then
 * base64url, +33% for a guarantee rather than a guess: the output
 * alphabet is `A-Za-z0-9-_`, so no character in a title can need
 * percent-encoding, break out of the payload, or be eaten by whatever
 * linkifies the message it is pasted into. Escaping Unicode by hand into
 * a URL-safe subset was the alternative and it is a percent-encoder with
 * a different sigil — three bytes per accented character, and a table to
 * get wrong. `CompressionStream` was the other: asynchronous, which a
 * synchronous format called from a click handler cannot use.
 *
 * The token is `version.check.body`, and the check is what makes
 * truncation reportable. Without it a link cut short on a base64 boundary
 * — a chat client breaking a line, half a link pasted — decodes into a
 * *plausible* event with its last field silently shortened, which is the
 * one hostile case that cannot be caught by shape: the bytes are legal and
 * the instants are fine. Four base36 characters of FNV-1a over the record
 * is 1.7 million values for five characters of link, and `fnv1a` is
 * already this repo's answer to "is this the same content".
 * ------------------------------------------------------------------ */

import { readEvent } from "./backup";
import type { CalEvent } from "./events";
import { fnv1a } from "./ics";
import type { Repeat } from "./recur";
import { addDays, startOfDay } from "./time";

/**
 * The format's one version token, and it leads the payload so a reader
 * knows what it is holding before it has parsed a byte of it. A format
 * with no version is a format that cannot change: the fields below may be
 * appended to at will, but reordering or re-spelling one needs this
 * number, and a payload from a version this build does not know **fails**
 * rather than half-decoding into an event nobody wrote.
 */
export const SHARE_VERSION = 1;

/**
 * The longest payload this will mint or read, in characters.
 *
 * A cap has to exist: a note of any length and a rule carrying a hundred
 * RDATEs are what push a link past what a chat app will linkify or a
 * browser's address bar will keep, and a link that silently arrives
 * truncated is worse than a refusal — the receiver gets "this link is
 * broken" with nothing to do about it, while the sender gets a copy
 * confirmation. 1,600 leaves room for a long origin inside 2,048, which
 * is the floor every browser, mail client and chat preview still handles,
 * and it is about a thousand characters of notes.
 */
export const SHARE_MAX = 1_600;

/** The fragment's own spelling, in one place. `e` for the one event it
 *  carries; the query string next to it is the app's day and view. */
const FRAGMENT_PREFIX = "#e=";

/** The three booleans, as bits, because three fields of `0`/`1` cost five
 *  characters more than one base36 digit. Read *before* the instants: an
 *  all-day event spells them differently. */
const ALL_DAY = 1;
const TASK = 2;
const FREE = 4;

/**
 * The wire's own name for each frequency, rather than an index into
 * `FREQUENCIES`. One character either way, and this way reordering that
 * array — a refactor with no reason to think about links — cannot turn
 * every weekly event already pasted into a chat window into a monthly one.
 */
const REPEAT_CODES: Record<Repeat, string> = {
  never: "n",
  secondly: "s",
  minutely: "i",
  hourly: "h",
  daily: "d",
  weekly: "w",
  monthly: "m",
  yearly: "y",
};

/** The same table, read the other way. A `Record` rather than a `Map`
 *  because it is eight static string keys, and derived rather than written
 *  twice because two literal tables are two chances to disagree. */
const REPEAT_BY_CODE = Object.fromEntries(
  Object.entries(REPEAT_CODES).map(([repeat, code]) => [code, repeat]),
) as Record<string, Repeat>;

/** What an event is once its id is gone: the draft a receiver is offered.
 *  The id deliberately does not travel — see `encodeShare`. */
export type ShareDraft = Omit<CalEvent, "id">;

export type ShareEncoded = { ok: true; token: string } | { ok: false; reason: "too-long" };

export type ShareDecoded =
  | { ok: true; draft: ShareDraft }
  /** `version` is a payload from a build newer than this one; `unreadable`
   *  is everything else, including a truncated or hand-mangled one. */
  | { ok: false; reason: "too-long" | "version" | "unreadable" };

/* -------------------------------- primitives ------------------------------- */

const b36 = (n: number) => Math.trunc(n).toString(36);

/** A base36 field back to a number, or `NaN`. Strict, because `parseInt`
 *  reads `"12xyz"` as 12 and a payload is a stranger's string. */
function fromB36(field: string): number {
  return /^-?[0-9a-z]+$/.test(field) ? Number.parseInt(field, 36) : NaN;
}

/**
 * The record's own check digits, fixed width so a decoder can compare
 * strings rather than parse a number. `fnv1a` is base36 of a 32-bit hash,
 * so its own length varies with the value — padded before the slice, or
 * one record in thirty-six would be checked on three digits.
 *
 * Exported for the tests, which have to be able to forge a *well-formed*
 * payload carrying one broken field: a suite that could only hand this
 * module strings it had produced itself could not test the readers at all.
 * The same reason `backup.ts` exports its validators.
 */
export function shareCheck(record: string): string {
  return fnv1a(record).padStart(7, "0").slice(-4);
}

/**
 * Only two characters can confuse the record — its own separator and the
 * escape itself — so escaping is two replacements rather than a character
 * table. A title carrying a tilde pays one character for it; nothing else
 * pays anything.
 */
const escapeText = (value: string) => value.replace(/[\\~]/g, "\\$&");

/** The record split on unescaped separators. `String.split` cannot do this
 *  without a lookbehind that Safari only learned recently, and a walk is
 *  shorter than the regex would be. */
function fields(record: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < record.length; i += 1) {
    const char = record[i];
    if (char === "\\" && i + 1 < record.length) {
      current += record[i + 1];
      i += 1;
    } else if (char === "~") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

/** Trailing empties dropped: an event with a title and nothing else is
 *  four fields, not eleven. */
function pack(parts: string[], separator: string): string {
  let end = parts.length;
  while (end > 0 && parts[end - 1] === "") end -= 1;
  return parts.slice(0, end).join(separator);
}

const utf8 = new TextEncoder();
/** Fatal, so a mangled payload is a refusal rather than an event whose
 *  title is a row of replacement characters. */
const utf8Reader = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(value: string): string {
  const bytes = utf8.encode(value);
  let binary = "";
  // A byte at a time rather than `String.fromCharCode(...bytes)`: the
  // spread is a call with one argument per byte, which the payload cap
  // makes survivable and does not make correct.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return utf8Reader.decode(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------- the rule --------------------------------- */

/** `2026-03-08T09:00:00` → `20260308T090000`, and back. An EXDATE key's
 *  separators are the same four characters in every key, so they are
 *  spelled here once rather than carried once per key on the wire — and the
 *  pair MUST stay exact inverses, which is why they sit together. */
const packKey = (key: string) => key.replace(/[-:]/g, "");

const unpackKey = (packed: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(packed);
  if (!m) return packed;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return m[4] ? `${date}T${m[4]}:${m[5]}:${m[6]}` : date;
};

/**
 * A `Recurrence` as one field of the record, or `""` for an event that
 * happens once and names no dates of its own.
 *
 * Positional again, and the order is **by how often a real rule fills the
 * field in** rather than by the RFC's own listing: frequency, interval,
 * bound, weekdays, then the two date lists a deleted occurrence writes,
 * and only then the BY* cascade almost nothing uses. Trailing empties are
 * dropped, so ordering it the RFC's way cost ten separators on every
 * series with one skipped day. `interval`, `wkst` and `until` are omitted
 * at their own defaults rather than written as `1`, `1` and `0`.
 */
function encodeRule(event: ShareDraft): string {
  if (event.repeat === "never" && event.rdates.length === 0 && event.exdates.length === 0)
    return "";
  const ints = (list: number[]) => list.map(b36).join(",");
  return pack(
    [
      REPEAT_CODES[event.repeat],
      event.interval === 1 ? "" : b36(event.interval),
      event.until > 0 ? b36(Math.floor(event.until / 1000)) : "",
      // `nth` first and the weekday last, which is what makes it readable
      // back without a separator: a weekday is one digit, so whatever
      // precedes it is the position.
      event.byDay.map((d) => `${d.nth === 0 ? "" : d.nth}${d.day}`).join(","),
      event.exdates.map(packKey).join(","),
      event.rdates.map(packKey).join(","),
      ints(event.byMonthDay),
      ints(event.byMonth),
      ints(event.byHour),
      ints(event.byMinute),
      ints(event.bySecond),
      ints(event.byWeekNo),
      ints(event.byYearDay),
      ints(event.bySetPos),
      event.wkst === 1 ? "" : b36(event.wkst),
    ],
    ";",
  );
}

/**
 * The rule field back into the loose shape `readRecurrence` validates.
 *
 * Nothing is range-checked here on purpose: what a legal rule is lives in
 * `recur.ts` and has three readers already, and a fourth opinion about
 * BYMONTHDAY is the mistake that file's own comment documents. Junk
 * arrives as `NaN` or as a key that matches neither of EXDATE's two forms,
 * which is exactly what that validator drops.
 */
function decodeRule(field: string): Record<string, unknown> {
  const parts = field.split(";");
  const at = (i: number) => parts[i] ?? "";
  const ints = (i: number) => at(i).split(",").filter(Boolean).map(fromB36);
  const until = fromB36(at(2));
  return {
    repeat: REPEAT_BY_CODE[at(0)],
    interval: fromB36(at(1)),
    until: Number.isNaN(until) ? 0 : until * 1000,
    byDay: at(3)
      .split(",")
      .filter(Boolean)
      .map((token) => {
        const m = /^([+-]?\d*)(\d)$/.exec(token);
        return m ? { day: Number(m[2]), nth: m[1] ? Number(m[1]) : 0 } : { day: NaN, nth: NaN };
      }),
    exdates: at(4).split(",").filter(Boolean).map(unpackKey),
    rdates: at(5).split(",").filter(Boolean).map(unpackKey),
    byMonthDay: ints(6),
    byMonth: ints(7),
    byHour: ints(8),
    byMinute: ints(9),
    bySecond: ints(10),
    byWeekNo: ints(11),
    byYearDay: ints(12),
    bySetPos: ints(13),
    wkst: fromB36(at(14)),
  };
}

/* --------------------------------- encode --------------------------------- */

/**
 * One event as a payload, or a refusal.
 *
 * What travels is decided field by field rather than by serialising
 * whatever is on the object — the same walk `duplicateOf` makes, and for
 * two of the fields the same answer.
 *
 * Travelling: `title`, the instants, `allDay`, `task`, `free`, `tzid`
 * (the zone the *rule* is read against, so a series shared out of a feed
 * still lands on the right days), `location`, `url`, `notes`, `color`,
 * `icon` and the whole `Recurrence`. That is what the sender was looking
 * at, which is what "share this event" means.
 *
 * Deliberately not travelling:
 *
 * - **`organizer`, `attendees`, `attendeeCount`.** Other people's names
 *   and addresses, and a link is pasted into chat apps, group threads and
 *   ticket systems. This app cannot send an invitation and has no control
 *   that would make one, so a guest list here could only ever be a record
 *   of somebody else's — handing it on is a disclosure the sender did not
 *   ask for. `duplicateOf` refuses them for the neighbouring reason.
 * - **`id`.** A receiver's copy is their own event; carrying the sender's
 *   identity would let one id name two events in two calendars, and a
 *   later import would treat them as one.
 * - **`seriesId`/`seriesKey`.** They name a relationship to another event,
 *   and that event is not in the link. A shared override is an ordinary
 *   event on the day it used to replace.
 * - **`doneKeys`.** Ticks against work the *sender* did. A shared task
 *   arriving pre-ticked is a to-do list that lies.
 * - **`remindLead`.** It overrides the *reader's* own setting, and how much
 *   warning the sender wants about their day is not part of what the event
 *   is — the same reason a `.ics` carries no preferences. Absent, the field
 *   arrives as `REMIND_INHERIT`, which is precisely "follow this reader's
 *   setting" rather than somebody else's answer.
 * - **`calendarId`.** The receiver's calendars are their own, so the
 *   editor they are shown picks the default and they can change it.
 *
 * An **all-day event travels as a day and a day count, never as two
 * instants**, and that is the one instant decision in the format. Its
 * instants are local midnights, so an epoch second minted in Berlin is
 * mid-afternoon of the day before in Los Angeles: a birthday would arrive
 * on the wrong date, spanning two days, and the receiver would have no way
 * to know. A day is a day everywhere, so the day key crosses and the
 * receiver's own midnights are rebuilt from it with calendar arithmetic —
 * the same re-anchoring `travel.ts` does for a device that moved, and the
 * same reason `draftEvent` builds an all-day `end` with `addDays` rather
 * than adding minutes. A **timed** event is the opposite and for the same
 * model: an instant is absolute, so 18:00 in Berlin genuinely is 09:00 in
 * Los Angeles and that is what the receiver should see. Sending the wall
 * clock instead would be inventing a floating event out of a moment two
 * people are meant to share.
 */
export function encodeShare(event: ShareDraft): ShareEncoded {
  const flags = (event.allDay ? ALL_DAY : 0) | (event.task ? TASK : 0) | (event.free ? FREE : 0);
  let when: string;
  let length: string;
  if (event.allDay) {
    const first = startOfDay(new Date(event.start));
    when = b36(first.getFullYear() * 10_000 + (first.getMonth() + 1) * 100 + first.getDate());
    // Days covered, off the exclusive end: `end - 1` names the last day, which
    // is the measurement the editor's own Date row makes. Rounded because a
    // span across a transition is not a whole number of 24-hour days, and
    // floored at one because a corrupt `end` must not encode a span of none.
    const spanned = startOfDay(new Date(event.end - 1)).getTime() - first.getTime();
    length = b36(Math.max(1, Math.round(spanned / 86_400_000) + 1));
  } else {
    when = b36(Math.floor(event.start / 1000));
    length = b36(Math.floor(event.end / 1000) - Math.floor(event.start / 1000));
  }

  const record = pack(
    [
      b36(flags),
      when,
      length,
      escapeText(event.title),
      encodeRule(event),
      escapeText(event.tzid),
      escapeText(event.location),
      escapeText(event.url),
      escapeText(event.notes),
      escapeText(event.color),
      escapeText(event.icon),
    ],
    "~",
  );
  const token = `${b36(SHARE_VERSION)}.${shareCheck(record)}.${toBase64Url(record)}`;
  return token.length > SHARE_MAX ? { ok: false, reason: "too-long" } : { ok: true, token };
}

/* --------------------------------- decode --------------------------------- */

/**
 * A payload back into a draft, or why it is not one.
 *
 * This is a string from a stranger, so it takes `backup.ts`'s posture
 * whole: nothing throws out of here, and every value that survives the
 * shape check is handed to `backup.readEvent` rather than trusted. That is
 * deliberately the *same* validator a `.json` restore goes through — it
 * already owns what a legal title, zone, mark and rule are, and a second
 * opinion here is how two paths come to disagree about what an event is.
 * The instants are the exception it cannot cover, because the day form is
 * this format's own: a day key outside the calendar is refused here, and
 * everything else (a `NaN` instant, an end before its start, a task's
 * zero width) is refused there.
 *
 * `calendarId` is the caller's, because the receiver's calendars are not
 * the sender's — see `encodeShare` on what does not travel.
 */
export function decodeShare(token: string, calendarId: string): ShareDecoded {
  // Length first, so an absurd payload costs a comparison rather than a
  // decode.
  if (token.length > SHARE_MAX) return { ok: false, reason: "too-long" };
  const [versionField, check, body, ...extra] = token.split(".");
  if (extra.length > 0 || !body) return { ok: false, reason: "unreadable" };
  const version = fromB36(versionField);
  if (Number.isNaN(version)) return { ok: false, reason: "unreadable" };
  // A version from the future is not a corrupt link and must not be reported
  // as one: the sender's link is fine, this build is behind. Asked before the
  // check, because a later version may not even compute one this way.
  if (version !== SHARE_VERSION) return { ok: false, reason: "version" };

  const record = fromBase64Url(body);
  if (record === null) return { ok: false, reason: "unreadable" };
  // The truncation gate: legal bytes carrying a shortened record get this far
  // and nothing further on would notice.
  if (check !== shareCheck(record)) return { ok: false, reason: "unreadable" };

  const parts = fields(record);
  const flags = fromB36(parts[0] ?? "");
  if (Number.isNaN(flags)) return { ok: false, reason: "unreadable" };
  const allDay = (flags & ALL_DAY) !== 0;
  const instants = allDay
    ? allDayInstants(fromB36(parts[1] ?? ""), fromB36(parts[2] ?? ""))
    : timedInstants(fromB36(parts[1] ?? ""), fromB36(parts[2] ?? ""));
  if (!instants) return { ok: false, reason: "unreadable" };

  const rule = parts[4] ? decodeRule(parts[4]) : {};
  const read = readEvent({
    ...rule,
    ...instants,
    calendarId,
    title: parts[3] ?? "",
    allDay,
    task: (flags & TASK) !== 0,
    free: (flags & FREE) !== 0,
    tzid: parts[5] ?? "",
    location: parts[6] ?? "",
    url: parts[7] ?? "",
    notes: parts[8] ?? "",
    color: parts[9] ?? "",
    icon: parts[10] ?? "",
  });
  if (!read) return { ok: false, reason: "unreadable" };
  const { id: _id, ...draft } = read;
  return { ok: true, draft };
}

/** A timed pair, in milliseconds. A negative length is refused rather than
 *  turned round: an end before its start is a corrupt payload, and
 *  `readEvent` would drop it one line later anyway. */
function timedInstants(seconds: number, length: number) {
  if (!Number.isFinite(seconds) || !Number.isFinite(length) || length < 0) return null;
  const start = seconds * 1000;
  return { start, end: start + length * 1000 };
}

/**
 * `20260308` and a day count → this reader's own two midnights.
 *
 * The parts are checked rather than handed to `new Date(y, m, d)`, which
 * normalises: month 13 is silently next January, and an event on a day
 * nobody named is worse than a refused link.
 */
function allDayInstants(packed: number, days: number) {
  if (!Number.isInteger(packed) || packed < 1_000_000 || packed > 99_991_231) return null;
  if (!Number.isInteger(days) || days < 1) return null;
  const year = Math.trunc(packed / 10_000);
  const month = Math.trunc(packed / 100) % 100;
  const dayOfMonth = packed % 100;
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const start = new Date(year, month - 1, dayOfMonth);
  if (start.getMonth() !== month - 1 || start.getDate() !== dayOfMonth) return null;
  // Calendar arithmetic, not `days × 1440 minutes`: a span across a DST
  // transition is not a whole number of days long, and an all-day `end`
  // has to *be* a midnight or the last day drops off the dial.
  return { start: start.getTime(), end: addDays(start, days).getTime() };
}

/* -------------------------------- fragment -------------------------------- */

/** The payload as a fragment, ready to be appended to this app's own URL. */
export function shareFragment(token: string): string {
  return `${FRAGMENT_PREFIX}${token}`;
}

/**
 * The payload out of `window.location.hash`, or `""` for a fragment that
 * is not one of ours — including no fragment at all, which is every
 * ordinary load.
 */
export function shareToken(hash: string): string {
  return hash.startsWith(FRAGMENT_PREFIX) ? hash.slice(FRAGMENT_PREFIX.length) : "";
}
