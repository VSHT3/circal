/* ------------------------------------------------------------------ *
 * Settings — everything the dial can be told, in one card.
 *
 * The sidebar is where you look at a day; this is where you configure the
 * instrument. It owns the two rings the dial can grow (daylight, a second
 * timezone), the subscriptions it mirrors, and the only two buttons that can
 * get your data back out of this browser.
 *
 * Settings mutations go straight to `store` rather than through
 * `ShellActions`: the shell has no view state to update for any of them, and
 * five more members on that object would only be a longer way to say `store`.
 * ------------------------------------------------------------------ */

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Download, LocateFixed, RefreshCw, Trash2, Upload } from "lucide-react";
import { refreshFeed } from "@/lib/feeds";
import { notify } from "@/lib/notify";
import { hostLabel, store } from "@/lib/store";
import { isValidPlace, sunTimes } from "@/lib/sun";
import { allZones, atMinutes, formatTimeShort, startOfDay, zoneCity, zoneRegion } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Calendar } from "@/lib/events";
import type { SettingsPanelProps } from "@/components/react/types";
import { FieldRow, IconButton, Segmented, Select } from "@/components/react/ui/primitives";

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * City first, region second — `Tokyo · Asia`, not `Asia · Tokyo`.
 *
 * A native `<select>` type-ahead matches from the *start* of the option text,
 * and nobody looking for Tokyo types "Asia". Leading with the continent turned
 * a four-hundred-entry list into a scroll.
 */
function zoneLabel(zone: string): string {
  const region = zoneRegion(zone);
  return region ? `${zoneCity(zone)} · ${region}` : zoneCity(zone);
}

/** Sorted by the thing the user is about to type, and built once per module —
 *  four hundred entries do not change while the app is open. */
const ZONE_OPTIONS = [
  { value: "", label: "Off" },
  ...allZones()
    .map((zone) => ({ value: zone, label: zoneLabel(zone) }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

/**
 * Geolocation fails for three genuinely different reasons and the browser is
 * the only thing that knows which. Reporting all three as "permission denied"
 * sent people back to a permission they had already granted — on macOS the
 * usual cause is the *system* withholding location from the browser itself,
 * which no amount of clicking Allow in the page will fix.
 */
function locationFailure(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return "Location permission denied";
  if (error.code === error.POSITION_UNAVAILABLE) {
    return "No location available — check that your system lets this browser see it";
  }
  if (error.code === error.TIMEOUT) return "Location lookup timed out";
  return error.message || "Could not get a location";
}

function relativeAge(at: number): string {
  if (!at) return "never pulled";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export default function Settings({
  open,
  onClose,
  clock,
  secondZone,
  place,
  calendars,
  actions,
}: SettingsPanelProps) {
  const reducedMotion = useReducedMotion();
  const [feedUrl, setFeedUrl] = useState("");
  const [lat, setLat] = useState(place ? `${place.lat}` : "");
  const [lon, setLon] = useState(place ? `${place.lon}` : "");
  const [pulling, setPulling] = useState<string | null>(null);

  // Reset the two typed fields when a *different* place arrives (geolocation
  // answering, an undo, another tab). Render-phase adjustment, not an effect.
  const identity = place ? `${place.lat},${place.lon}` : "";
  const [seeded, setSeeded] = useState(identity);
  if (seeded !== identity) {
    setSeeded(identity);
    setLat(place ? `${place.lat}` : "");
    setLon(place ? `${place.lon}` : "");
  }

  const subscriptions = calendars.filter((c) => c.feed);
  const sun = place ? sunTimes(startOfDay(new Date()), place) : null;

  function commitPlace(nextLat: string, nextLon: string) {
    const latitude = Number(nextLat);
    const longitude = Number(nextLon);
    if (nextLat.trim() === "" && nextLon.trim() === "") {
      store.setPlace(null);
      return;
    }
    if (!isValidPlace(latitude, longitude)) return;
    store.setPlace({
      lat: latitude,
      lon: longitude,
      label: `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`,
    });
  }

  function locate() {
    if (!navigator.geolocation) {
      notify("This browser will not share a location", "error");
      return;
    }
    const found = (position: GeolocationPosition) => {
      store.setPlace({
        lat: Number(position.coords.latitude.toFixed(4)),
        lon: Number(position.coords.longitude.toFixed(4)),
        label: "Here",
      });
      notify("Location set");
    };

    navigator.geolocation.getCurrentPosition(found, (first) => {
      // A cached coarse fix routinely comes back unavailable on a desktop with
      // no recent Wi-Fi scan, while the high-accuracy path succeeds. Worth one
      // retry before telling someone their permission is broken when it isn't.
      if (first.code !== first.POSITION_UNAVAILABLE) {
        notify(locationFailure(first), "error");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        found,
        (second) => notify(locationFailure(second), "error"),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    });
  }

  async function pull(calendar: Calendar) {
    setPulling(calendar.id);
    await refreshFeed(calendar);
    setPulling(null);
  }

  async function addFeed() {
    const url = feedUrl.trim();
    if (!url) return;
    const normalised = url.replace(/^webcal:/i, "https:");
    setFeedUrl("");
    const calendar = store.addFeed(normalised, hostLabel(normalised));
    await pull(calendar);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[55] grid place-items-center bg-black/50 backdrop-blur-[2px]"
          onClick={onClose}
          role="presentation"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0 }}
          transition={{ duration: 0.16, ease: EASE }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[86vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
            initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            <div className="border-b border-hairline px-3.5 py-3">
              <span className="text-[17px] font-medium text-ink">Settings</span>
            </div>

            <div className="no-scrollbar flex-1 overflow-y-auto">
              <FieldRow label="Dial">
                <Segmented
                  value={clock}
                  onChange={actions.setClock}
                  options={[
                    { id: "12h" as const, label: "12 h" },
                    { id: "24h" as const, label: "24 h" },
                  ]}
                />
              </FieldRow>

              <FieldRow label="2nd ring">
                <Select
                  value={secondZone}
                  onChange={store.setSecondZone}
                  label="Second timezone"
                  className="flex-1"
                  options={ZONE_OPTIONS}
                />
              </FieldRow>

              <FieldRow label="Daylight" align="top">
                <div className="flex items-center gap-2">
                  <Coordinate
                    label="Latitude"
                    value={lat}
                    onChange={setLat}
                    onCommit={(next) => commitPlace(next, lon)}
                  />
                  <span className="text-ink-4">·</span>
                  <Coordinate
                    label="Longitude"
                    value={lon}
                    onChange={setLon}
                    onCommit={(next) => commitPlace(lat, next)}
                  />
                  <IconButton label="Use my location" onClick={locate}>
                    <LocateFixed size={14} strokeWidth={1.75} />
                  </IconButton>
                  {place && (
                    <IconButton
                      label="Turn the daylight band off"
                      onClick={() => store.setPlace(null)}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </IconButton>
                  )}
                </div>
                <span className="label text-ink-3">
                  {!place
                    ? "Shades the rim with today's sunrise and sunset"
                    : sun?.polar === "day"
                      ? "Midnight sun"
                      : sun?.polar === "night"
                        ? "Polar night"
                        : sun?.sunrise != null && sun.sunset != null
                          ? `${formatTimeShort(atMinutes(new Date(), sun.sunrise), clock)} – ${formatTimeShort(atMinutes(new Date(), sun.sunset), clock)}`
                          : "No sunrise today"}
                </span>
              </FieldRow>

              <FieldRow label="Feeds" align="top">
                {subscriptions.length === 0 && (
                  <span className="label text-ink-3">
                    Paste a public ICS link — read-only, refreshed on launch
                  </span>
                )}
                {subscriptions.map((calendar) => (
                  <div key={calendar.id} className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: calendar.color }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] text-ink">{calendar.name}</span>
                      <span
                        className={feedMetaClass(calendar.feed?.error)}
                        title={calendar.feed?.error || calendar.feed?.url}
                      >
                        {pulling === calendar.id
                          ? "PULLING…"
                          : calendar.feed?.error || relativeAge(calendar.feed?.fetchedAt ?? 0)}
                      </span>
                    </span>
                    <IconButton label={`Refresh ${calendar.name}`} onClick={() => pull(calendar)}>
                      <RefreshCw size={13} strokeWidth={1.75} />
                    </IconButton>
                    <IconButton
                      label={`Remove ${calendar.name}`}
                      onClick={() => store.removeCalendar(calendar.id)}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </IconButton>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <input
                    type="url"
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addFeed();
                      }
                    }}
                    placeholder="https://…/basic.ics"
                    aria-label="Feed URL"
                    className="h-8 min-w-0 flex-1 rounded-[8px] bg-surface-2 px-2 text-[13px] text-ink placeholder:text-ink-3"
                  />
                  <button
                    type="button"
                    onClick={() => void addFeed()}
                    disabled={!feedUrl.trim()}
                    className="h-8 shrink-0 rounded-[8px] border border-hairline bg-surface-2 px-3 text-[13px] text-ink transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-35"
                  >
                    Add
                  </button>
                </div>
              </FieldRow>

              <FieldRow label="Data" align="top" last>
                <div className="flex flex-wrap items-center gap-2">
                  <DataButton
                    icon={<Download size={13} strokeWidth={1.75} />}
                    onClick={actions.exportIcs}
                  >
                    Export .ics
                  </DataButton>
                  <DataButton
                    icon={<Download size={13} strokeWidth={1.75} />}
                    onClick={actions.exportBackup}
                  >
                    Backup .json
                  </DataButton>
                  <DataButton
                    icon={<Upload size={13} strokeWidth={1.75} />}
                    onClick={actions.importFile}
                  >
                    Import…
                  </DataButton>
                </div>
                <span className="label text-ink-3">
                  Events live only in this browser. A backup is the only copy that survives it
                </span>
              </FieldRow>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Feed meta line: a failing subscription is the one place chrome goes red. */
function feedMetaClass(error?: string): string {
  return cn("label truncate text-[10px]", error ? "text-danger" : "text-ink-4");
}

/**
 * A free-typed coordinate. Committed on blur and Enter rather than per
 * keystroke: `-` and `51.` are both unparseable halves of a valid number, and
 * re-rendering the whole dial for each is a waste besides.
 */
function Coordinate({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
}) {
  return (
    <input
      inputMode="decimal"
      value={value}
      aria-label={label}
      placeholder={label === "Latitude" ? "51.51" : "-0.13"}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
          e.currentTarget.blur();
        }
      }}
      className="h-8 w-[74px] rounded-[8px] bg-surface-2 px-2 text-[13px] text-ink tabular-nums placeholder:text-ink-3"
    />
  );
}

function DataButton({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-white/10"
    >
      {icon}
      {children}
    </button>
  );
}
