import { describe, expect, it } from "vitest";
import { at, calendar, dailyNote, event } from "../helpers";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { localZone, MIRROR_VERSION } from "@/lib/mirror";
import { isResourceUri, renderResource } from "../../mcp/resources";
import type { Loaded } from "../../mcp/store";

function loaded(): Loaded {
  return {
    warning: null,
    contents: {
      version: MIRROR_VERSION,
      zone: localZone(),
      rev: 0,
      events: [],
      tasks: [],
      calendars: [calendar()],
      taskLists: [],
      dayNotes: [],
      settings: { ...DEFAULT_SETTINGS },
      settingsAt: 0,
      graves: [],
    },
  };
}

function text(uri: string, input: Loaded, now: Date): string {
  const content = renderResource(uri, input, "file /calendar.json", now).contents[0];
  if (!("text" in content)) throw new Error("Expected text resource");
  return content.text;
}

describe("resource dates west of UTC", () => {
  it("keeps today's late-evening agenda on its local date, not the next UTC date", () => {
    const input = loaded();
    input.contents.events = [
      event({ title: "Late local event", start: "2026-03-08 23:00", end: "2026-03-08 23:30" }),
      event({ title: "Next day event", start: "2026-03-09 09:00" }),
    ];
    const now = at("2026-03-08 23:15");
    expect(now.toISOString()).toContain("2026-03-09");
    const output = text("circal://today", input, now);
    expect(output).toContain("America/Los_Angeles");
    expect(output).toContain("2026-03-08 —");
    expect(output).toContain("Late local event");
    expect(output).not.toContain("Next day event");
    expect(text("circal://days/2026-03-08", input, now)).toBe(output);
    const afterMidnight = text("circal://today", input, at("2026-03-09 00:00"));
    expect(afterMidnight).toContain("Next day event");
    expect(afterMidnight).not.toContain("Late local event");
  });

  it.each([
    { date: "2026-03-08", next: "2026-03-09", utcHour: "06:59" },
    { date: "2026-11-01", next: "2026-11-02", utcHour: "07:59" },
  ])("keeps the complete DST day $date until local midnight", ({ date, next, utcHour }) => {
    const input = loaded();
    input.contents.events = [
      event({ title: "Early", start: `${date} 00:15`, end: `${date} 00:45` }),
      event({ title: "Late", start: `${date} 23:15`, end: `${date} 23:45` }),
      event({ title: "Tomorrow", start: `${next} 00:00`, end: `${next} 00:30` }),
    ];
    const beforeMidnight = at(`${date} 23:59`);
    expect(beforeMidnight.toISOString()).toContain(`${next}T${utcHour}`);
    const output = text("circal://today", input, beforeMidnight);
    expect(output).toContain(`${date} — 2 occurrences`);
    expect(output).toContain("Early");
    expect(output).toContain("Late");
    expect(output).not.toContain("Tomorrow");
    expect(text("circal://today", input, at(`${next} 00:00`))).toContain("Tomorrow");
  });

  it("looks up note keys directly without converting a date through UTC", () => {
    const input = loaded();
    input.contents.dayNotes = [
      dailyNote({ day: "2026-03-08", text: "Sunday note" }),
      dailyNote({ day: "2026-03-09", text: "Monday note" }),
    ];
    const output = text("circal://notes/2026-03-08", input, at("2026-03-08 23:59"));
    expect(output).toContain("Sunday note");
    expect(output).not.toContain("Monday note");
    expect(isResourceUri("circal://days/2028-02-29")).toBe(true);
    expect(isResourceUri("circal://days/2026-02-29")).toBe(false);
    expect(isResourceUri("circal://notes/2026-02-29")).toBe(false);
  });
});
