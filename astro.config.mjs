// @ts-check
import { defineConfig } from "astro/config";

import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Two static pages, one island. `src/pages/index.astro` is the app: a single
// HTML shell under which everything is one React island
// (`src/components/react/App.tsx`), because the whole product is one
// continuously-animating clock and there is nothing to split out of it.
// `src/pages/manifesto.astro` is prose and ships no JS at all.
export default defineConfig({
  site: "https://circal.day",
  trailingSlash: "always",

  // The app fills the viewport edge to edge; the dev toolbar floats over the
  // bottom of the dial, so every dev screenshot would misrepresent the layout.
  devToolbar: { enabled: false },

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [react()],
});
