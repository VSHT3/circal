/* ------------------------------------------------------------------ *
 * The controls the whole app is built from.
 *
 * Every piece of chrome in circal is one of these. Adding a seventh variant
 * of a button is how a product stops looking like one thing, so a new surface
 * composes what is here or the control moves in here first.
 *
 * The two field controls at the bottom are shared by the settings card and the
 * life view's prompt — the same date and the same number, asked for in two
 * places.
 * ------------------------------------------------------------------ */

import { ChevronsUpDown } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { PALETTE } from "@/lib/events";
import { cn } from "@/lib/utils";

/** A keyboard chip. Renders the glyph, never the word ("⌘", not "Cmd"). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/**
 * One `label / value` line inside a modal card. Shared by the event editor
 * and the settings panel, which is the whole reason it lives here: two modals
 * with two row grids is two products.
 */
export function FieldRow({
  label,
  children,
  last,
  disabled,
  align,
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
  disabled?: boolean;
  /** `top` for a row whose value is a stack rather than a single control. */
  align?: "center" | "top";
}) {
  return (
    <div
      className={cn(
        // The label column is a variable so a card with a long label can widen
        // it — `LIGHTCYCLE` overruns 76px — without moving every other card.
        "grid min-h-[38px] grid-cols-[var(--field-label,76px)_1fr] gap-2.5 px-3.5",
        align === "top" ? "items-start py-2.5" : "items-center",
        !last && "border-b border-hairline",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span className={cn("label text-ink-3", align === "top" && "pt-1.5")}>{label}</span>
      <div
        className={cn(
          "relative flex min-w-0 text-[14px] text-ink",
          align === "top" ? "flex-col items-stretch gap-2" : "items-center gap-2",
        )}
      >
        {children}
      </div>
    </div>
  );
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

/**
 * Icon + shortcut, in a pill. The top bar's vocabulary for a named action.
 *
 * The chips go at the same 900px `Segmented`'s do, and for the same reason:
 * they name a key nobody has on a window this narrow, and with them the bar's
 * two groups overflow a phone by 92px — which puts Settings off the edge of
 * the screen entirely.
 */
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
      <span className="hidden items-center gap-1.5 min-[900px]:flex">
        {keys?.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </button>
  );
}

/**
 * Segmented control. `value` is the id of the active segment.
 *
 * The shortcut chips are hidden below 900px: they cost 48px a segment and name
 * a key nobody has on the window sizes where the top bar is short of room.
 */
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
            {!on && option.keys && (
              <span className="hidden items-center gap-1.5 min-[900px]:flex">
                {option.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            )}
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
 * A `Switch` that says what it switches. The editor's rows carry their label
 * in the grid's left column, but settings that sit two or three to a row need
 * to name themselves — and a small one, because these annotate a control
 * that already has a `FieldRow` label above them.
 *
 * `name` overrides the accessible name where two rows use the same word:
 * "Daylight" appears twice in the settings card, once per place, and the
 * printed label leans on the row it sits in to say which. A screen reader
 * has no row to lean on.
 */
export function Toggle({
  label,
  name,
  checked,
  onChange,
}: {
  label: string;
  name?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <Switch checked={checked} onChange={onChange} label={name ?? label} />
      <span className={cn("label", checked ? "text-ink-2" : "text-ink-3")}>{label}</span>
    </span>
  );
}

/**
 * Nine places, as nine places. A dropdown reading "Top left … Bottom right"
 * makes you translate a word back into a corner; this is the corner. Buttons
 * rather than radios, because nine unlabelled cells that answer to the arrow
 * keys would also swallow the arrow keys the shell steps days with.
 */
export function PositionField<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  /** Exactly nine, row-major, each named for a screen reader. */
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid w-fit grid-cols-3 gap-[3px] rounded-[8px] bg-white/5 p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "size-[17px] rounded-[4px] transition-colors",
            value === option.value ? "bg-ink" : "bg-white/8 hover:bg-white/20",
          )}
        />
      ))}
    </div>
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

/**
 * Open the native date picker.
 *
 * A styled date row is a face with a transparent `input[type=date]` stretched
 * over it, and clicking the *field* of a date input opens nothing in Chrome or
 * Safari — only its calendar indicator does, which is the one part the input is
 * hiding. So the row's own click has to ask for the picker directly.
 *
 * Wrapped, because `showPicker` throws without a user gesture and does not
 * exist in every browser that renders the field. Either way the field stays
 * typeable and the arrow keys still step the date.
 */
export function openDatePicker(input: HTMLInputElement) {
  try {
    input.showPicker();
  } catch {
    /* no picker; the field itself still edits */
  }
}

/**
 * A date, as a value you can click. `children` is the printed face — a caller
 * with something better to say than the raw value (a relative day, an age)
 * passes it, and the invisible input covers whatever that turns out to be.
 */
export function DateField({
  value,
  onChange,
  label,
  min,
  max,
  className,
  children,
}: {
  /** `YYYY-MM-DD`, always — the native field speaks nothing else. */
  value: string;
  onChange: (next: string) => void;
  label: string;
  min?: string;
  max?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative flex h-8 min-w-0 items-center gap-2 rounded-[8px] bg-surface-2 px-2.5 text-[13px] text-ink",
        className,
      )}
    >
      {children ?? <span className="truncate tabular-nums">{value || "—"}</span>}
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => openDatePicker(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          openDatePicker(e.currentTarget);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </span>
  );
}

/**
 * A small integer with a unit after it. Committed on change and clamped on
 * blur rather than per keystroke: clamping while typing makes "8" jump to the
 * minimum before the "0" arrives.
 */
export function NumberField({
  value,
  onChange,
  label,
  suffix,
  min,
  max,
  className,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
  suffix?: string;
  min: number;
  max: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 text-[13px] text-ink",
        className,
      )}
    >
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value)))))}
        className="w-[3.5ch] [appearance:textfield] tabular-nums [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="label text-ink-3">{suffix}</span>}
    </span>
  );
}

/**
 * One swatch. A plain `<button>` for the presets, and for "custom" a hidden
 * `<input type="color">` filling the same circle — the OS picker is better
 * than anything hand-rolled and it is already keyboard- and screen-reader-
 * addressable.
 */
function Swatch({
  color,
  selected,
  label,
  onSelect,
  children,
}: {
  color: string;
  selected: boolean;
  label: string;
  onSelect?: () => void;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "relative grid size-[22px] place-items-center rounded-full transition-shadow",
        selected && "ring-2 ring-ink/70 ring-offset-2 ring-offset-[var(--surface)]",
      )}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        onClick={onSelect}
        className="size-[18px] rounded-full"
        style={{ background: color }}
      />
      {children}
    </span>
  );
}

/**
 * The ten presets and an any-colour picker.
 *
 * `fallback` is the inheritance case and it is optional, because only an event
 * inherits: `""` means "follow the calendar" and the extra swatch stands for
 * it. A calendar's own colour has nothing above it to fall back to, so the
 * swatch and its divider are simply absent there rather than present and
 * meaningless.
 */
export function ColorPicker({
  value,
  fallback,
  onChange,
}: {
  value: string;
  fallback?: string;
  onChange: (color: string) => void;
}) {
  const custom = value !== "" && !PALETTE.includes(value as (typeof PALETTE)[number]);
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {fallback !== undefined && (
        <>
          <Swatch
            color={fallback}
            selected={value === ""}
            label="Use the calendar's colour"
            onSelect={() => onChange("")}
          />
          {/* A divider, so "inherit the calendar" reads as a different kind of
              choice from the ten literal colours next to it. */}
          <span aria-hidden className="h-4 w-px bg-white/15" />
        </>
      )}
      {PALETTE.map((preset) => (
        <Swatch
          key={preset}
          color={preset}
          selected={value === preset}
          label={preset}
          onSelect={() => onChange(preset)}
        />
      ))}
      <Swatch
        color={custom ? value : "conic-gradient(#ff9fb4,#ffdf8c,#8bf0b8,#8ecbff,#c79bff,#ff9fb4)"}
        selected={custom}
        label="Custom colour"
      >
        <input
          type="color"
          aria-label="Custom colour"
          value={custom ? value : (fallback ?? PALETTE[0])}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </Swatch>
    </div>
  );
}
