import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CalendarMinus,
  CalendarPlus,
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  Sparkles,
} from "lucide-react";
import { colorOf, markOf, PALETTE } from "@/lib/events";
import {
  compareTasks,
  compareTaskOrder,
  taskListDescendants,
  taskListTree,
  taskState,
  unplanned,
  type Task,
} from "@/lib/tasks";
import { store } from "@/lib/store";
import { formatDuration, formatRelativeDay, formatTimeShort } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SidebarProps } from "@/components/react/types";
import { ActionPill, IconButton } from "@/components/react/ui/primitives";
import { CalendarMark } from "@/components/react/ui/icons";

type Props = Pick<SidebarProps, "tasks" | "taskLists" | "calendars" | "clock" | "now" | "actions">;
type Carried = { kind: "task" | "list"; id: string };
type Destination = {
  listId: string;
  beforeId?: string;
  key: string;
  edge: "before" | "after" | "inside";
};

export default function TaskLists({ tasks, taskLists, calendars, clock, now, actions }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done: true });
  const [carried, setCarried] = useState<Carried | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const root = useRef<HTMLElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const active = selected && !taskLists.some((list) => list.id === selected) ? null : selected;
  const tree = useMemo(() => taskListTree(taskLists), [taskLists]);
  const visibleTree = useMemo(() => {
    const visible: typeof tree = [];
    let hiddenBelow: number | null = null;
    for (const row of tree) {
      if (hiddenBelow !== null && row.depth > hiddenBelow) continue;
      hiddenBelow = active !== null && expanded[row.list.id] ? null : row.depth;
      visible.push(row);
    }
    return visible;
  }, [tree, active, expanded]);
  const known = useMemo(() => new Set(taskLists.map((list) => list.id)), [taskLists]);
  const byList = useMemo(() => {
    const result = new Map<string, Task[]>();
    for (const task of tasks) {
      const id = known.has(task.listId) ? task.listId : "";
      const rows = result.get(id) ?? [];
      rows.push(task);
      result.set(id, rows);
    }
    for (const rows of result.values()) rows.sort(compareTaskOrder);
    return result;
  }, [tasks, known]);
  const groups = useMemo(
    () =>
      [
        { id: "overdue", title: "Overdue" },
        { id: "due-soon", title: "Due soon" },
        { id: "later", title: "Later" },
        { id: "done", title: "Done" },
      ]
        .map((group) => ({
          ...group,
          rows: tasks.filter((task) => taskState(task, now) === group.id).sort(compareTasks),
        }))
        .filter((group) => group.rows.length),
    [tasks, now],
  );

  useEffect(() => () => cancelDrag.current?.(), []);

  function commitMove(item: Carried, into: Destination) {
    const moved =
      item.kind === "task"
        ? store.moveTask(item.id, into.listId, into.beforeId)
        : store.moveTaskList(item.id, into.listId, into.beforeId);
    if (moved) {
      setAnnouncement(
        `Moved to ${taskLists.find((list) => list.id === into.listId)?.name ?? (item.kind === "task" ? "Unlisted" : "Top level")}`,
      );
      if (item.kind === "task") {
        setSelected(into.listId);
        setExpanded((value) => ({ ...value, [into.listId]: true }));
      } else if (into.listId) {
        setSelected(into.listId);
        setExpanded((value) => ({ ...value, [into.listId]: true }));
      }
    }
  }

  function targetAt(item: Carried, x: number, y: number): Destination | null {
    const element = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-list-drop], [data-task-drop]");
    if (!element || !root.current?.contains(element)) return null;
    const taskId = element.dataset.taskDrop;
    const listId = element.dataset.listDrop ?? "";
    const box = (element.querySelector("[aria-expanded]") ?? element).getBoundingClientRect();
    if (taskId) {
      if (item.kind !== "task" || item.id === taskId) return null;
      const task = tasks.find((row) => row.id === taskId);
      if (!task) return null;
      const parent = known.has(task.listId) ? task.listId : "";
      const rows = (byList.get(parent) ?? []).filter((row) => row.id !== item.id);
      const index = rows.findIndex((row) => row.id === taskId);
      const before = y < box.top + box.height / 2;
      return {
        listId: parent,
        beforeId: before ? taskId : rows[index + 1]?.id,
        key: taskId,
        edge: before ? "before" : "after",
      };
    }
    if (item.kind === "task") return { listId, key: `list:${listId}`, edge: "inside" };
    if (!listId) return { listId: "", key: "list:", edge: "inside" };
    const list = taskLists.find((row) => row.id === listId);
    if (!list || taskListDescendants(taskLists, item.id).has(listId)) return null;
    const fraction = (y - box.top) / box.height;
    if (fraction > 0.25 && fraction < 0.75)
      return { listId, key: `list:${listId}`, edge: "inside" };
    const siblings = tree.filter(
      (row) => row.list.parentId === list.parentId && row.list.id !== item.id,
    );
    const index = siblings.findIndex((row) => row.list.id === listId);
    const before = fraction <= 0.25;
    return {
      listId: list.parentId,
      beforeId: before ? listId : siblings[index + 1]?.list.id,
      key: `list:${listId}`,
      edge: before ? "before" : "after",
    };
  }

  function beginDrag(event: ReactPointerEvent, item: Carried) {
    if (event.button !== 0) return;
    cancelDrag.current?.();
    suppressClick.current = false;
    const x0 = event.clientX;
    const y0 = event.clientY;
    const pointer = event.pointerId;
    const touch = event.pointerType === "touch";
    let ready = !touch;
    let hold: number | undefined;
    let started = false;
    let target: Destination | null = null;
    const end = () => {
      window.clearTimeout(hold);
      window.removeEventListener("touchmove", preventScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", end);
      cancelDrag.current = null;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setCarried(null);
      setDestination(null);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!ready) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) >= 6) end();
        return;
      }
      if (!started && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
      e.preventDefault();
      if (!started) {
        started = true;
        suppressClick.current = true;
        setCarried(item);
      }
      // The dial keeps its own scheduling gesture; filing never starts a plan.
      if (
        item.kind === "task" &&
        !touch &&
        e.clientX > (root.current?.getBoundingClientRect().right ?? Infinity) + 12 &&
        !tasks.find((task) => task.id === item.id)?.done
      ) {
        end();
        actions.dragTask(item.id);
        return;
      }
      const scroller = root.current?.parentElement;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const step = e.clientY < box.top + 36 ? -14 : e.clientY > box.bottom - 36 ? 14 : 0;
        if (step) scroller.scrollTop += step;
      }
      target = targetAt(item, e.clientX, e.clientY);
      setDestination((old) =>
        old?.key === target?.key && old?.edge === target?.edge ? old : target,
      );
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (started) target = targetAt(item, e.clientX, e.clientY);
      end();
      if (started && target) commitMove(item, target);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      end();
    };
    // A swipe scrolls normally; only movement after a hold belongs to the row.
    const preventScroll = (e: TouchEvent) => {
      if (ready) e.preventDefault();
    };
    if (touch) {
      hold = window.setTimeout(() => {
        ready = true;
        started = true;
        suppressClick.current = true;
        setCarried(item);
      }, 300);
      window.addEventListener("touchmove", preventScroll, { passive: false });
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", end);
    cancelDrag.current = end;
  }

  function reorderKey(event: React.KeyboardEvent, item: Carried) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const parent =
      item.kind === "task"
        ? (tasks.find((task) => task.id === item.id)?.listId ?? "")
        : (taskLists.find((list) => list.id === item.id)?.parentId ?? "");
    const rows =
      item.kind === "task"
        ? (byList.get(known.has(parent) ? parent : "") ?? [])
        : tree.filter(({ list }) => list.parentId === parent).map(({ list }) => list);
    const index = rows.findIndex((row) => row.id === item.id);
    const next = index + (event.key === "ArrowUp" ? -1 : 1);
    if (next < 0 || next >= rows.length) return;
    commitMove(item, {
      listId: known.has(parent) ? parent : "",
      beforeId: rows[event.key === "ArrowUp" ? next : next + 1]?.id,
      key: item.id,
      edge: "before",
    });
  }

  function dropStyle(key: string) {
    return (
      destination?.key === key &&
      (destination.edge === "inside"
        ? "bg-surface-2 ring-1 ring-ink-3"
        : destination.edge === "before"
          ? "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-ink-2"
          : "after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-ink-2")
    );
  }

  function taskRow(task: Task, manual: boolean) {
    return (
      <div
        key={task.id}
        data-task-drop={task.id}
        onPointerDown={(event) => beginDrag(event, { kind: "task", id: task.id })}
        onContextMenu={(event) => event.preventDefault()}
        className={cn(
          "group/task relative flex min-w-0 items-center gap-0.5 rounded-[7px] select-none",
          dropStyle(task.id),
          carried?.id === task.id && "opacity-40",
        )}
      >
        <IconButton
          label={task.done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          aria-pressed={task.done}
          onClick={() => actions.toggleTask(task.id)}
          className="size-6"
        >
          <span
            className="size-[9px] rounded-full"
            style={
              task.done
                ? { border: `1.5px solid ${colorOf(task, calendars)}` }
                : { backgroundColor: colorOf(task, calendars) }
            }
          />
        </IconButton>
        <ActionPill
          label={`Edit task ${task.title}`}
          onClick={() => actions.editTask(task.id)}
          onKeyDown={
            manual ? (event) => reorderKey(event, { kind: "task", id: task.id }) : undefined
          }
          aria-description="Drag this row to reorder or move to a list. On touch, hold before dragging. Arrow keys reorder within a list."
          className="h-9 min-w-0 flex-1 cursor-grab px-1 text-left active:cursor-grabbing"
          icon={
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1 text-[12.5px]",
                  task.done ? "text-ink-3 line-through" : "text-ink",
                )}
              >
                <span className="truncate">{task.title || "Untitled"}</span>
                {!task.done && !unplanned(task) && (
                  <span
                    aria-label="Already planned"
                    className="ml-auto size-[5px] shrink-0 rounded-full bg-ink-3"
                  />
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-[10px] text-ink-2">
                <span className="truncate">
                  {formatRelativeDay(new Date(task.due), now)}
                  {!task.dueAllDay && ` ${formatTimeShort(new Date(task.due), clock)}`}
                  {task.estimate !== null && ` · ${formatDuration(task.estimate)}`}
                </span>
                <CalendarMark
                  icon={markOf(task, calendars, true)}
                  color={colorOf(task, calendars)}
                  size={10}
                />
              </span>
            </span>
          }
        />
        {task.plans.length > 0 && (
          <IconButton
            label={`Unschedule ${task.title || "Untitled"}`}
            onClick={() => store.updateTask(task.id, { plans: [] })}
            className="size-6 opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <CalendarMinus size={12} strokeWidth={1.75} />
          </IconButton>
        )}
        {!task.done && (
          <IconButton
            label={`Schedule ${task.title || "Untitled"}`}
            onClick={() => actions.scheduleTask(task.id)}
            className="size-6 opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <CalendarPlus size={12} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>
    );
  }

  function listTasks(id: string) {
    const rows = byList.get(id) ?? [];
    const pending = rows.filter((task) => !task.done);
    const done = rows.filter((task) => task.done);
    return (
      <div className="ml-2 border-l border-hairline pl-1">
        {pending.map((task) => taskRow(task, true))}
        {done.length > 0 && (
          <>
            <ActionPill
              label={`Completed tasks in ${taskLists.find((list) => list.id === id)?.name ?? "Unlisted"}`}
              aria-expanded={collapsed[`done:${id}`] === false}
              onClick={() =>
                setCollapsed((value) => ({
                  ...value,
                  [`done:${id}`]: !(value[`done:${id}`] ?? true),
                }))
              }
              className="text-[11px]"
              icon={
                <>
                  <ChevronRight
                    size={11}
                    className={cn(collapsed[`done:${id}`] === false && "rotate-90")}
                  />
                  Done {done.length}
                </>
              }
            />
            {collapsed[`done:${id}`] === false && done.map((task) => taskRow(task, true))}
          </>
        )}
        <ActionPill
          label={`New task in ${taskLists.find((list) => list.id === id)?.name ?? "Unlisted"}`}
          onClick={() => actions.newTaskInList(id)}
          className="text-[11px]"
          icon={
            <>
              <Plus size={11} />
              Add task
            </>
          }
        />
      </div>
    );
  }

  return (
    <section
      ref={root}
      aria-label="Tasks"
      className="flex w-full shrink-0 flex-col gap-1"
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <div className="flex items-center justify-between">
        <span className="label text-ink-2">Tasks</span>
        <div className="flex items-center">
          <IconButton label="Fill free time" onClick={actions.fillFreeTime} className="size-6">
            <Sparkles size={12} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="New task list"
            onClick={() => actions.newTaskList()}
            className="size-6"
          >
            <FolderPlus size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="New task"
            onClick={() => actions.newTaskInList(active ?? "")}
            className="size-6"
          >
            <Plus size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>
      <div className="flex gap-1">
        <ActionPill
          label="All tasks"
          icon={<span>All tasks</span>}
          aria-pressed={active === null}
          onClick={() => setSelected(null)}
          className={cn("text-[12px]", active === null && "bg-surface-2 text-ink")}
        />
        <ActionPill
          data-list-drop=""
          label="Unlisted tasks"
          icon={<span>Unlisted</span>}
          aria-pressed={active === ""}
          onClick={() => setSelected("")}
          className={cn(
            "relative text-[12px]",
            active === "" && "bg-surface-2 text-ink",
            carried?.kind === "task" && dropStyle("list:"),
          )}
        />
      </div>
      {visibleTree.map(({ list, depth }) => {
        const open = active !== null && expanded[list.id];
        const count = (byList.get(list.id) ?? []).filter((task) => !task.done).length;
        return (
          <div key={list.id} className="min-w-0" style={{ marginLeft: Math.min(depth, 3) * 8 }}>
            <div
              data-list-drop={list.id}
              onPointerDown={(event) => beginDrag(event, { kind: "list", id: list.id })}
              onContextMenu={(event) => event.preventDefault()}
              className={cn(
                "group/list relative flex min-w-0 flex-wrap items-center rounded-[7px] select-none",
                dropStyle(`list:${list.id}`),
                carried?.id === list.id && "opacity-40",
              )}
            >
              <ActionPill
                label={`Show ${list.name}`}
                aria-expanded={!!open}
                onKeyDown={(event) => reorderKey(event, { kind: "list", id: list.id })}
                aria-description="Drag between lists to reorder or onto a list to nest. On touch, hold before dragging. Arrow keys reorder."
                onClick={() => {
                  setSelected(list.id);
                  setExpanded((value) => ({ ...value, [list.id]: !open }));
                }}
                className={cn(
                  "min-w-0 flex-1 cursor-grab px-1 text-left text-[12.5px] active:cursor-grabbing",
                  active === list.id && "bg-surface-2 text-ink",
                )}
                icon={
                  <>
                    <ChevronRight size={11} className={cn("shrink-0", open && "rotate-90")} />
                    <CalendarMark
                      icon={list.icon ?? ""}
                      color={list.color ?? PALETTE[0]}
                      size={13}
                    />
                    <span className="truncate">{list.name}</span>
                    <span className="ml-auto text-[10px] text-ink-2">{count || ""}</span>
                  </>
                }
              />
              <div
                className={cn(
                  "flex pointer-coarse:w-full pointer-coarse:justify-end",
                  !open && "pointer-coarse:hidden",
                )}
              >
                <IconButton
                  label={`New sublist in ${list.name}`}
                  onClick={() => actions.newTaskList(list.id)}
                  className="size-6 opacity-0 group-focus-within/list:opacity-100 group-hover/list:opacity-100 pointer-coarse:opacity-100"
                >
                  <Plus size={12} strokeWidth={1.75} />
                </IconButton>
                <IconButton
                  label={`Edit list ${list.name}`}
                  onClick={() => actions.editTaskList(list.id)}
                  className="size-6 opacity-0 group-focus-within/list:opacity-100 group-hover/list:opacity-100 pointer-coarse:opacity-100"
                >
                  <Pencil size={12} strokeWidth={1.75} />
                </IconButton>
              </div>
            </div>
            {open && listTasks(list.id)}
          </div>
        );
      })}
      {active === "" && listTasks("")}
      {active === null && (
        <div className="mt-2 border-t border-hairline pt-2">
          {groups.map((group) => (
            <div key={group.id}>
              <ActionPill
                label={group.title}
                aria-expanded={!collapsed[group.id]}
                onClick={() =>
                  setCollapsed((value) => ({ ...value, [group.id]: !value[group.id] }))
                }
                className="h-6 text-[11px]"
                icon={
                  <>
                    <ChevronRight size={11} className={cn(!collapsed[group.id] && "rotate-90")} />
                    {group.title} <span className="text-ink-3">{group.rows.length}</span>
                  </>
                }
              />
              {!collapsed[group.id] && group.rows.map((task) => taskRow(task, false))}
            </div>
          ))}
          {groups.length === 0 && <span className="caption px-1">Nothing due</span>}
        </div>
      )}
    </section>
  );
}
