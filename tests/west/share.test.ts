import { describe, expect, it } from "vitest";
import "../helpers";
import { day, event, ms } from "../helpers";
import { decodeShare, encodeShare } from "@/lib/share";

/* ------------------------------------------------------------------ *
 * A shared link is the one payload in this app that is *written by one
 * reader and read by another*, so it is the one place a zone can differ
 * between the two halves of a round trip — which is exactly what
 * `tests/share.test.ts` cannot see, because both halves of it run in
 * Berlin.
 *
 * The three tokens below were minted in Berlin (`TZ=Europe/Berlin`, the
 * `local` project's own zone) and are pasted here verbatim, because a
 * token this project encodes for itself would only prove Los Angeles
 * agrees with Los Angeles. Re-mint them by encoding the same events under
 * that zone; the events are named in each case.
 * ------------------------------------------------------------------ */

const CALENDAR = "cal-mine";

/** `event({ title: "Ada's birthday", start: day("2026-03-08"), end:
 *  day("2026-03-09"), allDay: true })`, encoded in Berlin. */
const BERLIN_ALL_DAY = "1.70dp.MX5jMjh5Y34xfkFkYSdzIGJpcnRoZGF5";

/** `event({ title: "Trip", start: day("2026-10-31"), end: day("2026-11-03"),
 *  allDay: true })`, encoded in Berlin — three days across the transition
 *  Los Angeles makes on 1 November and Berlin made on 25 October. */
const BERLIN_ALL_DAY_SPAN = "1.cod7.MX5jMjlpZn4zflRyaXA";

/** `event({ title: "Standup", start: ms("2026-07-15 18:00"), end:
 *  ms("2026-07-15 18:30") })`, encoded in Berlin: 16:00 UTC. */
const BERLIN_TIMED = "1.vlwc.MH50aTg0ZzB-MWUwflN0YW5kdXA";

describe("a shared all-day event keeps its date west of UTC", () => {
  it("lands on this reader's own midnight, not mid-afternoon the day before", () => {
    // The whole reason an all-day event travels as a day key: Berlin's
    // midnight on the 8th is 15:00 on the 7th here, so an epoch instant
    // would put a birthday on the wrong date and span it over two days.
    const read = decodeShare(BERLIN_ALL_DAY, CALENDAR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect.soft(read.draft.allDay).toBe(true);
    expect.soft(read.draft.title).toBe("Ada's birthday");
    expect.soft(read.draft.start).toBeSameInstantAs("2026-03-08 00:00");
    expect.soft(read.draft.end).toBeSameInstantAs("2026-03-09 00:00");
    expect.soft(read.draft.start).toBe(day("2026-03-08").getTime());
  });

  it("rebuilds a span across this zone's own transition as 73 hours", () => {
    // Los Angeles goes back on 1 November 2026, so 31 October to 2 November
    // inclusive is 73 hours here and 72 in Berlin. The day count crossed, so
    // the receiver's own calendar arithmetic is what settles the length —
    // `days × 1440` minutes would end at 23:00 on the last evening, which an
    // exclusive `end` then drops off the dial.
    const read = decodeShare(BERLIN_ALL_DAY_SPAN, CALENDAR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect.soft(read.draft.start).toBe(day("2026-10-31").getTime());
    expect.soft(read.draft.end).toBe(day("2026-11-03").getTime());
    expect.soft(read.draft.end - read.draft.start).toBe(73 * 3_600_000);
  });
});

describe("a shared timed event is the same instant west of UTC", () => {
  it("arrives as the moment the sender named, on this reader's clock", () => {
    // The opposite answer to the one above, from the same model: an instant
    // is absolute here (see `travel.ts`), so 18:00 in Berlin genuinely is
    // 09:00 in Los Angeles and that is what the receiver should be shown.
    const read = decodeShare(BERLIN_TIMED, CALENDAR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect.soft(read.draft.start).toBe(1784131200000);
    expect.soft(read.draft.start).toBeSameInstantAs("2026-07-15 09:00");
    expect.soft(read.draft.end).toBeSameInstantAs("2026-07-15 09:30");
  });
});

describe("the round trip is stable in this zone too", () => {
  it("re-encodes an all-day event to the same day it was read on", () => {
    // Encoding here and reading here must agree, or a link forwarded on by
    // its receiver would walk a day west every hop.
    const again = encodeShare(
      event({ start: day("2026-03-08"), end: day("2026-03-09"), allDay: true }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const read = decodeShare(again.token, CALENDAR);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect.soft(read.draft.start).toBeSameInstantAs("2026-03-08 00:00");
    expect.soft(read.draft.end).toBeSameInstantAs("2026-03-09 00:00");
  });

  it("keeps a rule's local exdate keys as this reader's own wall keys", () => {
    // An EXDATE key is a *local* key everywhere in this app, so it crosses as
    // written: the day the sender skipped is the day named, not an instant
    // shifted into another zone.
    const again = encodeShare(
      event({
        start: ms("2026-03-09 09:00"),
        end: ms("2026-03-09 09:30"),
        repeat: "weekly",
        exdates: ["2026-04-06"],
      }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const read = decodeShare(again.token, CALENDAR);
    expect(read.ok && read.draft.exdates).toEqual(["2026-04-06"]);
  });
});
