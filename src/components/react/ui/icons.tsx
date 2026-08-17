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
 * **Why the path table is a lazy chunk, and how a mark still draws on
 * the first frame.** All 247 `bold` paths are 118 KB raw / 43 gzipped —
 * a quarter of the whole bundle, and it used to ride the critical path
 * because `Dial`, `Face` and `Sidebar` each draw a calendar's mark on
 * the very first painted frame. Loading the whole table lazily and
 * letting a mark pop in half a second late reads as a rendering fault,
 * so instead this module keeps a small path cache in `localStorage`
 * (`circal.marks`, its own key, the way `circal.intro` and
 * `circal.feed.<id>` sit outside the main blob). The cache is read
 * **synchronously at module load**, so a mark the user has already
 * chosen draws correctly on the first frame with no chunk fetched at
 * all — a handful of path strings is a few kilobytes against 118 KB.
 * The full `marks.ts` table is imported lazily only when a mark's path
 * is not cached, which in practice is the picker opening or a backup
 * restored into a fresh browser.
 *
 * **Why not every Phosphor icon.** Measured, not assumed: all 1,512
 * bold paths are 621 KB raw and 206 KB gzipped — more than the entire
 * rest of the application, for a picker. These 247 are 118 KB and 43,
 * they are the fifth of the library a calendar ever wants, and the
 * emoji field covers the long tail at zero bytes and in colour.
 *
 * **The paths are vendored, and they live in `marks.ts`.**
 * `@phosphor-icons/react` ships every icon as a component carrying all
 * six weights inline, so even a curated set costs four times its own
 * weight in `dist/`. Bold only, as data, is the whole library's worth
 * of choice at none of the price — and as its own module, because it is
 * a quarter of the bundle and the only thing that must load lazily.
 *
 * Two icon vocabularies in one repo is not two conventions: lucide is
 * the *chrome's* voice at 14–15px and stroke 1.75, and nothing here may
 * use it. This set is the *user's*, and the user picked Phosphor.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { isIconName } from "@/lib/events";
import { cn } from "@/lib/utils";

/** Phosphor draws on a 256-unit square; every path in `marks.ts` assumes it. */
const VIEW_BOX = "0 0 256 256";

/* ----------------------------- the path cache ----------------------------- */

/**
 * name → path string, for the marks this browser has actually seen. Seeded
 * synchronously from `localStorage` below, so a mark the user picked before
 * draws on the first frame without the lazy table being fetched at all.
 */
const cache = new Map<string, string>();

/** `localStorage`, or `null` where there is none — SSR, and a browser that
 *  refuses the API outright rather than throwing on use. Same guard `store.ts`
 *  keeps for the feed keys. */
function disk(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** Its own key, outside the `circal.v1` blob — a few path strings that are a
 *  render-time cache, not part of the user's data and never exported. */
const CACHE_KEY = "circal.marks";

// Synchronous seed at module load. A corrupt payload is a cache miss the lazy
// table refills, so it stays silent — same reasoning as `store.readFeeds`.
try {
  const raw = disk()?.getItem(CACHE_KEY);
  if (raw) {
    const stored = JSON.parse(raw) as Record<string, string>;
    for (const [name, path] of Object.entries(stored)) {
      if (typeof path === "string") cache.set(name, path);
    }
  }
} catch {
  cache.clear();
}

function persist() {
  try {
    disk()?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Nothing lost: the worst case is the lazy chunk fetched again next boot.
  }
}

/* --------------------------- the "loaded" signal -------------------------- */

/**
 * A mark drawn from a cache miss shows the fallback dot, then must repaint the
 * moment the lazy table fills its path in. `useSyncExternalStore` over a bump
 * counter is that repaint: every renderer that missed subscribes, and one
 * `bump()` when the chunk lands re-runs them all.
 */
let version = 0;
const listeners = new Set<() => void>();
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function bump() {
  version += 1;
  for (const fn of listeners) fn();
}

/** The full-table import, kicked off at most once. The chunk fills the cache,
 *  persists it and bumps the signal so everything that fell back repaints. */
let loading: Promise<Record<string, string>> | null = null;
function ensureMarks(): Promise<Record<string, string>> {
  if (loading) return loading;
  loading = import("./marks").then((mod) => {
    let added = false;
    for (const [name, path] of Object.entries(mod.MARK_PATHS)) {
      if (!cache.has(name)) {
        cache.set(name, path);
        added = true;
      }
    }
    if (added) {
      persist();
      bump();
    }
    return mod.MARK_PATHS;
  });
  return loading;
}

/**
 * The path for `name`, or `undefined` while it is still being fetched.
 *
 * A cached name answers immediately, on the first frame, with no chunk loaded.
 * A miss on a real icon name (not an emoji, not `""`) kicks the lazy table off
 * and subscribes to the signal, so the component repaints from the fallback to
 * the glyph the one time that ever happens per browser.
 */
function useMarkPath(name: string): string | undefined {
  // Reading `version` is what makes the subscription live — the snapshot must
  // change when the table lands or React will not re-run the component.
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  const cached = cache.get(name);
  if (cached === undefined && name !== "" && isIconName(name)) {
    // Only fires while the path is genuinely absent; `ensureMarks` is idempotent
    // and `""` / emojis never need a path, so neither triggers a fetch.
    void ensureMarks();
  }
  return cached;
}

/**
 * The whole table, for the one caller that needs all of it: the picker. It
 * loads the lazy chunk, caches every path (so a mark chosen there draws on the
 * first frame after a reload) and returns the paths keyed in picker order.
 * `undefined` until the chunk arrives.
 */
export function useAllMarks(): Record<string, string> | undefined {
  return useSyncExternalStore(
    subscribe,
    () => loadedTable(),
    () => undefined,
  );
}

/** The full table once loaded, else `undefined`. Kicks the import off on first
 *  ask; the return is reference-stable so `useSyncExternalStore` does not loop. */
let table: Record<string, string> | undefined;
function loadedTable(): Record<string, string> | undefined {
  if (table) return table;
  void ensureMarks().then((paths) => {
    table = paths;
    bump();
  });
  return undefined;
}

/* ------------------------------- renderers -------------------------------- */

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
  const path = useMarkPath(icon);
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
  // `""`, and an icon name whose path is not cached yet: nothing. On an arc a
  // missing mark is invisible — the stroke already carries the colour — so the
  // one-per-browser lazy fill (a backup into a fresh browser) shows no dot to
  // pop out of, it simply gains the glyph when the chunk lands.
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
 *
 * The one case this cannot cover on the first frame: a backup restored into a
 * fresh browser has the mark *name* but no cached path, so it draws the plain
 * dot — the same fallback an unknown name has always drawn — and fills in the
 * glyph once the lazy table arrives. It happens once per browser per restore.
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
  // Called unconditionally — `useMarkPath` returns `undefined` for an emoji or
  // `""` and fetches nothing, so the hook is safe to run on every mark.
  const path = useMarkPath(icon);
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
