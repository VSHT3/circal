/* ------------------------------------------------------------------ *
 * Auto-schedule: the drag performed by the app (TASKS.md §9).
 *
 * One pure function, nothing written. It reads exactly what the dial
 * reads — `dayAgenda` over the same lists, `freeGaps` against the same
 * waking window — so a placement can never land where the face shows
 * time already spoken for. The caller commits the result through
 * `store.applyPlans`, one commit, one ⌘Z.
 * ------------------------------------------------------------------ */

import { dayAgenda, freeGaps, type CalEvent, type Calendar } from "./events";
import { compareTasks, type Plan, type Task } from "./tasks";
import { addDays, atMinutes, daysBetween, minutesOfDay, startOfDay } from "./time";

/** One placement the run decided on — `store.applyPlans`' own input shape. */
export interface Placement {
  id: string;
  plan: Plan;
}

export interface ScheduleResult {
  placements: Placement[];
  /** Candidates the horizon had no room for: no gap long enough inside
   *  waking hours that ends before the task's own deadline. The caller
   *  says so — a silent miss is indistinguishable from a bug. */
  unplaced: Task[];
}

/** How far ahead a run looks, in days. Two weeks: the sidebar's "due soon"
 *  window and one more of runway — past that a placement is a guess about a
 *  calendar that does not exist yet. */
export const HORIZON_DAYS = 14;

/** The grid every placement snaps to — the dial's own drag granularity. */
const STEP = 15;

/**
 * The rule, whole: take every task that is not done, has an estimate and no
 * plan yet; sort soonest deadline first, then priority, then name
 * (`compareTasks`, the sidebar's own order); walk days from `from` to the
 * horizon; give each task the first free gap at least its estimate long,
 * inside waking hours, ending no later than its deadline. Placements made
 * earlier in the run are folded into every later day read — one run cannot
 * double-book itself — and a second run is a no-op, because everything the
 * first run placed now has a plan.
 *
 * A task with plans is never touched, even under-planned ones: the plans it
 * has were placed by somebody, and topping them up unasked is the slot
 * machine this function must not be. A task with no estimate is not a
 * candidate at all — it cannot be sized, and the sidebar already says so.
 */
export function schedule(
  tasks: Task[],
  events: CalEvent[],
  calendars: Calendar[],
  waking: { from: number; to: number },
  from: Date,
  horizonDays: number = HORIZON_DAYS,
): ScheduleResult {
  const candidates = tasks
    .filter((t) => !t.done && t.estimate !== null && t.plans.length === 0)
    .sort(compareTasks);

  const placements: Placement[] = [];
  const unplaced: Task[] = [];
  if (candidates.length === 0) return { placements, unplaced };

  // The working copy the day reads see: every placement is appended to its
  // task here, so `dayAgenda` on a later day — or a later task on the same
  // day — already counts it as booked time.
  const working = tasks.map((t) => ({ ...t, plans: [...t.plans] }));
  const byId = new Map(working.map((t) => [t.id, t]));
  const first = startOfDay(from);

  for (const task of candidates) {
    const estimate = task.estimate as number;
    // Days past the deadline cannot hold a legal placement, so the walk
    // stops at the due day itself (a timed deadline may still leave room
    // that morning; the minute check below decides).
    const lastDay = Math.min(horizonDays - 1, daysBetween(first, startOfDay(new Date(task.due))));
    let placed = false;

    for (let i = 0; i <= lastDay && !placed; i++) {
      const day = addDays(first, i);
      // A gap that started before `from` is not free, it is late — the
      // shared-link rule, applied to the first day only.
      const floor = i === 0 ? minutesOfDay(from) : 0;
      // The plan must end by the deadline: the due minute on its own day
      // for a timed one, the end of the due day for an all-day one.
      const dueDay = daysBetween(first, startOfDay(new Date(task.due)));
      const ceiling = !task.dueAllDay && i === dueDay ? minutesOfDay(new Date(task.due)) : Infinity;

      const agenda = dayAgenda(events, calendars, day, working).all;
      for (const gap of freeGaps(agenda, estimate, waking.from, waking.to)) {
        const startMin = Math.ceil(Math.max(gap.start, floor) / STEP) * STEP;
        const endMin = startMin + estimate;
        if (endMin > gap.end || endMin > ceiling) continue;
        const plan: Plan = {
          start: atMinutes(day, startMin).getTime(),
          end: atMinutes(day, endMin).getTime(),
        };
        placements.push({ id: task.id, plan });
        byId.get(task.id)?.plans.push(plan);
        placed = true;
        break;
      }
    }

    if (!placed) unplaced.push(task);
  }

  return { placements, unplaced };
}
