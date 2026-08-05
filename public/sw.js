/* ------------------------------------------------------------------ *
 * circal's service worker. Hand-written, no Workbox, no build step —
 * this file ships as-is from `public/` and is never bundled.
 *
 * circal is local-first: every event lives only in this origin's
 * localStorage, and iOS evicts an uninstalled site's storage after
 * 7 days of non-use. This worker exists so the app can be installed
 * and keeps working offline, not because the app needs a network
 * cache for performance — it barely fetches anything to begin with.
 * ------------------------------------------------------------------ */

// Bumped when an *unhashed* `public/` asset changes — the icons are the only
// ones — because stale-while-revalidate would otherwise serve the old file
// once more to every installed client. Hashed assets never need this.
const CACHE = "circal-v2";

self.addEventListener("install", () => {
  // No precache list: Astro content-hashes every built asset filename, so
  // there is nothing stable to precache here. This worker only caches what
  // actually gets requested, as it's requested (see `fetch` below).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop caches from earlier versions so a bump to CACHE above reliably
  // sheds stale entries instead of accumulating them forever.
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only same-origin GET is ours to cache. Cross-origin, non-GET, and
  // anything under /api/ (the live ICS proxy) must always hit the network —
  // caching a proxied feed would silently serve stale calendar data.
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    // Network-first: a page load should always get the freshest shell when
    // online. Offline, fall back to the cached "/" so a cold offline launch
    // still boots the app instead of showing the browser's dead-air page.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put("/", response.clone());
          return response;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = await cache.match("/");
          if (cached) return cached;
          throw new Error("offline and no cached shell");
        }
      })(),
    );
    return;
  }

  // Everything else (hashed JS/CSS/fonts/icons): stale-while-revalidate.
  // Serving the cache hit first keeps repeat loads instant; the background
  // fetch keeps the cache from going stale without blocking the response.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);

      const revalidate = fetch(request)
        .then((response) => {
          // Only cache a normal same-origin 200 — opaque/error responses
          // aren't safe to replay later.
          if (response.ok && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);
      // A background revalidate must never surface as an unhandled
      // rejection; `.catch` above already reduced any failure to
      // `undefined`, so this just keeps the worker alive until it settles.
      event.waitUntil(revalidate);

      return cached ?? (await revalidate) ?? Response.error();
    })(),
  );
});
