import { LinkifyIt } from "linkify-it";
import { Check, Pencil } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { IconButton } from "@/components/react/ui/primitives";

const linkify = new LinkifyIt({ fuzzyLink: true }).add("ftp:", null).add("//", null);

export function NotesField({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(!value && !readOnly);
  const content = useMemo(() => {
    const parts: ReactNode[] = [];
    let end = 0;
    for (const match of linkify.match(value) ?? []) {
      parts.push(value.slice(end, match.index));
      parts.push(
        <a
          key={match.index}
          href={match.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ink-3 underline-offset-2 hover:decoration-ink focus-visible:outline focus-visible:outline-ink"
        >
          {match.text}
        </a>,
      );
      end = match.lastIndex;
    }
    parts.push(value.slice(end));
    return parts;
  }, [value]);

  return (
    <div className="w-full min-w-0">
      {!readOnly && (
        <div className="flex justify-end">
          <IconButton
            label={editing ? "Done editing notes" : "Edit notes"}
            onClick={() => setEditing(!editing)}
          >
            {editing ? (
              <Check size={14} strokeWidth={1.75} />
            ) : (
              <Pencil size={14} strokeWidth={1.75} />
            )}
          </IconButton>
        </div>
      )}
      {editing ? (
        <textarea
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Add notes"
          aria-label="Notes"
          className="[field-sizing:content] min-h-[68px] w-full resize-none border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-3"
        />
      ) : (
        <div className="min-h-[68px] text-[13.5px] [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
          {value ? content : <span className="text-ink-3">No notes</span>}
        </div>
      )}
    </div>
  );
}
