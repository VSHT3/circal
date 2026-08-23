import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import "./helpers";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_PALETTES,
  isThemeName,
  wash,
  washHex,
  type ThemeName,
} from "@/lib/theme";

/* ---------------------------------------------------------------------- *
 * Three presets, and every hardcoded colour they replaced.
 *
 * The palettes are what a stylesheet cannot reach — canvas fills, SVG
 * strokes, the elapsed ramp — and this suite pins two things about them.
 * First, that midnight is byte-identical to the colours it replaced: not
 * "a preset that happens to be close", but the app every existing user
 * has, where any drift repaints the default install without a commit
 * saying so. Second, that the other two can actually carry the face:
 * contrast ratios are computed here rather than trusted to taste, because
 * a numeral grey that reads on black silently fails on paper.
 *
 * The CSS-side tokens in `global.css` are parsed out of the stylesheet
 * itself, so editing a token past its own contrast budget fails here —
 * it does not wait for somebody to remember to re-check by eye.
 * ---------------------------------------------------------------------- */

const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");

/* --------------------------------- maths -------------------------------- */

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const raw = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!raw) throw new Error(`not a hex colour: ${hex}`);
  const rgb = Number.parseInt(raw[1], 16);
  return (
    0.2126 * channel((rgb >> 16) & 255) +
    0.7152 * channel((rgb >> 8) & 255) +
    0.0722 * channel(rgb & 255)
  );
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbChannels(colour: string): number[] {
  return (colour.match(/\d+/g) ?? []).map(Number);
}

/* ------------------------------ css parsing ----------------------------- */

const SOLID_TOKENS = [
  "void",
  "surface",
  "surface-2",
  "ink",
  "ink-2",
  "ink-3",
  "ink-4",
  "accent",
  "danger",
] as const;

const ALPHA_TOKENS = [
  "veil-05",
  "veil-06",
  "veil-08",
  "veil-10",
  "veil-15",
  "veil-20",
  "ring-40",
  "chip",
] as const;

function tokenBlock(theme: ThemeName): string {
  const pattern =
    theme === "midnight"
      ? /:root,\s*:root\[data-theme="midnight"\]\s*\{([^}]*)\}/
      : new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`);
  const found = pattern.exec(css);
  if (!found) throw new Error(`no [data-theme="${theme}"] block in global.css`);
  return found[1];
}

function token(body: string, name: string): string {
  const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
  if (!found) throw new Error(`no --${name} in block`);
  return found[1].trim();
}

/* ------------------------------- the list ------------------------------- */

describe("the theme list", () => {
  it("is exactly three presets, never free-form", () => {
    expect([...THEMES]).toEqual(["midnight", "ember", "paper"]);
  });

  it("defaults to midnight — the app existing users already have", () => {
    expect(DEFAULT_THEME).toBe("midnight");
  });

  it("isThemeName accepts the three and refuses everything else", () => {
    for (const name of THEMES) expect(isThemeName(name)).toBe(true);
    expect.soft(isThemeName("sepia")).toBe(false);
    expect.soft(isThemeName("")).toBe(false);
    expect.soft(isThemeName(3)).toBe(false);
    if (isThemeName("paper")) {
      const name: ThemeName = "paper";
      expect(name).toBe("paper");
    }
  });
});

/* ------------------------------ the palettes ----------------------------- */

const PALETTE_KEYS = [
  "void",
  "ink",
  "tick",
  "numeralHour",
  "numeralZone",
  "accent",
  "emptyMark",
  "moonLit",
  "ghost",
] as const;

describe("THEME_PALETTES", () => {
  it.each([...THEMES])("%s: every key present and every value legal hex", (theme) => {
    const entry = THEME_PALETTES[theme];
    for (const key of PALETTE_KEYS) {
      expect.soft(entry[key], `${theme}.${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("midnight carries the historical literals byte for byte", () => {
    // Pinned, not duplicated: any drift here repaints every existing
    // user's dial without a commit saying so.
    expect(THEME_PALETTES.midnight).toEqual({
      void: "#000000",
      ink: "#ffffff",
      tick: "#ffffff",
      numeralHour: "#6d6d73",
      numeralZone: "#55555a",
      accent: "#a3d9e4",
      emptyMark: "#3a3a3e",
      moonLit: "#ffffff",
      ghost: "#ffffff",
    });
  });

  it.each([...THEMES])("%s: ink reads on void at body-text strength (>= 7)", (theme) => {
    expect(contrast(THEME_PALETTES[theme].ink, THEME_PALETTES[theme].void)).toBeGreaterThanOrEqual(
      7,
    );
  });

  it.each([...THEMES])("%s: hour numerals stay legible on void (>= 3)", (theme) => {
    expect(
      contrast(THEME_PALETTES[theme].numeralHour, THEME_PALETTES[theme].void),
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([...THEMES])("%s: accent survives as small text on void (>= 4.5)", (theme) => {
    // `text-accent` chrome prints at caption size — the life grid's
    // percentage, today's numeral. Paper's darker aqua exists for exactly
    // this bound; the others clear it on their pale accent alone.
    expect(
      contrast(THEME_PALETTES[theme].accent, THEME_PALETTES[theme].void),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...THEMES])("%s: an empty day's year-ring mark is visible but quiet", (theme) => {
    const { emptyMark, void: ground } = THEME_PALETTES[theme];
    expect(contrast(emptyMark, ground)).toBeGreaterThanOrEqual(1.2);
    expect(contrast(emptyMark, ground)).toBeLessThanOrEqual(3.5);
  });
});

/* --------------------------------- wash --------------------------------- */

describe("wash", () => {
  it("level 0 is the theme's own void and level 1 the base untouched", () => {
    for (const theme of THEMES) {
      expect
        .soft(wash(theme, 124, 227, 216, 0))
        .toBe(washHex(theme, THEME_PALETTES[theme].void, 0));
      expect.soft(wash(theme, 124, 227, 216, 1)).toBe("rgb(124,227,216)");
    }
  });

  it("on midnight a lerp toward black IS the multiply it replaced", () => {
    // The whole reason midnight users see nothing change.
    for (let level = 0; level <= 20; level++) {
      const k = level / 20;
      const [r, g, b] = [255, 198, 124];
      expect(wash("midnight", r, g, b, k)).toBe(
        `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`,
      );
    }
  });

  it("each channel runs monotonically between void and base, both directions", () => {
    for (const theme of THEMES) {
      const hex = THEME_PALETTES[theme].void.replace("#", "");
      const ground = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const base = [10, 200, 90];
      const dist = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
      for (let step = 0; step <= 10; step++) {
        const out = rgbChannels(wash(theme, base[0], base[1], base[2], step / 10));
        expect(out).toHaveLength(3);
        for (let c = 0; c < 3; c++) {
          const lo = Math.min(ground[c], base[c]);
          const hi = Math.max(ground[c], base[c]);
          expect.soft(out[c], `${theme} ch${c} @${step} >= lo`).toBeGreaterThanOrEqual(lo);
          expect.soft(out[c], `${theme} ch${c} @${step} <= hi`).toBeLessThanOrEqual(hi);
          const d = Math.abs(base[c] - out[c]);
          expect.soft(d, `${theme} ch${c} distance @${step}`).toBeLessThanOrEqual(dist[c]);
          dist[c] = d;
        }
      }
    }
  });

  it("clamps overshoot instead of washing past either end", () => {
    for (const theme of THEMES) {
      expect.soft(wash(theme, 10, 200, 90, -3)).toBe(wash(theme, 10, 200, 90, 0));
      expect.soft(wash(theme, 10, 200, 90, 7)).toBe("rgb(10,200,90)");
    }
  });

  it("washHex treats an unreadable colour as black, as dim always did", () => {
    expect(washHex("midnight", "not-a-colour", 1)).toBe("rgb(0,0,0)");
  });
});

/* ------------------------------ css tokens ------------------------------ */

describe("global.css token blocks", () => {
  it.each([...THEMES])("%s defines every chrome token the components read", (theme) => {
    const body = tokenBlock(theme);
    for (const name of [...SOLID_TOKENS, ...ALPHA_TOKENS, "on-accent", "scrim-a", "scrim-b"]) {
      expect.soft(token(body, name), `${theme} --${name}`).toBeTruthy();
    }
  });

  it.each([...THEMES])("%s's veil ladder rises strictly with its number", (theme) => {
    const body = tokenBlock(theme);
    let last = -1;
    for (const name of ALPHA_TOKENS.filter((name) => name !== "chip")) {
      const alpha = /\/\s*([0-9.]+)\)/.exec(token(body, name));
      if (!alpha) throw new Error(`--${name} is not an alpha form`);
      expect.soft(Number(alpha[1]), `${theme} --${name}`).toBeGreaterThan(last);
      last = Number(alpha[1]);
    }
    // The chip is a keycap, not a rung: it sits between steps by design.
  });

  it.each([
    { theme: "midnight" as ThemeName, scheme: "dark" },
    { theme: "ember" as ThemeName, scheme: "dark" },
    { theme: "paper" as ThemeName, scheme: "light" },
  ])("%s declares color-scheme: %s so browser chrome agrees", ({ theme, scheme }) => {
    const body = tokenBlock(theme);
    const found = new RegExp("(?:^|\\s)color-scheme:\\s*([^;]+);").exec(body);
    if (!found) throw new Error(`${theme} block declares no color-scheme`);
    expect(found[1].trim()).toBe(scheme);
  });

  it.each([...THEMES])("%s: ink-2 names things legibly on surface (>= 4.5)", (theme) => {
    // A name may not take ink-3 because placeholder shares it; the corollary
    // is that ink-2 must hold naming strength on its own surface in all
    // three greyscales.
    const body = tokenBlock(theme);
    expect(contrast(token(body, "ink-2"), token(body, "surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...THEMES])("%s: danger stays readable where it is spoken (>= 3)", (theme) => {
    const body = tokenBlock(theme);
    expect(contrast(token(body, "danger"), token(body, "surface"))).toBeGreaterThanOrEqual(3);
  });

  it("the midnight block still matches no attribute — pre-hydration paint", () => {
    // The first selector must be bare `:root` beside the named one, or a
    // page before React mounts paints without tokens at all.
    expect(/:root,\s*:root\[data-theme="midnight"\]/.test(css)).toBe(true);
  });

  it("every preset's CSS accent matches the canvas palette's", () => {
    // Two spellings of one fact — `text-accent` chrome and the canvases'
    // today-pip must not disagree about what the app's voice sounds like.
    for (const theme of THEMES) {
      expect(token(tokenBlock(theme), "accent").toLowerCase()).toBe(THEME_PALETTES[theme].accent);
    }
  });
});
