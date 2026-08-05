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
import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { refreshFeed } from "@/lib/feeds";
import { hostLabel, store } from "@/lib/store";
import { PLACE_OPTIONS, placeForZone } from "@/lib/places";
import { sunTimes } from "@/lib/sun";
import { allZones, atMinutes, formatTimeShort, startOfDay, zoneLabel } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Calendar } from "@/lib/events";
import type { SettingsPanelProps } from "@/components/react/types";
import { FieldRow, IconButton, Segmented, Select, Toggle } from "@/components/react/ui/primitives";

const EASE = [0.32, 0.72, 0, 1] as const;

/** Built once per module — four hundred entries do not change while the app
 *  is open, and both pickers read the same list. */
const OFF = { value: "", label: "Off" };

const ZONE_OPTIONS = [
  OFF,
  ...allZones()
    .map((zone) => ({ value: zone, label: zoneLabel(zone) }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

const LIGHTCYCLE_OPTIONS = [OFF, ...PLACE_OPTIONS];

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
  showZoneName,
  showZoneOffset,
  place,
  daylight,
  moonlight,
  calendars,
  actions,
}: SettingsPanelProps) {
  const reducedMotion = useReducedMotion();
  const [feedUrl, setFeedUrl] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);

  const subscriptions = calendars.filter((c) => c.feed);
  const sun = place ? sunTimes(startOfDay(new Date()), place) : null;

  function pickPlace(zone: string) {
    store.setPlace(zone ? placeForZone(zone) : null);
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

            <div className="no-scrollbar flex-1 overflow-y-auto [--field-label:88px]">
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

              <FieldRow label="2nd ring" align={secondZone ? "top" : "center"}>
                <Select
                  value={secondZone}
                  onChange={store.setSecondZone}
                  label="Second timezone"
                  className="flex-1"
                  options={ZONE_OPTIONS}
                />
                {secondZone && (
                  <div className="flex items-center gap-4">
                    <Toggle
                      label="City name"
                      checked={showZoneName}
                      onChange={(on) => store.setDialToggle("showZoneName", on)}
                    />
                    <Toggle
                      label="Offset"
                      checked={showZoneOffset}
                      onChange={(on) => store.setDialToggle("showZoneOffset", on)}
                    />
                  </div>
                )}
              </FieldRow>

              <FieldRow label="Lightcycle" align="top">
                <Select
                  value={place?.zone ?? ""}
                  onChange={pickPlace}
                  label="Place"
                  className="flex-1"
                  options={LIGHTCYCLE_OPTIONS}
                />
                {place && (
                  <div className="flex items-center gap-4">
                    <Toggle
                      label="Daylight"
                      checked={daylight}
                      onChange={(on) => store.setDialToggle("daylight", on)}
                    />
                    <Toggle
                      label="Moonlight"
                      checked={moonlight}
                      onChange={(on) => store.setDialToggle("moonlight", on)}
                    />
                  </div>
                )}
                <span className="label text-ink-3">
                  {!place
                    ? "Puts the day's light on the ring, in place of the elapsed trail"
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
