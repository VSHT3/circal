import { describe, expect, it } from "vitest";
import "./helpers";
import { attendee, byDay, day, event, ms, rule } from "./helpers";
import {
  SHARE_MAX,
  SLOTS_MAX,
  decodeShare,
  decodeSlots,
  encodeShare,
  encodeSlots,
  shareCheck,
  shareFragment,
  shareToken,
  slotsFragment,
  slotsToken,
  type ShareEncoded,
  type SlotsEncoded,
} from "@/lib/share";
import { MAX_INTERVAL, NEVER } from "@/lib/recur";
import { REMIND_INHERIT, REMIND_SILENT } from "@/lib/events";

/* ---------------------------------------------------------------------- *
 * One event, inside a link. Two halves to hold down: the round trip must
 * return the event the sender was looking at, and the payload is a string
 * from a stranger — so every way one can arrive wrong has to come back as
 * a refusal rather than as an event with nonsense instants or a title that
 * is somebody's guest list.
 * ---------------------------------------------------------------------- */

const CALENDAR = "cal-mine";

/** The token, or a failure loud enough to name itself. Every round-trip
 *  case needs one, and `if (!ok) throw` in each would bury the assertion. */
function token(encoded: ShareEncoded): string {
  if (!encoded.ok) throw new Error(`encodeShare refused: ${encoded.reason}`);
  return encoded.token;
}

/** `version.check.body` split up, so a case can read or replace one part. */
const parts = (text: string) => text.split(".");

const base64url = (record: string) =>
  btoa(record).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The record inside a payload, as it is on the wire. Used to prove a field
 *  is genuinely absent rather than merely dropped on the way back. */
function payload(text: string): string {
  return atob(parts(text)[2].replace(/-/g, "+").replace(/_/g, "/"));
}

/** A hand-built payload, check digits and all, so one field can be made
 *  wrong at a time — see `shareCheck` on why that is exported. */
const forge = (record: string) => `1.${shareCheck(record)}.${base64url(record)}`;

function roundTrip(source: Parameters<typeof encodeShare>[0]) {
  const read = decodeShare(token(encodeShare(source)), CALENDAR);
  if (!read.ok) throw new Error(`decodeShare refused: ${read.reason}`);
  return read.draft;
}

/* --------------------------------- the trip -------------------------------- */

describe("encodeShare / decodeShare — what travels", () => {
  it("returns the event the sender was looking at", () => {
    const source = event({
      title: "Design review",
      start: "2026-03-08 09:00",
      end: "2026-03-08 10:30",
      location: "Room 2",
      url: "https://example.com/call",
      notes: "Bring the two mocks",
      color: "#7ce3d8",
      icon: "barbell",
      free: true,
      travel: 25,
    });
    const draft = roundTrip(source);
    expect.soft(draft.start).toBeSameInstantAs("2026-03-08 09:00");
    expect.soft(draft.end).toBeSameInstantAs("2026-03-08 10:30");
    expect.soft(draft.title).toBe("Design review");
    expect.soft(draft.location).toBe("Room 2");
    expect.soft(draft.url).toBe("https://example.com/call");
    expect.soft(draft.notes).toBe("Bring the two mocks");
    expect.soft(draft.color).toBe("#7ce3d8");
    expect.soft(draft.icon).toBe("barbell");
    expect.soft(draft.free).toBe(true);
    expect.soft(draft.travel).toBe(25);
    expect.soft(draft.allDay).toBe(false);
  });

  it("carries the whole rule, not just the frequency", () => {
    // A shared series that came back as a single meeting is the failure this
    // pins: the receiver would see one Monday and never know.
    const draft = roundTrip(
      event({
        start: "2026-03-09 09:00",
        end: "2026-03-09 09:15",
        ...rule({
          repeat: "weekly",
          interval: 2,
          byDay: byDay("MO,FR"),
          until: ms("2026-12-01 23:59"),
          wkst: 0,
          exdates: ["2026-04-06", "2026-04-10T09:00:00"],
          rdates: ["2026-05-02T11:00:00"],
        }),
      }),
    );
    expect.soft(draft.repeat).toBe("weekly");
    expect.soft(draft.interval).toBe(2);
    expect.soft(draft.byDay).toEqual(byDay("MO,FR"));
    expect.soft(draft.until).toBeSameInstantAs("2026-12-01 23:59");
    expect.soft(draft.wkst).toBe(0);
    expect.soft(draft.exdates).toEqual(["2026-04-06", "2026-04-10T09:00:00"]);
    expect.soft(draft.rdates).toEqual(["2026-05-02T11:00:00"]);
  });

  it("carries the BY* cascade the editor cannot even spell", () => {
    const draft = roundTrip(
      event({
        ...rule({
          repeat: "monthly",
          byDay: byDay("-1FR"),
          bySetPos: [-1],
          byMonthDay: [1, -2],
          byMonth: [3, 9],
          byHour: [9, 17],
          byMinute: [30],
          bySecond: [0],
          byWeekNo: [-1, 12],
          byYearDay: [366],
        }),
      }),
    );
    expect.soft(draft.byDay).toEqual(byDay("-1FR"));
    expect.soft(draft.bySetPos).toEqual([-1]);
    expect.soft(draft.byMonthDay).toEqual([1, -2]);
    expect.soft(draft.byMonth).toEqual([3, 9]);
    expect.soft(draft.byHour).toEqual([9, 17]);
    expect.soft(draft.byMinute).toEqual([30]);
    expect.soft(draft.bySecond).toEqual([0]);
    expect.soft(draft.byWeekNo).toEqual([-1, 12]);
    expect.soft(draft.byYearDay).toEqual([366]);
  });

  it("keeps a rule's dates on an event that repeats never", () => {
    // `readRecurrence` reads the two lists before the frequency, because an
    // RDATE-only series is real. The wire has to carry them for that to hold.
    const draft = roundTrip(event({ ...rule({ rdates: ["2026-05-02T11:00:00"] }) }));
    expect.soft(draft.repeat).toBe("never");
    expect.soft(draft.rdates).toEqual(["2026-05-02T11:00:00"]);
  });

  it("keeps the zone a rule is read against", () => {
    expect(roundTrip(event({ tzid: "Europe/Berlin" })).tzid).toBe("Europe/Berlin");
  });

  it("lands the receiver's own calendar on it, never the sender's", () => {
    expect(roundTrip(event({ calendarId: "cal-someone-else" })).calendarId).toBe(CALENDAR);
  });
});

describe("encodeShare — all-day events travel as days", () => {
  it("rebuilds this reader's own two midnights", () => {
    const draft = roundTrip(
      event({ start: day("2026-03-08"), end: day("2026-03-09"), allDay: true }),
    );
    expect.soft(draft.allDay).toBe(true);
    expect.soft(draft.start).toBeSameInstantAs("2026-03-08 00:00");
    expect.soft(draft.end).toBeSameInstantAs("2026-03-09 00:00");
  });

  it("keeps every day of a span, exclusive end included", () => {
    const draft = roundTrip(
      event({ start: day("2026-03-08"), end: day("2026-03-13"), allDay: true }),
    );
    expect.soft(draft.start).toBeSameInstantAs("2026-03-08 00:00");
    expect.soft(draft.end).toBeSameInstantAs("2026-03-13 00:00");
  });

  it("rebuilds an end across a spring-forward as a midnight, not 23:00", () => {
    // Germany goes forward on 29 March 2026, so this span is 71 hours — the
    // reason the day count is rebuilt with calendar arithmetic rather than
    // `days × 1440` minutes, which drops the last day off an exclusive end.
    const draft = roundTrip(
      event({ start: day("2026-03-28"), end: day("2026-03-31"), allDay: true }),
    );
    expect.soft(draft.end).toBeSameInstantAs("2026-03-31 00:00");
    expect.soft(draft.end - draft.start).toBe(71 * 3_600_000);
  });
});

describe("decodeShare — the retired task bit stays retired", () => {
  it("refuses an old task link rather than reading it as an event of no width", () => {
    // Bit 2 spelled `TASK` while a task was an event. Its record carries a
    // zero length, which `readEvent` now refuses — an unreadable link, never
    // a silent zero-width event, and never a free event from a reused bit.
    const seconds = Math.floor(ms("2026-03-08 01:15") / 1000).toString(36);
    const record = ["2", seconds, "0", "Old task", "", "", "", "", "", "", ""].join("~");
    expect(decodeShare(forge(record), CALENDAR)).toEqual({ ok: false, reason: "unreadable" });
  });
});

/* ----------------------------- what stays behind --------------------------- */

describe("encodeShare — the fields that deliberately do not travel", () => {
  const invited = event({
    id: "evt-original",
    title: "Standup",
    organizer: { name: "Ada Lovelace", address: "ada@example.com" },
    attendees: [attendee("grace@example.com", "accepted", "Grace Hopper")],
    attendeeCount: 12,
    seriesId: "series-1",
    seriesKey: "2026-03-08T09:00:00",
    remindLead: REMIND_SILENT,
  });

  it("leaves no guest anywhere in the payload, encoded or decoded", () => {
    // The non-negotiable: a link is pasted into chat apps, so somebody
    // else's name and address must not be inside it at all — a decoded
    // draft with an empty list would still have carried them across.
    const wire = payload(token(encodeShare(invited)));
    expect.soft(wire).not.toContain("ada@example.com");
    expect.soft(wire).not.toContain("grace@example.com");
    expect.soft(wire).not.toContain("Ada");
    expect.soft(wire).not.toContain("Grace");
    expect.soft(wire).toContain("Standup");
  });

  it.each([
    { name: "the organiser", field: "organizer", expected: null },
    { name: "the guest list", field: "attendees", expected: [] },
    { name: "the guest count", field: "attendeeCount", expected: 0 },
    { name: "the series it overrode", field: "seriesId", expected: "" },
    { name: "the instance it replaced", field: "seriesKey", expected: "" },
  ] as const)("drops $name", ({ field, expected }) => {
    expect.soft(roundTrip(invited)[field]).toEqual(expected);
  });

  it("arrives following the receiver's own reminder setting", () => {
    // The sender silenced their copy. That is an answer about their own
    // attention, not about the event.
    expect(roundTrip(invited).remindLead).toBe(REMIND_INHERIT);
  });
});

/* --------------------------------- the shape ------------------------------- */

describe("the payload's shape", () => {
  it("is URL-safe with nothing left to percent-encode", () => {
    const wide = token(
      encodeShare(event({ title: "Café ☕ 会議 ~ #1 / 50% + more", notes: "a\\b~c" })),
    );
    expect.soft(wide).toMatch(/^[0-9a-z]+\.[0-9a-z]{4}\.[A-Za-z0-9_-]+$/);
    expect.soft(encodeURIComponent(wide)).toBe(wide);
  });

  it("returns a title carrying the record's own separators unharmed", () => {
    const draft = roundTrip(event({ title: "a~b\\c~~d", notes: "\\~" }));
    expect.soft(draft.title).toBe("a~b\\c~~d");
    expect.soft(draft.notes).toBe("\\~");
  });

  it("is far shorter than the event as JSON, which is the whole point", () => {
    // The obvious implementation — `btoa(JSON.stringify(event))` — is what
    // this format exists instead of. A link that wraps three times in a chat
    // window is a link people stop sending, so pin the order of magnitude.
    const source = event({ title: "Standup", start: "2026-03-08 09:00" });
    const naive = btoa(JSON.stringify(source)).length;
    expect.soft(token(encodeShare(source)).length).toBeLessThan(naive / 4);
  });

  it("costs an untravelled event no characters at all", () => {
    // The appended slot is empty for `travel: 0`, and `pack` drops trailing
    // empties, so an ordinary timed event is still the four fields it was
    // before the field existed. A field that lengthened every link ever minted
    // would be the wrong trade for one somebody types on a few events.
    const plain = event({ title: "Standup", start: "2026-03-08 09:00" });
    const commute = event({ title: "Standup", start: "2026-03-08 09:00", travel: 25 });
    expect.soft(payload(token(encodeShare(plain))).split("~")).toHaveLength(4);
    expect
      .soft(token(encodeShare(commute)).length)
      .toBeGreaterThan(token(encodeShare(plain)).length);
  });

  it("round-trips through the fragment it is carried in", () => {
    const payloadText = token(encodeShare(event({ title: "Standup" })));
    expect.soft(shareToken(shareFragment(payloadText))).toBe(payloadText);
  });

  it.each([
    { name: "no fragment at all", hash: "" },
    { name: "the app's own bare hash", hash: "#" },
    { name: "somebody else's fragment", hash: "#section-2" },
    { name: "a query string pretending to be one", hash: "?e=1.abc" },
  ])("reads $name as no shared event", ({ hash }) => {
    expect.soft(shareToken(hash)).toBe("");
  });
});

/* ---------------------------------- the cap -------------------------------- */

describe("the cap", () => {
  it("refuses to mint a link past it rather than one that breaks quietly", () => {
    const encoded = encodeShare(event({ title: "Standup", notes: "n".repeat(4_000) }));
    expect.soft(encoded.ok).toBe(false);
    expect.soft(encoded.ok === false && encoded.reason).toBe("too-long");
  });

  it("mints a link right up to the cap", () => {
    // The refusal must be about length, not about notes: a long note that
    // fits is a link that works.
    const encoded = encodeShare(event({ title: "Standup", notes: "n".repeat(1_000) }));
    expect.soft(encoded.ok).toBe(true);
    expect.soft(encoded.ok && encoded.token.length).toBeLessThanOrEqual(SHARE_MAX);
  });

  it("refuses to read an absurd payload before decoding a byte of it", () => {
    const read = decodeShare(`1.${"A".repeat(SHARE_MAX)}`, CALENDAR);
    expect.soft(read.ok).toBe(false);
    expect.soft(read.ok === false && read.reason).toBe("too-long");
  });
});

/* ------------------------------- hostile input ----------------------------- */

describe("decodeShare — a string from a stranger", () => {
  it("names a version it does not know rather than half-decoding it", () => {
    const [, check, body] = parts(token(encodeShare(event({ title: "Standup" }))));
    const read = decodeShare(`2.${check}.${body}`, CALENDAR);
    expect.soft(read.ok).toBe(false);
    expect.soft(read.ok === false && read.reason).toBe("version");
  });

  it.each([
    { name: "an empty string", value: "" },
    { name: "a bare word", value: "hello" },
    { name: "a version with no payload", value: "1." },
    { name: "a version and a check with no payload", value: "1.abcd." },
    { name: "a payload with no version", value: ".abcd.MH50YmttODB" },
    { name: "a payload with no check digits", value: "1.MH50YmttODB" },
    { name: "an unreadable version token", value: "!.abcd.MH50YmttODB" },
    { name: "a fourth part nobody wrote", value: "1.abcd.MH50YmttODB.extra" },
    { name: "base64 of nothing an event would be", value: "1.abcd.aGVsbG8" },
    { name: "characters outside the alphabet", value: "1.abcd.MH50*mttODB" },
    { name: "a percent-encoded payload", value: "1.abcd.MH50%7EmttODB" },
    { name: "invalid UTF-8 inside the payload", value: "1.abcd.____" },
    { name: "a truncated payload", value: "1.abcd.MH50YmttOD" },
  ])("refuses $name without throwing", ({ value }) => {
    const read = decodeShare(value, CALENDAR);
    expect.soft(read.ok).toBe(false);
    expect.soft(read.ok === false && read.reason).not.toBe("version");
  });

  it.each([
    { name: "one character added", mangle: (t: string) => `${t}x` },
    { name: "two characters added, so base64 still aligns", mangle: (t: string) => `${t}xx` },
    { name: "its last character dropped", mangle: (t: string) => t.slice(0, -1) },
    {
      name: "four characters dropped, so base64 still aligns",
      mangle: (t: string) => t.slice(0, -4),
    },
    {
      name: "its first payload character changed",
      mangle: (t: string) => {
        const [version, check, body] = parts(t);
        return `${version}.${check}.${body[0] === "Z" ? "Y" : "Z"}${body.slice(1)}`;
      },
    },
    {
      name: "its check digits left behind by an edit",
      mangle: (t: string) => {
        const [version, check, body] = parts(t);
        return `${version}.${check}.${base64url(`${atob(body.replace(/-/g, "+").replace(/_/g, "/"))}!`)}`;
      },
    },
  ])("refuses a good payload with $name", ({ mangle }) => {
    // A real link, then one edit — a chat client breaking a line, half a link
    // pasted, a hand-patched field. Base64's own alignment catches some of it,
    // the fatal UTF-8 decoder some more, and the check digits the rest, which
    // is what they are there for: legal bytes carrying a shortened record.
    const good = token(
      encodeShare(event({ title: "Design review · Café ☕", notes: "two mocks" })),
    );
    const read = decodeShare(mangle(good), CALENDAR);
    expect.soft(read.ok).toBe(false);
  });

  it.each([
    { name: "an empty record", record: "" },
    { name: "flags that are not a number", record: "!!~tbkm80~1e0~Standup" },
    { name: "a start that is not a number", record: "0~9AM~1e0~Standup" },
    { name: "a length that is not a number", record: "0~tbkm80~HALF~Standup" },
    { name: "an end before its start", record: "0~tbkm80~-1e0~Standup" },
    { name: "a zero-width event that is not a task", record: "0~tbkm80~0~Standup" },
    { name: "an all-day event in the thirteenth month", record: "1~c29px~1~Standup" },
    { name: "an all-day event on the nought-th day", record: "1~c28y4~1~Standup" },
    { name: "an all-day event of no days", record: "1~c28yc~0~Standup" },
    { name: "an all-day event of an absurd number of days", record: "1~c28yc~zzzzzz~Standup" },
    { name: "a day key with no year", record: "1~1~1~Standup" },
  ])("refuses $name", ({ record }) => {
    const read = decodeShare(forge(record), CALENDAR);
    expect.soft(read.ok).toBe(false);
  });

  it("reads an all-day payload naming a real date, so the refusals above are about the date", () => {
    // The control for the table: `c28yc` is 2026-03-08 in base36, and the
    // four rows above differ from it only in the part being made wrong.
    const read = decodeShare(forge("1~c28yc~1~Standup"), CALENDAR);
    expect.soft(read.ok).toBe(true);
    expect.soft(read.ok && read.draft.start).toBeSameInstantAs("2026-03-08 00:00");
  });

  it("hands a hostile rule to the one validator rather than trusting it", () => {
    // Every field here is out of range or the wrong type. `readRecurrence`
    // owns what a legal rule is — the point of this case is that none of them
    // arrive as written and none of them throw.
    const read = decodeShare(
      forge("0~tbkm80~1e0~Standup~w;zzzzzz;;9,zz,-91;notadate;;99;99;99;99;99;99;99;99;z"),
      CALENDAR,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { draft } = read;
    expect.soft(draft.interval).toBe(MAX_INTERVAL);
    expect.soft(draft.byDay).toEqual([]);
    expect.soft(draft.exdates).toEqual([]);
    expect.soft(draft.byMonthDay).toEqual([]);
    expect.soft(draft.wkst).toBe(NEVER.wkst);
  });

  // The appended slot, index 11, with everything between it and the title
  // empty. `fromB36` is `NaN` on the mangled tail of a truncated link where
  // `Number` would read a prefix, and `readTravel` refuses the rest, so no
  // hostile spelling arrives as a run-up.
  const travelRecord = (field: string) => `0~tbkm80~1e0~Standup${"~".repeat(8)}${field}`;

  it.each([
    { name: "a travel past the ceiling", field: "zzzzzz" },
    { name: "a negative travel", field: "-u" },
    { name: "a fraction of a minute", field: "1.5" },
    { name: "a mangled tail", field: "p=" },
    { name: "prose", field: "soon ish" },
  ])("reads $name as no travel", ({ field }) => {
    const read = decodeShare(forge(travelRecord(field)), CALENDAR);
    expect.soft(read.ok).toBe(true);
    expect.soft(read.ok && read.draft.travel).toBe(0);
  });

  it("reads a legal travel slot, so the refusals above are about the value", () => {
    // The control for the table: `p` is 25 in base36, and the rows above
    // differ from it only in the field being made wrong.
    const read = decodeShare(forge(travelRecord("p")), CALENDAR);
    expect.soft(read.ok).toBe(true);
    expect.soft(read.ok && read.draft.travel).toBe(25);
  });
});

/* ---------------------------------------------------------------------- *
 * Free time, inside a link — the other payload. The same two halves: the
 * round trip must return the gaps the sender was free for, and a payload
 * is a string from a stranger, so every wrong shape is a refusal.
 * ---------------------------------------------------------------------- */

function slotsTokenOf(encoded: SlotsEncoded): string {
  if (!encoded.ok) throw new Error(`encodeSlots refused: ${encoded.reason}`);
  return encoded.token;
}

function slotsTrip(spans: Parameters<typeof encodeSlots>[0]) {
  const read = decodeSlots(slotsTokenOf(encodeSlots(spans)));
  if (!read.ok) throw new Error(`decodeSlots refused: ${read.reason}`);
  return read.slots;
}

/** A hand-built slots record: base in epoch minutes, then `offset.length`
 *  pairs, all base36 — see `encodeSlots`. */
const slotsRecord = (baseMin: number, pairs: string) => `${baseMin.toString(36)}~${pairs}`;

const forgeSlots = (record: string) => `1.${shareCheck(record)}.${base64url(record)}`;

describe("encodeSlots / decodeSlots — what travels", () => {
  it("returns the gaps the sender was free for, as the instants they are", () => {
    const spans = [
      { start: ms("2026-03-08 09:00"), end: ms("2026-03-08 10:30") },
      { start: ms("2026-03-09 14:00"), end: ms("2026-03-09 16:00") },
    ];
    const slots = slotsTrip(spans);
    expect(slots).toHaveLength(2);
    expect.soft(slots[0].start).toBeSameInstantAs("2026-03-08 09:00");
    expect.soft(slots[0].end).toBeSameInstantAs("2026-03-08 10:30");
    expect.soft(slots[1].start).toBeSameInstantAs("2026-03-09 14:00");
    expect.soft(slots[1].end).toBeSameInstantAs("2026-03-09 16:00");
  });

  it("carries nothing else — no name, no titles, no ids", () => {
    const record = payload(
      slotsTokenOf(encodeSlots([{ start: ms("2026-03-08 09:00"), end: ms("2026-03-08 10:00") }])),
    );
    // One base36 instant and one pair: any letter sequence longer than a
    // base36 field would be text that has no business here.
    expect(record).toMatch(/^[0-9a-z]+~[0-9a-z]+\.[0-9a-z]+$/);
  });

  it("sorts and merges what it is given — a union of free time is the same free time", () => {
    const slots = slotsTrip([
      { start: ms("2026-03-08 14:00"), end: ms("2026-03-08 16:00") },
      { start: ms("2026-03-08 09:00"), end: ms("2026-03-08 10:00") },
      { start: ms("2026-03-08 15:00"), end: ms("2026-03-08 17:00") },
      // Touching is merged too: two readings of one stretch is a decoder's
      // question nobody should have to answer.
      { start: ms("2026-03-08 10:00"), end: ms("2026-03-08 11:00") },
    ]);
    expect(slots).toHaveLength(2);
    expect.soft(slots[0].start).toBeSameInstantAs("2026-03-08 09:00");
    expect.soft(slots[0].end).toBeSameInstantAs("2026-03-08 11:00");
    expect.soft(slots[1].start).toBeSameInstantAs("2026-03-08 14:00");
    expect.soft(slots[1].end).toBeSameInstantAs("2026-03-08 17:00");
  });

  it("floors to the minute — nothing in this app writes a sub-minute instant", () => {
    const slots = slotsTrip([
      { start: ms("2026-03-08 09:00") + 31_000, end: ms("2026-03-08 10:00") + 59_999 },
    ]);
    expect.soft(slots[0].start).toBeSameInstantAs("2026-03-08 09:00");
    expect.soft(slots[0].end).toBeSameInstantAs("2026-03-08 10:00");
  });

  it("refuses to mint an empty link, and a degenerate span is empty", () => {
    expect(encodeSlots([])).toEqual({ ok: false, reason: "empty" });
    const moment = ms("2026-03-08 09:00");
    expect(encodeSlots([{ start: moment, end: moment }])).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("keeps a full week short enough to paste", () => {
    // Two gaps a day for seven days: the ordinary shape of the feature.
    const spans = Array.from({ length: 14 }, (_, i) => {
      const start = ms("2026-03-08 08:00") + Math.floor(i / 2) * 86_400_000 + (i % 2) * 21_600_000;
      return { start, end: start + 5_400_000 };
    });
    const minted = slotsTokenOf(encodeSlots(spans));
    expect(minted.length).toBeLessThan(160);
    expect(minted.length).toBeLessThan(SHARE_MAX);
  });
});

describe("decodeSlots — a string from a stranger", () => {
  it("a truncated link is a refusal, not shorter free time", () => {
    const minted = slotsTokenOf(
      encodeSlots([
        { start: ms("2026-03-08 09:00"), end: ms("2026-03-08 10:00") },
        { start: ms("2026-03-09 09:00"), end: ms("2026-03-09 10:00") },
      ]),
    );
    expect(decodeSlots(minted.slice(0, -4))).toEqual({ ok: false, reason: "unreadable" });
  });

  it("a payload from a newer build is a version answer, not corruption", () => {
    const minted = slotsTokenOf(
      encodeSlots([{ start: ms("2026-03-08 09:00"), end: ms("2026-03-08 10:00") }]),
    );
    const [, check, body] = parts(minted);
    expect(decodeSlots(`2.${check}.${body}`)).toEqual({ ok: false, reason: "version" });
  });

  it("refuses a payload past SHARE_MAX on length alone", () => {
    expect(decodeSlots(`1.aaaa.${"A".repeat(SHARE_MAX)}`)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it.each([
    { name: "an overlap — the encoder merges, so one can only be damage", pairs: "0.1o,10.1o" },
    { name: "a pair out of order", pairs: "2s.u,0.u" },
    { name: "a zero-length slot", pairs: "0.0" },
    { name: "a negative offset", pairs: "-5.u" },
    { name: "a slot longer than a day", pairs: `0.${(1441).toString(36)}` },
    { name: "a slot past the sixty-two-day window", pairs: `${(90_000).toString(36)}.u` },
    { name: "a pair that is not a pair", pairs: "0.u.5" },
    { name: "letters where minutes should be", pairs: "0.u,x!.u" },
  ])("refuses $name", ({ pairs }) => {
    expect(decodeSlots(forgeSlots(slotsRecord(29_538_720, pairs)))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("refuses a base that is not an instant, and a list past the cap", () => {
    expect.soft(decodeSlots(forgeSlots("0~0.u"))).toEqual({ ok: false, reason: "unreadable" });
    expect.soft(decodeSlots(forgeSlots("~0.u"))).toEqual({ ok: false, reason: "unreadable" });
    const crowd = Array.from({ length: SLOTS_MAX + 1 }, (_, i) => `${(i * 60).toString(36)}.u`);
    expect.soft(decodeSlots(forgeSlots(slotsRecord(29_538_720, crowd.join(","))))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("reads the control the table above varies from", () => {
    // 29,538,720 epoch minutes is 2026-03-05 12:00 UTC; `u` is 30 minutes.
    const read = decodeSlots(forgeSlots(slotsRecord(29_538_720, "0.u")));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.slots[0].end - read.slots[0].start).toBe(30 * 60_000);
    expect(read.slots[0].start).toBe(29_538_720 * 60_000);
  });
});

describe("the two fragments never read each other", () => {
  it("rides #f= and leaves #e= alone", () => {
    expect.soft(slotsToken(slotsFragment("abc"))).toBe("abc");
    expect.soft(slotsToken(shareFragment("abc"))).toBe("");
    expect.soft(shareToken(slotsFragment("abc"))).toBe("");
    expect.soft(slotsToken("")).toBe("");
  });
});
