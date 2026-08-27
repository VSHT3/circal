/* ------------------------------------------------------------------ *
 * `/mcp.json` — where `circal-mcp login` learns which Supabase project
 * this deployment talks to, so nobody has to hand a terminal two long
 * flags copied out of a dashboard.
 *
 * Both values are public by design (see `.env.example`: the publishable
 * key names the project and carries no more authority than an
 * unauthenticated visitor; row level security does the guarding), and
 * they are *already* shipped to every visitor inside the client bundle
 * — this file only gives them a stable address a CLI can read without
 * scraping chunk names. Emitted from the same env the bundle is built
 * from, so the two can never disagree; a fork that never configures the
 * cloud serves `null`s, which the CLI reads as "this site does not
 * offer one".
 *
 * A static asset, not a Worker route: the Worker still has exactly one.
 * ------------------------------------------------------------------ */

import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  const { PUBLIC_SUPABASE_URL: url, PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = import.meta.env;
  return Response.json({
    url: typeof url === "string" && url ? url : null,
    key: typeof key === "string" && key ? key : null,
  });
};
