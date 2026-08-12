/* ------------------------------------------------------------------ *
 * What a calendar or an event looks like when it is named.
 *
 * Colour was the only category encoding this app had, and colour runs
 * out: ten pastels, two of which have to share a rim without being
 * confused, and no way to say what a thing is *for*. A mark says that
 * in one glyph and costs no radius.
 *
 * Two vocabularies, one field. A mark is either one of the names in
 * `marks.ts` or a literal emoji, told apart by their own alphabet — see
 * `isIconName` in `lib/events.ts`, which owns the format because the
 * field is stored. `""` is the plain colour dot on a calendar and
 * "follow the calendar" on an event; a name this build does not carry
 * falls back to the same, because a set that shrinks must not blank a
 * calendar.
 *
 * **Why not every Phosphor icon.** Measured, not assumed: all 1,512
 * bold paths are 621 KB raw and 206 KB gzipped — more than the entire
 * rest of the application, for a picker. These 247 are 118 KB and 43,
 * they are the fifth of the library a calendar ever wants, and the
 * emoji field covers the long tail at zero bytes and in colour. If the
 * set ever has to be complete, the only honest shape is a lazily
 * imported chunk *plus* an eager core — because a mark has to render
 * on the first frame of a cold load, and a dot that pops into an icon
 * half a second later is worse than a smaller set.
 *
 * **The paths are vendored, and they live in `marks.ts`.**
 * `@phosphor-icons/react` ships every icon as a component carrying all
 * six weights inline, so even a curated set costs four times its own
 * weight in `dist/`. Bold only, as data, is the whole library's worth
 * of choice at none of the price — and as its own module, because it is
 * a quarter of the bundle and this file is the half of the pair that has
 * to render on the first frame.
 *
 * Two icon vocabularies in one repo is not two conventions: lucide is
 * the *chrome's* voice at 14–15px and stroke 1.75, and nothing here may
 * use it. This set is the *user's*, and the user picked Phosphor.
 * ------------------------------------------------------------------ */

import { useState } from "react";
import { ICON_MAX, firstGrapheme, isIconName } from "@/lib/events";
import { cn } from "@/lib/utils";
import { MARK_PATHS } from "./marks";

/** Picker order, and the only list anything outside this file iterates. */
export const CALENDAR_ICONS = Object.keys(MARK_PATHS);

/** Phosphor draws on a 256-unit square; every path in `marks.ts` assumes it. */
const VIEW_BOX = "0 0 256 256";

/** Whether this build can actually draw a mark — the picker's search asks,
 *  so it does not offer a name the renderer would fall back on. */
export function hasIcon(icon: string): boolean {
  return isIconName(icon) && icon in MARK_PATHS;
}

/**
 * The same glyph, SVG-native and centred on the origin, for a caller that is
 * already inside an `<svg>` and has its own transform to apply — the dial's
 * arc label, which puts a mark before the name and has to rotate it radially.
 *
 * Separate from `CalendarMark` rather than a mode of it: that one answers with
 * a `<span>` for an emoji and a plain dot for nothing, and neither is legal or
 * wanted here. This one draws a name or an emoji and **nothing at all** for
 * `""` — an arc already carries its colour along its whole length, so the dot
 * that stands in for "no mark" elsewhere would be a second, smaller, redundant
 * one sitting on top of it.
 */
export function MarkGlyph({ icon, color, size }: { icon: string; color: string; size: number }) {
  const path = isIconName(icon) ? MARK_PATHS[icon] : undefined;
  if (path) {
    // 256 → `size`, about a centre the caller has already placed and turned.
    const scale = size / 256;
    return <path d={path} fill={color} transform={`scale(${scale}) translate(-128 -128)`} />;
  }
  if (icon && !isIconName(icon)) {
    // The emoji brings its own colour and its own metrics; `central` is the
    // same baseline the label's text uses, so the two sit on one line.
    return (
      <text fontSize={size} textAnchor="middle" dominantBaseline="central">
        {icon}
      </text>
    );
  }
  return null;
}

/**
 * A calendar or an event, as one glyph in its own colour.
 *
 * The dot it replaces is still the default *and* the fallback, so every
 * surface renders a mark the same way without asking whether there is one:
 * `<CalendarMark icon={…} color={…} />` answers a dot, an emoji or an icon
 * depending only on the value.
 *
 * `color` is deliberately whatever the caller resolved — `calendar.color`
 * where a calendar is named, `colorOf(event, calendars)` where an event is —
 * so on an event the shape and the colour can come from different places and
 * each still means one thing.
 */
export function CalendarMark({
  icon,
  color,
  size = 14,
  className,
}: {
  icon: string;
  color: string;
  size?: number;
  className?: string;
}) {
  const named = isIconName(icon);
  const path = named ? MARK_PATHS[icon] : undefined;
  if (path) {
    return (
      <svg
        aria-hidden
        viewBox={VIEW_BOX}
        width={size}
        height={size}
        fill={color}
        className={cn("shrink-0", className)}
      >
        <path d={path} />
      </svg>
    );
  }
  if (icon && !named) {
    return (
      <span
        aria-hidden
        className={cn("shrink-0 text-center leading-none", className)}
        // The emoji brings its own colour, so the only thing left to match is
        // the space an icon of the same size would have taken.
        style={{ fontSize: size, width: size, height: size }}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("shrink-0 rounded-full", className)}
      // Two thirds of an icon's box: a filled disc at an icon's full size
      // outweighs every glyph beside it in the same list.
      style={{ width: size * 0.64, height: size * 0.64, backgroundColor: color }}
    />
  );
}

/**
 * The mark, as three ways of saying the same thing: nothing, an emoji you
 * type, or one of the 247 glyphs. One row rather than a mode switch, because
 * they are alternatives and a mode would make you choose twice.
 *
 * Shared by the calendar card and the event editor, which is the whole reason
 * it lives here rather than in one of them — the two differ only in what
 * "nothing" means, and `noneLabel` is that difference. On a calendar it is a
 * plain colour dot; on an event it is "follow the calendar", which is the same
 * empty string standing for a different sentence.
 *
 * The grid scrolls at four rows: 247 swatches unrolled is a card taller than
 * the window. **No fade on it** — the fade elsewhere in the app hints that a
 * list continues, and here it dimmed the glyphs you were choosing between,
 * which is the one thing this control exists to let you see. A scroll bar's
 * worth of hint is not worth a row of unreadable icons, and the search box
 * above is the real answer to a list this long anyway.
 *
 * Search is a second way in, not a replacement for the grid: 247 names are
 * fast to scan when you know the shape and slow when you know the word, so a
 * query narrows the same grid rather than opening a second surface. It matches
 * on bare letters — hyphens in the name and spaces in the query both fall away
 * first — so "first aid", "firstaid" and "aid" all land on `first-aid`.
 * `fuzzyScore` is deliberately not used: it is tuned for the palette's command
 * titles, and its subsequence match ranks `bird` over `barbell` for "b", which
 * is the wrong answer for a name you are trying to recall exactly.
 */
export function MarkPicker({
  icon,
  color,
  noneLabel,
  onChange,
}: {
  icon: string;
  /** What the chosen glyph is drawn in — the calendar's colour, or the one the
   *  event has resolved to. The unchosen ones stay grey; a grid of 247 in the
   *  event's colour is a swatch book, not a picker. */
  color: string;
  /** What `""` means here. */
  noneLabel: string;
  onChange: (icon: string) => void;
}) {
  const emoji = icon !== "" && !isIconName(icon);
  const [query, setQuery] = useState("");
  const bare = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const wanted = bare(query);
  const shown =
    wanted === "" ? CALENDAR_ICONS : CALENDAR_ICONS.filter((n) => bare(n).includes(wanted));
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 py-1.5">
      <div className="flex items-center gap-2">
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
        {/* A divider, so "nothing" and "an emoji" read as two different kinds
            of answer from the grid of glyphs under them. */}
        <span aria-hidden className="h-4 w-px bg-white/15" />
        <input
          value={emoji ? icon : ""}
          onChange={(e) => onChange(firstGrapheme(e.target.value))}
          placeholder="Emoji"
          aria-label="Emoji mark"
          maxLength={ICON_MAX}
          className={cn(
            "h-[26px] w-[72px] min-w-0 shrink-0 rounded-[7px] bg-surface-2 px-2 text-[13px] text-ink outline-none placeholder:text-ink-3",
            emoji && "ring-1 ring-ink/40",
          )}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search marks"
          className="h-[26px] min-w-0 flex-1 rounded-[7px] bg-surface-2 px-2 text-[13px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      <div className="no-scrollbar grid max-h-[108px] grid-cols-8 gap-1 overflow-y-auto">
        {shown.length === 0 ? (
          <span className="label col-span-8 py-2 text-ink-4">
            No mark called that — try an emoji
          </span>
        ) : (
          shown.map((name) => (
            <button
              key={name}
              type="button"
              aria-label={name.replace(/-/g, " ")}
              aria-pressed={icon === name}
              title={name.replace(/-/g, " ")}
              onClick={() => onChange(name)}
              className={cn(
                "grid size-[26px] place-items-center rounded-[7px] transition-colors hover:bg-white/8",
                icon === name && "bg-white/10",
              )}
            >
              <CalendarMark icon={name} color={icon === name ? color : "var(--ink-2)"} size={15} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
