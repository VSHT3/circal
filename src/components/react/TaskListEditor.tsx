import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { taskListDescendants, taskListTree } from "@/lib/tasks";
import { useFocusTrap } from "@/components/react/hooks";
import { ActionPill, FieldRow, Select, TextField } from "@/components/react/ui/primitives";
import type { TaskListEditorProps } from "@/components/react/types";

export default function TaskListEditor({
  target,
  taskLists,
  seedParentId,
  onSave,
  onDelete,
  onClose,
}: TaskListEditorProps) {
  const dialog = useFocusTrap<HTMLDivElement>(true);
  const reducedMotion = useReducedMotion();
  const [name, setName] = useState(target?.name ?? "");
  const [parentId, setParentId] = useState(target?.parentId ?? seedParentId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const excluded = target ? taskListDescendants(taskLists, target.id) : new Set<string>();
  const parents = taskListTree(taskLists).filter(({ list }) => !excluded.has(list.id));
  const validParent = parentId === "" || parents.some(({ list }) => list.id === parentId);

  function save() {
    if (!name.trim()) return;
    if (!onSave(name.trim(), parentId))
      setError("Choose an existing parent list, or keep this at the top level.");
  }

  useEffect(() => {
    dialog.current?.querySelector("input")?.focus();
  }, [dialog]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (confirming) setConfirming(false);
        else onClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !confirming) {
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    }
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });

  const destination = taskLists.find((list) => list.id === target?.parentId)?.name;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <motion.div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
      />
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={target ? "Edit task list" : "New task list"}
        className="relative flex max-h-[86vh] w-[330px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface"
        initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.18 }}
      >
        <div className="border-b border-hairline px-3.5 py-3 text-[19px] font-medium text-ink">
          {target ? "Edit task list" : "New task list"}
        </div>
        <FieldRow label="Name">
          <TextField
            label="List name"
            value={name}
            onChange={setName}
            placeholder="List name"
            onEnter={save}
            className="w-full"
          />
        </FieldRow>
        <FieldRow label="Parent" last>
          <Select
            label="Parent list"
            value={parentId}
            onChange={setParentId}
            options={[
              { value: "", label: "Top level" },
              ...(!validParent ? [{ value: parentId, label: "Choose a parent" }] : []),
              ...parents.map(({ list, depth }) => ({
                value: list.id,
                label: `${"› ".repeat(depth)}${list.name}`,
              })),
            ]}
          />
        </FieldRow>
        {error && (
          <p role="alert" className="caption px-3.5 py-2">
            {error}
          </p>
        )}
        {confirming ? (
          <div className="border-t border-hairline p-3">
            <p className="caption">
              {destination
                ? `Tasks and sublists move to ${destination}.`
                : "Tasks become unlisted. Sublists move to the top level."}{" "}
              Nothing inside is deleted.
            </p>
            <div className="mt-3 flex justify-between">
              <ActionPill
                label="Cancel deletion"
                icon={<span>Cancel</span>}
                onClick={() => setConfirming(false)}
              />
              <ActionPill
                label="Delete list"
                icon={<span>Delete list</span>}
                className="text-danger"
                onClick={onDelete}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1 border-t border-hairline p-3">
            {target && (
              <ActionPill
                label="Delete list"
                icon={<span>Delete</span>}
                className="text-danger"
                onClick={() => setConfirming(true)}
              />
            )}
            <ActionPill
              label="Cancel"
              icon={<span>Cancel</span>}
              className="ml-auto"
              onClick={onClose}
            />
            <ActionPill
              label={target ? "Save list" : "Create list"}
              icon={<span>{target ? "Save" : "Create"}</span>}
              className="bg-surface-2 text-ink disabled:opacity-40"
              disabled={!name.trim() || !validParent}
              onClick={save}
            />
          </div>
        )}
      </motion.div>
    </div>
  );
}
