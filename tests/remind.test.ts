import { describe, expect, it } from "vitest";
import { at, byDay, calendar, event } from "./helpers";
import { REMIND_INHERIT, REMIND_SILENT, instantKey } from "@/lib/events";
import {
  REMIND_LEADS,
  dueReminders,
  leadOf,
  remindLabel,
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

/* ------------------------------ the three states ------------------------------ *
 * `leadOf` is to a reminder what `colorOf` is to a colour: the one place that
 * knows an event's field is an *override* rather than the answer. The
 * vocabulary it reads — the two states and the validator that pins them —
 * belongs to the model and is tested in `tests/events.test.ts`; what is here
 * is the precedence, which is this module's own. */

describe("leadOf: inherit, its own, or silent", () => {
  const rows = [
    { name: "inheriting takes the setting's lead", own: REMIND_INHERIT, expected: 10 },
    { name: "its own lead beats the setting", own: 60, expected: 60 },
    { name: "silent is no reminder at all", own: REMIND_SILENT, expected: null },
    // The whole reason the two absences are negative: "tell me as it starts"
    // is a lead somebody means, and a scheme where `0` doubled as off or as
    // absent would make it unsayable.
    { name: "0 is a lead, not an absence", own: 0, expected: 0 },
  ];

  it.each(rows)("$name", ({ own, expected }) => {
    expect(leadOf(event({ remindLead: own }), 10)).toBe(expected);
  });

  it("answers about the event, never about whether reminders are switched on", () => {
    // The shell's own gate, deliberately not asked here — a resolver that
    // consulted it could not be used by the exporter, which must know what
    // the event says whatever this browser is set to.
    expect(leadOf(event({ remindLead: 15 }), 10)).toBe(15);
  });
});

describe("remindLabel", () => {
  it.each([
    { minutes: 0, label: "As it starts" },
    { minutes: 5, label: "5m before" },
    { minutes: 60, label: "1h before" },
    { minutes: 1440, label: "24h before" },
  ])("prints $minutes as $label", ({ minutes, label }) => {
    expect.soft(remindLabel(minutes)).toBe(label);
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

/* ------------------------------ the per-event lead ------------------------------ *
 * The setting is now the *fallback*. An event may name its own lead or ask
 * for none at all, and the same one-minute window is measured from whichever
 * of the three it turns out to be. */

describe("dueReminders: an event's own lead overrides the setting's", () => {
  // The setting says five minutes; the dentist wants an hour.
  const dentist = () => event({ title: "Dentist", start: "2026-03-09 09:00", remindLead: 60 });

  it("fires an hour ahead, where the setting would have waited", () => {
    const reminders = dueReminders([dentist()], [cal], at("2026-03-09 08:00"), 5, new Set());
    expect.soft(reminders).toHaveLength(1);
    // The resolved lead, which is what the notification then prints.
    expect.soft(reminders[0]?.lead).toBe(60);
    expect.soft(reminderText(reminders[0], "24h").body).toBe("in 1h · 09:00");
  });

  it("says nothing at the setting's own minute", () => {
    const reminders = dueReminders([dentist()], [cal], at("2026-03-09 08:55"), 5, new Set());
    expect.soft(reminders).toHaveLength(0);
  });

  // Zero has to be a lead the event can *name*, not a way of spelling one of
  // the two absences: this is the case that fails if it ever doubles as one.
  it("a named lead of 0 fires as the occurrence starts, not an hour before it", () => {
    const standup = event({ title: "Standup", start: "2026-03-09 09:00", remindLead: 0 });
    expect
      .soft(dueReminders([standup], [cal], at("2026-03-09 08:00"), 60, new Set()))
      .toHaveLength(0);
    const atStart = dueReminders([standup], [cal], at("2026-03-09 09:00"), 60, new Set());
    expect.soft(atStart).toHaveLength(1);
    expect.soft(atStart[0]?.lead).toBe(0);
  });

  // Two events in one minute, two different leads, and the day scan is driven
  // off the leads in use rather than off one number — a scan that only looked
  // where the setting pointed would find one of these and not the other.
  it("resolves each occurrence separately in the same tick", () => {
    const soon = event({ title: "Soon", start: "2026-03-09 09:05", remindLead: 5 });
    const later = event({ title: "Later", start: "2026-03-09 10:00", remindLead: 60 });
    const reminders = dueReminders([soon, later], [cal], at("2026-03-09 09:00"), 15, new Set());
    expect.soft(reminders.map((r) => r.event.title)).toEqual(["Soon", "Later"]);
    expect.soft(reminders.map((r) => r.lead)).toEqual([5, 60]);
  });

  it("finds an event whose own lead is the one that crosses midnight", () => {
    const e = event({ start: "2026-03-09 00:15", remindLead: 60 });
    // The setting is 0, so nothing but this event's own lead can look into
    // tomorrow at all.
    const reminders = dueReminders([e], [cal], at("2026-03-08 23:15"), 0, new Set());
    expect.soft(reminders).toHaveLength(1);
    expect.soft(reminders[0]?.start).toBeSameInstantAs("2026-03-09 00:15");
  });
});

describe("dueReminders: a silent event, and only it, stays quiet", () => {
  // The point of the third state: one event you already know about goes
  // quiet without the whole feature going quiet with it.
  const quiet = () =>
    event({ title: "Standup", start: "2026-03-09 09:00", remindLead: REMIND_SILENT });
  const other = () => event({ title: "Review", start: "2026-03-09 09:00" });

  it("raises nothing for the silenced event while its neighbour fires", () => {
    const reminders = dueReminders([quiet(), other()], [cal], at("2026-03-09 09:00"), 0, new Set());
    expect.soft(reminders.map((r) => r.event.title)).toEqual(["Review"]);
  });

  it("stays quiet at every lead the setting could be on", () => {
    for (const lead of REMIND_LEADS) {
      const now = at("2026-03-09 09:00");
      now.setMinutes(now.getMinutes() - lead);
      expect.soft(dueReminders([quiet()], [cal], now, lead, new Set())).toHaveLength(0);
    }
  });

  // The reason the whole event list is passed to every day query rather than
  // partitioned by lead: an override suppresses the instant it replaces, and
  // a series scanned without its silent override in the list would generate
  // the very occurrence the user silenced.
  it("a silenced override keeps its series quiet on that day alone", () => {
    const series = event({
      id: "series",
      title: "Standup",
      start: "2026-03-02 09:00",
      end: "2026-03-02 09:15",
      repeat: "weekly",
    });
    const silenced = event({
      id: "series-quiet",
      title: "Standup",
      seriesId: "series",
      seriesKey: instantKey(at("2026-03-09 09:00")),
      start: "2026-03-09 09:00",
      end: "2026-03-09 09:15",
      remindLead: REMIND_SILENT,
    });
    const events = [series, silenced];
    expect.soft(dueReminders(events, [cal], at("2026-03-09 09:00"), 0, new Set())).toHaveLength(0);
    // The Monday after is the series' own occurrence again, and it speaks.
    expect.soft(dueReminders(events, [cal], at("2026-03-16 09:00"), 0, new Set())).toHaveLength(1);
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
