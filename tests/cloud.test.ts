import { describe, expect, it } from "vitest";
import { calendar, event, grave, ms } from "./helpers";
import { DEFAULT_SETTINGS } from "@/lib/store";
import { MIRROR_VERSION, serialiseMirror } from "@/lib/mirror";
import {
  LOCKED,
  cloudPlan,
  cloudResume,
  cloudTake,
  readCloudRow,
  type CloudRow,
} from "@/lib/cloudLink";
import { bytesToBase64Url } from "@/lib/base64";
import type { CalEvent, Calendar, Grave } from "@/lib/events";
import { mergeDocuments, pruneGraves } from "@/lib/merge";
import { applyRemove } from "@/lib/mutate";

/**
 * `cloudLink.ts` is a network client, an auth session, a websocket and a
 * debounce, and `AGENTS.md` keeps `mirrorLink.ts` out of the suite for the
 * same reason: a test that mocked a Postgres client would be asserting its own
 * mock. So the transport is driven by hand — two browsers against one project,
 * one of them offline, one of them holding the wrong passphrase — and what is
 * pinned here is everything that decides *whether* to write, which is where a
 * bug costs a calendar rather than a round trip:
 *
 * - `readCloudRow`, because the row is external input.
 * - `cloudPlan`, the compare-and-swap decision, the version gate and the zone
 *   gate — all three answerable before anything is decrypted, which is why
 *   those three fields are columns.
 * - `cloudTake`, the merge-or-adopt answer and the digest guard — and above
 *   all its refusal to hand back anything a caller could write when the
 *   payload would not open.
 */

const CAL = "work";
const HERE = "Europe/Berlin";
const STAMP = ms("2026-03-08 09:00");

function snapshot(
  events: CalEvent[],
  over: { graves?: Grave[]; settingsAt?: number; calendars?: Calendar[] } = {},
) {
  return {
    events,
    calendars: over.calendars ?? [calendar({ id: CAL })],
    settings: DEFAULT_SETTINGS,
    // Stamped by default; the cases about an unstamped document say so.
    settingsAt: over.settingsAt ?? STAMP,
    graves: over.graves ?? [],
  };
}

function row(over: Partial<CloudRow> = {}): CloudRow {
  return { rev: 5, version: MIRROR_VERSION, zone: HERE, payload: "sealed", ...over };
}

describe("the row, as it arrives", () => {
  it.each([
    { name: "not an object", value: "sealed" },
    { name: "null", value: null },
    { name: "a row with no payload", value: { rev: 3, version: 2, zone: HERE } },
    { name: "a row whose payload is empty", value: { rev: 3, payload: "" } },
  ])("reads $name as no row at all", ({ value }) => {
    expect.soft(readCloudRow(value)).toBeNull();
  });

  // The same readings `readMirrorFile` makes of the same envelope: bookkeeping
  // that arrived malformed must not cost the document.
  it.each([
    { name: "a rev that is not a number", value: { payload: "x", rev: "five" }, want: { rev: 0 } },
    { name: "an absent rev", value: { payload: "x" }, want: { rev: 0 } },
    { name: "an absent zone", value: { payload: "x" }, want: { zone: "" } },
    {
      name: "an absent version",
      value: { payload: "x" },
      want: { version: MIRROR_VERSION },
    },
    {
      name: "a version that is not a number",
      value: { payload: "x", version: "two" },
      want: { version: MIRROR_VERSION },
    },
  ])("reads $name", ({ value, want }) => {
    expect.soft(readCloudRow(value)).toMatchObject(want);
  });

  // Reported rather than clamped, because the whole point of the gate below is
  // being able to tell a newer writer from this one.
  it("reports a newer envelope version as it found it", () => {
    expect(readCloudRow({ payload: "x", version: MIRROR_VERSION + 3 })?.version).toBe(
      MIRROR_VERSION + 3,
    );
  });
});

describe("the compare-and-swap decision", () => {
  it("fills an empty slot rather than treating it as a loss", () => {
    expect(cloudPlan(null, 4, HERE)).toEqual({ do: "write", rev: 5 });
  });

  // The one that would be a permanent write loop if it answered anything else:
  // a row where we left it must produce no write at all.
  it("keeps a row where we left it, and writes nothing", () => {
    expect(cloudPlan(row({ rev: 7 }), 7, HERE)).toEqual({ do: "keep" });
  });

  it("opens a row somebody moved on, and hands the row over with the answer", () => {
    const found = row({ rev: 8 });
    expect(cloudPlan(found, 7, HERE)).toEqual({ do: "open", row: found });
  });

  // `mirrorVerdict`'s `stale`: winding a calendar backwards is the one outcome
  // nothing undoes, so an older copy is re-asserted over, never adopted — and
  // at *our* next revision, because ours is the newer truth. The row's own
  // number matters only on the branch where it is ahead, which `claim` takes
  // from the document it just absorbed.
  it.each([
    { name: "one behind", rev: 6 },
    { name: "six behind", rev: 1 },
  ])("re-asserts over a row that is $name", ({ rev }) => {
    expect.soft(cloudPlan(row({ rev }), 7, HERE)).toEqual({ do: "write", rev: 8 });
  });
});

describe("the gates, answered before anything is decrypted", () => {
  it.each([
    { name: "ahead of us", rev: 9, local: 7 },
    { name: "behind us", rev: 2, local: 7 },
  ])("refuses an envelope from a newer circal that is $name", ({ rev, local }) => {
    const plan = cloudPlan(row({ rev, version: MIRROR_VERSION + 1 }), local, HERE);
    expect.soft(plan.do).toBe("stop");
    // Stricter than the file half on purpose: re-asserting over a newer
    // document round-trips it through validators too old for it, which is the
    // nine-keys loss in the other direction.
    expect.soft(plan.do === "stop" && plan.message).toContain("newer circal");
  });

  it("refuses a row ahead of us that was written in another zone", () => {
    const plan = cloudPlan(row({ rev: 9, zone: "Asia/Tokyo" }), 7, HERE);
    expect.soft(plan.do).toBe("stop");
    expect.soft(plan.do === "stop" && plan.message).toContain("Asia/Tokyo");
  });

  // The zone is asked only where the row would teach us something. A row we
  // are re-asserting over cannot put an event on the wrong day here.
  it("does not refuse a row behind us over its zone", () => {
    expect(cloudPlan(row({ rev: 2, zone: "Asia/Tokyo" }), 7, HERE)).toEqual({
      do: "write",
      rev: 8,
    });
  });

  it("opens a row whose writer did not say which zone it was in", () => {
    expect(cloudPlan(row({ rev: 9, zone: "" }), 7, HERE).do).toBe("open");
  });
});

describe("a payload that will not open", () => {
  const mine = snapshot([event({ id: "mine", calendarId: CAL, updatedAt: STAMP })]);

  /* The sharpest failure in the feature. A wrong passphrase or a damaged box
   * must never produce anything a caller could write, because sealing local
   * state over a box we could not read destroys the other machine's work with
   * no copy anywhere. Every one of these asserts the *absence* of a document,
   * not merely the presence of a message. */
  it("stops, and hands back no document to write", () => {
    const taken = cloudTake(null, mine, STAMP);
    expect.soft(taken.take).toBe("stop");
    expect.soft(taken).not.toHaveProperty("document");
    expect.soft(taken.take === "stop" && taken.message).toBe(LOCKED);
  });

  it("says nothing was written, because nothing was", () => {
    const taken = cloudTake(null, mine, STAMP);
    expect(taken.take === "stop" && taken.message).toContain("untouched");
  });

  it("stops on a payload that opened into something that is not a calendar", () => {
    expect.soft(cloudTake("{", mine, STAMP).take).toBe("stop");
    expect.soft(cloudTake(JSON.stringify({ app: "fantastical" }), mine, STAMP).take).toBe("stop");
  });
});

describe("merge, or adopt whole", () => {
  const theirs = (over: Parameters<typeof snapshot>[1] = {}, rev = 9) =>
    serialiseMirror(
      snapshot([event({ id: "theirs", calendarId: CAL, updatedAt: STAMP })], over),
      rev,
    );

  const mine = snapshot([
    event({ id: "mine", calendarId: CAL, updatedAt: ms("2026-03-10 09:00") }),
  ]);

  it("merges two stamped documents, keeping both machines' work", () => {
    const taken = cloudTake(theirs(), mine, STAMP);
    expect.soft(taken.take).toBe("merge");
    expect
      .soft(taken.take !== "stop" && taken.document.events.map((e) => e.id))
      .toEqual(["mine", "theirs"]);
  });

  it("carries the row's own revision and zone, since the merge is written over that row", () => {
    const taken = cloudTake(theirs({}, 12), mine, STAMP);
    expect.soft(taken.take !== "stop" && taken.document.rev).toBe(12);
    expect.soft(taken.take !== "stop" && taken.document.version).toBe(MIRROR_VERSION);
  });

  // The gate is `mirrorMerges`', so a document that predates stamping — no
  // settings stamp and no record carrying one — is adopted whole exactly as it
  // is on the file half.
  it("adopts a document that predates stamping rather than guessing", () => {
    const older = serialiseMirror(
      snapshot([event({ id: "theirs", calendarId: CAL })], { settingsAt: 0 }),
      9,
    );
    const taken = cloudTake(older, mine, STAMP);
    expect.soft(taken.take).toBe("adopt");
    expect
      .soft(taken.take !== "stop" && taken.document.events.map((e) => e.id))
      .toEqual(["theirs"]);
  });

  // The first link of a browser: signing in is not publishing whatever this
  // browser happens to hold, which on a seed day is eight demo events.
  it("adopts rather than merges when the caller says this is a first link", () => {
    const taken = cloudTake(theirs(), mine, STAMP, false);
    expect.soft(taken.take).toBe("adopt");
    expect
      .soft(taken.take !== "stop" && taken.document.events.map((e) => e.id))
      .toEqual(["theirs"]);
  });

  it("goes through mergeDocuments, so a grave still beats an older record", () => {
    const buried = snapshot([], { graves: [grave("theirs", "2026-03-09 09:00")] });
    const taken = cloudTake(theirs(), buried, STAMP);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.document.events).toEqual([]);
  });

  /* Two fresh installs, which is what somebody sets this feature up to do and
   * the one case every other test here passed over. Both machines are on their
   * demo day, so neither carries a settings stamp; when `stamped` asked only
   * about `settingsAt`, neither could merge, each adopted the other whole, and
   * adopting an unstamped document left them both unstamped for ever — so the
   * first real edit on the new laptop was adopted away by the machine that
   * synced next. Driven on the real transport before it was fixed, not
   * theorised. */
  const demo = (over: Parameters<typeof snapshot>[1] = {}) =>
    snapshot([event({ id: "demo", calendarId: CAL })], { settingsAt: 0, ...over });

  it("still refuses to merge two untouched demo days, so neither publishes seed data", () => {
    const taken = cloudTake(serialiseMirror(demo(), 1), demo(), STAMP);
    expect(taken.take).toBe("adopt");
  });

  it("merges the moment each machine holds one real event, with no settings change on either", () => {
    const laptop = snapshot(
      [
        event({ id: "demo", calendarId: CAL }),
        event({ id: "laptop", calendarId: CAL, updatedAt: STAMP }),
      ],
      { settingsAt: 0 },
    );
    const desktop = snapshot(
      [
        event({ id: "demo", calendarId: CAL }),
        event({ id: "desktop", calendarId: CAL, updatedAt: STAMP }),
      ],
      { settingsAt: 0 },
    );
    const taken = cloudTake(serialiseMirror(desktop, 2), laptop, STAMP);
    expect.soft(taken.take).toBe("merge");
    // Both days' work, which is the whole promise. Before the fix this was
    // `["demo", "desktop"]` and the laptop's own event was gone.
    expect
      .soft(taken.take !== "stop" && taken.document.events.map((e) => e.id))
      .toEqual(["demo", "desktop", "laptop"]);
  });

  /* One real action of any kind is enough, and `settingsAt` stays 0 in every
   * row: the predicate is about demo data, not about settings. */
  it.each([
    {
      name: "an event created",
      make: () =>
        snapshot(
          [event({ id: "demo", calendarId: CAL }), event({ id: "real", updatedAt: STAMP })],
          {
            settingsAt: 0,
          },
        ),
    },
    {
      name: "a calendar added",
      make: () =>
        snapshot([event({ id: "demo", calendarId: CAL })], {
          settingsAt: 0,
          calendars: [calendar({ id: CAL }), calendar({ id: "added", updatedAt: STAMP })],
        }),
    },
    {
      name: "something deleted, with nothing left to show for it",
      make: () =>
        snapshot([event({ id: "demo", calendarId: CAL })], {
          settingsAt: 0,
          graves: [grave("gone", STAMP)],
        }),
    },
  ])("counts $name as a document worth merging, with settingsAt still 0", ({ make }) => {
    expect.soft(cloudTake(serialiseMirror(make(), 3), make(), STAMP).take).toBe("merge");
  });
});

describe("the digest guard", () => {
  const both = (over: Parameters<typeof snapshot>[1] = {}) =>
    snapshot([event({ id: "shared", calendarId: CAL, updatedAt: STAMP })], over);

  /* Whether a merge has to go back to the row. Answered against the row rather
   * than against the store, because a pass that answered every read with a
   * write is two machines writing at each other for ever — the loop Phase 1
   * found the hard way. */
  it("does not write back a merge that changed nothing", () => {
    const taken = cloudTake(serialiseMirror(both(), 9), both(), STAMP);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take === "merge" && taken.changed).toBe(false);
  });

  it("writes back a merge carrying something the row has not got", () => {
    const mine = snapshot([
      event({ id: "shared", calendarId: CAL, updatedAt: STAMP }),
      event({ id: "new", calendarId: CAL, updatedAt: ms("2026-03-11 09:00") }),
    ]);
    const taken = cloudTake(serialiseMirror(both(), 9), mine, STAMP);
    expect.soft(taken.take === "merge" && taken.changed).toBe(true);
  });

  // The digest is canonical, so a document rebuilt by `readEvent` out of the
  // payload and the same document held in memory are the same document. An
  // insertion-order digest read this as a change and wrote on every pass.
  it("does not read the round trip through the payload as a change", () => {
    const held = both({ graves: [grave("gone", "2026-03-07 09:00")] });
    const taken = cloudTake(serialiseMirror(held, 9), held, STAMP);
    expect(taken.take === "merge" && taken.changed).toBe(false);
  });
});

describe("whether this machine learned anything", () => {
  const shared = (over: Parameters<typeof snapshot>[1] = {}) =>
    snapshot([event({ id: "shared", calendarId: CAL, updatedAt: STAMP })], over);

  /* The write-back is not optional — both machines have to converge on the row
   * — so the machine that wrote first always sees its own edit come back as
   * the other one's `rev + 1`. It merges, produces exactly what it already
   * had, and used to adopt and toast it: "Calendar updated from the cloud
   * copy" about its own event, plus an undo step that undoes nothing. */
  it("learns nothing from a row that is its own document at a higher revision", () => {
    const taken = cloudTake(serialiseMirror(shared(), 12), shared(), STAMP);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  it("learns from a row carrying an event this machine has not got", () => {
    const taken = cloudTake(
      serialiseMirror(
        snapshot([
          event({ id: "shared", calendarId: CAL, updatedAt: STAMP }),
          event({ id: "theirs", calendarId: CAL, updatedAt: ms("2026-03-11 09:00") }),
        ]),
        12,
      ),
      shared(),
      STAMP,
    );
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(true);
  });

  // An adopt is the other route into `absorb`, and two machines holding the
  // same unstamped demo day reach it. Nothing to announce there either.
  it("learns nothing from adopting a document it already holds", () => {
    const demo = () => snapshot([event({ id: "demo", calendarId: CAL })], { settingsAt: 0 });
    const taken = cloudTake(serialiseMirror(demo(), 1), demo(), STAMP);
    expect.soft(taken.take).toBe("adopt");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  it("learns from adopting a document that predates stamping", () => {
    const older = serialiseMirror(
      snapshot([event({ id: "theirs", calendarId: CAL })], { settingsAt: 0 }),
      9,
    );
    const taken = cloudTake(older, shared(), STAMP);
    expect.soft(taken.take).toBe("adopt");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(true);
  });

  /* The two flags are separate questions, and this is the pass that proves it:
   * the row is behind, so it needs this machine's bytes, and the merge is
   * exactly what this machine already held, so there is nothing to say. A fix
   * that muted the toast by skipping the write-back would strand the other
   * machine on an older row. */
  it("writes back without announcing anything when only the row is behind", () => {
    const mine = snapshot([
      event({ id: "shared", calendarId: CAL, updatedAt: STAMP }),
      event({ id: "mine", calendarId: CAL, updatedAt: ms("2026-03-11 09:00") }),
    ]);
    const taken = cloudTake(serialiseMirror(shared(), 9), mine, STAMP);
    expect.soft(taken.take === "merge" && taken.changed).toBe(true);
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  // The digest is canonical either way, so the round trip through the payload
  // is not a thing learned any more than it is a change.
  it("does not read the round trip through the payload as something learned", () => {
    const held = shared({ graves: [grave("gone", "2026-03-07 09:00")] });
    const taken = cloudTake(serialiseMirror(held, 9), held, STAMP);
    expect(taken.take !== "stop" && taken.learned).toBe(false);
  });
});

/* Graves take a different route through `mergeDocuments` than ordinary records
 * do — united and pruned separately, then filtered against the survivors — and
 * nothing else here pins the round trip. The cycle is the ordinary one: A
 * deletes and writes; B merges, learns the deletion and writes the merged
 * document back; A finds the row ahead and merges a document it should
 * recognise as its own. */
describe("a deletion coming back round", () => {
  const x = event({ id: "x", calendarId: CAL, updatedAt: STAMP });
  const y = event({ id: "y", calendarId: CAL, updatedAt: STAMP });
  const KILLED = ms("2026-03-10 11:00");
  const NOW = ms("2026-03-10 12:00");

  /** What `store.remove` leaves behind: the shortened list, and a grave
   *  appended to whatever was already there. Not pruned — the store appends. */
  const removed = applyRemove([x, y], "y", KILLED);
  const mine = snapshot(removed.events, { graves: removed.graves });

  it("leaves the local document with the event gone and a grave for it", () => {
    expect.soft(mine.events.map((e) => e.id)).toEqual(["x"]);
    expect.soft(mine.graves).toEqual([{ id: "y", at: KILLED }]);
  });

  /** The other machine's write-back: it held both events, merged, and lost `y`
   *  to the grave. */
  const theirs = mergeDocuments(snapshot([x, y]), mine, NOW);

  it("has the other machine reach the same document", () => {
    expect.soft(theirs.events.map((e) => e.id)).toEqual(["x"]);
    expect.soft(theirs.graves).toEqual([{ id: "y", at: KILLED }]);
  });

  it("learns nothing when its own deletion comes back", () => {
    const taken = cloudTake(serialiseMirror({ ...mine, ...theirs }, 10), mine, NOW);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  // A row that has not caught up with the deletion needs this machine's bytes
  // and still has nothing to tell it: `changed` without `learned`, which is the
  // pair the two flags exist to keep apart.
  it("writes the deletion back to a row that has not got it, silently", () => {
    const taken = cloudTake(serialiseMirror(snapshot([x, y]), 10), mine, NOW);
    expect.soft(taken.take === "merge" && taken.changed).toBe(true);
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  /* The shape that diverged for ever. `store.remove` used to append its graves
   * — `[...base.graves, ...removed.graves]` — while every reader of a grave
   * list collapses an id to its latest instant, so a delete the user undid and
   * then made again left the store holding two graves for one id and the row
   * holding one. The same document by every rule that reads it, and two
   * different arrays to the digest, so this machine was told its own deletion
   * was news on every pass thereafter. `store.write` now collapses on the way
   * in; these pin the merge's half of that agreement. */
  const again = applyRemove([x, y], "y", KILLED + 1000);
  const collapsed = pruneGraves([...removed.graves, ...again.graves], NOW);

  it("collapses a re-deletion to one grave at the later instant", () => {
    expect(collapsed).toEqual([{ id: "y", at: KILLED + 1000 }]);
  });

  it("learns nothing when a re-deletion comes back", () => {
    const twice = snapshot(again.events, { graves: collapsed });
    const theirsToo = mergeDocuments(snapshot([x, y]), twice, NOW);
    const taken = cloudTake(serialiseMirror({ ...twice, ...theirsToo }, 11), twice, NOW);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(false);
  });

  // The other direction, and the one the guard must never swallow: the row
  // carries a deletion this machine has not seen, so there is something to
  // adopt and something to say.
  it("learns a deletion the row has and this machine has not", () => {
    const killed = applyRemove([x, y], "y", KILLED);
    const theirsGone = snapshot(killed.events, { graves: killed.graves });
    const taken = cloudTake(serialiseMirror(theirsGone, 10), snapshot([x, y]), NOW);
    expect.soft(taken.take).toBe("merge");
    expect.soft(taken.take !== "stop" && taken.learned).toBe(true);
    expect.soft(taken.take !== "stop" && taken.document.events.map((e) => e.id)).toEqual(["x"]);
  });
});

/* The gate in front of a remembered key. Everything around it is hand-driven —
 * the IndexedDB record, the `CryptoKey`, the resume itself — for the reason at
 * the top of this file and the reason `AGENTS.md` keeps `mirrorLink.ts` out of
 * the suite: a test that mocked them would assert its own mock. This is the one
 * decision in that path that is a function of two values, and it is the one
 * that decides whether a user meets an explanation or meets `LOCKED` having
 * typed nothing at all. */
describe("whether a remembered key still fits the box", () => {
  /** A payload's header is `version(1) || salt(16) || iv(12) || …`, so a box
   *  sealed under a given salt is that salt in bytes 1–17. Built by hand rather
   *  than by sealing, because the salt is the only part this reads. */
  const sealedUnder = (salt: Uint8Array) => {
    const bytes = new Uint8Array(1 + 16 + 12 + 16);
    bytes[0] = 1;
    bytes.set(salt, 1);
    return bytesToBase64Url(bytes);
  };
  const salt = (fill: number) => new Uint8Array(16).fill(fill);

  it("opens on the salt the row was sealed under", () => {
    expect(cloudResume(salt(7), sealedUnder(salt(7)))).toBe("open");
  });

  it("is stale when the row was re-sealed under another salt", () => {
    expect(cloudResume(salt(7), sealedUnder(salt(8)))).toBe("stale");
  });

  it("is stale on a salt of the wrong length, without reading past either", () => {
    expect(cloudResume(new Uint8Array(8).fill(7), sealedUnder(salt(7)))).toBe("stale");
  });

  // An account whose row is still empty has no salt to disagree with, and
  // enrolment's own salt is committed by the first seal. Calling that stale
  // would send every first-device user to a passphrase prompt for nothing.
  it("opens when there is no row yet", () => {
    expect(cloudResume(salt(7), null)).toBe("open");
  });

  /* A damaged box is not a stale key, and saying it is would send the user to a
   * passphrase prompt that cannot help them. It goes down the ordinary path
   * instead, which is the one that refuses to write. */
  it.each([
    { name: "junk", payload: "not base64url!!" },
    { name: "an empty string", payload: "" },
    { name: "too few bytes to hold a box", payload: bytesToBase64Url(new Uint8Array(20)) },
  ])("opens rather than blaming the key for $name", ({ payload }) => {
    expect(cloudResume(salt(7), payload)).toBe("open");
  });
});
