/* ------------------------------------------------------------------ *
 * The ICS feed proxy.
 *
 * Circal is otherwise a pure static app — everything else in this repo
 * is served straight out of `dist/`. This one route exists because a
 * third-party ICS feed (Google, Apple, Fastmail…) sends no CORS headers,
 * so a page running on circal's own origin cannot `fetch()` it directly;
 * something same-origin has to fetch it on the browser's behalf. That is
 * the entire reason this Worker runs in front of assets instead of the
 * assets binding serving the build alone.
 * ------------------------------------------------------------------ */

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname !== "/api/feed") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return proxyFeed(url, request.method);
  },
};

async function proxyFeed(requestUrl: URL, method: string): Promise<Response> {
  const raw = requestUrl.searchParams.get("url");
  if (!raw) return new Response("Missing url parameter", { status: 400 });

  // Apple and Google both hand out `webcal:` links; browsers never fetch
  // that scheme, and it means exactly `https:` everywhere it's used, so
  // it's rewritten before parsing rather than added as a third accepted
  // protocol. `URL#protocol`'s setter is spec'd to no-op across the
  // special/non-special scheme boundary — `webcal:` isn't a special
  // scheme — so the rewrite has to happen on the string, before parsing.
  const normalized = /^webcal:/i.test(raw) ? raw.replace(/^webcal:/i, "https:") : raw;

  let target: URL;
  try {
    target = new URL(normalized);
  } catch {
    return new Response("Unparseable url parameter", { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new Response("Unsupported protocol: only http, https and webcal feeds are proxied", {
      status: 400,
    });
  }

  const blocked = ssrfBlockReason(target.hostname);
  if (blocked) return new Response(blocked, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method,
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return new Response(timedOut ? "Upstream feed timed out" : "Failed to reach upstream feed", {
      status: timedOut ? 504 : 502,
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream feed returned ${upstream.status}`, { status: upstream.status });
  }

  const declaredLength = upstream.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_FEED_BYTES) {
    return new Response("Feed exceeds 5MB limit", { status: 413 });
  }

  const body = await readCapped(upstream.body, MAX_FEED_BYTES);
  if (body === null) return new Response("Feed exceeds 5MB limit", { status: 413 });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });
}

/** Buffers the upstream body chunk by chunk instead of trusting
 *  `content-length` alone — a feed that lies about its size (or omits the
 *  header) would otherwise blow past the cap before anything downstream
 *  could react. Returns `null` once the cap is exceeded, so the caller
 *  never has to hold more than `capBytes` in memory. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * The SSRF guard. Blocks the loopback/private/link-local address space so
 * a feed URL can't be used to probe the Worker's own network — `localhost`
 * and the `.localhost`/`.internal` TLDs by name, and literal IPv4/IPv6
 * addresses in the reserved ranges. DNS rebinding (a public hostname that
 * later resolves to a private address) is out of reach here: `fetch`
 * resolves the name itself and this Worker never sees the resolved IP.
 */
function ssrfBlockReason(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return "Refusing to fetch a local hostname";
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host.replace(/^\[|\]$/g, ""))) {
    return "Refusing to fetch a private, loopback or link-local address";
  }
  return null;
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = m.slice(1, 3).map(Number);
  if (a > 255 || b > 255) return false;
  return (
    a === 127 || // 127.0.0.0/8 — loopback
    a === 10 || // 10.0.0.0/8 — private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — private
    (a === 192 && b === 168) || // 192.168.0.0/16 — private
    (a === 169 && b === 254) // 169.254.0.0/16 — link-local
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true; // loopback
  const firstGroup = host.split(":")[0];
  // fc00::/7 (unique local) and fe80::/10 (link-local) both resolve to a
  // fixed prefix within the *first* 16-bit group, so a full-width group
  // match is exact — see the comment above `isPrivateIpv4` for the sibling
  // v4 ranges this mirrors.
  return /^f[cd][0-9a-f]{2}$/.test(firstGroup) || /^fe[89ab][0-9a-f]$/.test(firstGroup);
}
