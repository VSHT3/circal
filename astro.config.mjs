// @ts-check
import { defineConfig } from "astro/config";

import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// Single-page app served as one static HTML shell. Everything below the shell
// is one React island (`src/components/react/App.tsx`) — the whole product is
// one continuously-animating clock, so there is nothing to split into a second
// island and no route to prerender separately.
export default defineConfig({
  site: "https://circal.app",
  trailingSlash: "always",

  // The app fills the viewport edge to edge; the dev toolbar floats over the
  // bottom of the dial, so every dev screenshot would misrepresent the layout.
  devToolbar: { enabled: false },

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [react()],
});
