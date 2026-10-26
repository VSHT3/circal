# Testing doctrine

> Doctrine for this area, moved verbatim from `AGENTS.md`. Read before touching: writing or changing any test; fixtures, matchers, TZ projects, what is and is not tested.
> Sibling docs live in `docs/agent/`; the index is in the root `AGENTS.md`.

## Testing & QA

**Suite exists. Read before writing one.** Vitest, `tests/`, 2,378 cases, 38 files, ~3 s, wired into `verify`. Coverage = cases in file owning module. Never scaffold second harness, second fixture style, `*.spec.ts`.

| test file                         | covers                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/helpers.ts`                | **not a test** — fixtures, builders, matchers. Extend, never fork                                                                                                                                                                       |
| `tests/time.test.ts`              | `time.ts` — day arithmetic, DST, `parseClock`, `zonedToUtc`                                                                                                                                                                             |
| `tests/theme.test.ts`             | `theme.ts` + `global.css` token blocks — midnight byte-parity, `wash`'s two ends and midnight ≡ multiply, contrast floors computed not eyeballed, veil ladder, `color-scheme` per preset                                                |
| `tests/quickadd.test.ts`          | `quickadd.ts` — every date form, scanner, repeats, ambiguous pairs                                                                                                                                                                      |
| `tests/fuzzy.test.ts`             | `fuzzy.ts` — matching, forgiven typo, ranking order                                                                                                                                                                                     |
| `tests/dial.test.ts`              | `dial.ts` — `angleAt` ↔ `minutesAtPoint`, `arcPath`, `capInset`, `arcLabel`, `hollowPath`'s three shapes                                                                                                                                |
| `tests/recur.test.ts`             | `recur.ts` — RFC 5545 §3.8.5.3 worked examples, BY\* , BYSETPOS                                                                                                                                                                         |
| `tests/describe.test.ts`          | `describe.ts` — `isExpressible`'s gate, `describeRule`'s clause order, BYSETPOS as adjective                                                                                                                                            |
| `tests/events.test.ts`            | `events.ts` — clipping, lanes, overrides, `freeGaps`, free time booking nothing, `colorOf`, `inkOn`, lead + guest format                                                                                                                |
| `tests/tasks.test.ts`             | `tasks.ts` — field validators, `plannedMinutes`/`unplanned`, `taskState`'s boundaries, `scoreTask`, `compareTasks`                                                                                                                      |
| `tests/plan.test.ts`              | `plan.ts` — auto-schedule's five invariants: candidacy, order, waking/deadline bounds, no double-booking, idempotence                                                                                                                   |
| `tests/ics.test.ts`               | `ics.ts` — round-trip incl. `TRANSP`, `VALARM`, `ORGANIZER` + `ATTENDEE`, `METHOD` ignored, folding, escaping, malformed feeds                                                                                                          |
| `tests/store.test.ts`             | `store.ts` — write/delete/move, undo, cross-tab, `sane`, seeding, backup clock                                                                                                                                                          |
| `tests/backup.test.ts`            | `backup.ts` — hostile input, orphan reparenting, `backupDue`'s interval                                                                                                                                                                 |
| `tests/mutate.test.ts`            | `mutate.ts` — three scopes: overrides re-pointed vs dropped, exdate/rdate partitioned, cut at first instant                                                                                                                             |
| `tests/merge.test.ts`             | `merge.ts` — commutativity, idempotence, grave vs edit both ways, canonical tie-break, TTL pruning, v1 refusal, two machines converging                                                                                                 |
| `tests/mirror.test.ts`            | `mirror.ts` — round trip, plain backup read as mirror, hostile input, feed pull state ignored, who wins                                                                                                                                 |
| `tests/feeds.test.ts`             | `feeds.ts` — id stability, errors, cross-tab undo                                                                                                                                                                                       |
| `tests/life.test.ts`              | `life.ts` — `lifeCellAt` inverse, splits, density policy, milestones, `lifeFraction`, loupe transpose, a run's bands                                                                                                                    |
| `tests/year.test.ts`              | `year.ts` — `dayAngle` ↔ `dayAtPoint`, month marks, `unroller`'s two ends                                                                                                                                                               |
| `tests/week.test.ts`              | `week.ts` — layout bounds, scroll floor, zoom's diameter contract                                                                                                                                                                       |
| `tests/sun.test.ts`               | `sun.ts` — NOAA references, polar cases, no clipping                                                                                                                                                                                    |
| `tests/moon.test.ts`              | `moon.ts` — published new/full anchors, 200-cycle walk, eight names                                                                                                                                                                     |
| `tests/remind.test.ts`            | `remind.ts` — one-minute window, never catching up, all-day silence, task deadlines and plans, `leadOf`'s precedence                                                                                                                    |
| `tests/travel.test.ts`            | `travel.ts` — when to ask, per-instant shift, all-day re-anchoring, `until`, scoped clear                                                                                                                                               |
| `tests/share.test.ts`             | `share.ts` — round trip, what refuses to travel, truncation caught, length ratio                                                                                                                                                        |
| `tests/vault.test.ts`             | `vault.ts` — round trip incl. multi-byte titles and a 380 KB document, fresh IV per seal, which of two refusals each damage earns                                                                                                       |
| `tests/cloud.test.ts`             | `cloudLink.ts` — `readCloudRow` on hostile row, `cloudPlan`'s CAS decision, zone and version gates answered before decrypting, payload that will not open stopping the write, merge vs adopt whole, digest guard                        |
| `tests/mcp-file.test.ts`          | `mcp/file.ts` — which path it will touch, both refusals, CAS, queue, lock, a whole write                                                                                                                                                |
| `tests/mcp-domain.test.ts`        | `mcp/domain.ts` + `mcp/find.ts` — glue: scope refusals, span rules, patch anchoring, read tools' caps, `--find`                                                                                                                         |
| `tests/mcp-cloud.test.ts`         | `mcp/cloud.ts` — `resolveProject`'s three routes, the credentials record, load/decrypt with the zone warning, the row CAS (retry, give-up, refusals never retried, in-process queue), version and re-sealed-row guards, session refresh |
| `tests/mcp-resources.test.ts`     | Resource discovery, dated URI validation, warning/redaction boundaries and shared rendering                                                                                                                                             |
| `tests/mcp-prompts.test.ts`       | Read-only prompt context, date ranges, warnings and untrusted-data isolation                                                                                                                                                            |
| `tests/mcp-notifications.test.ts` | Legacy/modern subscription lifecycle, content filtering, acknowledgement ordering, recovery and cleanup                                                                                                                                 |
| `tests/worker.test.ts`            | `ssrfBlockReason` — hostname table                                                                                                                                                                                                      |
| `tests/worker-proxy.test.ts`      | `/api/feed` — routing, redirect chain, caps                                                                                                                                                                                             |
| `tests/west/*.test.ts`            | zone-sensitive invariants, re-run west of UTC                                                                                                                                                                                           |

**Two projects; the split is required.** `local` = `tests/**`, `TZ=Europe/Berlin`; `west` = `tests/west/**`, `TZ=America/Los_Angeles`, own process. Nearly every date function deliberately local-time: unpinned suite passes one zone, fails other. Own process: TZ change after Node start not reliably observed. **Touching `dayKey`, `zonedToUtc`, `startOfDay`, `addDays`, anything day-keyed? Add case to `tests/west/` too.** `tests/west/share.test.ts` sharpest: three Berlin-minted tokens read **verbatim** — share link = only payload one reader writes, another reads; a token's two ends can sit in different zones at once.

**`tests/helpers.ts` = shared floor.** Import in every test file; that import registers matchers.

| helper                                   | use                                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `at("2026-03-08 09:30")`                 | local `Date`. **Never `new Date("2026-01-01")`** — parses as UTC |
| `ms(stamp)` / `day("2026-03-08")`        | epoch ms / local midnight                                        |
| `event({ start: "…", title: "…" })`      | full `CalEvent`, all 16 recurrence fields defaulted              |
| `calendar()` / `rule()` / `byDay("1FR")` | `Calendar` / `Recurrence` / `WeekdayRule[]`                      |
| `MemoryStorage`                          | `Storage` stand-in; `.quota = 0` makes `setItem` throw           |
| `show(dateOrMs)`                         | `2026-03-08 09:30 Sun` — the one way an instant is printed       |

**Three matchers; instants MUST use them** — aligned actual/expected columns, `(missing)` / `(unexpected)` / `(out of order)`: 40-instance RRULE diff as raw epoch ints = no diff:

```ts
expect(instants).toBeInstants(["2026-03-08 09:00", "2026-03-15 09:00"]);
expect(instants).toOccurOn(["2026-03-08", "2026-03-15"]); // days only
expect(occ.start).toBeSameInstantAs("2026-03-08 09:00");
```

**Scope = pure layers, not DOM** — `src/lib/*`, worker guards, `mcp/file.ts`. No DOM, jsdom, component tests. SVG path snapshot = change-detector, fails on every legit geometry tweak; dial checked by eye. `feedback.ts` / `keys.ts` need real `AudioContext`: tuned by offline measurement, not asserted. `mcp/file.ts` earned its slot: three of mirror's four reproduced bugs lived there, untested. Needs **real temp directory**, not stubbed `fs` — claim = temp files, renames, `fsync`; invisible via mock. `mirrorLink.ts` out, hand-driven: `FileSystemFileHandle` + IndexedDB + poll; test via shell's own `window.__circalMirror` seam in real browser — how lost-update race was reproduced, confirmed fixed.

**Store/feeds tests need `vi.resetModules()` + `await import(…)`.** `snapshot`, `lastRaw`, `hydrated`, `past`, `future` module-level, deliberately survive reload — what static import would share across tests. Dynamic import = sanctioned exception to static-import rule; copy `freshStore()` in `tests/store.test.ts`. `store.subscribe` exported so cross-tab + seeding run without React; `withWindow()` stubs the one `addEventListener` needed.

**Test the invariant a `why` comment names.** Most non-obvious `src/lib/` lines carry one = contract worth pinning. Every test MUST be able to fail on plausible bug — not plumbing, source text, default equalling itself. Table-driven: `it.each` + `$name` so failures name case, `expect.soft` so every row reports.

**Case a suite cannot reach = write it down, then drive it.** `tests/cloud.test.ts` holds two-fresh-installs: two browsers, one account, no setting changed, each creates one event. Shape passed **every** existing case in `merge`, `mirror`, `cloud` yet quietly adopted away a user's first edit. No bad mock, no careless fixture: state never occurred in suite building documents stamped, and `stamped`'s table asserted false true for wrong reason. Two real browsers on real row caught it in one pass (see gotcha); fix ships with cases failing seven ways on old predicate. Rule about what document _is_, not what function returns → build fixtures as first run looks: unstamped records, seed calendars, `settingsAt` of `0`. Else test agrees with bug.

**`pnpm verify` proves nothing about how it _looks_.** Drive it: `pnpm dev`, exercise path (create event, drag ring, ⌘P, switch face, step days), screenshot. `/api/feed`, service worker, manifest need `pnpm dev:worker` — `astro dev` serves neither Worker route nor PROD build.

1. For user-facing prose, inspect the rendered text against `BANNED - THE DEFINITIVE GUIDE.md`. Check accidental Cyrillic lookalikes and punctuation bans, preserve protected wording and evidence, and verify that copied setup instructions include the visible steps and code.
