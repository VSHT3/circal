# Tasks: a list you can drag onto the day

**Status:** built, all five stages shipped (2026-08-29). Written from a brainstorm
on 2026-08-20. Where the build deviated, `docs/agent/dial.md` §Tasks records it:
no migration (no users), `taskOccurrences` in `events.ts`, one completing verb in
MCP (`toggle_done`, no `complete_task`), no legacy `X-CIRCAL-TASK` read.

**The open question, resolved by default.** The one thing left undecided in the
conversation was whether a task may exist with no date at all. This spec takes
the narrower answer — **every task carries a due date** — because it keeps the
property that makes circal a calendar rather than a to-do app: everything has a
day, and everything can be found by walking the days. What is undated here is
only the _plan_: when you intend to do the work. If that turns out to be a cage,
allowing `due: null` is strictly additive and touches the sidebar's grouping, the
sort, and one validator; nothing else in this document changes. It is one line in
§4 and one group in §6.

---

## 1. Why

A task today is one field on `CalEvent` — `task: true`, with `end === start` —
plus `doneKeys`, the list of ticked occurrences (`src/lib/events.ts:451`). That
buys exactly one drawing: a pip on the rim at a minute. Three consequences, and
they are the whole complaint:

**One instant is doing the job of three facts.** A piece of work has a deadline,
a rough length, and a time you plan to spend on it. Those are three different
numbers with three different lifetimes — the deadline is somebody else's, the
length is a guess, the plan is a decision you revise. circal has one number for
all three, so a task cannot book time, cannot be moved without moving its
deadline, and cannot say "due Friday, doing it Wednesday morning".

**There is nothing to drag from.** Drag-to-schedule needs a queue of work that is
not yet on a clock. `AGENTS.md` currently forbids that outright: _"Undated tasks
are deliberately not modelled — a list with no day on it is a different product
wearing this one as a skin."_ That sentence was right about the thing it was
refusing. It is wrong about the thing this spec builds, and §14 replaces it.

**A task is invisible unless you are standing on its day.** A deadline is a fact
about now, not about the square it sits in. Work that has slipped past falls off
the back of the face and says nothing. This is why every task app has an
"Overdue" group at the top of a list.

What is well-built and survives unchanged: the tick vocabulary (filled while it
stands, hollow once done — the same two shapes on the rim and in the readout),
`packLanes` leaving tasks out of lane packing, and the rule that a task books no
time in `freeGaps` and `dayLoad`.

## 2. The shape of the feature, in one paragraph

The sidebar grows a list of work, grouped by deadline: overdue, due soon, later.
Each row carries a name, its due date, and an estimate. You drag a row onto the
rim and sweep out the minutes you want to give it, exactly as you draw an event;
on release, that task owns those minutes and draws as an arc with its pip at the
head. The pip is its checkbox: tick it and the arc goes hollow, so a day you have
cleared reads as cleared. Auto-schedule is the same operation performed by the
app: it drops unplanned tasks into free gaps inside your waking hours, soonest
deadline first, and it never touches a block you placed yourself.

## 3. Decisions, and why

**A task is its own record, not an event with a nullable start.** `CalEvent.start`
is a number in `dial.ts`, `recur.ts`, `events.ts`, `year.ts`, `life.ts`, `ics.ts`,
`mirror.ts` and `mcp/`. Making it nullable makes every one of those readers ask
"is this on a day at all", and a missed reader is the `undefined → NaN` class of
bug `store.parse`'s hydration exists to prevent. The two things also genuinely
differ in fields and lifetime: a deadline, an estimate and a done state have no
meaning on a meeting.

**`plans` is a list from the first commit.** One task worked on Tuesday and again
on Thursday is the normal case, and splitting a long task across gaps is the
obvious second version of auto-schedule. A single `plan` field makes that a
rewrite of every reader; a list of one costs nothing now.

**`dayAgenda` stays the single read path onto a day.** A planned block enters it
as an `Occurrence`, so `Face`, `CenterPanel` and the week strip never learn that
there are two models behind them. Everything that draws a day keeps its one
question.

**No new encoding on the face.** A plan is an arc, a due date is a pip, done is
hollow. Hollow normally means _free_, but `Face.tsx:1193` already documents that
`free` is never asked of a task — so on a task the shape is unclaimed, and it can
carry "done" without colliding with anything.

**Auto-schedule only ever places tasks that have no plan.** If it can move a block
you can see, re-running it is a slot machine and you stop trusting the face.

## 4. The model

New module `src/lib/tasks.ts`, sitting at the same tier as `events.ts` (it may
import `time.ts`, `fuzzy.ts`, `recur.ts`; nothing at that tier may import it).

```ts
interface Plan {
  start: number; // epoch ms
  end: number; // exclusive, as everywhere else
}

interface Task {
  id: string;
  title: string;
  notes: string;
  calendarId: string;
  icon: string; // the mark vocabulary, unchanged
  color: string; // "" = follow the calendar, as on an event
  due: number; // epoch ms. A day, or a day and a minute
  dueAllDay: boolean; // true = a date with no time on it
  estimate: number | null; // minutes; null = "no idea"
  priority: 0 | 1 | 2; // normal / high / urgent
  plans: Plan[];
  done: boolean;
}
```

Notes on each of the debatable ones:

- **`dueAllDay`** rather than a separate date type: "due Friday" and "due Friday
  17:00" are one field with a flag, which is the shape `allDay` already has on an
  event and the shape the editor already knows how to draw.
- **`estimate` is nullable** and nullable means something: auto-schedule skips a
  task it cannot size, and the sidebar says so rather than inventing an hour. A
  drag still works — the sweep _is_ the length — and a drop with no sweep uses
  `DEFAULT_DURATION` from `quickadd.ts`.
- **`priority`** exists because two things need a tiebreak: the sidebar's order
  within a group and auto-schedule's order within a day. Three values, because a
  scale nobody can hold in their head is a field nobody sets.
- **`done` is a boolean, not `doneKeys`.** A task has one deadline and is finished
  once. Repeating deadlines are deliberately out of v1 (§13); when they arrive,
  `done` becomes the ticked-instants list the current model already has, and that
  is the only field that changes.

No `Recurrence` on a task in v1. That is the single largest thing this cuts, and
the reason is that a repeating task is two features wearing one name — a deadline
that returns, and a habit you want on the face every week — and neither is
answered well by borrowing an event's rule wholesale.

### Derived answers, all in `tasks.ts`

- `plannedMinutes(task)` — the total the plans cover.
- `unplanned(task)` — no plans at all, or plans totalling less than the estimate.
  This is what the sidebar marks and what auto-schedule feeds on.
- `taskState(task, now)` — `done | overdue | due-soon | later`, one place deciding
  it so the sidebar's groups and any future badge cannot disagree. "Due soon" is
  the next seven days, measured in local days like every other day boundary here.
- `scoreTask(task, query)` — the `scoreEvent` shape (title, then notes at a
  penalty) so the palette and the life-grid thread can reach tasks with the same
  engine and never light for a query the list would not find.
- `taskOccurrences(tasks, calendars, day)` — each plan that overlaps `day`,
  clipped to it, as `Occurrence`s. `dayAgenda` calls this and concatenates before
  packing lanes; `occurrencesOn` is untouched.

`Occurrence` gains one optional field, `task?: Task`, and `done` keeps its
meaning. Nothing else on that interface moves.

## 5. Store and persistence

`Snapshot` gains `tasks: Task[]`, inside the blob beside `events` — it is the
user's own data, it is exported, and it is undone. Actions, all following the
existing `fresh()`-then-`commit()` shape:

`addTask`, `updateTask`, `removeTask`, `toggleTaskDone`, `planTask(id, plan)`,
`unplanTask(id, index)`, `movePlan(id, index, plan)`, and `applyPlans(list)` — the
last one is auto-schedule's single commit, so a whole run is one ⌘Z.

`hydrateTasks` mirrors `hydrateEvents`: it fills fields a blob predates, keeps its
identity fast path, and asks about shape before it asks about values. `sane()`
gains nothing; the per-task clamps live in one validator, `readTask`, exported
from `backup.ts` for the same reason `readEvent` is — three readers (a backup, a
mirror, the store's own hydration) sharing one opinion about what a task legally
is. Caps: title and notes as an event's, `estimate` inside `[0, 24 × 60]`,
`priority` snapped into range, plans dropped when `end <= start`, and a plan list
capped at `PLANS_MAX` (32) so a hand-edited file cannot put ten thousand arcs on
one day.

**No `SCHEMA` bump.** A bump resets settings, and nothing stored changes meaning —
this is a field arriving, which is the case `hydrateEvents` already covers.

Two settings, and only two:

- `autoSchedule: boolean`, **off by default.** A feature that writes to your
  calendar without being asked does not default on; this is the reminder switch's
  own argument.
- `autoScheduleHorizon: 7` days — how far ahead a run is allowed to place work,
  from a small fixed list. Unbounded, a run puts a task with a distant deadline on
  a day nobody has thought about yet.

Waking hours are `settings.wakingFrom` / `wakingTo`, already there and already the
window "free" is counted against. One idea of the working day, not two.

## 6. The sidebar

A section above the calendars, below the mini-month. Three groups from
`taskState`, each collapsible, each showing its count the way `Overdue 1` does in
the app that prompted this: **Overdue**, **Due soon**, **Later**. Done tasks leave
the list on tick (they are still on the face, hollow, on the day they were worked)
and are reachable through a `Done` group that stays collapsed.

A row is: the pip, the title, and a meta line of the due date, the estimate, and
the calendar's mark. Sorted by due, then priority, then title. A row whose task is
already planned is marked — a small filled dot at the trailing edge, not a dimming
— because "already on the face somewhere" is the one thing you need to know before
you drag it again.

The column is 260px and `.label`/`.caption` are the two voices available, so the
meta line is one line and truncates. Two things it may not become: a second
agenda (the interior answers the day, and this column lost its agenda for exactly
that reason), and a card stack — these are rows, at the mini-month's own rhythm.

`+` in the section header opens the task editor with a blank draft due today. The
palette's existing `New task` row does the same.

## 7. Drag a row onto the rim

The gesture, in order: press a row, move; once the pointer is over the face the
dial shows a ghost arc of the task's estimate length, snapped to the quarter hour
under the pointer; keep moving to slide it; drag past its own end to sweep out a
different length; release to commit. Escape abandons, from the shell, because a
drag is the one thing here you can start by accident.

Three things this must reuse rather than reinvent: the ghost arc channel `Face`
already has for a draft, `clampDelta`'s minimum-duration behaviour, and the
`step` / `created` cues, so placing a task sounds like drawing an event.

**Pointer events, not HTML5 drag-and-drop.** The face is SVG under pointer
capture, and the ghost, the sound and the fifteen-minute snap all live on that
path. The payload is one field of shell state, `dragTask: string | null`, because
`Sidebar` and `Dial` are siblings and the drop target has to know what is coming.

**Every drag has a keyboard and touch equivalent, because in drawer mode the
column covers the face and there is nothing to drag onto.** A row's own verb —
`Schedule` — plans it on the selected day at the next quarter hour, at its
estimate's length, and toasts where it landed. A plan can then be moved with the
same arc drag every event has.

Dropping a row on a week-strip face plans it on that day at the next free quarter
hour inside waking hours. The strip stays read-only about arcs; this is the same
whole-day drop its span gesture already makes.

## 8. What the face says

- **A plan is an arc.** Same lane packing, same colour resolution (`colorOf` on
  the task, with the calendar behind it), same label rules.
- **The pip sits at the plan's head**, inside the arc's own stroke: it is the tick
  control and the thing that says "this arc is work, not an appointment".
- **Done is hollow** — the arc becomes the outline `hollowPath` already draws, and
  the pip empties with it. Legal because `free` is never asked of a task.
- **A due date with no plan on that day is a pip on the rim at its minute**, which
  is what a task draws today, unchanged. An all-day due date draws no pip, as an
  all-day event draws no arc.
- **The readout**: a planned task prints its span like anything else, with the
  strike-through on tick that `CenterPanel` already does. A bare deadline prints
  one instant, which is the `peekedTask` branch that already exists.
- **Year ring and life grid** count a plan as a day carrying something, because it
  is time spent. A bare due date does not colour a day: a deadline is not work.

## 9. Auto-schedule

A new pure module `src/lib/plan.ts`, one exported function:

`schedule(tasks, occurrences, settings, from, horizonDays) → Plan[]` — a list of
placements, nothing written.

The rule: take every task that is not done, has an estimate, and is unplanned;
sort by due ascending, then priority descending; walk days from `from` to the
horizon; for each task take the first free gap at least as long as its estimate,
inside waking hours, that ends before its deadline. A task that does not fit is
returned as unplaced and the caller says so. Free gaps come from `freeGaps`, over
the occurrences of that day _including_ placements already made in this run — one
run cannot double-book itself.

Invariants worth pinning in tests, because each is a way the feature could quietly
be a slot machine:

1. Running it twice in a row is a no-op the second time.
2. It never returns a plan for a task that already has one.
3. Nothing lands outside waking hours, and nothing lands after its own deadline.
4. Nothing overlaps an existing occurrence, a placement from the same run, or a
   busy event; free events (`TRANSP:TRANSPARENT`) are bookable, which is what free
   already means everywhere else here.
5. The whole run is one commit and one ⌘Z.

Where it is triggered: a verb in the sidebar's section header (`Fill free time`)
and, when `settings.autoSchedule` is on, once on load and after a task is added.
It always toasts what it placed and what it could not, because a silent write to
your calendar is indistinguishable from a bug.

## 10. Everything else that reads a task

- **Reminders.** Today a dated task fires at its instant. After this, a reminder
  fires at a plan's start (the thing actually on the clock) and at a timed
  deadline. `dueReminders` takes tasks alongside events; the lead vocabulary and
  the one-minute window are untouched. An all-day deadline fires nothing, as an
  all-day event does not.
- **Command palette.** Tasks appear as rows through `scoreTask`, at the same
  penalty structure events use; the row's primary verb opens the task editor and
  its `alt` is `Schedule`.
- **The editor.** A new `TaskEditor.tsx`, a sibling of `EventEditor` — one column
  at 330px, reusing `FieldRow`, `TimeField`, `DateField`, `ColorPicker`,
  `MarkPicker`, `useFocusTrap`. Rows: title, notes, due, estimate, priority,
  calendar, colour, mark, and the plans as a small list with a remove on each.
  `EditorTarget` gains a `kind`. The event editor's current event ⇄ task switch
  goes; in its place both editors carry a `Convert` verb, which builds the other
  record and commits once.
- **Life grid and year ring search** thread tasks through `scoreTask`, so a lit
  day agrees with the list.

## 11. Interop

**iCalendar.** A task is a `VTODO`: `DUE`, `PRIORITY`, `STATUS:COMPLETED`, and
the plans as `DTSTART` + `DURATION` on the VTODO itself for the first plan, with
any further plans as `X-CIRCAL-PLAN` lines. `X-CIRCAL-TASK` on a VEVENT is still
_read_, as a task with a deadline and no plan, so an export from an older circal
imports correctly. The cost, stated plainly: a consumer that ignores VTODO shows
nothing, where today a circal task exports as a VEVENT everybody renders. That is
the price of saying the true thing on the wire.

The current argument against VTODO in `AGENTS.md` rests on circal modelling only
"the half of VTODO that has a day and a minute". That stops being true here, which
is what licenses the change.

**A subscription's VTODOs are dropped in v1**, deliberately: a feed's payload is
`CalEvent[]` per calendar and a read-only task you cannot tick is noise on the
rim. Named as a follow-on, not a silent omission.

**Backup and mirror** carry `tasks` through `readTask`. **Share links** carry an
event only; a task in a link is a follow-on and the token's version field is what
makes that possible without breaking a link minted today.

**MCP** gains `list_tasks`, `create_task`, `update_task`, `complete_task` and
`plan_task`, each through the same store actions, so the assistant and the dial
cannot disagree about what is planned. `mutate.ts` is untouched — a task has no
`EditScope` question, because it has no series.

## 12. Migration

Existing `task: true` events become tasks, in `hydrate()` — the shape
`migrateFeeds` already has, run once, rewriting the blob immediately, and shared
by `load()` and `fresh()` because either can be first to see a blob.

Each becomes a task whose `due` is the event's instant, `dueAllDay` false,
`estimate` null, `priority` 0, `plans` empty, and `done` true when the event's
`doneKeys` contained that instant. A repeating task event — the one case v1's
model cannot hold — migrates to **one** task at its next uncompleted instant, and
the toast says so. Data is not silently dropped: the migration is recorded as an
undo step, so the answer is one ⌘Z away.

`CalEvent.task` and `CalEvent.doneKeys` are then removed outright, along with
`taskDraft`, `toggleDoneKey`, the editor's type switch, and the task branches in
`Face`, `occurrencesOn` and `packLanes` that exist only for a zero-width event.
Clean cutover: no compatibility flag, no dual model, one reading of what a task
is.

## 13. Non-goals

Repeating deadlines. Subtasks. Tags. Task lists separate from calendars — a
calendar already is a list, and a second grouping is a second product. Time
tracking or over-run. "Flexible" blocks that auto-schedule may move. Splitting one
task across several gaps in a single run (the `plans` list makes it additive; the
placement rule does not do it yet). Undated tasks (§0). A task inside a share
link. Feed VTODOs.

## 14. Documentation this makes false

`AGENTS.md` has four passages that stop being true and must be replaced in the
same commits, not afterwards:

1. The "Tasks" section's opening — _"A task is an explicit `CalEvent.task`"_ — and
   its paragraph refusing undated tasks.
2. The VTODO paragraph, whose argument this spec inverts.
3. `doneKeys` as the per-occurrence tick.
4. The sidebar's _"no agenda"_ paragraph, which needs the sentence saying why a
   task list is the thing that column _is_ for: it holds what the interior cannot
   show, and the interior cannot show work with no time on it.

## 15. Testing

The suite is pure-layer only, and this feature is mostly pure, which is the good
news.

- `tests/tasks.test.ts` — `taskState`'s boundaries, `unplanned`, plan clipping
  into occurrences, `scoreTask`'s ranking.
- `tests/plan.test.ts` — the five invariants in §9, table-driven, plus the
  unplaceable case.
- `tests/west/tasks.test.ts` — deadlines and plans are day-keyed, so the whole
  file re-runs west of UTC. Mandatory, not optional: `taskState` compares local
  days.
- Extensions rather than new files: `events.test.ts` (agenda merging, lanes with a
  plan present), `store.test.ts` (the migration, undo of a run, cross-tab),
  `backup.test.ts` (hostile task input, the caps), `ics.test.ts` (VTODO round
  trip, `X-CIRCAL-TASK` read as a task), `remind.test.ts` (a plan's lead, a timed
  deadline, an all-day deadline firing nothing).

`pnpm verify` proves none of the drag. That is driven by hand: `pnpm dev`, drag a
row onto the rim at three window widths, in push and drawer mode, with Escape
mid-flight, and the same row placed by keyboard.

## 16. Order of work

Five specs, each shippable, each leaving the app working:

1. **Model and store** — `tasks.ts`, `Snapshot.tasks`, actions, `readTask`,
   hydration, the migration, `CalEvent.task` removed. No new UI; the sidebar list
   is the only way to see one, and it can be a bare list at this stage.
2. **The sidebar and the editor** — groups, rows, `TaskEditor`, the palette rows,
   `Schedule` as a verb. Everything reachable by keyboard before anything is
   draggable.
3. **The face** — plan arcs, due pips, hollow-done, the readout, the year ring and
   life grid counting a plan.
4. **The drag** — row onto rim, row onto a strip face, ghost, cues, Escape.
5. **Auto-schedule and interop** — `plan.ts`, the sidebar verb, the setting, then
   VTODO, mirror, MCP.

Steps 1 and 3 are where the risk is: one changes the shape of stored data, the
other changes what the instrument draws. Both are covered by the pure suite.
