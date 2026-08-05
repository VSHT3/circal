// Flat config (ESLint 10). Astro shell + React island + TypeScript, with JSX
// a11y on the island. Type-aware linting is off by design (fast, no
// parserOptions.project needed).
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  // `.wrangler/` holds the dev server's generated bundles — not source.
  globalIgnores(["dist/", ".astro/", ".wrangler/", "node_modules/", "public/"]),

  js.configs.recommended,
  tseslint.configs.recommended,

  // a11y plus rules-of-hooks on the island. The dial re-renders every second;
  // a stale closure here is a wrong clock, not a lint nit.
  {
    files: ["**/*.{jsx,tsx}"],
    extends: [jsxA11y.flatConfigs.recommended, reactHooks.configs.flat["recommended-latest"]],
  },

  {
    // The only two `autoFocus` call sites are modal overlays — the ⌘K palette
    // and the event editor. WAI-ARIA requires focus to move into a modal when
    // it opens, so the blanket ban is wrong exactly here.
    files: ["src/components/react/{CommandPalette,EventEditor}.tsx"],
    rules: { "jsx-a11y/no-autofocus": "off" },
  },

  astro.configs.recommended,
  astro.configs["jsx-a11y-recommended"],

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);
