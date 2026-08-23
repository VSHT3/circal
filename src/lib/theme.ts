/**
 * The three greyscales chrome comes in.
 *
 * Chrome is greyscale by rule and colour belongs to events — but *which*
 * greyscale is a choice, and this file is where the choice lives: an
 * enumerated list, never a free-form theme editor. A slider is a thousand
 * faces nobody tested; three presets are three faces somebody did.
 *
 * Two halves, because two different readers need answering:
 *
 * - The **CSS tokens** in `global.css` (`--void`, `--ink`, …) carry every
 *   HTML surface. They are keyed off `[data-theme]` on `<html>`, which
 *   `App` writes from `settings.theme`; components that only ever print
 *   chrome never learn a theme exists.
 * - This file's **palettes** carry what a stylesheet cannot reach: colours
 *   computed in JavaScript — canvas fills, SVG strokes, the elapsed ramp —
 *   which would otherwise hardcode white-on-black and silently break on
 *   paper.
 *
 * The one drawing primitive both share is [`wash`]: a lerp from the theme's
 * own void toward a base colour. On a black void a lerp toward black *is* a
 * multiplication by the level (`v + (base − v) · k` collapses to `base · k`
 * when `v` is 0), so midnight's output is identical to the multiply it
 * replaced — pinned in `tests/theme.test.ts`. On paper the same primitive
 * fades a dot into the page instead of into a hole, which is the whole
 * reason the direction lives here rather than beside each caller.
 */

export const THEMES = ["midnight", "ember", "paper"] as const;

export type ThemeName = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeName = "midnight";

/** One validator, three readers — `readRecurrence`'s shape: `backup.readSettings`,
 *  `sane()` in the store, and the settings panel's own `Segmented` (whose ids are
 *  typed and need no runtime check). */
export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * What a canvas or an SVG needs beyond the CSS tokens. Every entry is a
 * colour string legal for `fillStyle` / `fill` / `stroke`.
 *
 * `ink` is this theme's brightest writing colour and `void` its darkest
 * ground — the pair every ramp runs between. `tick` is the full-strength
 * hairline ink (ticks, the now-hand, the year ring's selection overlay);
 * the two numeral greys sit below it, as `ink-3`/`ink-2` do in chrome.
 */
export interface ThemePalette {
  /** Canvas ground, matching the CSS `--void` (kept here because
   *  `getContext("2d").fillStyle` cannot read a custom property). */
  readonly void: string;
  /** Brightest ink on the face — the ramp's ceiling, the loupe's grey. */
  readonly ink: string;
  /** Hairlines drawn at their own alphas: ticks, hand, track, selection. */
  readonly tick: string;
  /** Hour numerals. Midnight's spellings are the historical literals. */
  readonly numeralHour: string;
  /** Zone-ring numerals, a step dimmer than the hours. */
  readonly numeralZone: string;
  /** The accent as a canvas needs it — today's pip, the life grid's today
   *  dot. Paper's is a darker aqua than the calendar default it echoes,
   *  because up there it is also small text (`text-accent` chrome) and pale
   *  aqua on paper fails at that size. */
  readonly accent: string;
  /** An empty day's mark on the year ring. */
  readonly emptyMark: string;
  /** The moon disc's lit half. Ink-consistent rather than always white: on
   *  paper a lit moon prints dark, the way this app prints everything. */
  readonly moonLit: string;
  /** What a gesture being drawn wears before it has a colour of its own. */
  readonly ghost: string;
}

export const THEME_PALETTES: Record<ThemeName, ThemePalette> = {
  /* The original. Values are the historical literals — `tests/theme.test.ts`
   * pins them, because midnight is not "a preset that happens to be close":
   * it is the app every existing user already has. */
  midnight: {
    void: "#000000",
    ink: "#ffffff",
    tick: "#ffffff",
    numeralHour: "#6d6d73",
    numeralZone: "#55555a",
    accent: "#a3d9e4",
    emptyMark: "#3a3a3e",
    moonLit: "#ffffff",
    ghost: "#ffffff",
  },
  /* Warm dark. Same structure, warmer ground: the greys lean brown, and the
   * accent stays cool deliberately — one cold note on a warm face is what
   * keeps it reading as the app's own voice rather than as sepia. */
  ember: {
    void: "#151110",
    ink: "#f3ece1",
    tick: "#f3ece1",
    numeralHour: "#8d8272",
    numeralZone: "#6b6155",
    accent: "#a3d9e4",
    emptyMark: "#453c32",
    moonLit: "#f3ece1",
    ghost: "#ffffff",
  },
  /* Paper. Ink and ground trade places; the pastel event colours are left
   * alone, because they were chosen high-value enough to sit on either. */
  paper: {
    void: "#f2efe8",
    ink: "#26221b",
    tick: "#2b2720",
    numeralHour: "#8f887a",
    numeralZone: "#b3ac9f",
    accent: "#177078",
    emptyMark: "#d9d3c6",
    moonLit: "#26221b",
    ghost: "#26221b",
  },
};

function channels(color: string): readonly [number, number, number] {
  const raw = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!raw) return [0, 0, 0];
  const rgb = Number.parseInt(raw[1], 16);
  return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
}

/**
 * `level` of a base colour over the theme's own ground: `0` is the void,
 * `1` is the base untouched, everything between a straight lerp. Clamped,
 * so an end-of-life fade or a hover lift cannot overshoot into negative
 * light. Opaque output, for the same reason the elapsed ramp is opaque:
 * overlapping strokes must replace, not compound.
 */
export function wash(theme: ThemeName, r: number, g: number, b: number, level: number): string {
  const [vr, vg, vb] = channels(THEME_PALETTES[theme].void);
  const k = Math.max(0, Math.min(1, level));
  const mix = (ground: number, base: number) => Math.round(ground + (base - ground) * k);
  return `rgb(${mix(vr, r)},${mix(vg, g)},${mix(vb, b)})`;
}

/** [`wash`] for a colour that arrives as a string — an event's own pastel
 *  fading toward the page at the grid's horizon, the one case the callers
 *  do not already hold channels for. Unreadable input washes from black,
 *  which is what `dim` always did with one. */
export function washHex(theme: ThemeName, color: string, level: number): string {
  const [r, g, b] = channels(color);
  return wash(theme, r, g, b, level);
}
