import { describe, expect, it } from "vitest";
import { event, id as mintId, ms, rule } from "./helpers";
import { instantKey, type CalEvent } from "@/lib/events";
import { applyRemove, applySplit, applyToggleDone, applyTruncate, applyUpdate } from "@/lib/mutate";

/** The series' own body, ready to be handed back as the tail of a split —
 *  the same shape `store.splitSeries`'s caller hands over. */
function body(series: CalEvent): Omit<CalEvent, "id"> {
  const { id: _id, ...rest } = series;
  return rest;
}

/** A weekly series seeded on Sunday 8 March 2026 at 01:00, and the instants of
 *  the three occurrences after it. */
const WEEKLY = {
  seed: ms("2026-03-08 01:00"),
  second: ms("2026-03-15 01:00"),
  third: ms("2026-03-22 01:00"),
  fourth: ms("2026-03-29 01:00"),
};

/** A weekly series starting at `WEEKLY.seed`, fresh per call — several cases
 *  mutate the id map by feeding it back through `applySplit`/`applyTruncate`. */
const series = () => event({ repeat: "weekly", start: WEEKLY.seed });

describe("applyUpdate", () => {
  it("patches only the named event; every other event is the same object, untouched", () => {
    const a = event({ title: "A" });
    const b = event({ title: "B" });
    const patched = applyUpdate([a, b], a.id, { title: "A2" });
    expect.soft(patched.find((e) => e.id === a.id)?.title).toBe("A2");
    expect.soft(patched.find((e) => e.id === b.id)).toBe(b);
  });

  it("patching an id that is not there is a no-op", () => {
    const a = event();
    expect(applyUpdate([a], "does-not-exist", { title: "changed" })).toEqual([a]);
  });
});

describe("applyToggleDone", () => {
  it("ticks one occurrence of the named event, and leaves an override of the same series untouched", () => {
    const parent = series();
    const override = event({ seriesId: parent.id, seriesKey: instantKey(WEEKLY.second) });
    const ticked = applyToggleDone([parent, override], parent.id, WEEKLY.second);
    expect
      .soft(ticked.find((e) => e.id === parent.id)?.doneKeys)
      .toEqual([instantKey(WEEKLY.second)]);
    // A tick is per-occurrence on one event, not per-series: an override
    // carrying the same seriesId is a different event and keeps its own list.
    expect.soft(ticked.find((e) => e.id === override.id)?.doneKeys).toEqual([]);
  });

  it("un-ticks a key already present rather than appending a duplicate", () => {
    const task = event({ doneKeys: [instantKey(WEEKLY.second)] });
    expect(applyToggleDone([task], task.id, WEEKLY.second)[0].doneKeys).toEqual([]);
  });
});

describe("applyRemove", () => {
  it("takes the series' own overrides with it, and leaves an unrelated event's overrides alone", () => {
    const target = series();
    const detached = event({ seriesId: target.id, seriesKey: instantKey(WEEKLY.second) });
    const otherSeries = series();
    const otherOverride = event({
      seriesId: otherSeries.id,
      seriesKey: instantKey(WEEKLY.second),
    });

    const remaining = applyRemove([target, detached, otherSeries, otherOverride], target.id);
    expect.soft(remaining.map((e) => e.id)).toEqual([otherSeries.id, otherOverride.id]);
  });

  it("removing an id that is not there is a no-op", () => {
    const a = event();
    expect(applyRemove([a], "does-not-exist")).toEqual([a]);
  });
});

describe("applySplit", () => {
  it.each([
    { name: "before the cut stays on the head", key: WEEKLY.second, wantsHead: true },
    { name: "exactly at the cut moves to the tail", key: WEEKLY.third, wantsHead: false },
    { name: "after the cut moves to the tail", key: WEEKLY.fourth, wantsHead: false },
  ])("an override $name", ({ key, wantsHead }) => {
    const s = series();
    const override = event({ seriesId: s.id, seriesKey: instantKey(key) });
    const { events, created } = applySplit([s, override], s.id, WEEKLY.third, body(s), mintId);
    const moved = events.find((e) => e.id === override.id);
    expect.soft(moved?.seriesId).toBe(wantsHead ? s.id : created?.id);
  });

  it("seeds the created tail as a series of its own — no seriesId, no seriesKey", () => {
    const s = series();
    const { created } = applySplit([s], s.id, WEEKLY.third, body(s), mintId);
    expect.soft(created?.seriesId).toBe("");
    expect.soft(created?.seriesKey).toBe("");
    // The tail is the same rule the head was, unless split.tail overrides it.
    expect(created?.repeat).toBe("weekly");
  });

  it("leaves an event with no relation to the split exactly as it was", () => {
    const s = series();
    const unrelated = event({ title: "standalone" });
    const { events } = applySplit([s, unrelated], s.id, WEEKLY.third, body(s), mintId);
    expect(events.find((e) => e.id === unrelated.id)).toBe(unrelated);
  });

  it("returns created: null and the events array unchanged for an id that is not there", () => {
    const events: CalEvent[] = [series()];
    const result = applySplit(events, "does-not-exist", WEEKLY.third, body(series()), mintId);
    expect.soft(result.created).toBeNull();
    expect(result.events).toBe(events);
  });

  // The cut bounds `until` at `at - 1`, whatever `at` is — including the
  // series' own start, which leaves the head able to generate nothing.
  it("cutting at the series' own first instant bounds the head before its own start", () => {
    const s = series();
    const { events } = applySplit([s], s.id, WEEKLY.seed, body(s), mintId);
    expect(events.find((e) => e.id === s.id)?.until).toBe(WEEKLY.seed - 1);
  });

  it("partitions exdates/rdates onto the two halves rather than copying them onto both", () => {
    const s = event({
      start: WEEKLY.seed,
      ...rule({
        repeat: "weekly",
        exdates: [instantKey(WEEKLY.second), instantKey(WEEKLY.fourth)],
        rdates: [instantKey(WEEKLY.second), instantKey(WEEKLY.fourth)],
      }),
    });
    const { events, created } = applySplit([s], s.id, WEEKLY.third, body(s), mintId);
    const head = events.find((e) => e.id === s.id);
    // A future EXDATE left on the head would resurrect a day the split was
    // meant to keep skipped; a future RDATE left on the head would fire from
    // both halves once the tail also carries it.
    expect.soft(head?.exdates).toEqual([instantKey(WEEKLY.second)]);
    expect.soft(head?.rdates).toEqual([instantKey(WEEKLY.second)]);
    expect.soft(created?.exdates).toEqual([instantKey(WEEKLY.fourth)]);
    expect.soft(created?.rdates).toEqual([instantKey(WEEKLY.fourth)]);
  });
});

describe("applyTruncate", () => {
  it.each([
    { name: "before the cut is kept", key: WEEKLY.second, kept: true },
    { name: "exactly at the cut is dropped", key: WEEKLY.third, kept: false },
    { name: "after the cut is dropped", key: WEEKLY.fourth, kept: false },
  ])("an override $name", ({ key, kept }) => {
    const s = series();
    const override = event({ seriesId: s.id, seriesKey: instantKey(key) });
    const truncated = applyTruncate([s, override], s.id, WEEKLY.third);
    expect(truncated.some((e) => e.id === override.id)).toBe(kept);
  });

  it("bounds the head at the instant before the cut, the same as a split", () => {
    const s = series();
    const truncated = applyTruncate([s], s.id, WEEKLY.third);
    expect(truncated.find((e) => e.id === s.id)?.until).toBe(WEEKLY.third - 1);
  });

  it("truncating an id that is not there returns the same events array, unchanged", () => {
    const events: CalEvent[] = [series()];
    expect(applyTruncate(events, "does-not-exist", WEEKLY.third)).toBe(events);
  });
});
