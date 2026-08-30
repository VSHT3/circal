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
 *
 * `METHOD` is deliberately not read, and that is a decision rather than an
 * omission. It is the calendar-level property that separates an invitation
 * (`REQUEST`) from a published feed (`PUBLISH`), and from a `REPLY` or a
 * `CANCEL` about an event you already hold — but every one of those readings
 * only pays off in the half of the protocol circal has refused. `REQUEST`
 * would want an Accept button; `REPLY` would have to patch a `PARTSTAT` on an
 * event already on the dial; `CANCEL` would have to delete somebody else's
 * event on their say-so. Circal imports every `.ics` the same way — into a new
 * calendar of its own, one undo step away — and the one fact the surface
 * prints, that a named person organised this and these people were asked, is
 * already spelled by ORGANIZER and ATTENDEE on the VEVENT itself. So reading
 * `METHOD` would change nothing and would leave a field inviting exactly the
 * branch this scope excludes. `toIcs` writes none either: an export carrying
 * `METHOD:REQUEST` is this app claiming to be the organiser of a meeting it
 * only read, which is how a consumer is told to start sending replies.
 * ------------------------------------------------------------------ */

import { dayKey, isZone, wallClockIn, zonedToUtc } from "./time";
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
  REMIND_INHERIT,
  ownLead,
  readGuests,
  readPerson,
  readRemindLead,
  readTravel,
  type Attendee,
  type CalEvent,
  type Person,
  type Recurrence,
  type Repeat,
  type WeekdayRule,
} from "./events";
import { readEstimate, readPlans, type Plan, type Task } from "./tasks";

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
  /**
   * DTSTART's own zone — `""` for UTC, floating, all-day, or a `TZID` this
   * build's `Intl` does not recognise. Becomes `CalEvent.tzid` verbatim
   * once a consumer (`feeds.ts`, `backup.ts`'s `.ics` import) copies this
   * event across; nothing here reads it back.
   */
  tzid: string;
  location: string;
  url: string;
  notes: string;
  /**
   * `TRANSP` — the one property in this pair that is the standard's own.
   * §3.8.2.7 defines exactly two values: `OPAQUE`, the default, is time that
   * blocks; `TRANSPARENT` is time that does not. An absent property is
   * `OPAQUE`, so `false` is both the default and what every producer that
   * says nothing means.
   */
  free: boolean;
  /**
   * `X-APPLE-TRAVEL-DURATION`, in whole minutes, `0` for a VEVENT that named
   * no travel. Apple Calendar's own spelling, and the reason this is not an
   * `X-CIRCAL-` line: Apple writes it, reserves the same window as busy and
   * raises its "time to leave" alert from it, so a run-up round-trips through
   * a calendar somebody else already owns. `X-APPLE-TRAVEL-START` is not
   * read or written — it is a place, and circal holds none.
   */
  travel: number;
  /**
   * The lead from the first `VALARM` this reader could model, in
   * `CalEvent.remindLead`'s own three-state vocabulary — `REMIND_INHERIT`
   * for a VEVENT that carried no alarm, or none this app can count down in.
   *
   * Never `REMIND_SILENT`: a file that says nothing about alarms is not the
   * same statement as an event asking for silence, and reading an absence
   * as a refusal would import a calendar that never speaks.
   */
  remindLead: number;
  /**
   * `ORGANIZER`, or `null` when the VEVENT named nobody — a published calendar
   * usually does not, an invitation always does.
   */
  organizer: Person | null;
  /**
   * `ATTENDEE`, one entry per line, capped and de-duplicated by `readGuests`.
   * `attendeeCount` is how many the file named before the cap, which is the
   * only way the surface can say what it is not showing.
   */
  attendees: Attendee[];
  attendeeCount: number;
}

/** A VTODO reduced to what circal models (TASKS.md §11). `uid` is kept for
 *  the reason `IcsEvent`'s is: a re-import replaces rather than duplicates. */
export interface IcsTask {
  uid: string;
  title: string;
  notes: string;
  /** Epoch ms; `dueAllDay` says whether it is a day or a day and a minute.
   *  Always present — a VTODO with no `DUE` has no day, and everything here
   *  lives on a day, so it is skipped rather than invented. */
  due: number;
  dueAllDay: boolean;
  estimate: number | null;
  priority: 0 | 1 | 2;
  /** First plan from `DTSTART` + `DURATION`, further ones from
   *  `X-CIRCAL-PLAN` period lines — through `readPlans`, the model's one
   *  validator, so a hand-written file obeys the same caps a backup does. */
  plans: Plan[];
  done: boolean;
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

/**
 * One `ORGANIZER`/`ATTENDEE` line: `NAME;CN="…"<extra>:mailto:someone@host`.
 *
 * Two rules, both about the fact that a param value is *not* escaped the way a
 * property value is — §3.1 gives it quoting instead, so `escapeText` here
 * would write literal backslashes into somebody else's address book. A `CN` is
 * always quoted (a real display name carries commas and colons: `"Lovelace,
 * Ada (Analytical Engine)"`), and the two characters a QSAFE-CHAR may not be —
 * a double quote and a control character — are dropped rather than escaped:
 * RFC 6868's `^"` encoding exists but is younger than most consumers, and a
 * name that loses one quote mark still names the person, where a param a
 * reader chokes on loses the whole line.
 *
 * The value keeps whatever scheme it arrived with. `mailto:` is put back
 * because that is what was taken off on the way in, and an address that
 * already carries a scheme of its own (`urn:`, `sip:` — a `CAL-ADDRESS` is any
 * URI) is written through untouched rather than mailed to.
 */
function calAddressLine(property: string, person: Person, extra: string): string {
  // Filtered by code point rather than by a regex: a class holding the C0
  // range is a `no-control-regex` error, and spelling those bytes as an escape
  // in source is the kind of line a later reader deletes as a typo.
  const cn = [...person.name]
    .filter((c) => c !== '"' && c >= " " && c !== "\u007f")
    .join("")
    .trim();
  const address = person.address.includes(":") ? person.address : `mailto:${person.address}`;
  return `${property}${cn ? `;CN="${cn}"` : ""}${extra}:${address}`;
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

/** The wall-clock stamp DTSTART/DTEND/RECURRENCE-ID take with a `TZID`
 *  param — `YYYYMMDDTHHMMSS`, no trailing `Z`, because the param already
 *  says which clock the digits are on. `d` is expected to already be a
 *  wall-clock `Date` from `wallClockIn`, not a real instant. */
function zonedStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The §3.3.6 duration value for a count of whole minutes — the only unit
 *  this app writes a duration in, so the one form covers a task's planned
 *  block and an event's travel run-up both. `parseDuration` is its opposite
 *  half, and reads every longer form back. */
function minutesDuration(minutes: number): string {
  return `PT${minutes}M`;
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
    // series, a UTC datetime for a timed one, *even when DTSTART carries a
    // TZID*: §3.3.10 requires exactly that once a zone is present, which
    // makes this UTC stamp load-bearing rather than incidental now — a
    // wall-clock UNTIL would read differently depending on which zone
    // resolved it, and RFC's own fix is to pin it to UTC instead.
    const until = new Date(event.until);
    parts.push(`UNTIL=${event.allDay ? dateStamp(until) : utcStamp(until)}`);
  }
  return parts.join(";");
}

/**
 * EXDATE/RDATE lines for one property, grouped by the value type each key
 * already names: a day key (`YYYY-MM-DD`) goes on one `VALUE=DATE` line, an
 * instant key (`YYYY-MM-DDTHH:mm:ss`) goes on one plain line — UTC for a
 * floating event, `;TZID=<zone>:` for a zoned one. RFC lets the property
 * repeat, but never mixes value types on a line.
 *
 * A zoned key's digits are not converted: `parseDateList` put that zone's
 * own wall-clock digits there on the way in (see its own comment), so
 * `20260615T090000` comes back out exactly as `2026-06-15T09:00:00` went in
 * — the identity `keyToInstant`/`utcStamp` only need for the floating case,
 * where the key has no zone of its own to carry.
 */
function recurDateLines(
  name: "EXDATE" | "RDATE",
  keys: string[],
  seed: Date,
  zone: string,
): string[] {
  const days = keys.filter((k) => !k.includes("T")).sort();
  const instants = keys.filter((k) => k.includes("T")).sort();

  const lines: string[] = [];
  if (days.length > 0) {
    lines.push(`${name};VALUE=DATE:${days.map((k) => k.replace(/-/g, "")).join(",")}`);
  }
  if (instants.length > 0) {
    if (zone) {
      const stamps = instants.map((k) => k.replace(/[-:]/g, ""));
      lines.push(`${name};TZID=${zone}:${stamps.join(",")}`);
    } else {
      const stamps = instants
        .map((k) => keyToInstant(k, seed))
        .filter((ms): ms is number => ms !== null)
        .map((ms) => utcStamp(new Date(ms)));
      if (stamps.length > 0) lines.push(`${name}:${stamps.join(",")}`);
    }
  }
  return lines;
}

/* -------------------------------- serialise -------------------------------- */

/**
 * The right-hand side of every UID this app *writes*. It exists to name a
 * domain the producer owns; uniqueness is carried entirely by the left-hand
 * side (`event.id`), so nothing about the format depends on this string.
 *
 * **Changing it is not free, and this is the cost.** A consumer that keys on
 * UID — Google, Apple, Outlook, Fastmail all do — treats a changed domain as
 * a different event, so anyone who exported an `.ics` under the old value and
 * imported it somewhere gets a *second copy of every event in both exports*
 * on their next export-and-import into that same calendar. The old copies do
 * not update and do not disappear; they sit alongside. It was changed once,
 * from `circal.app` to `circal.day`, when it turned out `circal.app` had
 * belonged to somebody else since 2022 — done then because nothing was yet
 * deployed on any custom domain, which is as small as that population gets.
 *
 * What is *not* affected, which is most of it: circal → circal handoff, since
 * `importIcs` mints a fresh id per uid and never matches on the uid itself
 * (`backup.ts`, and its comment saying a uid is not what the store indexes
 * by); the `.json` backup, the mirror file and the cloud row, none of which
 * carry a uid at all. `toIcs` has exactly one caller — the Export button —
 * so a hand-written `.ics` is the only way this string ever leaves.
 *
 * Not the domain a *synthesised* uid gets: a VEVENT that arrived without one
 * is stamped `@circal.local` by `derivedUid`, deliberately a reserved
 * non-routable TLD, so a fabricated id can never be mistaken for a minted
 * one. Changing this constant must not change that one.
 */
const UID_DOMAIN = "circal.day";

/**
 * `name` becomes X-WR-CALNAME.
 *
 * No VTIMEZONE component, zoned event or not. Every mainstream consumer
 * (Google, Apple, Outlook) resolves an IANA `TZID` against its own tz
 * database rather than reading the one a file brought — RFC 5545 allows
 * either, but nothing worth writing for prefers the file's copy — and a
 * synthesised VTIMEZONE would have to either duplicate that whole database
 * (every rule, every historical transition) or lie about the DST rules
 * outside the one range it bothered to write. A wrong DST rule reads as a
 * *correct* time that is quietly an hour off, which is worse than the UTC
 * export this feature replaces: that one at least loses cleanly.
 */
export function toIcs(events: CalEvent[], name: string, tasks: Task[] = []): string {
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
    const uid = `${overrides ? overrides.id : event.id}@${UID_DOMAIN}`;
    const zone = event.tzid;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(new Date(event.start))}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(new Date(event.end))}`);
    } else if (zone) {
      lines.push(`DTSTART;TZID=${zone}:${zonedStamp(wallClockIn(event.start, zone))}`);
      lines.push(`DTEND;TZID=${zone}:${zonedStamp(wallClockIn(event.end, zone))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(event.start))}`);
      lines.push(`DTEND:${utcStamp(new Date(event.end))}`);
    }
    if (overrides) {
      // Matches this VEVENT's own DTSTART value type, as RFC requires.
      const at = keyToInstant(event.seriesKey, new Date(event.start));
      if (at !== null) {
        lines.push(
          event.allDay
            ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(new Date(at))}`
            : zone
              ? `RECURRENCE-ID;TZID=${zone}:${zonedStamp(wallClockIn(at, zone))}`
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
    lines.push(...recurDateLines("EXDATE", event.exdates, seed, zone));
    lines.push(...recurDateLines("RDATE", event.rdates, seed, zone));
    // Written only when it is not the default, which is what `OPAQUE` is:
    // every other calendar reads an absent `TRANSP` as busy, so a line
    // saying so is a line saying nothing.
    if (event.free) lines.push("TRANSP:TRANSPARENT");
    // Apple Calendar's property, not an `X-CIRCAL-` one: it writes this,
    // reserves the window as busy and raises its own "time to leave" alert
    // from it, so a run-up survives a trip through a calendar circal does not
    // own. `VALUE=DURATION` is stated because an `X-` property has no
    // registered type. Zero writes nothing, `TRANSP`'s reason: a line naming
    // the default names nothing.
    if (event.travel > 0)
      lines.push(`X-APPLE-TRAVEL-DURATION;VALUE=DURATION:${minutesDuration(event.travel)}`);
    // `ORGANIZER` and `ATTENDEE`, the two properties that make a VEVENT an
    // invitation rather than a notice. Written back because they came in: a
    // file whose guest list survives one import and is gone from the next
    // export is a file that quietly loses the only record of who was asked.
    // Nothing here says the export *is* an invitation — no `METHOD`, no
    // `RSVP`, no `SEQUENCE` — see this file's own header.
    if (event.organizer) lines.push(calAddressLine("ORGANIZER", event.organizer, ""));
    for (const attendee of event.attendees) {
      // `PARTSTAT` only when it is not the RFC's own default, exactly as
      // `TRANSP` is written only when it is not `OPAQUE`: `NEEDS-ACTION` is
      // what an absent param already means, so the line would say nothing.
      // The stored value is the RFC token in lower case, so upper-casing it
      // is the whole conversion rather than a table that could disagree.
      const partstat =
        attendee.status === "needs-action" ? "" : `;PARTSTAT=${attendee.status.toUpperCase()}`;
      lines.push(calAddressLine("ATTENDEE", attendee, partstat));
    }
    // A `VALARM` only for an event that named a lead of its own. An event
    // inheriting the setting has no per-event alarm to export, and writing
    // the current setting into the file would turn a preference into data:
    // it would come back on the next import as an override nobody set, and
    // then stop following the setting it was a copy of. A silent event
    // exports no alarm either — that is the honest answer rather than a
    // clever one, because iCalendar has no way to spell "and do not apply
    // your own default here": the absence of a VALARM is the only thing a
    // file can say, and it is exactly what circal will read back as
    // "inherit". Silence is the one state that does not survive an export,
    // and inventing an `X-` line for it would make it survive only into
    // circal, which is the app that already has the value.
    const lead = ownLead(event);
    if (lead !== null) {
      lines.push("BEGIN:VALARM");
      // §3.6.6 requires ACTION and TRIGGER, and DESCRIPTION as well once the
      // action is DISPLAY — an alarm with nothing to display is rejected by
      // strict readers rather than shown blank.
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${escapeText(event.title || "Reminder")}`);
      // Whole minutes, the only unit this app counts leads in, and negative
      // because a lead is time *before* the start. Zero is the exception and
      // takes the unsigned form every mainstream producer writes for "at the
      // time of the event": a negative zero duration is legal ABNF and reads
      // as a typo.
      lines.push(lead === 0 ? "TRIGGER:PT0S" : `TRIGGER:-PT${lead}M`);
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");
  }

  // Tasks as VTODO — the true thing on the wire (TASKS.md §11). The cost is
  // named there: a consumer that ignores VTODO shows nothing, where the old
  // zero-width VEVENT was rendered by everybody. `DUE`, `PRIORITY` and
  // `STATUS` are the standard's own; the first plan rides `DTSTART` +
  // `DURATION` (both legal on a VTODO), further plans and the estimate take
  // `X-CIRCAL-` lines, since RFC 5545 has no property for either.
  for (const task of tasks) {
    lines.push("BEGIN:VTODO");
    lines.push(`UID:${task.id}@${UID_DOMAIN}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${escapeText(task.title)}`);
    lines.push(
      task.dueAllDay
        ? `DUE;VALUE=DATE:${dateStamp(new Date(task.due))}`
        : `DUE:${utcStamp(new Date(task.due))}`,
    );
    if (task.notes) lines.push(`DESCRIPTION:${escapeText(task.notes)}`);
    // §3.8.1.9: 1 is the highest urgency and 0 is "undefined", so normal
    // writes nothing — an absent line already means it. High takes 4, the
    // top of CUA convention's middle band, so a three-state reader on the
    // other side keeps the three states apart.
    if (task.priority === 2) lines.push("PRIORITY:1");
    else if (task.priority === 1) lines.push("PRIORITY:4");
    if (task.done) lines.push("STATUS:COMPLETED");
    if (task.estimate !== null) lines.push(`X-CIRCAL-ESTIMATE:${task.estimate}`);
    const [first, ...rest] = task.plans;
    if (first) {
      lines.push(`DTSTART:${utcStamp(new Date(first.start))}`);
      lines.push(`DURATION:${minutesDuration(Math.round((first.end - first.start) / 60_000))}`);
    }
    for (const plan of rest) {
      lines.push(`X-CIRCAL-PLAN:${utcStamp(new Date(plan.start))}/${utcStamp(new Date(plan.end))}`);
    }
    lines.push("END:VTODO");
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

/** DTSTART/DTEND → an instant, whether it read as an all-day date, and the
 *  zone it was read in — `""` for UTC, floating, `VALUE=DATE`, or a `TZID`
 *  `isZone` refuses. */
function parseDateProp(
  prop: PropEntry | undefined,
): { ms: number; allDay: boolean; tzid: string } | null {
  if (!prop) return null;
  const { params, value } = prop;

  if (params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number);
    return { ms: new Date(y, mo - 1, d).getTime(), allDay: true, tzid: "" };
  }

  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc) {
    const [y, mo, d, h, mi, s] = utc.slice(1).map(Number);
    return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false, tzid: "" };
  }

  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!local) return null;
  const [y, mo, d, h, mi, s] = local.slice(1).map(Number);

  if (params.TZID && isZone(params.TZID)) {
    return { ms: zonedToUtc(y, mo, d, h, mi, params.TZID, s), allDay: false, tzid: params.TZID };
  }
  // An unrecognised TZID falls through here too: read as floating local
  // time rather than thrown on, same as no TZID at all.
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false, tzid: "" };
}

/**
 * One VEVENT's properties. EXDATE, RDATE and ATTENDEE are kept apart because
 * they are the properties here that legitimately appear on several lines of
 * the same component, and a flat map would keep only the last of each — which
 * is a series quietly gaining back every occurrence it was told to skip, or a
 * meeting of forty people arriving with one guest, the last one the sender
 * happened to list.
 *
 * `alarms` is apart for a different reason: a VALARM is a *component*, not a
 * property, and a VEVENT may carry several. Its lines must never land in
 * `props` — an alarm has its own DESCRIPTION and its own DURATION, and both
 * mean something else there.
 */
interface Block {
  props: Record<string, PropEntry>;
  exdates: PropEntry[];
  rdates: PropEntry[];
  attendees: PropEntry[];
  alarms: Record<string, PropEntry>[];
}

/**
 * One `CAL-ADDRESS` property — `ORGANIZER`, `ATTENDEE` — as the pair circal
 * prints, or `null` when the line named nobody and is therefore malformed.
 *
 * The value is a URI and is normally `mailto:`, which is stripped: the scheme
 * is a spelling of "this is an address" and printing it spends a third of a
 * 320px row saying so. Case-insensitively, because §3.3.3 says a scheme is,
 * and Outlook writes `MAILTO:`. Anything else keeps its scheme, since a
 * `CAL-ADDRESS` may legitimately be another kind of URI and guessing it is
 * mail would be inventing an address.
 *
 * `CN` is the display name and is genuinely optional — a file that names only
 * the mailbox is normal, not broken, so the caller prints the address instead.
 * The other params are read by nothing: `readGuests` takes `PARTSTAT` off the
 * `status` field this hands it, and `ROLE`/`RSVP` are dropped for the reasons
 * `PARTSTATS` gives.
 */
function readCalAddress(prop: PropEntry | undefined): (Person & { status: string }) | null {
  if (!prop) return null;
  const raw = prop.value.trim();
  const address = /^mailto:/i.test(raw) ? raw.slice(7).trim() : raw;
  if (!address) return null;
  // A param value is quoted rather than escaped, and `splitLine` has already
  // taken the quotes off — so `unescapeText` here would eat backslashes that
  // are part of somebody's name.
  return { name: (prop.params.CN ?? "").trim(), address, status: prop.params.PARTSTAT ?? "" };
}

/**
 * The lead the first modelable `VALARM` asks for, in minutes, or
 * `REMIND_INHERIT` when there is none.
 *
 * Only one shape is read, and everything else is ignored rather than guessed
 * at: a `TRIGGER` that is a duration relative to the start (which is
 * `RELATED=START`, the RFC's own default) and lands at or before it. What
 * that leaves out is deliberate — an absolute `VALUE=DATE-TIME` trigger is a
 * wall-clock alarm rather than a lead and would have to be recomputed for
 * every occurrence of a series; `RELATED=END` counts from an end this app
 * does not count down to; a positive duration fires *after* the start, which
 * is not a warning; `REPEAT`/`DURATION` are an alarm that nags, and circal
 * notifies once; and `ACTION` is not read at all, because an EMAIL alarm's
 * lead is still the lead the sender wanted. A trigger that is not a whole
 * number of minutes is dropped too: the tick is minute-grained, and rounding
 * ninety seconds to one minute or to two would be inventing an answer.
 *
 * The *first* such alarm, not the shortest or the longest. Several is a
 * calendar that nags in stages, which circal does not model, and taking the
 * one the sender wrote first is the only choice that does not silently
 * re-rank somebody else's intent.
 */
function readAlarmLead(alarms: Record<string, PropEntry>[]): number {
  for (const alarm of alarms) {
    const trigger = alarm.TRIGGER;
    if (!trigger) continue;
    if (trigger.params.VALUE?.toUpperCase().trim() === "DATE-TIME") continue;
    const related = trigger.params.RELATED?.toUpperCase().trim();
    if (related && related !== "START") continue;
    const ms = parseDuration(trigger.value.trim());
    if (ms === null || ms > 0) continue;
    // `Math.abs`, not a negation: `ms` is zero or below, and negating a zero
    // gives `-0`, which stores and compares as a different number from the
    // `0` every other reader of this field writes.
    const minutes = Math.abs(ms) / 60_000;
    // Whether that is a lead at all is `events.ts`'s question, not this
    // file's: a whole number of minutes inside the cap. `minutes` is never
    // negative here, so the inheriting answer can only mean "not one this
    // app can model" — read as ignore, and the next alarm gets its turn.
    const lead = readRemindLead(minutes);
    if (lead === REMIND_INHERIT) continue;
    return lead;
  }
  return REMIND_INHERIT;
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
 *
 * A zoned event's key is that *zone's* wall clock, not `propKey`'s reading
 * of it. `startsBetweenIn` walks the rule over the zone's own wall time
 * (see its comment in `recur.ts`), so an EXDATE has to name a slot on that
 * same walked clock or the day it excludes there is not the day it names
 * here. `eventTzid` is DTSTART's own zone, read whenever a line omits a
 * `TZID` of its own — the common shape, since only a pedantic producer
 * repeats it on every EXDATE line RFC lets it carry one.
 */
function parseDateList(entries: PropEntry[], eventTzid: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const lineTzid = entry.params.TZID && isZone(entry.params.TZID) ? entry.params.TZID : "";
    const zone = lineTzid || eventTzid;
    for (const raw of entry.value.split(",")) {
      const token = entry.params.VALUE === "PERIOD" ? raw.trim().split("/")[0] : raw.trim();
      const parsed = parseDateProp({ params: entry.params, value: token });
      if (!parsed) continue;
      const key = parsed.allDay
        ? dayKey(new Date(parsed.ms))
        : instantKey(zone ? wallClockIn(parsed.ms, zone) : parsed.ms);
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
function readRecurrence(block: Block, start: number, tzid: string): Recurrence {
  // EXDATE and RDATE are properties of the VEVENT, not of the RRULE, and
  // RFC 5545 allows a series made of RDATEs alone. The model handles that —
  // `repeats()` is true for rdates with `repeat: "never"`, and
  // `startsBetween` adds them whatever the frequency — so dropping them with
  // the rule lost dates a producer had named explicitly.
  const dates = {
    exdates: parseDateList(block.exdates, tzid),
    rdates: parseDateList(block.rdates, tzid),
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

  let end: number;
  const dtend = parseDateProp(props.DTEND);
  if (dtend) {
    end = dtend.ms;
  } else {
    const duration = props.DURATION ? parseDuration(props.DURATION.value) : null;
    // §3.6.1's hour-long fallback for a meeting sent without an end, a day for
    // an all-day one: it is what a reader expects, and reading either as
    // zero-length would collapse it onto the rim.
    end = dtstart.ms + (duration ?? (dtstart.allDay ? 86_400_000 : 3_600_000));
  }

  // A UID is required by RFC 5545, so this fallback only fires on a
  // non-conforming feed — which is to say, on exactly the feeds nobody can
  // fix. It must be *derived*, never generated: a random id here is a new id
  // on every pull, and `feeds.ts` builds the event's key from it, so React
  // remounted every arc each refresh — hover dropped, selection dropped, and
  // the arc under the pointer vanished and came back beneath it.
  const uidValue = props.UID?.value;
  const uid = uidValue ? unescapeText(uidValue) : derivedUid(props, dtstart.ms, end);

  // `parseDuration` is this module's one duration reader, so `PT1H` and
  // `PT1H30M` both arrive as minutes rather than needing a second parser
  // that could disagree with the first. It keeps seconds, and a fractional
  // minute (`PT90S`) is left for `readTravel` to refuse rather than rounded
  // here: a guessed commute is worse than none, and that refusal is the
  // model's own rule, stated once.
  const travelProp = props["X-APPLE-TRAVEL-DURATION"];
  const travelMs = travelProp ? parseDuration(travelProp.value.trim()) : null;

  return {
    uid,
    // `RANGE=THISANDFUTURE` is handled after every VEVENT is read, in
    // `linkThisAndFuture`, because it is a fact about two of them.
    recurrenceId: propKey(props["RECURRENCE-ID"]),
    title: props.SUMMARY ? unescapeText(props.SUMMARY.value) : "",
    start: dtstart.ms,
    end,
    allDay: dtstart.allDay,
    tzid: dtstart.tzid,
    location: props.LOCATION ? unescapeText(props.LOCATION.value) : "",
    url: props.URL ? unescapeText(props.URL.value) : "",
    notes: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : "",
    // §3.8.2.7 defines two values and no others, so the test is for the one
    // that means something: anything else — `OPAQUE`, a missing property, a
    // value this standard does not have — is busy, which is the default the
    // RFC itself names.
    free: props.TRANSP?.value.trim().toUpperCase() === "TRANSPARENT",
    // `readTravel` is the only bounds check, its five readers' reason: an
    // absent property, a negative duration, `PT99999H` and a value no parser
    // recognises all land on `0` by the one rule.
    travel: readTravel((travelMs ?? 0) / 60_000),
    remindLead: readAlarmLead(block.alarms),
    // Who asked, and who was asked. `readGuests` and `readPerson` own the
    // caps and the de-duplication, because a hand-edited backup and a
    // stranger's feed have to arrive at the same idea of a legal guest list —
    // one validator, three readers, exactly as `readRecurrence` is one. A line
    // naming nobody drops out here rather than becoming a blank row.
    //
    // No count is handed over: the file's own line total would count a
    // malformed line and count a merged reply's restated attendee twice, so
    // "and 40 others" would be measured against a number the sender did not
    // mean. The readable, de-duplicated total is the honest one, and
    // `readGuests` computes it from the list it just read.
    organizer: readPerson(readCalAddress(props.ORGANIZER)),
    ...readGuests(block.attendees.map(readCalAddress), undefined),
    ...readRecurrence(block, dtstart.ms, dtstart.tzid),
  };
}

/** One VTODO's properties, `Block`'s shape one component over: the flat map
 *  plus the one property that may repeat. */
interface TodoBlock {
  props: Record<string, PropEntry>;
  plans: PropEntry[];
}

/** An `X-CIRCAL-PLAN` period — two UTC stamps, `/`-joined, RFC 5545's own
 *  §3.3.9 explicit form. */
const PLAN_PERIOD = /^(\d{8}T\d{6}Z)\/(\d{8}T\d{6}Z)$/;

/**
 * One VTODO → the task circal models, or `null` for one it cannot place.
 * `DUE` is required — every task here carries a due date, and a dateless
 * to-do belongs to a different product — so a VTODO without one is skipped,
 * `buildEvent`'s own answer to a VEVENT without a DTSTART.
 */
function buildTask(block: TodoBlock): IcsTask | null {
  const props = block.props;
  const due = parseDateProp(props.DUE);
  if (!due) return null;

  const title = props.SUMMARY ? unescapeText(props.SUMMARY.value) : "";
  const uid = props.UID?.value.trim() || `todo-${fnv1a(`${title}|${due.ms}`)}@${UID_DOMAIN}`;

  // The first plan is DTSTART + DURATION on the VTODO itself; the rest are
  // X-CIRCAL-PLAN periods. All of it through `readPlans`, the model's one
  // validator, so the wire obeys the caps a backup already does.
  const raw: Plan[] = [];
  const start = parseDateProp(props.DTSTART);
  const duration = props.DURATION ? parseDuration(props.DURATION.value) : null;
  if (start && !start.allDay && duration !== null && duration > 0) {
    raw.push({ start: start.ms, end: start.ms + duration });
  }
  for (const entry of block.plans) {
    const m = PLAN_PERIOD.exec(entry.value.trim());
    if (!m) continue;
    const from = parseDateProp({ params: {}, value: m[1] });
    const to = parseDateProp({ params: {}, value: m[2] });
    if (from && to) raw.push({ start: from.ms, end: to.ms });
  }

  // §3.8.1.9: 1–4 are the high band, 5 medium, 6–9 low, 0 undefined. Three
  // states here, so the top of the band is urgent and the rest of it high —
  // the inverse of what the writer above spells.
  const rank = Number(props.PRIORITY?.value);
  const priority = rank >= 1 && rank <= 3 ? 2 : rank >= 4 && rank <= 6 ? 1 : 0;

  return {
    uid,
    title,
    notes: props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : "",
    due: due.ms,
    dueAllDay: due.allDay,
    // Through the model's own validator, `readPlans`'s reason: `null` for
    // anything unreadable, clamped otherwise.
    estimate: readEstimate(Number(props["X-CIRCAL-ESTIMATE"]?.value)),
    priority,
    plans: readPlans(raw),
    done: props.STATUS?.value.trim().toUpperCase() === "COMPLETED",
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
export function fromIcs(text: string): { name: string; events: IcsEvent[]; tasks: IcsTask[] } {
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
  const tasks: IcsTask[] = [];
  // Block nesting, tracked generically: a property belongs to the open
  // VEVENT only while VEVENT is the innermost block, so a VALARM (or
  // anything else) nested inside one can't leak its own properties in or
  // prematurely close it. The alarm is collected on its own for that exact
  // reason — it is the one nested block circal reads, and reading it is not
  // the same as letting it in.
  const stack: string[] = [];
  let current: Block | null = null;
  let alarm: Record<string, PropEntry> | null = null;
  // The open VTODO, tracked beside the open VEVENT rather than through it:
  // the two never nest, and a reader that shared `current` would let a
  // malformed file leak one component's properties into the other.
  let todo: TodoBlock | null = null;

  for (const raw of lines) {
    const parsed = splitLine(raw);
    if (!parsed) continue;
    const { name: propName, params, value } = parsed;

    if (propName === "BEGIN") {
      const block = value.toUpperCase();
      const inVevent = stack[stack.length - 1] === "VEVENT";
      stack.push(block);
      if (block === "VEVENT" && current === null)
        current = { props: {}, exdates: [], rdates: [], attendees: [], alarms: [] };
      // Only an alarm directly inside the open VEVENT. Anything deeper is a
      // component this reader has no opinion about.
      else if (block === "VALARM" && current !== null && inVevent) alarm = {};
      else if (block === "VTODO" && current === null && todo === null)
        todo = { props: {}, plans: [] };
      continue;
    }
    if (propName === "END") {
      const opened = stack.pop();
      if (opened === "VALARM" && alarm !== null && current !== null) {
        current.alarms.push(alarm);
        alarm = null;
      }
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
        // A file that opens a VALARM and never closes it must not hand that
        // alarm to the next VEVENT.
        alarm = null;
      }
      if (opened === "VTODO" && value.toUpperCase() === "VTODO" && todo !== null) {
        const task = buildTask(todo);
        if (task) tasks.push(task);
        todo = null;
      }
      continue;
    }

    if (alarm !== null && stack[stack.length - 1] === "VALARM") {
      alarm[propName] = { params, value };
    } else if (current !== null && stack[stack.length - 1] === "VEVENT") {
      if (propName === "EXDATE") current.exdates.push({ params, value });
      else if (propName === "RDATE") current.rdates.push({ params, value });
      // One line per guest, so this is the third property collected as a list
      // rather than kept in the flat map — a forty-person meeting arriving with
      // its last attendee is the same bug an EXDATE list flattened into one.
      else if (propName === "ATTENDEE") current.attendees.push({ params, value });
      else current.props[propName] = { params, value };
    } else if (todo !== null && stack[stack.length - 1] === "VTODO") {
      // Several plan lines per task, so a list, `EXDATE`'s own reason.
      if (propName === "X-CIRCAL-PLAN") todo.plans.push({ params, value });
      else todo.props[propName] = { params, value };
    } else if (current === null && propName === "X-WR-CALNAME") {
      name = unescapeText(value);
    }
  }

  return { name, events: linkThisAndFuture(read), tasks };
}
