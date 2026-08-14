/* ------------------------------------------------------------------ *
 * ICS subscriptions.
 *
 * Read-only mirrors of somebody else's calendar. This is deliberately the
 * cheapest possible version of "my real life is on the dial": one URL, one
 * fetch, no account, no token, no write path — and therefore no conflict
 * resolution, which is the part that turns a calendar into a sync product.
 *
 * The fetch goes through the Worker at `/api/feed` because no calendar host
 * sends CORS headers. The direct attempt afterwards is not a fallback so much
 * as a courtesy to `astro dev`, which serves the assets without the Worker.
 * ------------------------------------------------------------------ */

import { fromIcs } from "./ics";
import { store } from "./store";
import { recurrenceOf, type CalEvent, type Calendar } from "./events";

/** Feeds older than this are pulled again at the next opportunity. */
export const STALE_AFTER_MS = 30 * 60_000;

/**
 * How often the shell asks whether anything has gone stale. Cheaper than it
 * looks: `refreshStaleFeeds` filters on `fetchedAt` and a check with nothing
 * due costs one array scan, so this only has to be finer than `STALE_AFTER_MS`
 * rather than equal to it — which is what stops a tab that was hidden over the
 * boundary waiting most of another half hour for the tick it slept through.
 */
export const FEED_CHECK_MS = 5 * 60_000;

const TIMEOUT_MS = 15_000;

async function fetchText(url: string): Promise<string> {
  const viaProxy = `/api/feed?url=${encodeURIComponent(url)}`;
  for (const target of [viaProxy, url]) {
    let response: Response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      continue; // Network error or CORS refusal — try the other route.
    }
    if (response.ok) return response.text();
    // The proxy answers 4xx with a reason worth surfacing; a bad upstream URL
    // is not going to fetch any better without it.
    if (target === viaProxy && response.status >= 400 && response.status < 500) {
      throw new Error((await response.text()).trim() || `Feed returned ${response.status}`);
    }
  }
  throw new Error("Could not reach the feed");
}

/**
 * Pull one feed and replace its cached events. Errors are recorded on the
 * calendar rather than thrown: a subscription that 404s must not take the
 * dial down with it, and the settings panel is where the user can see it.
 */
export async function refreshFeed(calendar: Calendar): Promise<void> {
  if (!calendar.feed) return;
  try {
    const text = await fetchText(calendar.feed.url);
    const { name, events } = fromIcs(text);
    const cached: CalEvent[] = events.map((e) => {
      // An override VEVENT shares its parent's uid — that is what makes it
      // an override — so the parent's id alone would collide between the
      // two; the RECURRENCE-ID joins the key to keep both stable and apart.
      const isOverride = e.recurrenceId !== "";
      // `fromIcs` guarantees a uid, deriving a stable one when the feed
      // omitted it — see `derivedUid` there.
      const parentId = `${calendar.id}:${e.uid}`;
      return {
        id: isOverride ? `${parentId}:${e.recurrenceId}` : parentId,
        title: e.title,
        calendarId: calendar.id,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        // `fromIcs`'s DTSTART reader is `tzid`'s one writer; this mirror
        // just carries what it read across, same as every other field here.
        tzid: e.tzid,
        location: e.location,
        url: e.url,
        notes: e.notes,
        ...recurrenceOf(e),
        seriesId: isOverride ? parentId : "",
        seriesKey: isOverride ? e.recurrenceId : "",
        color: "",
        icon: "",
        // A subscription is read-only, so its tasks are read-only too: the
        // flag is mirrored, the ticks are whatever the sender last said. A
        // subscription that carries neither says `false` and `[]`.
        task: e.task,
        doneKeys: e.doneKeys,
      };
    });
    store.setFeedEvents(calendar.id, cached, name);
  } catch (error) {
    store.setFeedError(calendar.id, error instanceof Error ? error.message : "Refresh failed");
  }
}

/** Every feed that has not been pulled inside `maxAge`, in parallel. */
export async function refreshStaleFeeds(
  calendars: Calendar[],
  maxAge = STALE_AFTER_MS,
): Promise<void> {
  const due = calendars.filter((c) => c.feed && Date.now() - c.feed.fetchedAt > maxAge);
  await Promise.all(due.map(refreshFeed));
}
