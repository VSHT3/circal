/* ------------------------------------------------------------------ *
 * The five controls the whole app is built from.
 *
 * Chrome in circal is deliberately monotonous: a 28px square for icons, a
 * pill for anything with a shortcut, one switch, one select. Nothing here
 * carries colour — colour belongs to events.
 * ------------------------------------------------------------------ */

import { ChevronsUpDown } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A keyboard chip. Renders the glyph, never the word ("⌘", not "Cmd"). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({ label, active, className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[7px] transition-colors",
        "text-ink-2 hover:bg-white/8 hover:text-ink",
        active && "bg-white/10 text-ink",
        "disabled:pointer-events-none disabled:opacity-35",
        className,
      )}
      {...props}
    />
  );
}

/** Icon + shortcut, in a pill. The top bar's vocabulary for a named action. */
export function ActionPill({
  icon,
  keys,
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  keys?: string[];
  label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-[8px] px-1.5 transition-colors",
        "text-ink-2 hover:bg-white/6 hover:text-ink",
        className,
      )}
      {...props}
    >
      {icon}
      {keys?.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </button>
  );
}

/** Two-state segmented control. `value` is the id of the active segment. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { id: T; label: string; keys?: string[] }[];
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-[9px] bg-white/5 p-0.5">
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.id)}
            className={cn(
              "label flex h-6 items-center gap-1.5 rounded-[7px] px-2 transition-colors",
              on ? "bg-ink text-void" : "text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
            {!on && option.keys?.map((k) => <Kbd key={k}>{k}</Kbd>)}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "bg-surface-2",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-4 rounded-full transition-[left]",
          checked ? "left-[19px] bg-void" : "left-[3px] bg-ink",
        )}
      />
    </button>
  );
}

/**
 * A native `<select>` under a styled face. Hand-rolled listboxes lose
 * type-ahead, mobile wheels and screen-reader semantics; this keeps all three
 * and still renders as a value plus the app's chevron button.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("group relative flex min-w-0 items-center gap-2", className)}>
      <span className="truncate">{options.find((o) => o.value === value)?.label ?? value}</span>
      <span
        aria-hidden
        className="grid size-[19px] shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 transition-colors group-hover:text-ink"
      >
        <ChevronsUpDown size={11} strokeWidth={2.5} />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
