import { describe, expect, it } from "vitest";
import { calendar, event, ms, task, taskList } from "./helpers";
import { DEFAULT_SETTINGS } from "@/lib/store";
import {
  MIRROR_VERSION,
  mirrorDigest,
  mirrorMerges,
  mirrorVerdict,
  readMirrorFile,
  serialiseMirror,
  zonesAgree,
} from "@/lib/mirror";
import type { CalEvent, Calendar, Grave } from "@/lib/events";

/**
 * The mirror file is the one artefact something outside this browser holds,
 * so what is pinned here is the two claims that make that safe: it round
 * trips without losing anything, and it validates whatever comes back as
 * hostile input.
 */

const CAL = "work";

function snapshot(
  events: CalEvent[],
  calendars: Calendar[] = [calendar({ id: CAL })],
  over: { graves?: Grave[]; settingsAt?: number } = {},
) {
  return {
    tasks: [],
    taskLists: [],
    events,
    calendars,
    settings: DEFAULT_SETTINGS,
    // A stamped document by default: an unstamped one is what the version gate
    // is about, and those cases say so.
    settingsAt: over.settingsAt ?? ms("2026-03-08 09:00"),
    graves: over.graves ?? [],
  };
}

it("round-trips nested lists and task membership, and includes list edits in its digest", () => {
  const root = taskList({ id: "root", name: "Work" });
  const child = taskList({ id: "child", name: "Launch", parentId: root.id });
  const original = {
    ...snapshot([]),
    taskLists: [root, child],
    tasks: [task({ calendarId: CAL, listId: child.id })],
  };
  const restored = readMirrorFile(serialiseMirror(original, 1))!;
  expect(restored.taskLists).toEqual(original.taskLists);
  expect(restored.tasks).toEqual(original.tasks);
  expect(mirrorDigest(restored)).toBe(mirrorDigest(original));
  expect(mirrorDigest({ ...original, taskLists: [{ ...root, name: "Home" }, child] })).not.toBe(
    mirrorDigest(original),
  );
});

/** A file body with fields spliced in, for the cases a serialiser will not
 *  produce — which is most of what a reader has to survive. */
function body(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    app: "circal",
    version: MIRROR_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    zone: "Europe/Berlin",
    rev: 3,
    events: [],
    calendars: [calendar({ id: CAL })],
    settings: DEFAULT_SETTINGS,
    settingsAt: ms("2026-03-08 09:00"),
    graves: [],
    ...overrides,
  });
}

describe("round trip", () => {
  it("returns the events it was given, instants intact", () => {
    const one = event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00", title: "Standup" });
    const read = readMirrorFile(serialiseMirror(snapshot([one]), 7));

    expect(read).not.toBeNull();
    expect(read?.events).toHaveLength(1);
    expect(read?.events[0].start).toBeSameInstantAs("2026-03-08 09:00");
    expect(read?.events[0].title).toBe("Standup");
    expect(read?.rev).toBe(7);
  });

  it("carries the writer's zone, because the reader has to be able to refuse", () => {
    const read = readMirrorFile(serialiseMirror(snapshot([]), 1, "Asia/Tokyo"));
    expect(read?.zone).toBe("Asia/Tokyo");
  });

  it("keeps a recurrence rule whole", () => {
    const weekly = event({
      id: "r",
      calendarId: CAL,
      start: "2026-03-02 09:00",
      repeat: "weekly",
      interval: 2,
      exdates: ["2026-03-16"],
    });
    const read = readMirrorFile(serialiseMirror(snapshot([weekly]), 1));

    expect(read?.events[0].repeat).toBe("weekly");
    expect(read?.events[0].interval).toBe(2);
    expect(read?.events[0].exdates).toEqual(["2026-03-16"]);
  });
});

describe("a backup is a mirror file", () => {
  // The whole reason the format was not invented: an export from before any
  // of this existed has neither field, and must still open.
  it("reads one with no rev and no zone", () => {
    const read = readMirrorFile(body({ rev: undefined, zone: undefined }));
    expect(read).not.toBeNull();
    expect(read?.rev).toBe(0);
    expect(read?.zone).toBe("");
  });

  it("reads a rev that is not a number as zero rather than failing the file", () => {
    expect(readMirrorFile(body({ rev: "seven" }))?.rev).toBe(0);
  });

  // A backup taken before the mirror existed says nothing about the envelope,
  // and must read as this build's own rather than as version zero — otherwise
  // the writer's version guard would happily write it and the reader would
  // have refused a file it wrote itself.
  it("reads a missing version as this build's own", () => {
    expect(readMirrorFile(body({ version: undefined }))?.version).toBe(MIRROR_VERSION);
  });

  it("reads a version that is not a number as this build's own", () => {
    expect(readMirrorFile(body({ version: "two" }))?.version).toBe(MIRROR_VERSION);
  });

  // The one that matters: a file from a newer build reports its real version,
  // so `assertVersionAllowsMutation` in the MCP server can refuse to write it
  // rather than round-tripping it through a reader that would drop whatever
  // this build has no name for.
  it("reports a newer version rather than clamping it", () => {
    expect(readMirrorFile(body({ version: MIRROR_VERSION + 1 }))?.version).toBe(MIRROR_VERSION + 1);
  });
});

describe("hostile input", () => {
  it.each([
    { name: "not json", text: "{" },
    { name: "json that is not a circal file", text: JSON.stringify({ app: "fantastical" }) },
    { name: "a circal file carrying no calendars", text: body({ calendars: [] }) },
  ])("refuses $name", ({ text }) => {
    expect.soft(readMirrorFile(text)).toBeNull();
  });

  it("drops an event with an unreadable instant instead of admitting a NaN start", () => {
    const read = readMirrorFile(
      body({ events: [{ id: "bad", start: "soon", end: 1, calendarId: CAL }] }),
    );
    expect(read?.events).toEqual([]);
  });

  it("reparents an event whose calendar the file does not carry", () => {
    const read = readMirrorFile(
      body({
        events: [
          {
            id: "orphan",
            start: ms("2026-03-08 09:00"),
            end: ms("2026-03-08 10:00"),
            calendarId: "gone",
          },
        ],
      }),
    );
    expect(read?.events[0].calendarId).toBe(CAL);
  });
});

describe("a feed pull is not a calendar change", () => {
  const subscribed = (fetchedAt: number, error = ""): Calendar[] => [
    calendar({ id: CAL }),
    calendar({ id: "sub", feed: { url: "https://example.com/c.ics", fetchedAt, error } }),
  ];

  it("digests two pull states of one subscription the same", () => {
    const before = mirrorDigest(snapshot([], subscribed(0)));
    const after = mirrorDigest(snapshot([], subscribed(1_800_000, "Timed out")));
    expect(after).toBe(before);
  });

  it("still notices a real change", () => {
    const empty = mirrorDigest(snapshot([], subscribed(0)));
    const one = mirrorDigest(
      snapshot([event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00" })], subscribed(0)),
    );
    expect(one).not.toBe(empty);
  });

  it("writes the pull state out zeroed, so a reader sees the same bytes", () => {
    const written = serialiseMirror(snapshot([], subscribed(1_800_000, "Timed out")), 1);
    const feed = readMirrorFile(written)?.calendars.find((c) => c.id === "sub")?.feed;
    expect(feed?.url).toBe("https://example.com/c.ics");
    expect(feed?.fetchedAt).toBe(0);
    expect(feed?.error).toBe("");
  });
});

/* The store keeps events in the order they were made and `mergeDocuments`
 * unites them by id, so the two orders differ on any machine that did not
 * happen to create its events alphabetically. While the digest read that as a
 * change, the machine that wrote first saw its own edit return as the other
 * one's write-back and announced it: "Calendar updated from the cloud copy"
 * about an event it had just made itself. */
describe("record order is not a change", () => {
  const a = event({ id: "a", calendarId: CAL, start: "2026-03-08 09:00" });
  const b = event({ id: "b", calendarId: CAL, start: "2026-03-09 09:00" });

  it("digests two orderings of one document the same", () => {
    expect(mirrorDigest(snapshot([b, a]))).toBe(mirrorDigest(snapshot([a, b])));
  });

  it("digests two orderings of one calendar list the same", () => {
    const one = calendar({ id: "one" });
    const two = calendar({ id: "two" });
    expect(mirrorDigest(snapshot([], [one, two]))).toBe(mirrorDigest(snapshot([], [two, one])));
  });

  it("still notices a record the other ordering has not got", () => {
    expect(mirrorDigest(snapshot([b, a]))).not.toBe(mirrorDigest(snapshot([a])));
  });
});

describe("the version gate: merge, adopt, or refuse", () => {
  /* Three answers, and the order they are asked in matters. A file this
   * reader's build cannot fully understand, or a document that predates
   * stamping, gets today's behaviour exactly — `mirrorVerdict`, adopt, stale,
   * no merge — because an unstamped document cannot be merged without
   * guessing. */
  const mine = snapshot([
    event({ id: "mine", calendarId: CAL, updatedAt: ms("2026-03-10 09:00") }),
  ]);

  it.each([
    { name: "a v2 file against a v2 store merges", version: 2, settingsAt: 1, want: true },
    { name: "a v1 file adopts, whatever it carries", version: 1, settingsAt: 1, want: false },
    {
      name: "a v2 file whose document predates stamping adopts",
      version: 2,
      settingsAt: 0,
      want: false,
    },
  ])("$name", ({ version, settingsAt, want }) => {
    const contents = readMirrorFile(body({ version, settingsAt, rev: 9 }));
    expect.soft(contents).not.toBeNull();
    expect.soft(contents && mirrorMerges(contents, mine)).toBe(want);
  });

  it("refuses to merge into a store that predates stamping, however new the file is", () => {
    const contents = readMirrorFile(body({ version: MIRROR_VERSION, settingsAt: 1 }));
    expect(contents && mirrorMerges(contents, snapshot([], undefined, { settingsAt: 0 }))).toBe(
      false,
    );
  });

  // The zone guard is asked *before* either, one layer up in `mirrorLink`: a
  // file whose days are not this reader's days is refused whether the answer
  // would have been a merge or an adopt, which is what this pair says here.
  it.each([
    { name: "a merge", version: 2 },
    { name: "an adopt", version: 1 },
  ])("a disagreeing zone is refused before $name", ({ version }) => {
    const contents = readMirrorFile(body({ version, zone: "Asia/Tokyo", settingsAt: 1 }));
    expect.soft(zonesAgree(contents?.zone ?? "", "Europe/Berlin")).toBe(false);
  });

  it("round trips the graves and the settings stamp, which is what version 2 means", () => {
    const written = snapshot([], undefined, {
      graves: [{ id: "deleted", at: ms("2026-03-09 09:00") }],
      settingsAt: ms("2026-03-10 09:00"),
    });
    const read = readMirrorFile(serialiseMirror(written, 4));
    expect.soft(read?.graves).toEqual(written.graves);
    expect.soft(read?.settingsAt).toBe(written.settingsAt);
  });

  it("reads a file with neither as a document that predates stamping", () => {
    const read = readMirrorFile(body({ graves: undefined, settingsAt: undefined }));
    expect.soft(read?.graves).toEqual([]);
    expect.soft(read?.settingsAt).toBe(0);
    expect.soft(read && mirrorMerges(read, mine)).toBe(false);
  });
});

describe("who wins", () => {
  it.each([
    { name: "our own write, so adopting would loop", file: 4, local: 4, want: "ours" },
    { name: "somebody else moved it on", file: 5, local: 4, want: "adopt" },
    { name: "an older copy restored underneath us", file: 2, local: 4, want: "stale" },
  ])("$name", ({ file, local, want }) => {
    expect.soft(mirrorVerdict(file, local)).toBe(want);
  });

  it.each([
    { name: "a file that did not say", file: "", reader: "Europe/Berlin", want: true },
    { name: "the same zone", file: "Asia/Tokyo", reader: "Asia/Tokyo", want: true },
    { name: "two different zones", file: "Asia/Tokyo", reader: "Europe/Berlin", want: false },
  ])("zonesAgree: $name", ({ file, reader, want }) => {
    expect.soft(zonesAgree(file, reader)).toBe(want);
  });
});
