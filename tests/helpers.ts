/* ------------------------------------------------------------------ *
 * Fixtures, builders and matchers shared by every test file.
 *
 * The point of this module is that a new test file adds *cases*, never
 * scaffolding. If you find yourself writing a `CalEvent` literal with
 * sixteen recurrence fields in a test, stop and use `event()`.
 *
 * The matchers exist for one reason: a recurrence failure otherwise
 * diffs two arrays of epoch integers, which is unreadable. Every
 * assertion about instants goes through one of them so the failure
 * prints aligned local datetimes with weekday names.
 * ------------------------------------------------------------------ */

import { expect } from "vitest";
import {
  NEVER,
  REMIND_INHERIT,
  type Attendee,
  type CalEvent,
  type Calendar,
  type Grave,
  type Partstat,
  type Recurrence,
} from "@/lib/events";

/* -------------------------------- parsing --------------------------------- */

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * `"2026-03-08 09:30"` → a local `Date`. Never `new Date(string)` in a test:
 * that parses a bare `YYYY-MM-DD` as *UTC*, which is the exact bug half this
 * codebase's date handling exists to avoid, and it would silently shift every
 * fixture by the machine's offset.
 */
export function at(stamp: string): Date {
  const m = STAMP.exec(stamp);
  if (!m) throw new Error(`at(): expected "YYYY-MM-DD[ HH:mm[:ss]]", got ${JSON.stringify(stamp)}`);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    0,
  );
}

/** `at()` as epoch milliseconds, for the many fields that store one. */
export function ms(stamp: string): number {
  return at(stamp).getTime();
}

/** Local midnight of a day key. */
export function day(key: string): Date {
  return at(key);
}

/* ------------------------------- formatting ------------------------------- */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The one way an instant is printed in a failure message. Weekday included
 * because most of what goes wrong in RFC 5545 goes wrong on a weekday, and
 * `1772946000000` does not tell you it landed on a Sunday.
 */
export function show(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "Invalid Date";
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const secs = d.getSeconds() ? `:${pad(d.getSeconds())}` : "";
  return `${date} ${time}${secs} ${WEEKDAY[d.getDay()]}`;
}

/**
 * Two lists of instants side by side, one per line, marked. This is the whole
 * reason the matchers exist — a 40-instance yearly rule that is wrong in one
 * place should say *which* place on the first read.
 */
function alignedDiff(actual: (Date | number)[], expected: (Date | number)[]): string {
  const a = actual.map(show);
  const b = expected.map(show);
  const want = new Set(b);
  const got = new Set(a);
  const lines: string[] = [];
  const width = Math.max(0, ...a.map((s) => s.length), ...b.map((s) => s.length));

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? "";
    const right = b[i] ?? "";
    const ok = left === right;
    const mark = ok ? "   " : !right ? " + " : !left ? " - " : " ≠ ";
    const note = ok || !left ? "" : want.has(left) ? "  (out of order)" : "  (unexpected)";
    const missing = !ok && right && !got.has(right) ? "  (missing)" : "";
    lines.push(`${mark}${left.padEnd(width)}  |  ${right.padEnd(width)}${note || missing}`);
  }
  const head = `   ${"actual".padEnd(width)}  |  expected`;
  return [head, `   ${"-".repeat(width)}--+--${"-".repeat(width)}`, ...lines].join("\n");
}

/* -------------------------------- builders -------------------------------- */

let counter = 0;

/** A deterministic id, so a failure names the same event on every run. */
export function id(prefix = "e"): string {
  return `${prefix}${++counter}`;
}

/** Reset ids between files that assert on them. */
export function resetIds() {
  counter = 0;
}

export function calendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: "cal-work",
    name: "Work",
    color: "#a3d9e4",
    icon: "",
    visible: true,
    // Unstamped, which is what a record written before stamping existed says —
    // and what keeps a fixture deterministic, since a builder reading the clock
    // would make every snapshot comparison depend on when it ran. A case about
    // merging says its own stamp.
    updatedAt: 0,
    ...overrides,
  };
}

/** One deletion, for the merge cases. `at` is a stamp, so a grave and the
 *  record it argues with are written in the same vocabulary. */
export function grave(id: string, at: string | number): Grave {
  return { id, at: typeof at === "string" ? ms(at) : at };
}

/**
 * A `CalEvent` with every field defaulted, including the sixteen of
 * `Recurrence`. Times are given as stamps rather than epoch ms, because a test
 * that reads `start: 1772946000000` cannot be reviewed.
 *
 * A `Date` is accepted too — `day("2026-03-08")` returns one, and passing it
 * straight through used to store the Date object as the instant, which then
 * silently vanished from every query rather than failing loudly.
 */
export function event(
  overrides: Partial<Omit<CalEvent, "start" | "end">> & {
    start?: string | number | Date;
    end?: string | number | Date;
  } = {},
): CalEvent {
  const instant = (v: string | number | Date | undefined, fallback: number) =>
    v === undefined ? fallback : typeof v === "string" ? ms(v) : +v;
  const { start, end, ...rest } = overrides;
  const startMs = instant(start, ms("2026-03-08 09:00"));
  const endMs = instant(end, startMs + 3_600_000);
  return {
    id: id(),
    title: "Event",
    calendarId: "cal-work",
    start: startMs,
    end: endMs,
    allDay: false,
    tzid: "",
    location: "",
    url: "",
    notes: "",
    seriesId: "",
    seriesKey: "",
    color: "",
    icon: "",
    task: false,
    doneKeys: [],
    // Busy, which is what an event says when it says nothing.
    free: false,
    // Following the setting, which is the same kind of nothing: this event
    // has no opinion about how much warning it wants.
    remindLead: REMIND_INHERIT,
    // Nobody asked and nobody answered, which is every event that did not
    // arrive as an invitation.
    organizer: null,
    attendees: [],
    attendeeCount: 0,
    // Unstamped, for `calendar()`'s reason.
    updatedAt: 0,
    ...NEVER,
    ...rest,
  };
}

/** A recurrence rule with everything not stated left unstated. */
export function rule(overrides: Partial<Recurrence> = {}): Recurrence {
  return { ...NEVER, ...overrides };
}

/**
 * One guest. `"ada@example.com"` alone is somebody who has not answered — the
 * commonest row and the RFC's own default — and the name is optional because a
 * sender that writes only the mailbox is normal rather than broken.
 */
export function attendee(address: string, status: Partstat = "needs-action", name = ""): Attendee {
  return { address, status, name };
}

/** `byDay` from `"MO,TU,-1SU"`, the way an RRULE spells it. */
export function byDay(spec: string): Recurrence["byDay"] {
  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return spec
    .split(",")
    .filter(Boolean)
    .map((token) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token.trim().toUpperCase());
      if (!m) throw new Error(`byDay(): cannot parse ${JSON.stringify(token)}`);
      const index = DAYS.indexOf(m[2]);
      if (index < 0) throw new Error(`byDay(): ${m[2]} is not a weekday`);
      return { day: index, nth: m[1] ? Number(m[1]) : 0 };
    });
}

/* ------------------------------ storage stub ------------------------------ */

/**
 * A `Storage` good enough for the store, in ~20 lines, rather than pulling in
 * jsdom for one interface. `quota` makes `setItem` throw, which is the branch
 * that must notify rather than fail silently.
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  quota = Infinity;

  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new DOMException("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  /** What another tab would see, for the cross-tab cases. */
  raw(k: string) {
    return this.map.get(k) ?? null;
  }
}

/* -------------------------------- matchers -------------------------------- */

const key = (d: Date | number) => show(d).slice(0, 10);

expect.extend({
  /** Instants, in order, printed as local datetimes. */
  toBeInstants(received: unknown, expected: (Date | number | string)[]) {
    const want = expected.map((e) => (typeof e === "string" ? ms(e) : e));
    const got = Array.isArray(received) ? received : [received];
    const pass =
      got.length === want.length &&
      got.every((g, i) => +(g as Date | number) === +(want[i] as Date | number));
    return {
      pass,
      message: () =>
        pass
          ? `expected instants not to match, but they did:\n${alignedDiff(got as number[], want as number[])}`
          : `instants do not match:\n${alignedDiff(got as number[], want as number[])}`,
      actual: (got as (Date | number)[]).map(show),
      expected: (want as (Date | number)[]).map(show),
    };
  },

  /** The *days* a series lands on, ignoring time of day. */
  toOccurOn(received: unknown, expected: string[]) {
    const got = (Array.isArray(received) ? received : [received]) as (Date | number)[];
    const days = got.map(key);
    const pass = days.length === expected.length && days.every((d, i) => d === expected[i]);
    const width = Math.max(10, ...days.map((d) => d.length));
    const lines: string[] = [];
    for (let i = 0; i < Math.max(days.length, expected.length); i++) {
      const l = days[i] ?? "";
      const r = expected[i] ?? "";
      lines.push(`${l === r ? "   " : " ≠ "}${l.padEnd(width)}  |  ${r}`);
    }
    return {
      pass,
      message: () =>
        `${pass ? "expected days not to match" : "days do not match"}:\n   ${"actual".padEnd(width)}  |  expected\n${lines.join("\n")}`,
    };
  },

  toBeSameInstantAs(received: unknown, expected: Date | number | string) {
    const want = typeof expected === "string" ? ms(expected) : +expected;
    const got = +(received as Date | number);
    const pass = got === want;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${show(got)} not to be ${show(want)}`
          : `expected ${show(want)}\n     got ${show(got)}\n    (off by ${((got - want) / 60000).toFixed(2)} min)`,
    };
  },
});

interface InstantMatchers<R = unknown> {
  toBeInstants: (expected: (Date | number | string)[]) => R;
  toOccurOn: (expected: string[]) => R;
  toBeSameInstantAs: (expected: Date | number | string) => R;
}

declare module "vitest" {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
  interface Matchers<T = any> extends InstantMatchers<T> {}
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
}
