import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/* ------------------------------------------------------------------ *
 * The test harness.
 *
 * Two projects, and the split is not organisational — it is the only
 * honest way to test this codebase. Almost every date function here is
 * deliberately *local-time* (`dayKey` exists precisely because
 * `toISOString` shifts the day west of UTC), so a suite that runs in
 * whatever zone the machine happens to sit in tests nothing: it passes
 * in Berlin and fails in CI, or worse, the reverse.
 *
 * So `local` pins one zone — east of UTC, with DST — and `west` re-runs
 * the zone-sensitive cases in a zone on the other side of the meridian,
 * in its own process. Its own process because a TZ change after Node has
 * started is not reliably observed by an already-warm `Intl` cache; two
 * pools is the difference between a guarantee and a hope.
 * ------------------------------------------------------------------ */

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "local",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/west/**"],
          env: { TZ: "Europe/Berlin" },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "west",
          environment: "node",
          include: ["tests/west/**/*.test.ts"],
          env: { TZ: "America/Los_Angeles" },
        },
      },
    ],
  },
});
