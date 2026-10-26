import { describe, expect, it } from "vitest";
import { dailyNote } from "./helpers";
import { dayNoteId, isDayNoteDay, readDayNote, readDayNotes } from "@/lib/dayNotes";
import { canonicalJson, mergeDocuments } from "@/lib/merge";

describe("day note dates", () => {
  it.each(["2026-01-01", "2024-02-29", "2000-02-29", "0099-12-31", "2026-12-31"])(
    "accepts %s",
    (day) => {
      expect(isDayNoteDay(day)).toBe(true);
      expect(dayNoteId(day)).toBe(`day-note:${day}`);
    },
  );

  it.each([
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-1-01",
    "2026-01-1",
    "2026-01-01T00:00:00Z",
    "",
    null,
    20260101,
  ])("rejects %s", (day) => {
    expect(isDayNoteDay(day)).toBe(false);
    expect(readDayNote({ day, text: "Note" })).toBeNull();
  });
});

describe("day note reading", () => {
  it("derives identity from the date and preserves Markdown, whitespace and blank clears", () => {
    const note = dailyNote({ text: "# Heading\n\n- [x] Done\n\n  ", updatedAt: 1234 });
    expect(readDayNote({ ...note, id: "foreign-id" })).toEqual(note);
    expect(readDayNote({ ...note, text: "" })).toEqual({ ...note, text: "" });
  });

  it.each([null, [], {}, { day: "2026-03-08" }, { day: "2026-03-08", text: 3 }])(
    "rejects malformed records: %j",
    (value) => {
      expect(readDayNote(value)).toBeNull();
    },
  );

  it("normalises invalid stamps and missing collections", () => {
    expect(readDayNote({ day: "2026-03-08", text: "Note", updatedAt: -1 })?.updatedAt).toBe(0);
    expect(readDayNote({ day: "2026-03-08", text: "Note", updatedAt: 1234.5 })?.updatedAt).toBe(
      1234,
    );
    expect(readDayNotes(undefined)).toEqual([]);
    expect(readDayNotes({})).toEqual([]);
  });

  it("deduplicates dates by the same stamp and escaped-text tie-break as the merge", () => {
    const older = dailyNote({ text: "Old", updatedAt: 1 });
    const note = dailyNote({ text: "a", updatedAt: 2 });
    const tied = dailyNote({ text: "\n", updatedAt: 2 });
    const blank = dailyNote({ day: "2026-03-09", text: "", updatedAt: 3 });
    const expected = canonicalJson(note) < canonicalJson(tied) ? note : tied;
    expect(readDayNotes([older, note, tied, null, blank])).toEqual([expected, blank]);
    expect(readDayNotes([tied, note, older])).toEqual([expected]);
    const base = {
      events: [],
      calendars: [],
      tasks: [],
      taskLists: [],
      graves: [],
      settings: {},
      settingsAt: 0,
    };
    expect(
      mergeDocuments({ ...base, dayNotes: [note] }, { ...base, dayNotes: [tied] }, 3).dayNotes,
    ).toEqual([expected]);
  });
});
