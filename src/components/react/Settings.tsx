/* ------------------------------------------------------------------ *
 * Settings — everything the dial can be told, on one surface.
 *
 * The sidebar is where you look at a day; this is where you configure the
 * instrument. It owns the two rings the dial can grow (daylight, a second
 * timezone), the subscriptions it mirrors, and the only two buttons that can
 * get your data back out of this browser.
 *
 * Settings mutations go straight to `store` rather than through
 * `ShellActions`: the shell has no view state to update for any of them, and
 * five more members on that object would only be a longer way to say `store`.
 *
 * The card is a near-full-screen overlay rather than a 420px column because
 * this panel only grows: a single vertical scroll makes every setting added
 * after the first screenful less discoverable than the one before it. The
 * groups flow into balanced columns (`columns-[320px]`, each `Section` a
 * whole card), so growth spends the width first and the scroll last.
 * ------------------------------------------------------------------ */

import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Download, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { refreshFeed } from "@/lib/feeds";
import { canVibrate } from "@/lib/feedback";
import { formatCount, formatLifeDate, lifeSpan } from "@/lib/life";
import { notify } from "@/lib/notify";
import { REMIND_LEADS } from "@/lib/remind";
import {
  AMBIENT_DELAYS,
  LIFE_EXPECTANCY_RANGE,
  TOTALS_POSITIONS,
  YEAR_QUOTE_MAX,
  hostLabel,
  store,
} from "@/lib/store";
import { PLACE_OPTIONS, placeForZone } from "@/lib/places";
import { sunTimes } from "@/lib/sun";
import {
  allZones,
  atMinutes,
  dayKey,
  formatTimeShort,
  fromDayKey,
  startOfDay,
  zoneLabel,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Calendar } from "@/lib/events";
import { useFocusTrap } from "@/components/react/hooks";
import type { SettingsPanelProps } from "@/components/react/types";
import {
  DateField,
  FieldRow,
  IconButton,
  Kbd,
  NumberField,
  PositionField,
  Segmented,
  Select,
  Toggle,
} from "@/components/react/ui/primitives";
import { CalendarMark } from "@/components/react/ui/icons";

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

/** The auto-ambient delays, as the row prints them. `0` is the only one that
 *  is not a duration, and it is the default. */
const AMBIENT_OPTIONS = AMBIENT_DELAYS.map((minutes) => ({
  value: String(minutes),
  label: minutes === 0 ? "Never" : minutes === 60 ? "After 1 hour" : `After ${minutes} min`,
}));

/** The nine cells of the totals picker, row-major, each named for a reader
 *  who cannot see which cell it is. */
const TOTALS_LABELS = [
  "Top left",
  "Top",
  "Top right",
  "Left",
  "Centre",
  "Right",
  "Bottom left",
  "Bottom",
  "Bottom right",
];
const TOTALS_OPTIONS = TOTALS_POSITIONS.map((value, i) => ({ value, label: TOTALS_LABELS[i] }));

/** The lead times, as the row prints them. `0` is the only one that is not a
 *  duration, and it is the one that says what the whole feature is for. */
const REMIND_OPTIONS = REMIND_LEADS.map((minutes) => ({
  value: String(minutes),
  label: minutes === 0 ? "As it starts" : `${minutes} min before`,
}));

function relativeAge(at: number): string {
  if (!at) return "never pulled";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A group of rows under one word, as a card. The titles are the panel's
 *  only orientation, and a card is what lets the group be moved into a
 *  column without its rows coming apart from their heading — `break-inside`
 *  keeps it whole. Brighter than a `FieldRow` label on purpose: a section
 *  names the rows, so it cannot sit at their weight. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3 break-inside-avoid overflow-hidden rounded-[12px] border border-hairline">
      <h3 className="label border-b border-hairline px-3.5 py-2 text-ink-2">{title}</h3>
      {children}
    </section>
  );
}

export default function Settings({
  open,
  onClose,
  settings,
  calendars,
  actions,
}: SettingsPanelProps) {
  const {
    clock,
    secondZone,
    showZoneName,
    showZoneOffset,
    zoneDaylight,
    zoneMoonlight,
    place,
    daylight,
    moonlight,
    arcLabels,
    ambientAfter,
    ambientDim,
    ambientDaylight,
    ambientMoonlight,
    ambientZoneRing,
    ambientArcLabels,
    totals,
    totalsAt,
    tickSound,
    tickHaptics,
    birth,
    lifeExpectancy,
    milestones,
    yearQuote,
    inheritMarks,
    moonPhase,
    remind,
    remindLead,
  } = settings;
  const reducedMotion = useReducedMotion();
  const [feedUrl, setFeedUrl] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const dialog = useFocusTrap<HTMLDivElement>(open);

  const subscriptions = calendars.filter((c) => c.feed);
  const sun = place ? sunTimes(startOfDay(new Date()), place) : null;
  /**
   * The second zone can only carry a band if the coordinate table knows it:
   * the zone picker offers everything the browser does, which includes `UTC`
   * and a few aliases that have no place behind them. No coordinates, no
   * switch — an offer we cannot keep is worse than one we never made.
   */
  const zonePlace = secondZone ? placeForZone(secondZone) : null;
  /** Same rule for the vibration switch: no motor, no offer. Desktop and iOS
   *  are both in that camp, and only the sound half is shown there. */
  const vibrates = canVibrate();

  /** The life the grid would draw with what is set right now — the row prints
   *  where it ends, so the number beside it is never an abstraction. Plain
   *  derivation, not a memo: this card renders when it is opened. */
  const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(birth) ? fromDayKey(birth) : null;
  const span = birthDate ? lifeSpan(birthDate, lifeExpectancy) : null;

  function pickPlace(zone: string) {
    store.setPlace(zone ? placeForZone(zone) : null);
  }

  /**
   * Turning reminders on is the one switch here that has to ask somebody
   * else. Both Chrome and Safari require the prompt to come out of a user
   * gesture, which is why this hangs off the switch rather than off an
   * effect watching the setting — and the setting only goes on if the answer
   * came back `granted`, so a blocked site cannot end up with a switch that
   * says it is on and a browser that will not deliver.
   */
  async function toggleRemind(on: boolean) {
    if (!on) {
      store.setToggle("remind", false);
      return;
    }
    if (typeof Notification === "undefined") {
      notify("This browser has no notifications", "error");
      return;
    }
    const granted =
      Notification.permission === "granted" ||
      (await Notification.requestPermission()) === "granted";
    store.setToggle("remind", granted);
    if (!granted) notify("Notifications are blocked for this site", "error");
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
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            /* Nothing here autofocuses — the first control is the close button
               and a settings panel that opens with a ring on Close reads as a
               warning. The container takes focus instead, which is what the
               trap needs to keep Tab inside. */
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[min(900px,92vh)] min-h-[min(560px,82vh)] w-[min(1240px,94vw)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
            initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
              <h2 className="text-[17px] font-medium text-ink">Settings</h2>
              <span className="flex items-center gap-3">
                <span className="caption hidden sm:inline">
                  <Kbd>Esc</Kbd> to close
                </span>
                <IconButton label="Close settings" onClick={onClose}>
                  <X size={15} strokeWidth={1.75} />
                </IconButton>
              </span>
            </div>

            <div className="no-scrollbar flex-1 columns-[320px] gap-3 overflow-y-auto p-3 [--field-label:88px]">
              <Section title="Face">
                <FieldRow label="Dial" align="top">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    <Segmented
                      value={clock}
                      onChange={actions.setClock}
                      options={[
                        { id: "12h" as const, label: "12 h" },
                        { id: "24h" as const, label: "24 h" },
                      ]}
                    />
                    {/* The face's other word: how the day is spent. Off by
                      default, so it sits beside the face it annotates rather
                      than in a row of its own. */}
                    <Toggle
                      label="Totals"
                      name="Day totals"
                      checked={totals}
                      onChange={(on) => store.setToggle("totals", on)}
                    />
                  </div>
                  {totals && (
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                      <PositionField
                        value={totalsAt}
                        onChange={store.setTotalsAt}
                        options={TOTALS_OPTIONS}
                        label="Where the totals sit"
                      />
                      <span className="label text-ink-3">Where it sits on the face</span>
                    </div>
                  )}
                  {/* Its own line: three segments will not sit beside the face
                    and the totals switch inside 310px, and this is the one
                    setting here that changes what an arc *is* rather than
                    what the face is called. */}
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    <Segmented
                      value={arcLabels}
                      onChange={store.setArcLabels}
                      options={[
                        { id: "always" as const, label: "Always" },
                        { id: "hover" as const, label: "Hover" },
                        { id: "off" as const, label: "Off" },
                      ]}
                    />
                    {/* Two words: "Names on arcs" wraps at this column width,
                      and a caption on two lines beside a control on one reads
                      as a row that has come apart. */}
                    <span className="label text-ink-3">Arc names</span>
                  </div>
                </FieldRow>

                {/* A mark lives on calendars and events, not on the dial's
                  geometry — but whether a bare event borrows one is still a
                  question of what an arc prints, which is the question "Arc
                  names" answers above, so it sits here rather than opening a
                  section of its own. Two words, because the `Life` card's own
                  `Marks` row is about the milestone rings: one label per
                  meaning, or the panel stops being a map. */}
                <FieldRow label="Event marks" align="top">
                  <Toggle
                    label="Inherit"
                    name="Bare events show the calendar's mark"
                    checked={inheritMarks}
                    onChange={(on) => store.setToggle("inheritMarks", on)}
                  />
                  <span className="caption">
                    Off, an event with no mark of its own is just its colour; on, it borrows the
                    calendar's — sensible with one calendar per kind of thing, redundant with one
                    calendar per person
                  </span>
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
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Toggle
                        label="City name"
                        checked={showZoneName}
                        onChange={(on) => store.setToggle("showZoneName", on)}
                      />
                      <Toggle
                        label="Offset"
                        checked={showZoneOffset}
                        onChange={(on) => store.setToggle("showZoneOffset", on)}
                      />
                      {zonePlace && (
                        <>
                          <Toggle
                            label="Daylight"
                            name="Second ring daylight"
                            checked={zoneDaylight}
                            onChange={(on) => store.setToggle("zoneDaylight", on)}
                          />
                          <Toggle
                            label="Moonlight"
                            name="Second ring moonlight"
                            checked={zoneMoonlight}
                            onChange={(on) => store.setToggle("zoneMoonlight", on)}
                          />
                        </>
                      )}
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
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Toggle
                        label="Daylight"
                        checked={daylight}
                        onChange={(on) => store.setToggle("daylight", on)}
                      />
                      <Toggle
                        label="Moonlight"
                        checked={moonlight}
                        onChange={(on) => store.setToggle("moonlight", on)}
                      />
                    </div>
                  )}
                  <span className="caption tabular-nums">
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

                {/* Ambient is a display mode, so what it shows is its own
                  question — and every switch here can only take away what the
                  working face already draws. A mode is not an argument with a
                  choice the user already made. */}
                <FieldRow label="Ambient" align="top" last>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    <Select
                      value={String(ambientAfter)}
                      onChange={(next) => store.setAmbientAfter(Number(next))}
                      label="Start ambient after"
                      options={AMBIENT_OPTIONS}
                    />
                    <span className="label text-ink-3">Start on its own</span>
                  </div>
                  {/* Every one of these annotates something that has to exist
                    first, so with a bare dial the row is not empty — it is
                    not there. An empty flex row is a gap nobody can explain.

                    The two halves are ambient's own, not a view of the ones
                    above: only the place is shared, because a person is
                    somewhere and that is not a property of a mode. */}
                  {(place || secondZone) && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      {place && (
                        <>
                          <Toggle
                            label="Daylight"
                            name="Ambient daylight"
                            checked={ambientDaylight}
                            onChange={(on) => store.setToggle("ambientDaylight", on)}
                          />
                          <Toggle
                            label="Moonlight"
                            name="Ambient moonlight"
                            checked={ambientMoonlight}
                            onChange={(on) => store.setToggle("ambientMoonlight", on)}
                          />
                          <Toggle
                            label="Dusk dim"
                            name="Dim with the lightcycle"
                            checked={ambientDim}
                            onChange={(on) => store.setToggle("ambientDim", on)}
                          />
                        </>
                      )}
                      {secondZone && (
                        <Toggle
                          label="2nd ring"
                          name="Second ring in ambient"
                          checked={ambientZoneRing}
                          onChange={(on) => store.setToggle("ambientZoneRing", on)}
                        />
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    <Segmented
                      value={ambientArcLabels}
                      onChange={store.setAmbientArcLabels}
                      options={[
                        { id: "always" as const, label: "Always" },
                        { id: "hover" as const, label: "Hover" },
                        { id: "off" as const, label: "Off" },
                      ]}
                    />
                    <span className="label text-ink-3">Arc names</span>
                  </div>
                  <span className="caption">
                    Chrome away, dial to the window — <Kbd>F</Kbd>, or <Kbd>⇧F</Kbd> for the whole
                    screen
                  </span>
                </FieldRow>
              </Section>

              {/* Its own card, because the sidebar is its own surface. The
                  moon is the one thing in this app that draws something the
                  calendar does not contain, and filing it under Face would
                  claim it is on the dial — the one place the "do not add a
                  ring" rule says it may never be. */}
              <Section title="Sidebar">
                <FieldRow label="Moon" align="top" last>
                  <Segmented
                    value={moonPhase}
                    onChange={store.setMoonPhase}
                    options={[
                      { id: "off" as const, label: "Off" },
                      { id: "minimal" as const, label: "Minimal" },
                      { id: "aperture" as const, label: "Aperture" },
                    ]}
                  />
                  <span className="caption">
                    The phase of the selected day. Minimal draws the terminator; Aperture rides the
                    disc behind a window and lets its lobes cut the crescent, which is what the
                    mechanism on a wrist does
                  </span>
                </FieldRow>
              </Section>

              <Section title="Year">
                <FieldRow label="Quote" align="top" last>
                  <input
                    type="text"
                    value={yearQuote}
                    onChange={(e) => store.setYearQuote(e.target.value)}
                    maxLength={YEAR_QUOTE_MAX}
                    placeholder="Say something"
                    aria-label="The line under the year ring"
                    className="h-8 w-full min-w-0 rounded-[8px] bg-surface-2 px-2 text-[13px] text-ink placeholder:text-ink-3"
                  />
                  <span className="caption">
                    Printed in the middle of the ring, under the year. Empty leaves it bare
                  </span>
                </FieldRow>
              </Section>

              <Section title="Life">
                <FieldRow label="Span" align="top">
                  <div className="flex flex-wrap items-center gap-2">
                    <DateField
                      label="Date of birth"
                      value={birth}
                      onChange={(next) => store.setLife(next, lifeExpectancy)}
                      min="1900-01-01"
                      max={dayKey(new Date())}
                      className="w-[150px]"
                    >
                      <span className="truncate tabular-nums">
                        {birthDate ? formatLifeDate(birthDate) : "Not set"}
                      </span>
                    </DateField>
                    <NumberField
                      label="Life expectancy in years"
                      value={lifeExpectancy}
                      onChange={(next) => store.setLife(birth, next)}
                      suffix="years"
                      min={LIFE_EXPECTANCY_RANGE.min}
                      max={LIFE_EXPECTANCY_RANGE.max}
                    />
                  </div>
                  <span className="caption tabular-nums">
                    {span
                      ? `${formatCount(span.days)} days — one dot each, ending around ${formatLifeDate(span.death)}`
                      : "One dot per day for a whole life. The date is asked for once and never leaves this browser"}
                  </span>
                </FieldRow>
                <FieldRow label="Marks" align="top" last>
                  <Toggle
                    label="Milestones"
                    checked={milestones}
                    onChange={(on) => store.setToggle("milestones", on)}
                  />
                  <span className="caption">
                    Rings the round days: the ten-thousandth, the twenty-thousandth, the midpoint.
                    Click one for what it means
                  </span>
                </FieldRow>
              </Section>

              <Section title="Reminders">
                <FieldRow label="Notify" align="top" last>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    <Toggle
                      label="On"
                      name="Notify before an event starts"
                      checked={remind}
                      onChange={(on) => void toggleRemind(on)}
                    />
                    {remind && (
                      <Select
                        value={String(remindLead)}
                        onChange={(next) => store.setRemindLead(Number(next))}
                        label="How much warning"
                        options={REMIND_OPTIONS}
                      />
                    )}
                  </div>
                  {/* Said out loud, because the absence is the interesting
                      part: a calendar that never tells you anything is a
                      viewer, and the reason this one only speaks while it is
                      open is the same reason it has no account. Leaving that
                      to be discovered is how a missed meeting becomes a bug
                      report. */}
                  <span className="caption">
                    Only while circal is open, in this tab. Reminders with it closed would need a
                    server to push them, and nothing here leaves this browser
                  </span>
                </FieldRow>
              </Section>

              <Section title="Feedback">
                {/* No caption: two switches whose labels are the whole of what
                  they do, and the app demonstrates the rest the moment either
                  is on. */}
                <FieldRow label="Cues" align="top" last>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Toggle
                      label="Sound"
                      checked={tickSound}
                      onChange={(on) => store.setToggle("tickSound", on)}
                    />
                    {vibrates && (
                      <Toggle
                        label="Vibration"
                        checked={tickHaptics}
                        onChange={(on) => store.setToggle("tickHaptics", on)}
                      />
                    )}
                  </div>
                </FieldRow>
              </Section>

              <Section title="Data">
                <FieldRow label="Feeds" align="top">
                  {subscriptions.length === 0 && (
                    <span className="caption">
                      Paste a public ICS link — read-only, refreshed on launch
                    </span>
                  )}
                  {subscriptions.map((calendar) => (
                    <div key={calendar.id} className="flex items-center gap-2">
                      <CalendarMark icon={calendar.icon} color={calendar.color} size={14} />
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

                <FieldRow label="Backup" align="top" last>
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
                  <span className="caption">
                    Events live only in this browser. A backup is the only copy that survives it
                  </span>
                </FieldRow>
              </Section>

              <Section title="About">
                <FieldRow label="Manifesto" align="top" last>
                  {/* An anchor rather than a button: it is a real page, so
                      middle-click and "open in new tab" have to work. It opens
                      in one deliberately — installed standalone there is no
                      back button, and navigating away would also cost a reload
                      of a clock that is currently running. */}
                  <a
                    href="/manifesto/"
                    target="_blank"
                    rel="noopener"
                    className="flex h-8 w-fit items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-white/10"
                  >
                    <ArrowUpRight size={13} strokeWidth={1.75} />
                    Why a day is a circle
                  </a>
                  <span className="caption">
                    One page on what this is, and what it will not become
                  </span>
                </FieldRow>
              </Section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Feed meta line: a failing subscription is the one place chrome goes red. */
function feedMetaClass(error?: string): string {
  return cn("label truncate text-[10px]", error ? "text-danger" : "text-ink-3");
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
