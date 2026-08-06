/* ------------------------------------------------------------------ *
 * The `/api/feed` proxy — routing, method handling, size caps and the
 * redirect chain.
 *
 * `ssrfBlockReason`'s own table lives in `tests/worker.test.ts`. This
 * file is about what the Worker does *around* it, and in particular the
 * hole that guarding one hostname leaves open: an allowlisted, entirely
 * public host answering `302 Location: http://169.254.169.254/…`.
 * ------------------------------------------------------------------ */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../worker/index";

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";

const ASSETS: Env["ASSETS"] = {
  fetch: async () => new Response("<!doctype html>", { status: 200 }),
};

const env: Env = { ASSETS };

/** A request at the proxy for `url`, which is encoded for you. */
function feedRequest(url: string, init?: RequestInit) {
  return new Request(`https://circal.app/api/feed?url=${encodeURIComponent(url)}`, init);
}

/**
 * A `fetch` that answers from a table of `url → Response`, recording the
 * order it was asked in. Anything not in the table is a 404, so a hop the
 * Worker should never have made shows up as a miss rather than as a hang.
 */
function router(table: Record<string, () => Response>) {
  const seen: string[] = [];
  const inits: RequestInit[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    seen.push(url);
    inits.push(init);
    const make = table[url];
    return make ? make() : new Response("not in table", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { seen, inits };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------- routing --------------------------------- */

describe("routing", () => {
  it("hands anything outside /api/ to the assets binding", async () => {
    const response = await worker.fetch(new Request("https://circal.app/"), env);
    expect(await response.text()).toBe("<!doctype html>");
  });

  it("404s any /api/ route that is not /api/feed", async () => {
    // The one-route rule, made enforceable: a second API route is a different
    // product, and this is where that argument is kept honest.
    const response = await worker.fetch(new Request("https://circal.app/api/sync"), env);
    expect(response.status).toBe(404);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("405s %s", async (method) => {
    const response = await worker.fetch(feedRequest("https://example.com/c.ics", { method }), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("400s a missing url parameter", async () => {
    const response = await worker.fetch(new Request("https://circal.app/api/feed"), env);
    expect(response.status).toBe(400);
  });

  it("400s an unparseable url parameter", async () => {
    const response = await worker.fetch(feedRequest("not a url"), env);
    expect(response.status).toBe(400);
  });

  it.each(["ftp://example.com/c.ics", "file:///etc/passwd", "data:text/calendar,x"])(
    "400s the unsupported protocol in %s",
    async (url) => {
      const response = await worker.fetch(feedRequest(url), env);
      expect(response.status).toBe(400);
    },
  );

  it("rewrites webcal: to https: before parsing", async () => {
    // `URL#protocol`'s setter no-ops across the special/non-special boundary,
    // so the rewrite has to happen on the string — if it regresses, the
    // upstream url here comes back as `webcal:` and the table misses.
    const { seen } = router({ "https://example.com/c.ics": () => new Response(ICS) });
    const response = await worker.fetch(feedRequest("webcal://example.com/c.ics"), env);

    expect(seen).toEqual(["https://example.com/c.ics"]);
    expect(response.status).toBe(200);
  });
});

/* ------------------------------- redirects -------------------------------- */

describe("the redirect chain is validated hop by hop", () => {
  it("never lets fetch follow a redirect on its own", async () => {
    const { inits } = router({ "https://example.com/c.ics": () => new Response(ICS) });
    await worker.fetch(feedRequest("https://example.com/c.ics"), env);

    // The whole guard rests on this: with the default mode, `fetch` follows
    // hops the Worker never sees and never checks.
    expect(inits[0].redirect).toBe("manual");
  });

  it("refuses a redirect into the cloud metadata endpoint", async () => {
    const { seen } = router({
      "https://example.com/c.ics": () => redirectTo("http://169.254.169.254/latest/meta-data/"),
    });

    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/redirected to a blocked address/i);
    // And it must not have been fetched even once.
    expect(seen).toEqual(["https://example.com/c.ics"]);
  });

  it.each([
    ["loopback", "http://127.0.0.1/"],
    ["decimal loopback", "http://2130706433/"],
    ["private range", "http://10.1.2.3/"],
    ["link-local v6", "http://[fe80::1]/"],
    ["localhost by name", "http://localhost:8080/"],
  ])("refuses a redirect to %s", async (_name, location) => {
    router({ "https://example.com/c.ics": () => redirectTo(location) });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect.soft(response.status).toBe(400);
  });

  it("refuses a redirect that changes protocol to something unfetchable", async () => {
    router({ "https://example.com/c.ics": () => redirectTo("file:///etc/passwd") });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect(response.status).toBe(400);
  });

  it("follows a redirect to a public host and returns its body", async () => {
    const { seen } = router({
      "https://example.com/c.ics": () => redirectTo("https://cdn.example.net/c.ics"),
      "https://cdn.example.net/c.ics": () => new Response(ICS),
    });

    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ICS);
    expect(seen).toEqual(["https://example.com/c.ics", "https://cdn.example.net/c.ics"]);
  });

  it("resolves a relative Location against the hop that sent it", async () => {
    const { seen } = router({
      "https://example.com/a/c.ics": () => redirectTo("../b/d.ics"),
      "https://example.com/b/d.ics": () => new Response(ICS),
    });

    const response = await worker.fetch(feedRequest("https://example.com/a/c.ics"), env);
    expect(response.status).toBe(200);
    expect(seen[1]).toBe("https://example.com/b/d.ics");
  });

  it.each([301, 302, 303, 307, 308])("treats %i as a redirect", async (status) => {
    const { seen } = router({
      "https://example.com/c.ics": () => redirectTo("https://cdn.example.net/c.ics", status),
      "https://cdn.example.net/c.ics": () => new Response(ICS),
    });
    await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect.soft(seen).toHaveLength(2);
  });

  it("gives up on a redirect loop rather than spinning", async () => {
    const { seen } = router({
      "https://example.com/a": () => redirectTo("https://example.com/b"),
      "https://example.com/b": () => redirectTo("https://example.com/a"),
    });

    const response = await worker.fetch(feedRequest("https://example.com/a"), env);

    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/too many times/i);
    expect(seen.length).toBeLessThanOrEqual(6);
  });

  it("passes a 3xx with no Location straight through as the upstream status", async () => {
    router({ "https://example.com/c.ics": () => new Response(null, { status: 302 }) });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect(response.status).toBe(302);
  });
});

/* --------------------------------- upstream ------------------------------- */

describe("upstream handling", () => {
  it("passes an upstream error status through", async () => {
    router({ "https://example.com/c.ics": () => new Response("gone", { status: 404 }) });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect(response.status).toBe(404);
  });

  it("502s a network failure and 504s a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    expect((await worker.fetch(feedRequest("https://example.com/c.ics"), env)).status).toBe(502);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      }),
    );
    expect((await worker.fetch(feedRequest("https://example.com/c.ics"), env)).status).toBe(504);
  });

  it("413s a feed that declares itself over the cap", async () => {
    router({
      "https://example.com/c.ics": () =>
        new Response(ICS, { headers: { "content-length": String(6 * 1024 * 1024) } }),
    });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect(response.status).toBe(413);
  });

  it("413s a feed that lies about its size", async () => {
    // No content-length at all, and a body past the cap — the reason
    // `readCapped` exists rather than trusting the header.
    const big = "x".repeat(6 * 1024 * 1024);
    router({ "https://example.com/c.ics": () => new Response(big) });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);
    expect(response.status).toBe(413);
  });

  it("answers a good feed with CORS and a cache header", async () => {
    router({ "https://example.com/c.ics": () => new Response(ICS) });
    const response = await worker.fetch(feedRequest("https://example.com/c.ics"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toMatch(/text\/calendar/);
    expect(response.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  it("refuses a private address on the first hop too", async () => {
    const { seen } = router({});
    const response = await worker.fetch(feedRequest("http://169.254.169.254/latest/"), env);

    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });
});
