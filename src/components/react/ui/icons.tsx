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
 * The eager core: the paths the seed itself names, inlined so a brand-new
 * visitor draws them on the very first frame. A cleared-cache boot has no
 * `circal.marks` to read, and the seed gives three default calendars
 * (`house`, `briefcase`, `users`) and two sample events (`person-simple-run`,
 * `suitcase-rolling`) a mark each — so without this, every first impression
 * the app makes is dots turning into glyphs, which is the one frame this whole
 * design exists to protect.
 *
 * This is the other half of the shape `AGENTS.md` prescribes — a lazy chunk
 * plus an eager core. It is deliberately *only* the seed's own marks and must
 * stay that: it mirrors `DEFAULT_CALENDARS` and `seed()` in `store.ts`, and it
 * is not a place for a creeping "popular icons" set that would grow back into
 * the 118 KB problem. The user's own chosen marks ride the `localStorage`
 * cache below; these five exist for the run before that cache is written.
 */
const SEED_MARKS: Record<string, string> = {
  house:
    "M222.14,105.85l-80-80a20,20,0,0,0-28.28,0l-80,80A19.86,19.86,0,0,0,28,120v96a12,12,0,0,0,12,12h64a12,12,0,0,0,12-12V164h24v52a12,12,0,0,0,12,12h64a12,12,0,0,0,12-12V120A19.86,19.86,0,0,0,222.14,105.85ZM204,204H164V152a12,12,0,0,0-12-12H104a12,12,0,0,0-12,12v52H52V121.65l76-76,76,76Z",
  briefcase:
    "M100,100a12,12,0,0,1,12-12h32a12,12,0,0,1,0,24H112A12,12,0,0,1,100,100ZM236,68V196a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V68A20,20,0,0,1,40,48H76V40a28,28,0,0,1,28-28h48a28,28,0,0,1,28,28v8h36A20,20,0,0,1,236,68ZM100,48h56V40a4,4,0,0,0-4-4H104a4,4,0,0,0-4,4ZM44,72v35.23A180.06,180.06,0,0,0,128,128a180,180,0,0,0,84-20.78V72ZM212,192V133.94A204.27,204.27,0,0,1,128,152a204.21,204.21,0,0,1-84-18.06V192Z",
  users:
    "M125.18,156.94a64,64,0,1,0-82.36,0,100.23,100.23,0,0,0-39.49,32,12,12,0,0,0,19.35,14.2,76,76,0,0,1,122.64,0,12,12,0,0,0,19.36-14.2A100.33,100.33,0,0,0,125.18,156.94ZM44,108a40,40,0,1,1,40,40A40,40,0,0,1,44,108Zm206.1,97.67a12,12,0,0,1-16.78-2.57A76.31,76.31,0,0,0,172,172a12,12,0,0,1,0-24,40,40,0,1,0-10.3-78.67,12,12,0,1,1-6.16-23.19,64,64,0,0,1,57.64,110.8,100.23,100.23,0,0,1,39.49,32A12,12,0,0,1,250.1,205.67Z",
  "person-simple-run":
    "M152,92a36,36,0,1,0-36-36A36,36,0,0,0,152,92Zm0-48a12,12,0,1,1-12,12A12,12,0,0,1,152,44Zm76,93.4a12,12,0,0,1-7,10.91,66,66,0,0,1-21.47,3.78c-14,0-34.25-3.82-59.77-19a177,177,0,0,1-10.27,21C153.12,162.83,188,183.8,188,232a12,12,0,0,1-24,0c0-18.69-6.95-33.06-21.26-43.94-9.16-7-19.55-11-27.43-13.34-.81,1-1.64,2-2.5,2.95-20,22.87-44.82,34.76-72.25,34.76a97.33,97.33,0,0,1-9.75-.49,12,12,0,1,1,2.39-23.88c52.3,5.22,77.48-45.92,85.79-67.75C84.8,102.46,63.74,118.78,63.51,119a12,12,0,0,1-15-18.72C50.08,99,88,69.44,142.75,106.62c43.1,29.31,68.1,19.92,68.5,19.76a12,12,0,0,1,16.75,11Z",
  "suitcase-rolling":
    "M116,96v80a12,12,0,0,1-24,0V96a12,12,0,0,1,24,0Zm24,0v80a12,12,0,0,0,24,0V96a12,12,0,0,0-24,0Zm72-32V208a20,20,0,0,1-20,20H180v12a12,12,0,0,1-24,0V228H100v12a12,12,0,0,1-24,0V228H64a20,20,0,0,1-20-20V64A20,20,0,0,1,64,44H84V28A28,28,0,0,1,112,0h32a28,28,0,0,1,28,28V44h20A20,20,0,0,1,212,64ZM108,44h40V28a4,4,0,0,0-4-4H112a4,4,0,0,0-4,4Zm80,24H68V204H188Z",
};

/**
 * name → path string, for the marks this browser can draw without the lazy
 * table. Seeded from the eager core (`SEED_MARKS`, always present) and then
 * from `localStorage` below, so both the seed's own marks and the ones the
 * user has since chosen draw on the first frame without a chunk fetched.
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

// The eager core first — always present, even on a fresh browser with nothing
// stored — then the persisted cache on top, which may add or refresh entries.
for (const [name, path] of Object.entries(SEED_MARKS)) cache.set(name, path);
// A corrupt payload is a cache miss the lazy table refills, so it stays silent
// — same reasoning as `store.readFeeds`. The eager core survives it either way.
try {
  const raw = disk()?.getItem(CACHE_KEY);
  if (raw) {
    const stored = JSON.parse(raw) as Record<string, string>;
    for (const [name, path] of Object.entries(stored)) {
      if (typeof path === "string") cache.set(name, path);
    }
  }
} catch {
  // Keep the eager core; only the persisted layer is suspect.
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
