/* ------------------------------------------------------------------ *
 * Recurrence, in English.
 *
 * Two questions, and they are one pair: can the editor's three rows
 * actually spell this rule (`isExpressible`), and if not, what sentence
 * stands in for it (`describeRule`). `nthLabel` is the third, for the one
 * monthly control that has to name a position in a dropdown.
 *
 * Pure string logic over `Recurrence` — no DOM, no draft, no component —
 * which is why it lives here rather than in `EventEditor.tsx`, where it
 * could not have the test file it earns.
 * ------------------------------------------------------------------ */

import { REPEATS, repeatUnit, type Recurrence } from "./events";
import { MONTHS, WEEKDAYS } from "./time";

const ORDINALS = ["", "First", "Second", "Third", "Fourth", "Fifth"];

/** How a monthly position reads: `Third Thursday`, `Last Thursday`. */
export function nthLabel(nth: number, weekday: number): string {
  const name = WEEKDAYS[weekday];
  if (nth > 0) return `${ORDINALS[nth] ?? nth} ${name}`;
  return nth === -1 ? `Last ${name}` : `${ORDINALS[-nth] ?? -nth} last ${name}`;
}

/**
 * Can the editor's rows actually spell this rule? A subscription's RRULE can
 * carry BYWEEKNO, BYSETPOS, a sub-daily FREQ, or a BY* combination none of
 * them offers — the three rows are a dial, not a parser, and forcing such a
 * rule onto the nearest checkbox is how an import quietly becomes a
 * different meeting. `describeRule` is what stands in when this is false.
 */
export function isExpressible(rule: Recurrence, seed: Date): boolean {
  if (!(REPEATS as readonly string[]).includes(rule.repeat)) return false;
  if (
    rule.byMonth.length > 0 ||
    rule.byWeekNo.length > 0 ||
    rule.byYearDay.length > 0 ||
    rule.byHour.length > 0 ||
    rule.byMinute.length > 0 ||
    rule.bySecond.length > 0 ||
    rule.bySetPos.length > 0
  ) {
    return false;
  }
  if (rule.repeat === "daily" || rule.repeat === "yearly") {
    return rule.byMonthDay.length === 0 && rule.byDay.length === 0;
  }
  if (rule.repeat === "weekly") {
    return rule.byMonthDay.length === 0 && rule.byDay.every((w) => w.nth === 0);
  }
  if (rule.repeat === "monthly") {
    if (rule.byMonthDay.length > 0 || rule.byDay.length > 1) return false;
    if (rule.byDay.length === 0) return true;
    const [w] = rule.byDay;
    const seedNth = Math.floor((seed.getDate() - 1) / 7) + 1;
    return w.day === seed.getDay() && (w.nth === seedNth || w.nth === -1);
  }
  return true; // "never"
}

const POSITIONS = ["", "first", "second", "third", "fourth", "fifth"];

/** `13` → "13th". A date has to read as a date inside a sentence. */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** `3` → "third", `-1` → "last", `-2` → "second from last". */
function positionWord(n: number): string {
  if (n > 0) return POSITIONS[n] ?? ordinal(n);
  return n === -1 ? "last" : `${POSITIONS[-n] ?? ordinal(-n)} from last`;
}

/** `-3` → "3rd from last", counted from the end of the month as RFC does. */
function monthDayWord(n: number): string {
  return n > 0 ? ordinal(n) : `${ordinal(-n)} from last`;
}

function joinWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The sentence a rule reads as when it cannot be edited here — "Every 2 weeks
 * on Tue and Thu until 1 Jan 2027".
 *
 * It has to be a sentence rather than a dump of the parts, because it is the
 * only thing standing between the reader and a rule they cannot see: "taking
 * the -1 of those" tells somebody nothing they did not already fear.
 */
export function describeRule(rule: Recurrence): string {
  const every = rule.interval > 1 ? `${rule.interval} ` : "";
  const parts = [`Every ${every}${repeatUnit(rule.repeat, rule.interval)}`];

  if (rule.byMonth.length > 0) {
    parts.push(`in ${joinWords(rule.byMonth.map((m) => MONTHS[m - 1].slice(0, 3)))}`);
  }
  if (rule.byWeekNo.length > 0) {
    parts.push(
      `in week${rule.byWeekNo.length > 1 ? "s" : ""} ${joinWords(rule.byWeekNo.map(String))}`,
    );
  }
  if (rule.byYearDay.length > 0) {
    parts.push(`on the ${joinWords(rule.byYearDay.map(monthDayWord))} day of the year`);
  }

  const days = rule.byDay.map((w) =>
    w.nth === 0
      ? WEEKDAYS[w.day].slice(0, 3)
      : `${positionWord(w.nth)} ${WEEKDAYS[w.day].slice(0, 3)}`,
  );
  const dates = rule.byMonthDay.map(monthDayWord);

  // BYSETPOS is an adjective on the days the rule just produced — "the last of
  // Mon, Tue, Wed, Thu and Fri" — never a clause bolted on after them.
  if (rule.bySetPos.length > 0 && days.length + dates.length > 0) {
    const pick = joinWords(rule.bySetPos.map(positionWord));
    parts.push(`on the ${pick} of ${joinWords([...dates, ...days])}`);
  } else {
    if (dates.length > 0) parts.push(`on the ${joinWords(dates)}`);
    if (days.length > 0) parts.push(`on ${joinWords(days)}`);
    if (rule.bySetPos.length > 0) {
      parts.push(`keeping the ${joinWords(rule.bySetPos.map(positionWord))}`);
    }
  }

  if (rule.byHour.length > 0 || rule.byMinute.length > 0 || rule.bySecond.length > 0) {
    parts.push("at set times");
  }
  if (rule.until > 0) {
    const until = new Date(rule.until);
    parts.push(
      `until ${until.getDate()} ${MONTHS[until.getMonth()].slice(0, 3)} ${until.getFullYear()}`,
    );
  }
  return parts.join(" ");
}
