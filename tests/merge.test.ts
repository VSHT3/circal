import { describe, expect, it } from "vitest";
import { calendar, event, grave, ms, task, taskList } from "./helpers";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/store";
import { GRAVE_TTL } from "@/lib/events";
import { canonicalJson, mergeDocuments, pruneGraves, restamped, stamped } from "@/lib/merge";
import type { Mergeable } from "@/lib/merge";
import { mirrorDigest, mirrorMerges, readMirrorFile, serialiseMirror } from "@/lib/mirror";
import { applyRemove } from "@/lib/mutate";

/**
 * The module that decides what a conflict means, so what is pinned here is the
 * two properties that make it safe to run on every poll — it is commutative
 * and idempotent — plus the three answers it gives that a reader would
 * otherwise have to trust: a grave beats an older edit, an edit beats an older
 * grave, and an unstamped document is not merged at all.
 *
 * **No `tests/west/` case, and the exemption is reasoned rather than
 * forgotten.** The standing rule is the opposite (`AGENTS.md`: anything
 * day-keyed gets a re-run west of UTC), and it does not reach here: every
 * comparison in `merge.ts` is arithmetic on epoch milliseconds, with no
 * `dayKey`, no `startOfDay` and no `addDays` anywhere in the module or in
 * anything it imports for this purpose. A zone cannot change the answer to
 * `a.updatedAt > b.updatedAt`.
 */

const TUESDAY = ms("2026-03-10 09:00");
const WEDNESDAY = ms("2026-03-11 09:00");
const NOW = ms("2026-03-12 09:00");

/** A document, stamped. `settingsAt` defaults to something non-zero because
 *  that zero is the version gate's own case, and those tests say so. */
function doc(over: Partial<Mergeable<Settings>> = {}): Mergeable<Settings> {
  return {
    events: [],
    tasks: [],
    taskLists: [],
    calendars: [calendar({ id: "cal-work", updatedAt: TUESDAY })],
    graves: [],
    settings: DEFAULT_SETTINGS,
    settingsAt: TUESDAY,
    ...over,
  };
}

describe("task list merge", () => {
  it("unites nested lists, keeps later moves, and does not resurrect deleted lists", () => {
    const root = taskList({ id: "root", updatedAt: TUESDAY });
    const child = taskList({ id: "child", parentId: root.id, updatedAt: TUESDAY });
    const mine = doc({ taskLists: [root], graves: [{ id: child.id, at: WEDNESDAY }] });
    const theirs = doc({
      taskLists: [root, child, taskList({ id: "new", parentId: root.id, updatedAt: WEDNESDAY })],
    });
    const merged = mergeDocuments(mine, theirs, NOW);
    expect(merged.taskLists.map((list) => list.id)).toEqual(["new", "root"]);
    expect(merged).toEqual(mergeDocuments(theirs, mine, NOW));
    expect(mergeDocuments(merged, theirs, NOW)).toEqual(merged);
    const moved = doc({ taskLists: [{ ...root, parentId: "new", updatedAt: NOW }] });
    expect(
      mergeDocuments(merged, moved, NOW).taskLists.find((list) => list.id === root.id)?.parentId,
    ).toBe("new");
  });

  it("list-only edits mark an otherwise empty document as changed", () => {
    const empty = doc({ calendars: [], settingsAt: 0 });
    const edited = { ...empty, taskLists: [taskList({ updatedAt: TUESDAY })] };
    expect(stamped(edited)).toBe(true);
    const undone = restamped(empty, edited, NOW);
    expect(undone.graves).toContainEqual({ id: edited.taskLists[0].id, at: NOW });
  });
});
const ids = (records: { id: string }[]) => records.map((r) => r.id).sort();

describe("commutativity and idempotence", () => {
  /* Not remarks: they are what make it safe to merge on every poll rather than
   * once at a handshake. A merge that answered differently by argument order
   * would have two machines writing at each other for ever. */
  const laptop = doc({
    events: [
      event({ id: "a", title: "Tuesday", updatedAt: TUESDAY }),
      event({ id: "b", title: "mine only", updatedAt: TUESDAY }),
    ],
    graves: [grave("c", TUESDAY)],
  });
  const pc = doc({
    events: [
      event({ id: "a", title: "Wednesday", updatedAt: WEDNESDAY }),
      event({ id: "c", title: "deleted on the laptop", updatedAt: ms("2026-03-09 09:00") }),
    ],
    settingsAt: WEDNESDAY,
    settings: { ...DEFAULT_SETTINGS, clock: "12h" },
  });

  it("merges to the same document whichever way round the arguments come", () => {
    expect(canonicalJson(mergeDocuments(laptop, pc, NOW))).toBe(
      canonicalJson(mergeDocuments(pc, laptop, NOW)),
    );
  });

  it.each([
    { name: "the laptop", document: laptop },
    { name: "the PC", document: pc },
  ])("merging $name with itself changes nothing", ({ document }) => {
    expect.soft(mergeDocuments(document, document, NOW)).toEqual(document);
  });

  it("is stable under a second pass, so a poll that re-merges writes nothing new", () => {
    const once = mergeDocuments(laptop, pc, NOW);
    expect(mergeDocuments(once, once, NOW)).toEqual(once);
  });

  // The whole point of the feature, and the one case that loses a day today.
  it("keeps both machines' work rather than one machine's document", () => {
    const merged = mergeDocuments(laptop, pc, NOW);
    expect.soft(ids(merged.events)).toEqual(["a", "b"]);
    // The event both edited takes Wednesday's copy whole — no per-field merge,
    // which would manufacture a meeting neither person wrote.
    expect.soft(merged.events.find((e) => e.id === "a")?.title).toBe("Wednesday");
    expect.soft(merged.events.find((e) => e.id === "b")?.title).toBe("mine only");
  });
});

describe("tasks merge by the events' own rules", () => {
  it("unions by id, later stamp winning, and a grave beats a staler task", () => {
    const laptop = doc({
      tasks: [
        task({ id: "t-a", title: "Tuesday", updatedAt: TUESDAY }),
        task({ id: "t-b", title: "mine only", updatedAt: TUESDAY }),
      ],
      graves: [grave("t-c", TUESDAY)],
    });
    const pc = doc({
      tasks: [
        task({ id: "t-a", title: "Wednesday", updatedAt: WEDNESDAY }),
        task({ id: "t-c", title: "deleted on the laptop", updatedAt: ms("2026-03-09 09:00") }),
      ],
    });
    const merged = mergeDocuments(laptop, pc, NOW);
    expect.soft(ids(merged.tasks)).toEqual(["t-a", "t-b"]);
    expect.soft(merged.tasks.find((t) => t.id === "t-a")?.title).toBe("Wednesday");
    // Commutative here too, or two machines write at each other for ever.
    expect.soft(canonicalJson(mergeDocuments(pc, laptop, NOW))).toBe(canonicalJson(merged));
  });

  it("a task ticked later survives the merge ticked", () => {
    const mine = doc({ tasks: [task({ id: "t", done: false, updatedAt: TUESDAY })] });
    const theirs = doc({ tasks: [task({ id: "t", done: true, updatedAt: WEDNESDAY })] });
    expect(mergeDocuments(mine, theirs, NOW).tasks[0]?.done).toBe(true);
  });
});

/**
 * The whole point of the feature, through the real file format rather than
 * through the merge alone: the laptop edits on Tuesday, the PC on Wednesday,
 * and today whichever opens second adopts the other's document and discards
 * its own day.
 */
describe("two machines, one mirror file", () => {
  const MONDAY = ms("2026-03-09 09:00");
  const cal = calendar({ id: "cal-work", updatedAt: TUESDAY });
  const shared = event({
    id: "standup",
    title: "Standup",
    calendarId: "cal-work",
    updatedAt: TUESDAY,
  });
  // Written on Monday and deleted on Tuesday: a deletion follows the write it
  // is about, which is what makes the grave outrank the copy the PC still has.
  const stale = event({
    id: "stale",
    title: "Old thing",
    calendarId: "cal-work",
    updatedAt: MONDAY,
  });

  // Tuesday on the laptop: one new event, and one deletion.
  const removal = applyRemove(
    [
      shared,
      stale,
      event({ id: "tue", title: "Tuesday plan", calendarId: "cal-work", updatedAt: TUESDAY }),
    ],
    "stale",
    TUESDAY,
  );
  const laptop = doc({ events: removal.events, calendars: [cal], graves: removal.graves });

  // Wednesday on the PC, from a copy predating all of that: its own event, an
  // edit to the event they share, and the event the laptop deleted.
  const pc = doc({
    events: [
      { ...shared, title: "Standup, moved", updatedAt: WEDNESDAY },
      event({ id: "wed", title: "Wednesday plan", calendarId: "cal-work", updatedAt: WEDNESDAY }),
      stale,
    ],
    calendars: [cal],
  });

  const fromLaptop = () => readMirrorFile(serialiseMirror(laptop, 7))!;
  const fromPc = () => readMirrorFile(serialiseMirror(pc, 8))!;
  const titles = (d: { events: { title: string }[] }) => d.events.map((e) => e.title).sort();

  it("keeps both days' work, and the deletion sticks", () => {
    expect.soft(mirrorMerges(fromLaptop(), pc)).toBe(true);
    const onThePc = mergeDocuments(pc, fromLaptop(), WEDNESDAY);
    const onTheLaptop = mergeDocuments(laptop, fromPc(), WEDNESDAY);

    expect.soft(titles(onThePc)).toEqual(["Standup, moved", "Tuesday plan", "Wednesday plan"]);
    expect.soft(titles(onTheLaptop)).toEqual(titles(onThePc));
    // Not resurrected by the copy the PC was still holding.
    expect.soft(onThePc.events.some((e) => e.id === "stale")).toBe(false);
  });

  /**
   * The property the mirror depends on to stop writing back and forth, and it
   * has to hold on records that came out of the *file* as well as out of the
   * store — which is why the digest is canonical: the same event stored here
   * and rebuilt by `readEvent` there enumerate their keys differently, and an
   * insertion-order digest called a merge that changed nothing a change.
   */
  it("reaches one document from either side, and one digest with it", () => {
    const onThePc = mergeDocuments(pc, fromLaptop(), WEDNESDAY);
    const onTheLaptop = mergeDocuments(laptop, fromPc(), WEDNESDAY);
    expect.soft(canonicalJson(onThePc)).toBe(canonicalJson(onTheLaptop));
    expect.soft(mirrorDigest(onThePc)).toBe(mirrorDigest(onTheLaptop));
  });

  // What the mirror did before this work, for contrast: the branch took one
  // document whole, and the undo step landed on the machine nobody is at.
  it("where an adopt would have taken one document whole", () => {
    expect(titles(fromLaptop())).toEqual(["Standup", "Tuesday plan"]);
  });
});

describe("a grave against an edit", () => {
  const deleted = event({ id: "a", title: "gone", updatedAt: TUESDAY });

  it.each([
    {
      name: "buried after it was edited, so the deletion wins",
      buriedAt: WEDNESDAY,
      survives: false,
    },
    {
      name: "edited after it was buried, which is a resurrection the user performed",
      buriedAt: ms("2026-03-09 09:00"),
      survives: true,
    },
    {
      name: "buried in the same millisecond it was written, where the record stands",
      buriedAt: TUESDAY,
      survives: true,
    },
  ])("$name", ({ buriedAt, survives }) => {
    const holder = doc({ events: [deleted] });
    const digger = doc({ graves: [grave("a", buriedAt)] });
    // Both directions, because a merge cannot answer this one way round the
    // arguments and another way the other.
    for (const merged of [
      mergeDocuments(holder, digger, NOW),
      mergeDocuments(digger, holder, NOW),
    ]) {
      expect.soft(merged.events.some((e) => e.id === "a")).toBe(survives);
      // The grave is discarded exactly when the record outlived it: a grave
      // kept beside a live event would bury it again on the next pass.
      expect.soft(merged.graves.some((g) => g.id === "a")).toBe(!survives);
    }
  });

  it("buries a calendar the same way it buries an event", () => {
    const merged = mergeDocuments(
      doc({ calendars: [calendar({ id: "cal-work", updatedAt: TUESDAY })] }),
      doc({ calendars: [], graves: [grave("cal-work", WEDNESDAY)] }),
      NOW,
    );
    expect(merged.calendars).toEqual([]);
  });
});

describe("the tie-break", () => {
  /* `SYNC.md` said the lower id wins, which is unimplementable: this is a
   * union *by id*, so both candidates for a slot have the same id by
   * construction. The content is the only thing left that two machines can
   * compare without talking. */
  it("takes the same copy on both machines when the stamps are equal", () => {
    const mine = event({ id: "a", title: "Alpha", updatedAt: TUESDAY });
    const theirs = event({ id: "a", title: "Beta", updatedAt: TUESDAY });
    const a = mergeDocuments(doc({ events: [mine] }), doc({ events: [theirs] }), NOW);
    const b = mergeDocuments(doc({ events: [theirs] }), doc({ events: [mine] }), NOW);
    expect.soft(a.events[0].title).toBe(b.events[0].title);
    expect.soft(a.events[0].title).toBe("Alpha");
  });

  // The reason the tie-break cannot be `JSON.stringify`: the same record built
  // by a spread and rebuilt field by field by `backup.readEvent` enumerate
  // their keys in different orders, and a comparison on that string would call
  // two identical events different and pick by accident.
  it("reads two structurally equal records with different key order as one string", () => {
    const insertion = { id: "a", title: "Standup", attendees: [{ name: "Ada", address: "a@b" }] };
    const reversed = { attendees: [{ address: "a@b", name: "Ada" }], title: "Standup", id: "a" };
    expect.soft(JSON.stringify(insertion)).not.toBe(JSON.stringify(reversed));
    expect(canonicalJson(insertion)).toBe(canonicalJson(reversed));
  });

  it("breaks an equal settings stamp the same way, so neither machine keeps its own", () => {
    const mine = doc({ settings: { ...DEFAULT_SETTINGS, clock: "12h" } });
    const theirs = doc({ settings: { ...DEFAULT_SETTINGS, clock: "24h" } });
    expect(mergeDocuments(mine, theirs, NOW).settings).toEqual(
      mergeDocuments(theirs, mine, NOW).settings,
    );
  });
});

describe("settings are whole-object", () => {
  it("takes the later stamp's object entire, never a field from each", () => {
    const older = doc({ settings: { ...DEFAULT_SETTINGS, clock: "12h", totals: true } });
    const newer = doc({
      settings: { ...DEFAULT_SETTINGS, clock: "24h" },
      settingsAt: WEDNESDAY,
    });
    const merged = mergeDocuments(older, newer, NOW);
    expect.soft(merged.settings.clock).toBe("24h");
    expect.soft(merged.settings.totals).toBe(false);
    expect.soft(merged.settingsAt).toBe(WEDNESDAY);
  });
});

describe("graves are pruned", () => {
  it.each([
    { name: "inside the window", at: NOW - GRAVE_TTL + 1_000, kept: true },
    { name: "one millisecond past it", at: NOW - GRAVE_TTL - 1, kept: false },
  ])("a grave $name", ({ at, kept }) => {
    const merged = mergeDocuments(doc({ graves: [grave("x", at)] }), doc(), NOW);
    expect.soft(merged.graves.some((g) => g.id === "x")).toBe(kept);
  });

  it("keeps the later of two graves for one id, which is what a re-deletion is", () => {
    expect(pruneGraves([grave("x", TUESDAY), grave("x", WEDNESDAY)], NOW)).toEqual([
      { id: "x", at: WEDNESDAY },
    ]);
  });

  /* The consequence, stated rather than hidden: a machine offline longer than
   * the TTL resurrects what it deleted, because the grave is gone and the
   * record it argued with is not. */
  it("lets an expired grave lose to the event it used to bury", () => {
    const merged = mergeDocuments(
      doc({ graves: [grave("a", NOW - GRAVE_TTL - 1)] }),
      doc({ events: [event({ id: "a", updatedAt: NOW - GRAVE_TTL - 2 })] }),
      NOW,
    );
    expect(merged.events.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("an unstamped document is not merged", () => {
  /* The v1 refusal, and it is the caller's gate rather than a branch inside
   * `mergeDocuments`: a document that predates stamping cannot be merged
   * without guessing which of two undated copies of an event is the newer,
   * and today's adopt is the correct answer for it.
   *
   * What counts as stamped is the records, not only the settings stamp. It was
   * `settingsAt > 0` alone and that let two fresh installs adopt each other for
   * ever: neither may merge, and adopting an unstamped document leaves you
   * unstamped, so a real edit on one of them was adopted away by the other. */
  const bare = {
    events: [],
    calendars: [],
    tasks: [],
    taskLists: [],
    graves: [],
    settings: DEFAULT_SETTINGS,
    settingsAt: 0,
  };

  it.each([
    { name: "nothing stamped at all", over: {}, want: false },
    {
      name: "the demo day: seed events and default calendars, nobody's edits",
      over: {
        events: [event({ id: "demo" })],
        calendars: [calendar({ id: "personal" })],
      },
      want: false,
    },
    { name: "a settings change", over: { settingsAt: TUESDAY }, want: true },
    {
      name: "one real event",
      over: { events: [event({ id: "a", updatedAt: TUESDAY })] },
      want: true,
    },
    {
      name: "one real calendar",
      over: { calendars: [calendar({ id: "cal", updatedAt: TUESDAY })] },
      want: true,
    },
    {
      name: "one deletion, and nothing left to show for it",
      over: { graves: [grave("gone", TUESDAY)] },
      want: true,
    },
    {
      name: "one real task",
      over: { tasks: [task({ id: "t", updatedAt: TUESDAY })] },
      want: true,
    },
  ])("$name", ({ over, want }) => {
    expect.soft(stamped({ ...bare, ...over })).toBe(want);
  });
});

describe("restamped", () => {
  /* What an undo owes the merge. Left alone, an undo puts back records
   * carrying their old stamps and the next merge silently reverts it. */
  const kept = event({ id: "keep", title: "same", updatedAt: TUESDAY });

  it("stamps what changed, leaves what did not, and buries what is gone", () => {
    const current = {
      events: [kept, event({ id: "new", title: "created", updatedAt: WEDNESDAY })],
      calendars: [calendar({ id: "cal-work", updatedAt: TUESDAY })],
      tasks: [],
      taskLists: [],
      graves: [],
    };
    const step = {
      events: [kept, event({ id: "old", title: "deleted earlier", updatedAt: TUESDAY })],
      calendars: [calendar({ id: "cal-work", name: "Renamed", updatedAt: TUESDAY })],
      tasks: [],
      taskLists: [],
      graves: [],
    };
    const marked = restamped(step, current, NOW);

    // Untouched records keep their stamps: an undo that re-dated the whole
    // document would win every field of the next merge.
    expect.soft(marked.events.find((e) => e.id === "keep")?.updatedAt).toBe(TUESDAY);
    // A record the step brings back is a change made now.
    expect.soft(marked.events.find((e) => e.id === "old")?.updatedAt).toBe(NOW);
    expect.soft(marked.calendars[0].updatedAt).toBe(NOW);
    // And the creation the step does not carry is buried, not merely dropped.
    expect.soft(marked.graves).toEqual([{ id: "new", at: NOW }]);
  });

  it("compares by content, not by reference, because a cross-tab read rebuilds every object", () => {
    const rehydrated = { ...kept };
    const marked = restamped(
      { events: [rehydrated], calendars: [], tasks: [], taskLists: [], graves: [] },
      { events: [kept], calendars: [], tasks: [], taskLists: [], graves: [] },
      NOW,
    );
    expect(marked.events[0].updatedAt).toBe(TUESDAY);
  });
});
