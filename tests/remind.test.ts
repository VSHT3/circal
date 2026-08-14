import { describe, expect, it } from "vitest";
import { at, byDay, calendar, event } from "./helpers";
import {
  REMIND_LEADS,
  dueReminders,
  reminderText,
  titleCountdown,
  type Reminder,
} from "@/lib/remind";

const cal = calendar();

describe("REMIND_LEADS", () => {
  it("is the fixed set the settings panel offers", () => {
    expect(REMIND_LEADS).toEqual([0, 5, 10, 15, 30, 60]);
  });
});

/* ---------------------------- the one-minute window ---------------------------- */

describe("dueReminders: the half-open window, and it never catches up", () => {
  // now = 2026-03-09 08:00, lead = 60 -> target = 09:00:00, window = [09:00:00, 09:01:00).
  const rows = [
    { name: "just before the window opens", start: "2026-03-09 08:59:59", due: false },
    { name: "at the window's inclusive start", start: "2026-03-09 09:00:00", due: true },
    {
      name: "59 seconds into the window — still inside it",
      start: "2026-03-09 09:00:59",
      due: true,
    },
    {
      name: "at the window's exclusive end — the next tick's job",
      start: "2026-03-09 09:01:00",
      due: false,
    },
    {
      name: "well before target (tab asleep for a while) — it never catches up",
      start: "2026-03-09 08:45:00",
      due: false,
    },
  ];

  it.each(rows)("$name", ({ start, due }) => {
    const e = event({ start });
    const reminders = dueReminders([e], [cal], at("2026-03-09 08:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(due ? 1 : 0);
    if (due) expect.soft(reminders[0]?.event.id).toBe(e.id);
  });
});

describe("dueReminders: lead 0 and lead 60", () => {
  it("lead 0 — the occurrence starting this very minute", () => {
    const e = event({ start: "2026-03-09 09:00" });
    const reminders = dueReminders([e], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0]?.lead).toBe(0);
  });

  it("lead 60 — a full hour ahead of the occurrence", () => {
    const e = event({ start: "2026-03-09 10:00" });
    const reminders = dueReminders([e], [cal], at("2026-03-09 09:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0]?.lead).toBe(60);
  });

  it("does not fire lead 60 for an occurrence only 30 minutes out", () => {
    const e = event({ start: "2026-03-09 09:30" });
    const reminders = dueReminders([e], [cal], at("2026-03-09 09:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(0);
  });
});

describe("dueReminders: a target that crosses midnight into tomorrow", () => {
  it("finds an occurrence whose target minute lands after midnight", () => {
    const e = event({ start: "2026-03-09 00:15" });
    const reminders = dueReminders([e], [cal], at("2026-03-08 23:15"), 60, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0]?.start).toBeSameInstantAs("2026-03-09 00:15");
  });

  it("does not find it on the wrong side of the boundary", () => {
    const e = event({ start: "2026-03-09 00:15" });
    const reminders = dueReminders([e], [cal], at("2026-03-08 23:14"), 60, new Set());
    expect.soft(reminders).toHaveLength(0);
  });
});

/* -------------------------------- all-day / hidden ------------------------------- */

describe("dueReminders: all-day occurrences never fire", () => {
  it("skips an all-day event even when its midnight lines up with the window", () => {
    const e = event({ allDay: true, start: "2026-03-09", end: "2026-03-10" });
    const reminders = dueReminders([e], [cal], at("2026-03-09 00:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(0);
  });
});

describe("dueReminders: a dated task fires, a ticked one does not", () => {
  it("raises a task at its due moment — a to-do with a time is the thing most worth a nudge", () => {
    const e = event({ task: true, start: "2026-03-09 09:00", end: "2026-03-09 09:00" });
    const reminders = dueReminders([e], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminderText(reminders[0], "24h").body).toBe("Due now · 09:00");
  });

  it("says nothing about one already ticked off", () => {
    const e = event({
      task: true,
      start: "2026-03-09 09:00",
      end: "2026-03-09 09:00",
      doneKeys: ["2026-03-09T09:00:00"],
    });
    const reminders = dueReminders([e], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(0);
  });

  it("still nudges the occurrence of a repeating task that has not been ticked", () => {
    const e = event({
      task: true,
      start: "2026-03-02 09:00",
      end: "2026-03-02 09:00",
      repeat: "weekly",
      doneKeys: ["2026-03-02T09:00:00"],
    });
    const reminders = dueReminders([e], [cal], at("2026-03-09 08:50"), 10, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0].start).toBeSameInstantAs("2026-03-09 09:00");
  });
});

describe("dueReminders: hidden calendars are already filtered by occurrencesOn", () => {
  it("raises nothing for an event on a hidden calendar", () => {
    const hidden = calendar({ id: "cal-hidden", visible: false });
    const e = event({ calendarId: "cal-hidden", start: "2026-03-09 09:00" });
    const reminders = dueReminders([e], [hidden], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(0);
  });

  it("still raises the same event once its calendar is visible again", () => {
    const visible = calendar({ id: "cal-hidden", visible: true });
    const e = event({ calendarId: "cal-hidden", start: "2026-03-09 09:00" });
    const reminders = dueReminders([e], [visible], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders).toHaveLength(1);
  });
});

/* --------------------------------- fired / order ---------------------------------- */

describe("dueReminders: the fired set suppresses a repeat", () => {
  it("does not raise a key already in `fired`", () => {
    const e = event({ start: "2026-03-09 09:00" });
    const first = dueReminders([e], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(first).toHaveLength(1);

    const again = dueReminders([e], [cal], at("2026-03-09 09:00"), 0, new Set([first[0]!.key]));
    expect.soft(again).toHaveLength(0);
  });
});

describe("dueReminders: return order is by start instant", () => {
  it("sorts two occurrences due in the same window, regardless of input order", () => {
    const later = event({ title: "Later", start: "2026-03-09 09:00:45" });
    const earlier = event({ title: "Earlier", start: "2026-03-09 09:00:00" });
    // Passed in reverse so a stable-but-wrong implementation cannot pass by accident.
    const reminders = dueReminders([later, earlier], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders.map((r) => r.event.title)).toEqual(["Earlier", "Later"]);
  });
});

/* ------------------------------------ recurrence ----------------------------------- */

describe("dueReminders: a recurring event fires on the right day only", () => {
  // 2026-03-09 is a Monday, 2026-03-08 a Sunday.
  const weekly = () =>
    event({
      title: "Standup",
      repeat: "weekly" as const,
      byDay: byDay("MO"),
      start: "2026-03-02 09:00",
    });

  it("fires on the Monday the rule lands on", () => {
    const reminders = dueReminders([weekly()], [cal], at("2026-03-09 08:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0]?.start).toBeSameInstantAs("2026-03-09 09:00");
  });

  it("does not fire on the Sunday before it", () => {
    const reminders = dueReminders([weekly()], [cal], at("2026-03-08 08:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(0);
  });
});

/* ----------------------------------- multi-day ------------------------------------- */

describe("dueReminders: a multi-day event fires exactly once, only on the day it starts", () => {
  const trip = () =>
    event({ title: "Conference", start: "2026-03-08 09:00", end: "2026-03-11 09:00" });

  it("fires on its first day, at its own start", () => {
    const reminders = dueReminders([trip()], [cal], at("2026-03-08 08:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(1);
  });

  // A continuation day is clipped to startMin 0 by `occurrencesOn` — a bug that
  // compared minute-of-day instead of the real instant would fire here too.
  it("does not fire again at midnight on a day it merely continues through", () => {
    const reminders = dueReminders([trip()], [cal], at("2026-03-08 23:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(0);
  });

  it("does not fire on its second day at the hour it started on its first", () => {
    const reminders = dueReminders([trip()], [cal], at("2026-03-09 08:00"), 60, new Set());
    expect.soft(reminders).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- *
 * reminderText
 * -------------------------------------------------------------------------- */

describe("reminderText", () => {
  const reminder = (overrides: Partial<Reminder> = {}): Reminder => ({
    key: "k1",
    event: event({ title: "Design review" }),
    start: at("2026-03-09 09:05"),
    lead: 10,
    ...overrides,
  });

  it.each([
    { name: "lead 0, 12h clock", lead: 0, clock: "12h" as const, body: "Starts now · 9:05 AM" },
    { name: "lead 0, 24h clock", lead: 0, clock: "24h" as const, body: "Starts now · 09:05" },
    { name: "lead 10, 12h clock", lead: 10, clock: "12h" as const, body: "in 10m · 9:05 AM" },
    { name: "lead 10, 24h clock", lead: 10, clock: "24h" as const, body: "in 10m · 09:05" },
    { name: "lead 60, 12h clock", lead: 60, clock: "12h" as const, body: "in 1h · 9:05 AM" },
    { name: "lead 60, 24h clock", lead: 60, clock: "24h" as const, body: "in 1h · 09:05" },
  ])("$name", ({ lead, clock, body }) => {
    const { title, body: got } = reminderText(reminder({ lead }), clock);
    expect.soft(title).toBe("Design review");
    expect.soft(got).toBe(body);
  });

  it('falls back to "Untitled" for an event with no title', () => {
    const { title } = reminderText(reminder({ event: event({ title: "" }) }), "12h");
    expect.soft(title).toBe("Untitled");
  });
});

/* -------------------------------------------------------------------------- *
 * titleCountdown
 * -------------------------------------------------------------------------- */

describe("titleCountdown", () => {
  it("counts down to the next timed occurrence, floored like untilText", () => {
    // 899s to go, which is 14m59s — a round-to-nearest read would say 15m.
    const e = event({ title: "Standup", start: "2026-03-09 09:14:59" });
    const got = titleCountdown([e], [cal], at("2026-03-09 09:00:00"));
    expect(got).toBe("· 14m · Standup");
  });

  it("returns null when nothing timed is left today", () => {
    const e = event({ title: "Standup", start: "2026-03-09 08:00" });
    const got = titleCountdown([e], [cal], at("2026-03-09 09:00"));
    expect(got).toBeNull();
  });

  it("an all-day event is never it — no minute to count down to", () => {
    const allDay = event({ allDay: true, start: "2026-03-09", end: "2026-03-10" });
    const timed = event({ title: "Standup", start: "2026-03-09 10:00" });
    const got = titleCountdown([allDay, timed], [cal], at("2026-03-09 09:00"));
    expect(got).toBe("· 1h · Standup");
  });

  it("picks the earliest qualifying occurrence, not the first in the array", () => {
    const later = event({ title: "Lunch", start: "2026-03-09 12:00" });
    const sooner = event({ title: "Standup", start: "2026-03-09 09:30" });
    const got = titleCountdown([later, sooner], [cal], at("2026-03-09 09:00"));
    expect(got).toBe("· 30m · Standup");
  });

  it('reads "now" rather than 0m for an occurrence already running', () => {
    const e = event({ title: "Standup", start: "2026-03-09 08:45", end: "2026-03-09 09:15" });
    const got = titleCountdown([e], [cal], at("2026-03-09 09:00"));
    expect(got).toBe("· now · Standup");
  });

  // The minute it starts in is still "now": a floored zero and a running
  // occurrence are the same fact, and printing `0m` for either is a
  // countdown that has arrived and then stays there.
  it('reads "now" in the minute an occurrence starts', () => {
    const e = event({ title: "Standup", start: "2026-03-09 09:00:30" });
    const got = titleCountdown([e], [cal], at("2026-03-09 09:00:00"));
    expect(got).toBe("· now · Standup");
  });

  it('falls back to "Untitled" for an event with no title', () => {
    const e = event({ title: "", start: "2026-03-09 09:30" });
    const got = titleCountdown([e], [cal], at("2026-03-09 09:00"));
    expect(got).toBe("· 30m · Untitled");
  });
});
