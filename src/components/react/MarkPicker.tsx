/* ------------------------------------------------------------------ *
 * Choosing a mark, at two sizes.
 *
 * The row is the control: nothing, an emoji you type, or one of the 247
 * glyphs, side by side rather than behind a mode switch, because they
 * are alternatives and a mode would make you choose twice. Shared by
 * the calendar card and the event editor, which differ only in what
 * `""` means — `noneLabel` is that difference. On a calendar it is a
 * plain colour dot; on an event it is "follow the calendar", the same
 * empty string standing for a different sentence.
 *
 * The compact grid scrolls at four rows of eight. That is enough to
 * pick a shape you already have in mind, and far too little to *look*
 * at a set of 247 — the modal it sits in is 330px wide, so the grid is
 * a 26px porthole onto thirty-one rows. Hence the fullscreen twin: the
 * same controls over a grid that fits every mark on one screen at
 * nearly twice the size, which is the only way the choice is actually
 * on offer. One query serves both, so narrowing the list large and
 * closing leaves the small grid narrowed the same way.
 *
 * **No fade on either grid.** A fade hints that a list continues and
 * pays for the hint by dimming its own last row: a good trade over
 * prose or an agenda, a bad one over a grid of glyphs, where the dimmed
 * row is exactly what you were comparing. Search is the real answer to
 * a list this long.
 *
 * Not in `ui/icons.tsx` beside the renderer it draws through: a picker
 * is chrome, so it speaks lucide and reaches for `primitives.tsx` and
 * `useFocusTrap`, and that file may use none of the three — it is the
 * *user's* vocabulary, 247 Phosphor paths and the thing that draws
 * them, and the whole point of keeping the two apart.
 * ------------------------------------------------------------------ */

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { Maximize2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/components/react/hooks";
import { IconButton } from "@/components/react/ui/primitives";
import { CalendarMark, useAllMarks } from "@/components/react/ui/icons";

/**
 * Search is a second way in, not a replacement for the grid: 247 names are
 * fast to scan when you know the shape and slow when you know the word, so a
 * query narrows the same grid rather than opening a second surface.
 *
 * Matched on bare letters — hyphens in the name and spaces in the query both
 * fall away first — so "first aid", "firstaid" and "aid" all land on
 * `first-aid`. `fuzzyScore` is deliberately not used: it is tuned for the
 * palette's command titles, and its subsequence match ranks `bird` over
 * `barbell` for "b", which is the wrong answer for a name you are trying to
 * recall exactly.
 */
function bare(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function matching(query: string, names: string[]): string[] {
  const wanted = bare(query);
  return wanted === "" ? names : names.filter((n) => bare(n).includes(wanted));
}

/** The name, said rather than keyed. */
function spoken(name: string): string {
  return name.replace(/-/g, " ");
}

/** What both surfaces need to ask the question and answer it. */
interface MarkFieldsProps {
  icon: string;
  /** What the chosen glyph is drawn in — the calendar's colour, or the one the
   *  event has resolved to. The unchosen ones stay grey; a grid of 247 in the
   *  event's colour is a swatch book, not a picker. */
  color: string;
  /** What `""` means here. */
  noneLabel: string;
  query: string;
  onQuery: (query: string) => void;
  onChange: (icon: string) => void;
}

/**
 * "Nothing" and "which word" — one row, identical on both surfaces. The
 * fullscreen one deliberately does not grow these: it is the grid that was too
 * small, and a picker whose fields change size between its two sizes is two
 * controls.
 *
 * There was a third field, an emoji box, and it is gone. An emoji belongs in
 * the event's own title, where it is searchable, travels through `.ics` and
 * costs the mark vocabulary nothing — a second way to say the same thing, in a
 * field 72px wide, is not worth the row. The *format* is untouched:
 * `CalendarMark` still renders an emoji `icon`, and `isIconName` still tells
 * the two apart, so a value that arrived in a backup or from an older build
 * keeps drawing. Only the way to type a new one is withdrawn.
 *
 * The 26px cell is this column's rhythm, and `ColorPicker`'s swatch is the
 * same 26 for exactly that reason: the two rows sit one above the other in the
 * card's right-hand column, so their dividers land on the same x or the column
 * reads as ragged.
 */
function MarkFields({
  icon,
  color,
  noneLabel,
  query,
  onQuery,
  onChange,
  autoFocus,
}: MarkFieldsProps & { autoFocus?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        aria-label={noneLabel}
        aria-pressed={icon === ""}
        title={noneLabel}
        onClick={() => onChange("")}
        className={cn(
          "grid size-[26px] shrink-0 place-items-center rounded-[7px] transition-colors hover:bg-white/8",
          icon === "" && "bg-white/10",
        )}
      >
        <CalendarMark icon="" color={color} size={14} />
      </button>
      {/* A divider, so "nothing" reads as a different kind of answer from the
          grid of glyphs under it. */}
      <span aria-hidden className="h-4 w-px bg-white/15" />
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search"
        aria-label="Search marks"
        className="h-[26px] min-w-0 flex-1 rounded-[7px] bg-surface-2 px-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}

/** One glyph, offered. `className` is the cell — 26px in the row's own grid,
 *  a square of whatever the fullscreen columns come out at in the other.
 *  `data-mark` is how the grid it sits in reads the name back out: one handler
 *  on the container rather than a pair of callbacks on 247 cells. */
function MarkCell({
  name,
  color,
  selected,
  size,
  className,
  onPick,
}: {
  name: string;
  color: string;
  selected: boolean;
  size: number;
  className: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={spoken(name)}
      aria-pressed={selected}
      /* No `title`: the grid draws its own bubble, and the platform's tooltip
         would answer the same question a second time, later, in another voice.
         `aria-label` is what a screen reader reads either way. */
      data-mark={name}
      onClick={onPick}
      className={cn(
        "grid place-items-center rounded-[7px] transition-colors hover:bg-white/8",
        selected && "bg-white/10",
        className,
      )}
    >
      <CalendarMark icon={name} color={selected ? color : "var(--ink-2)"} size={size} />
    </button>
  );
}

/** What the grid says when the query names nothing. It points at the set
 *  rather than at a field: the emoji box that used to be the long tail's
 *  answer is gone, and the honest advice is now a different word. */
function NoMatch({ className }: { className: string }) {
  return <span className={cn("label text-ink-4", className)}>No mark called that</span>;
}

/** The bubble's own metrics. `.label` is 11px mono at 0.18em tracking, so a
 *  glyph advances ~8.6px and the bubble's width is arithmetic — the same trade
 *  `arcLabel` makes on the dial, and it keeps a hover off the layout path: no
 *  measured element, no second render, no read per cell crossed. */
const TIP_ADVANCE = 8.6;
const TIP_PAD = 18;
const TIP_HEIGHT = 26;
/** Between the bubble's tail and the cell, and between the bubble and the
 *  window's edge — the second one is what stops a long name being cropped by
 *  the leftmost column. */
const TIP_GAP = 7;
const TIP_EDGE = 8;

/** A cell, as the bubble over it needs to know it. */
interface TipAt {
  name: string;
  /** The cell's centre, which is what the tail points at. */
  cx: number;
  top: number;
  bottom: number;
  /** Under the cell rather than over it, for a top row that has no room. */
  below: boolean;
}

/**
 * The name of the mark under the pointer, in a bubble at the mark.
 *
 * At the cell rather than in a strip somewhere: a grid of 247 glyphs is read
 * with the pointer, so an answer printed anywhere else is a saccade away from
 * the thing it is about. It costs the neighbours it covers, which is the trade
 * every tooltip makes and the reason this one is small, `pointer-events-none`,
 * and gone the moment the pointer is.
 *
 * Portalled and `fixed` so it can hang past the grid it came from: that grid
 * scrolls, and the card around it is `overflow-hidden` for its own rounded
 * corners — either would crop a bubble drawn inside them.
 */
function MarkTip({ at }: { at: TipAt }) {
  const label = spoken(at.name);
  const half = (label.length * TIP_ADVANCE + TIP_PAD) / 2;
  // Clamped to the window, then the tail is offset by however far the clamp
  // moved it, so the bubble still points at the cell it is naming.
  const left = Math.min(Math.max(at.cx, TIP_EDGE + half), window.innerWidth - TIP_EDGE - half);
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[66] rounded-[9px] border border-hairline bg-surface px-2 py-1 shadow-[0_12px_28px_-12px_rgba(0,0,0,0.95)]"
      style={{
        left,
        top: at.below ? at.bottom + TIP_GAP : at.top - TIP_GAP,
        transform: at.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
    >
      <span className="label block whitespace-nowrap text-ink-2">{label}</span>
      <span
        className={cn(
          "absolute size-2 -translate-x-1/2 rotate-45 border-hairline bg-surface",
          at.below ? "-top-1 border-t border-l" : "-bottom-1 border-r border-b",
        )}
        style={{ left: `calc(50% + ${at.cx - left}px)` }}
      />
    </div>,
    document.body,
  );
}

/**
 * Which cell is being asked about, and the handlers a grid spreads to say so.
 *
 * One delegated listener on the container rather than a pair of callbacks on
 * 247 cells, reading the name back out of `data-mark`. The 4px between two
 * cells is deliberately **not** an answer: a name that blinked out crossing a
 * gap is worse than one that lags a cell, so only leaving the grid or losing
 * focus inside it clears the bubble — the same rule the life grid's loupe keeps
 * about the blanks between its years.
 *
 * A scroll **moves** the bubble rather than dropping it, which is why the cell
 * is held in a ref. Dropping it was the first version and it broke the
 * keyboard: focus landing on a cell above the fold scrolls the grid to show it,
 * so the first Tab named a mark and then unnamed it in the same beat.
 */
function usePeek() {
  const [at, setAt] = useState<TipAt | null>(null);
  /** The cell the bubble is about, so a scroll can re-measure it. */
  const cell = useRef<HTMLElement | null>(null);

  function place(box: HTMLElement, container: HTMLElement) {
    const name = box.dataset.mark;
    if (!name) return;
    const r = box.getBoundingClientRect();
    const grid = container.getBoundingClientRect();
    setAt({
      name,
      cx: r.left + r.width / 2,
      top: r.top,
      bottom: r.bottom,
      below: r.top - TIP_GAP - TIP_HEIGHT < grid.top,
    });
  }

  function peek(e: { target: EventTarget; currentTarget: HTMLElement }) {
    const found = (e.target as HTMLElement).closest?.("button[data-mark]");
    if (!(found instanceof HTMLElement)) return;
    cell.current = found;
    place(found, e.currentTarget);
  }

  function clear() {
    cell.current = null;
    setAt(null);
  }

  return {
    at,
    // Focus is in the list on purpose: tabbing the grid then names each mark in
    // the same place a pointer does.
    handlers: {
      onPointerOver: peek,
      onFocus: peek,
      onPointerLeave: clear,
      onBlur: clear,
      onScroll: (e: { currentTarget: HTMLElement }) => {
        const box = cell.current;
        if (box?.isConnected) place(box, e.currentTarget);
        else clear();
      },
    },
  };
}

/**
 * Every mark, at a size you can actually compare.
 *
 * A portal to `document.body`, not a child of the row: the card this picker
 * sits in is `overflow-hidden` and animates a transform on the way in, either
 * of which turns a `fixed` descendant into a clipped one, and it has to sit
 * above the modal that opened it rather than inside it.
 *
 * Picking closes. The grid covers the card whose field you were filling in, so
 * staying open would leave the answer hidden behind the question — and nothing
 * is committed here that Cancel on the card below will not still discard.
 *
 * **Escape belongs to the caller**, which is why `browsing` is its prop rather
 * than this file's state. Every modal in the app takes Escape on a `window`
 * *capture* listener, and capture listeners on one target fire in the order
 * they were added — so the editor's, added first, always wins, and a listener
 * here could only ever close the card behind as well. The layer that is on top
 * has to be visible to the layer that owns the key: the shell holds the life
 * grid's drawn run for exactly the same reason.
 */
function MarkBrowser({
  opener,
  onClose,
  ...fields
}: MarkFieldsProps & {
  /** The button that opened this, for focus to go back to. */
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const reducedMotion = useReducedMotion();

  /**
   * Hand focus back to the expand button, and do it *before* the trap's own
   * restore: that one remembers the last focus outside any `[role=dialog]`,
   * and this dialog was opened from inside another one, so its answer is a
   * control on the page behind the card. Declared above `useFocusTrap` so its
   * cleanup runs first — the trap then sees focus already moved deliberately
   * and abstains, which is its documented contract.
   */
  useEffect(
    () => () => {
      const back = opener.current;
      if (back?.isConnected) back.focus();
    },
    [opener],
  );
  const dialog = useFocusTrap<HTMLDivElement>(true);

  // The whole table, lazily. `undefined` while the chunk is in flight — the
  // grid renders empty (not "no match") until it arrives whole.
  const all = useAllMarks();
  const shown = matching(fields.query, all ? Object.keys(all) : []);

  const peeked = usePeek();

  return createPortal(
    <div className="fixed inset-0 z-[65] grid place-items-center p-3">
      <motion.div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        initial={reducedMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.18 }}
      />
      {/* A fixed height, not one that hugs its rows: the whole set at 46px is
          585px of grid, and a card that shrank to fit a narrowed search would
          jump a foot up the screen on the first keystroke. */}
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="All marks"
        className="relative flex h-[min(88vh,640px)] w-[min(96vw,1180px)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
        initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3.5 py-3">
          <span className="label shrink-0 text-ink-2">Mark</span>
          <MarkFields autoFocus {...fields} />
          {/* The count is the one thing this surface knows that the row does
              not: with a query it says how much of the set is left. */}
          <span className="caption shrink-0 tabular-nums">{shown.length}</span>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
        {/* Columns sized rather than counted: a phone gets six and a laptop
            gets all 247 in one screen, which is the whole reason this surface
            exists. 46px is what makes the last row land inside a 900px window
            — measured, not chosen, and still 1.8× the row's own 26. */}
        <div
          {...peeked.handlers}
          className="no-scrollbar grid flex-1 grid-cols-[repeat(auto-fill,minmax(46px,1fr))] content-start gap-1 overflow-y-auto p-3"
        >
          {all && shown.length === 0 ? (
            <NoMatch className="col-span-full py-2" />
          ) : (
            shown.map((name) => (
              <MarkCell
                key={name}
                name={name}
                color={fields.color}
                selected={fields.icon === name}
                size={26}
                className="aspect-square w-full"
                onPick={() => {
                  fields.onChange(name);
                  onClose();
                }}
              />
            ))
          )}
        </div>
        {peeked.at && <MarkTip at={peeked.at} />}
      </motion.div>
    </div>,
    document.body,
  );
}

/**
 * The mark, as three ways of saying the same thing — and a way to see all of
 * the third.
 */
export function MarkPicker({
  browsing,
  onBrowse,
  ...fields
}: MarkFieldsProps & {
  /** Whether the fullscreen grid is up. Owned by the caller, because the
   *  caller owns Escape — see `MarkBrowser`. */
  browsing: boolean;
  onBrowse: (browsing: boolean) => void;
}) {
  /** Read off the click rather than through a ref: the element is wanted only
   *  so focus can come back to it, and `currentTarget` already names it. */
  const opener = useRef<HTMLElement | null>(null);
  const all = useAllMarks();
  const shown = matching(fields.query, all ? Object.keys(all) : []);
  /** The same bubble as the fullscreen grid's, at 26px: one behaviour at both
   *  sizes, and it is portalled, so the card's own clipped edge is not its
   *  problem. */
  const peeked = usePeek();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2 py-1.5">
      <div className="flex items-center gap-2">
        <MarkFields {...fields} />
        {/* Hand-rolled at the row's own 26px rather than an `IconButton`,
            which is 28 and grows to 40 on a finger: in a row of 26px fields
            that would set the row's height from the one control that is not a
            field, and take the width out of the search box. It is a cell of
            this row, the same as the swatch at the other end of it. */}
        <button
          type="button"
          title="Browse all marks"
          aria-label="Browse all marks"
          onClick={(e) => {
            opener.current = e.currentTarget;
            onBrowse(true);
          }}
          className="grid size-[26px] shrink-0 place-items-center rounded-[7px] text-ink-2 transition-colors hover:bg-white/8 hover:text-ink"
        >
          <Maximize2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      {/* Cells fill their own track (`w-full aspect-square`) rather than being
          a fixed 26: eight fixed cells plus seven gaps is 236px against the
          220 this column has, so every track was 24 with a 26px cell spilling
          out of it and the last column's right edge sat 2px past the card's.
          A track-sized cell puts the grid's edges exactly on the column's,
          which is what lets the swatches above it share the same two edges.

          `basis-[108px]` and it grows: four rows is the porthole this is meant
          to be, and it is what the grid gets wherever nothing imposes a height
          — one column, and the fullscreen card. In the editor's two columns
          the shorter one is stretched to the taller, and the leftover used to
          sit under this row as a hole that looked like the mark section's own.
          It is the one thing in that column with something to do with the
          room, so it takes it and shows more of the set. */}
      <div
        {...peeked.handlers}
        className="no-scrollbar grid min-h-0 shrink grow basis-[108px] grid-cols-8 gap-1 overflow-y-auto"
      >
        {all && shown.length === 0 ? (
          <NoMatch className="col-span-8 py-2" />
        ) : (
          shown.map((name) => (
            <MarkCell
              key={name}
              name={name}
              color={fields.color}
              selected={fields.icon === name}
              size={15}
              className="aspect-square w-full"
              onPick={() => fields.onChange(name)}
            />
          ))
        )}
      </div>
      {peeked.at && !browsing && <MarkTip at={peeked.at} />}
      {browsing && <MarkBrowser {...fields} opener={opener} onClose={() => onBrowse(false)} />}
    </div>
  );
}
