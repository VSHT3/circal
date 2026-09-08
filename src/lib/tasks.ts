/* ------------------------------------------------------------------ *
 * The task model: a piece of work with a deadline, an estimate and the
 * time you plan to spend on it — three different numbers with three
 * different lifetimes, which is why a task is its own record rather
 * than an event with a nullable start (TASKS.md §3).
 *
 * Pure over the model. The one reader that manufactures `Occurrence`s
 * out of plans lives in `events.ts` beside `dayAgenda`, because that is
 * the read path's own glue and this module sits below `events.ts`.
 * ------------------------------------------------------------------ */

import { fuzzyScore } from "./fuzzy";
import { addDays, startOfDay } from "./time";

/** One block of time given to a task — "I'll work on this Tuesday 9 to 11". */
export interface Plan {
  /** Epoch ms. */
  start: number;
  /** Epoch ms, exclusive, as everywhere else. */
  end: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  calendarId: string;
  /** Empty means unlisted; calendar membership is independent. */
  listId: string;
  /** The mark vocabulary, unchanged — a Phosphor name or a literal emoji. */
  icon: string;
  /** `""` = follow the calendar, as on an event. */
  color: string;
  /** Epoch ms. A day, or a day and a minute — `dueAllDay` says which. */
  due: number;
  /** `true` = a date with no time on it: "due Friday", not "due Friday 17:00". */
  dueAllDay: boolean;
  /**
   * Minutes, or `null` for "no idea" — and null means something: the
   * auto-scheduler skips a task it cannot size, and the sidebar says so
   * rather than inventing an hour.
   */
  estimate: number | null;
  /** Normal / high / urgent. Three values, because a scale nobody can hold
   *  in their head is a field nobody sets. */
  priority: 0 | 1 | 2;
  /**
   * The blocks of time this task has been given, a list from the first
   * commit: one task worked on Tuesday and again on Thursday is the normal
   * case, and a single field would make that a rewrite of every reader.
   */
  plans: Plan[];
  /**
   * A boolean, not a per-occurrence list: a task has one deadline and is
   * finished once. Repeating deadlines are deliberately out of v1, and when
   * they arrive this is the only field that changes.
   */
  done: boolean;
  /** Epoch ms of the last change, `CalEvent.updatedAt`'s own contract:
   *  stamped by whoever commits, `0` on a record nobody has saved. */
  updatedAt: number;
}

export interface TaskList {
  id: string;
  name: string;
  parentId: string;
  updatedAt: number;
}

/** Includes the root, so the same set excludes self-parenting and cycles. */
export function taskListDescendants(lists: TaskList[], id: string): Set<string> {
  const found = new Set([id]);
  const children = new Map<string, string[]>();
  for (const list of lists) {
    const siblings = children.get(list.parentId) ?? [];
    siblings.push(list.id);
    children.set(list.parentId, siblings);
  }
  for (const parent of found) {
    for (const child of children.get(parent) ?? []) found.add(child);
  }
  return found;
}

/** Concurrent moves can form cycles; every list remains reachable on screen. */
export function taskListTree(lists: TaskList[]): { list: TaskList; depth: number }[] {
  const sorted = [...lists].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const ids = new Set(sorted.map((list) => list.id));
  const children = new Map<string, TaskList[]>();
  for (const list of sorted) {
    const parent = ids.has(list.parentId) ? list.parentId : "";
    const siblings = children.get(parent) ?? [];
    siblings.push(list);
    children.set(parent, siblings);
  }
  const result: { list: TaskList; depth: number }[] = [];
  const seen = new Set<string>();
  function walk(roots: TaskList[]) {
    const stack = roots.map((list) => ({ list, depth: 0 })).reverse();
    while (stack.length) {
      const row = stack.pop()!;
      if (seen.has(row.list.id)) continue;
      seen.add(row.list.id);
      result.push(row);
      const next = children.get(row.list.id) ?? [];
      for (let i = next.length - 1; i >= 0; i--) {
        stack.push({ list: next[i], depth: row.depth + 1 });
      }
    }
  }
  walk(children.get("") ?? []);
  walk(sorted.filter((list) => !seen.has(list.id)));
  return result;
}

/* ------------------------------- validators -------------------------------- */

/** The longest estimate a task may carry, in minutes — one whole day. An
 *  estimate is a guess at a sitting's work, and a guess past the revolution
 *  is a project, not a task. */
export const ESTIMATE_MAX = 24 * 60;

/** How many plans one task may carry, so a hand-edited file cannot put ten
 *  thousand arcs on one day. */
export const PLANS_MAX = 32;

/**
 * A stored or imported estimate, read. `null` is the ordinary value ("no
 * idea") and the answer for anything unreadable — inventing an hour here is
 * exactly what the field's nullability exists to refuse. Whole minutes,
 * clamped into `[0, ESTIMATE_MAX]`.
 */
export function readEstimate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(ESTIMATE_MAX, Math.max(0, Math.round(value)));
}

/** A stored or imported priority, snapped into range. Anything unreadable is
 *  normal — a hand-edited `9` must not sort above every urgent task. */
export function readPriority(value: unknown): 0 | 1 | 2 {
  return value === 1 || value === 2 ? value : 0;
}

/**
 * A stored or imported plan list, read: finite instants, `end > start` (a
 * plan of no width books nothing and draws nothing), capped at `PLANS_MAX`
 * and kept in start order so every reader walks the same day the same way.
 */
export function readPlans(value: unknown): Plan[] {
  if (!Array.isArray(value)) return [];
  const plans: Plan[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { start, end } = entry as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    plans.push({ start, end });
    if (plans.length === PLANS_MAX) break;
  }
  return plans.sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ---------------------------- derived answers ------------------------------ */

/** The total the plans cover, in whole minutes. */
export function plannedMinutes(task: Task): number {
  return Math.round(task.plans.reduce((sum, plan) => sum + (plan.end - plan.start), 0) / 60_000);
}

/**
 * Whether this task still needs time on the clock: no plans at all, or plans
 * totalling less than the estimate. This is what the sidebar marks and what
 * auto-schedule feeds on. A task with plans and no estimate is planned —
 * there is no target for the plans to fall short of.
 */
export function unplanned(task: Task): boolean {
  if (task.plans.length === 0) return true;
  return task.estimate !== null && plannedMinutes(task) < task.estimate;
}

export type TaskState = "done" | "overdue" | "due-soon" | "later";

/** How far ahead "due soon" reaches, in local days — today and the next
 *  seven, one week of runway. */
export const DUE_SOON_DAYS = 7;

/**
 * One place deciding which group a task belongs to, so the sidebar's groups
 * and any future badge cannot disagree. Days are local days, like every
 * other day boundary here: an all-day deadline is overdue the day *after*
 * it, a timed one the minute it passes.
 */
export function taskState(task: Task, now: Date): TaskState {
  if (task.done) return "done";
  const today = startOfDay(now);
  if (task.dueAllDay) {
    const dueDay = startOfDay(new Date(task.due));
    if (dueDay < today) return "overdue";
    return dueDay < addDays(today, DUE_SOON_DAYS + 1) ? "due-soon" : "later";
  }
  if (task.due <= now.getTime()) return "overdue";
  return startOfDay(new Date(task.due)) < addDays(today, DUE_SOON_DAYS + 1) ? "due-soon" : "later";
}

/**
 * What a match outside the title gives up — `scoreEvent`'s own number for a
 * note (`FIELD_PENALTY.notes` in `events.ts`), restated here because this
 * module sits below `events.ts` and may not import it. The two MUST stay
 * equal: a task and an event with the same note must rank the same, or the
 * palette's order says something about record kinds instead of matches.
 */
const NOTES_PENALTY = 45;

/**
 * How well a task answers a query, or `null` when it does not — `scoreEvent`'s
 * shape (title first, notes at a penalty), so the palette and the lit faces
 * reach tasks with the same engine and never light for a query the list
 * would not find. `scoreTaskBy` names the winning field for `scoreEventBy`'s
 * reason, a tie going to the title.
 */
export function scoreTaskBy(
  task: Task,
  query: string,
): { field: "title" | "notes"; score: number } | null {
  const title = fuzzyScore(task.title, query);
  const notes = fuzzyScore(task.notes, query);
  const penalised = notes === null ? null : notes - NOTES_PENALTY;
  let best: { field: "title" | "notes"; score: number } | null =
    title === null ? null : { field: "title", score: title };
  if (penalised !== null && (best === null || penalised > best.score)) {
    best = { field: "notes", score: penalised };
  }
  return best;
}

export function scoreTask(task: Task, query: string): number | null {
  return scoreTaskBy(task, query)?.score ?? null;
}

/** The sidebar's order inside a group: soonest deadline first, then the
 *  higher priority, then the name — one comparator so no two lists of tasks
 *  can disagree about it. */
export function compareTasks(a: Task, b: Task): number {
  return a.due - b.due || b.priority - a.priority || a.title.localeCompare(b.title);
}
