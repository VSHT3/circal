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

/** How much of the body to read before deciding it is not a calendar. RFC 5545
 *  puts `BEGIN:VCALENDAR` on the first line, so this is generous by three
 *  orders of magnitude — it exists only so a BOM, stray blank lines or a
 *  proxy's own preamble cannot fail an otherwise good feed. */
const SNIFF_BYTES = 1024;

/**
 * The security headers, and the second of two places that carry them.
 *
 * A request whose path matches a built asset never reaches this script:
 * `assets.binding` is set and `run_worker_first` is not, so Cloudflare's asset
 * server answers first. `public/_headers` is what covers those. This copy
 * covers the rest — an unmatched path falls through to the Worker, which hands
 * it back to `ASSETS` for the single-page-application fallback, and that
 * response is ours. Same list in both, or a deep link gets a weaker page than
 * the root does.
 *
 * The CSP is deliberately partial. `frame-ancestors`, `object-src` and
 * `base-uri` cannot break a page that frames nothing, embeds no plugins and
 * has one origin — so they are free. `script-src` and `connect-src` are the
 * two that would actually stop an injection and both need a decision first:
 * the SW registration in `Base.astro` is an inline script, so a real
 * `script-src` needs a nonce or a hash from the build, and `lib/feeds.ts`
 * falls back to fetching a feed *directly* when the proxy misses, which a
 * `connect-src 'self'` would forbid. Shipping half of it is worth more than
 * shipping none of it; the other half is not a header change, it is a build
 * change.
 */
const ASSET_HEADERS: Record<string, string> = {
  "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Nothing here asks for any of them, and the dial's own permissions
  // (fullscreen, wake lock, notifications) are deliberately not on the list.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** Enough for the `http:`→`https:`→`www.`→CDN chains real calendar hosts use,
 *  and short enough that a redirect loop costs four round trips, not sixty. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return withAssetHeaders(await env.ASSETS.fetch(request));
    if (url.pathname !== "/api/feed") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    return proxyFeed(url, request.method, request.headers.get("origin"));
  },
};

/** A fetched `Response`'s headers are immutable, so this is a re-wrap rather
 *  than a mutation. The body is passed through untouched and unbuffered. */
function withAssetHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(ASSET_HEADERS)) out.headers.set(name, value);
  return out;
}

async function proxyFeed(
  requestUrl: URL,
  method: string,
  origin: string | null,
): Promise<Response> {
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
    upstream = await followChecked(target, method);
  } catch (err) {
    if (err instanceof BlockedHop) return new Response(err.message, { status: 400 });
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

  // A HEAD has no body to look at, and `text/calendar` on nothing is honest.
  if (method !== "HEAD" && !looksLikeCalendar(body)) {
    return new Response("That URL did not return a calendar", { status: 502 });
  }

  const headers = new Headers({
    "content-type": "text/calendar; charset=utf-8",
    "cache-control": "public, max-age=300",
    // The answer depends on who asked, so a shared cache must not hand one
    // origin's response to another.
    vary: "origin",
  });
  // Same-origin `fetch` sends no `Origin` at all and needs no ACAO, so the
  // header is only ever echoed back to this site's own pages. It used to be
  // `*`, which made the route a general-purpose CORS stripper any page on the
  // web could point at arbitrary URLs and read the answer from — on this
  // domain's reputation. Residual, and not closable here: a client that sends
  // no `Origin` at all (curl, a script) is indistinguishable from a same-origin
  // page, so this stops browsers rather than everybody. Closing it properly
  // needs a rate limit or a token.
  if (origin !== null && origin === requestUrl.origin) {
    headers.set("access-control-allow-origin", origin);
  }

  return new Response(body, { status: 200, headers });
}

/**
 * Whether what came back is an iCalendar object at all.
 *
 * Without this the route relabels any 2xx body `text/calendar` and hands it
 * back, which launders a login page, a JSON error or somebody's HTML through
 * this origin. It also turns the most common subscription mistake — pasting
 * the web page you were looking at instead of its ICS link — from a silent
 * parse failure into a sentence that says what went wrong.
 *
 * Deliberately lenient about everything except the words: a BOM, leading
 * blank lines and CRLF are all things real feeds arrive with.
 */
export function looksLikeCalendar(body: string): boolean {
  return body.slice(0, SNIFF_BYTES).toUpperCase().includes("BEGIN:VCALENDAR");
}

/** A hop the guard refused. Distinguished from a network failure because the
 *  two want different statuses: this is the caller's URL leading somewhere it
 *  may not go (400), not the upstream being unreachable (502). */
class BlockedHop extends Error {}

/**
 * Fetch, following redirects *by hand* so every hop goes through the guard.
 *
 * Validating only the URL the user supplied is not a guard at all: an
 * allowlisted, entirely public host can answer `302 Location:
 * http://169.254.169.254/latest/meta-data/`, and with the default redirect
 * mode `fetch` follows it, buffers it, and this Worker hands it back with
 * `access-control-allow-origin: *`. So the mode is `manual` and each `Location`
 * is resolved, re-parsed and re-checked before it is followed.
 *
 * The timeout is one budget across the whole chain rather than per hop —
 * otherwise ten redirects legitimately take ten times as long as one.
 */
async function followChecked(start: URL, method: string): Promise<Response> {
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let target = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(target.toString(), {
      method,
      headers: { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
      redirect: "manual",
      signal: deadline,
    });

    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    // Relative to the hop that sent it, which is what `Location` means.
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new BlockedHop("Feed redirected to an unparseable address");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new BlockedHop("Feed redirected to an unsupported protocol");
    }
    const blocked = ssrfBlockReason(next.hostname);
    if (blocked) throw new BlockedHop(`Feed redirected to a blocked address — ${blocked}`);

    target = next;
  }

  throw new BlockedHop("Feed redirected too many times");
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
 * addresses in the reserved ranges.
 *
 * "Literal" is the part that takes work: `127.0.0.1`, `2130706433`,
 * `0177.0.0.1`, `0x7f000001`, `127.1` and `::ffff:127.0.0.1` are one address
 * in six spellings, and a guard that only reads dotted decimal blocks the
 * spelling. `ipv4Number` normalises all of them before anything is compared.
 *
 * Redirects are handled by `followChecked`, which re-runs this on every hop —
 * validating only the URL the user typed would let an allowlisted host `302`
 * straight into the metadata endpoint.
 *
 * DNS rebinding (a public hostname that later resolves to a private address)
 * is out of reach here: `fetch` resolves the name itself and this Worker
 * never sees the resolved IP.
 */
export function ssrfBlockReason(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return "Refusing to fetch a local hostname";
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host.replace(/^\[|\]$/g, ""))) {
    return "Refusing to fetch a private, loopback or link-local address";
  }
  return null;
}

/**
 * An IPv4 literal in any form a resolver will accept, as a 32-bit number.
 *
 * Dotted-quad is only the form people write. `inet_aton`, and every stack
 * downstream of it, also takes a bare 32-bit integer (`2130706433`), octal
 * octets (`0177.0.0.1`), hex (`0x7f000001`, `0x7f.0.0.1`) and short forms
 * with fewer than four parts (`127.1` — the last part carries the remaining
 * bytes). All of those are `127.0.0.1`, and a guard that only understands
 * dotted decimal blocks the spelling rather than the address.
 *
 * `null` when this is not an IPv4 literal at all, which is the common case:
 * a hostname to be resolved by name.
 */
function ipv4Number(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }

  // Every part but the last is one octet; the last spreads over whatever
  // bytes are left, which is what makes `127.1` loopback.
  const last = values.pop();
  if (last === undefined) return null;
  const spread = 4 - values.length;
  if (last >= 2 ** (8 * spread)) return null;
  if (values.some((v) => v > 255)) return null;

  let n = 0;
  for (const v of values) n = n * 256 + v;
  return n * 2 ** (8 * spread) + last;
}

function isPrivateIpv4(host: string): boolean {
  const n = ipv4Number(host);
  if (n === null) return false;
  const a = (n >>> 24) & 255;
  const b = (n >>> 16) & 255;
  return (
    a === 0 || // 0.0.0.0/8 — "this network", and 0.0.0.0 is loopback on Linux
    a === 127 || // 127.0.0.0/8 — loopback
    a === 10 || // 10.0.0.0/8 — private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — private
    (a === 192 && b === 168) || // 192.168.0.0/16 — private
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local, and the
    // cloud metadata endpoint that makes this whole function load-bearing
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — carrier NAT
    a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true; // loopback, unspecified

  // An IPv4-mapped or -compatible address is an IPv4 address wearing a v6
  // hat — `::ffff:127.0.0.1` and `::ffff:7f00:1` are both loopback, and the
  // second spells the same octets as two hex groups.
  const mapped = /^::(?:ffff:)?(?:0:)?([0-9a-f.:]+)$/i.exec(host);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes(".")) {
      if (isPrivateIpv4(tail)) return true;
    } else {
      const groups = tail.split(":");
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) {
        const n = (parseInt(groups[0], 16) << 16) | parseInt(groups[1], 16);
        if (isPrivateIpv4([24, 16, 8, 0].map((s) => (n >>> s) & 255).join("."))) return true;
      }
    }
  }

  const firstGroup = host.split(":")[0];
  // fc00::/7 (unique local) and fe80::/10 (link-local) both resolve to a
  // fixed prefix within the *first* 16-bit group, so a full-width group
  // match is exact — see the comment above `isPrivateIpv4` for the sibling
  // v4 ranges this mirrors.
  return /^f[cd][0-9a-f]{2}$/.test(firstGroup) || /^fe[89ab][0-9a-f]$/.test(firstGroup);
}
