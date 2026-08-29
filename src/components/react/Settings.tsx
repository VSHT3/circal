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

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarPlus,
  Clock,
  Download,
  HardDrive,
  Info,
  KeyRound,
  LayoutGrid,
  Link2,
  Mail,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlink2,
  Upload,
  X,
} from "lucide-react";
import {
  CODE_MAX,
  LOCKED,
  cloud,
  cloudStartedEmpty,
  cloudSupported,
  useCloud,
} from "@/lib/cloudLink";
import { refreshFeed } from "@/lib/feeds";
import { canVibrate } from "@/lib/feedback";
import { formatCount, formatLifeDate, lifeSpan } from "@/lib/life";
import { notify } from "@/lib/notify";
import { mirror, mirrorSupported, useMirror } from "@/lib/mirrorLink";
import { REMIND_LEADS, remindLabel } from "@/lib/remind";
import {
  AMBIENT_DELAYS,
  BACKUP_INTERVALS,
  LIFE_EXPECTANCY_RANGE,
  TOTALS_POSITIONS,
  YEAR_QUOTE_MAX,
  hostLabel,
  store,
} from "@/lib/store";
import { PLACE_OPTIONS, placeForZone } from "@/lib/places";
import { countStamped, stampedPlaces } from "@/lib/travel";
import { sunTimes } from "@/lib/sun";
import { MIN_DURATION } from "@/lib/quickadd";
import {
  MINUTES_PER_DAY,
  allZones,
  atMinutes,
  dayKey,
  formatDuration,
  formatTimeShort,
  fromDayKey,
  startOfDay,
  zoneLabel,
  type WeekStart,
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
  MOD,
  NumberField,
  PositionField,
  Segmented,
  Select,
  TextField,
  TimeField,
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

/** The lead times, as the row prints them — in `remindLabel`'s voice, which
 *  is the event editor's too: one number said one way, on both surfaces that
 *  offer it. */
const REMIND_OPTIONS = REMIND_LEADS.map((minutes) => ({
  value: String(minutes),
  label: remindLabel(minutes),
}));

/** The backup intervals, as the row prints them. */
const BACKUP_OPTIONS = BACKUP_INTERVALS.map((days) => ({
  value: String(days),
  label: `Every ${days} days`,
}));

function relativeAge(at: number): string {
  if (!at) return "never pulled";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** "just now" / "3m ago" / "1h 20m ago" — reuses `formatDuration` so a
 *  mirror's age reads in the same voice as every other duration in the app,
 *  rather than inventing a second one for this single caption. */
function mirrorAge(at: number): string {
  if (!at) return "never";
  const minutes = (Date.now() - at) / 60_000;
  return minutes < 1 ? "just now" : `${formatDuration(minutes)} ago`;
}

/**
 * Signing in to the cloud copy is three questions in order — an address, the
 * code that address received, then the passphrase the copy is sealed with —
 * and the third is asked again on every new device, where the first two are
 * not.
 */
type Asking = "email" | "code" | "passphrase";

/**
 * What the panel has *done*, which is deliberately not the same list as what
 * it is asking for. A gesture is recorded the moment it has been made and the
 * transport's own state then says whether it took: `answered` plus `error` is
 * a refused code, where `answered` plus `prompt` is a session. Keeping the two
 * apart is what stops the panel from having to guess a verdict it can read.
 */
type Stage = "email" | "sent" | "answered" | "opened";

interface SignIn {
  stage: Stage;
  email: string;
  code: string;
  passphrase: string;
}

/** A group of rows under one word, as a card. The titles are the panel's
 *  only orientation, and a card is what lets the group be moved into a
 *  column without its rows coming apart from their heading — `break-inside`
 *  keeps it whole. Brighter than a `FieldRow` label on purpose: a section
 *  names the rows, so it cannot sit at their weight. */
function Section({
  title,
  info,
  onInfo,
  children,
}: {
  title: string;
  /** The card's explanation, shown in the info dialog behind the header's
   *  "i". Prose lives there so the rows themselves stay controls plus a line
   *  of status; warnings that belong to a *decision* stay on the row. */
  info?: ReactNode;
  onInfo?: (next: InfoText) => void;
  children: ReactNode;
}) {
  return (
    <section className="mb-3 break-inside-avoid overflow-hidden rounded-[12px] border border-hairline">
      <div className="flex min-h-[35px] items-center justify-between border-b border-hairline pr-1 pl-3.5">
        <h3 className="label text-ink-2">{title}</h3>
        {info && onInfo && (
          <IconButton label={`About ${title}`} onClick={() => onInfo({ title, body: info })}>
            <Info size={13} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>
      {children}
    </section>
  );
}

/** What the info dialog is showing: a section's word and its prose. */
interface InfoText {
  title: string;
  body: ReactNode;
}

/** One named explanation inside the info dialog: the row's word, then its
 *  sentence — the glossary shape every card's `info` shares. */
function InfoEntry({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label text-[12px] text-ink-2">{name}</span>
      <span>{children}</span>
    </div>
  );
}

/** The panel's map: five places a setting can be found, instead of one wall
 *  of cards. Mirror and cloud stay beside Backup under Data because their
 *  captions reference each other; "one live copy at a time" has to be
 *  readable from both sides. */
const TABS = [
  { id: "face", label: "Face", icon: Clock },
  { id: "views", label: "Views", icon: LayoutGrid },
  { id: "events", label: "Events", icon: CalendarPlus },
  { id: "data", label: "Data", icon: HardDrive },
  { id: "about", label: "About", icon: Info },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Settings({
  open,
  onClose,
  settings,
  events,
  calendars,
  actions,
}: SettingsPanelProps) {
  const {
    theme,
    clock,
    stampedZones,
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
    lifeLoupe,
    yearQuote,
    inheritMarks,
    moon,
    remind,
    remindLead,
    backupNudge,
    backupInterval,
    defaultDuration,
    defaultCalendar,
    weekStart,
    wakingFrom,
    wakingTo,
    autoSchedule,
  } = settings;
  const reducedMotion = useReducedMotion();
  const [feedUrl, setFeedUrl] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const dialog = useFocusTrap<HTMLDivElement>(open);
  const mirrorStatus = useMirror();
  const cloudStatus = useCloud();
  /** Which tab is showing. Kept across open and close on purpose: the panel
   *  stays mounted, and reopening lands where the last change was made. */
  const [tab, setTab] = useState<TabId>("face");

  /** The open info card, if any — one small dialog for every section's "i".
   *  Dropped when the panel closes: the panel stays mounted, and a reopened
   *  panel starting under a stale explanation would read as a fault. */
  const [info, setInfo] = useState<InfoText | null>(null);
  const infoCard = useRef<HTMLDivElement | null>(null);
  if (!open && info) setInfo(null);

  /** Roving tablist keyboard: arrows move selection and focus together. Safe
   *  to claim arrows here — the shell's own ←/→ hotkeys are off while a
   *  panel is up. */
  function onTabKey(e: KeyboardEvent<HTMLElement>) {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(at + delta + TABS.length) % TABS.length].id;
    setTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  }

  /**
   * The info card claims Escape and Tab on a `window` capture listener while
   * it is up — the editor's own mechanism: the shell's Escape is a bubble
   * listener that would close the whole panel under the card, and the panel's
   * focus trap would walk Tab through controls behind the scrim. The card has
   * exactly one control, so Tab has exactly one place to go. Focus is handed
   * back to the "i" that opened it.
   */
  useEffect(() => {
    if (!info) return;
    const back = document.activeElement as HTMLElement | null;
    infoCard.current?.focus({ preventScroll: true });
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setInfo(null);
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        infoCard.current?.querySelector("button")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (back?.isConnected) back.focus();
    };
  }, [info]);
  /**
   * The sign-in flow, as one value rather than four `useState`s: it is one
   * gesture in three steps, and a stage that could disagree with the text it
   * is collecting is a stage that will.
   */
  const [signIn, setSignIn] = useState<SignIn>({
    stage: "email",
    email: "",
    code: "",
    passphrase: "",
  });
  /** One round trip in flight. `unlock` is 600k PBKDF2 rounds, so this is a
   *  visible fraction of a second and a second press would derive the key
   *  twice. */
  const [signingIn, setSigningIn] = useState(false);

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
  /** Same rule for the mirror: no file handle, no offer — an unusable
   *  Connect button is worse than a section that says plainly it cannot. */
  const canMirror = mirrorSupported();
  /**
   * Same rule again, and the strictest of the three: with no
   * `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_PUBLISHABLE_KEY` the section is
   * *absent*, not disabled and not explained. A fork that never configured a
   * project should not learn from this panel that the feature exists.
   */
  const canCloud = cloudSupported();
  /**
   * One live copy at a time, and the panel is where that is enforced —
   * `SYNC.md`'s "the first cut should still be one at a time", which the
   * transport deliberately left to this surface. `off` is the only state
   * either link is not holding something: a `prompt` is a remembered handle
   * or a signed-in session, and an `error` is one gesture from writing. So
   * each side's *advancing* verbs go when the other is engaged, while its
   * retreating ones never do — a reader who arrives with both remembered
   * (a session from before the file was picked) must be able to let one go.
   */
  const mirrorEngaged = canMirror && mirrorStatus.state !== "off";
  const cloudEngaged = canCloud && cloudStatus.state !== "off";
  /** The one message the panel reads rather than only prints: a locked box
   *  wants the passphrase again, where every other failure wants a retry.
   *  Compared against the transport's own constant, so there is still exactly
   *  one place that sentence is written. */
  const cloudLocked = cloudStatus.message === LOCKED;

  /**
   * Whether this browser is holding the derived key, asked of the transport
   * rather than stored here: the IndexedDB record *is* the switch, so a second
   * copy of that fact in a `Settings` field would be a copy to keep in step —
   * and a synced one would arm this on every other device, which is the one
   * thing "on this device" cannot mean.
   *
   * Re-asked whenever the link's state changes, because a key discarded as
   * stale by `resume` puts the row back to `prompt` and the switch back to off
   * without this surface doing anything.
   */
  const [remembering, setRemembering] = useState(false);
  useEffect(() => {
    let live = true;
    void cloud.remembering().then((on) => {
      if (live) setRemembering(on);
    });
    return () => {
      live = false;
    };
  }, [cloudStatus.state]);

  async function setRemember(on: boolean) {
    setRemembering(on);
    await cloud.remember(on);
  }

  /**
   * The second press. Local to this surface, and dropped the moment the link
   * stops being live, so a confirm strip can never be left standing over a
   * link that has already gone.
   *
   * The **render-phase adjustment** `AGENTS.md` makes a hard convention, and
   * not an effect: `react-hooks/set-state-in-effect` is right to refuse one
   * here, which would render the stale confirm and then render again to take
   * it down. React re-runs this component before touching the DOM, so it is
   * never painted.
   *
   * No `seeded` sentinel, unlike `Sidebar`'s: that shape resets on a prop
   * *changing*, and this is an invariant — a confirm may not stand while the
   * link is not live, however it got there. The `deleting &&` guard is what
   * makes the assignment terminate, and it is the whole of what the sentinel
   * would be buying.
   */
  const [deleting, setDeleting] = useState(false);
  if (deleting && cloudStatus.state !== "live" && !cloudLocked) setDeleting(false);

  /**
   * Which of the three the panel is asking for — the gesture made, read
   * against the verdict the transport has already published, so no failure
   * leaves a field standing for a question that was answered.
   *
   * An empty `name` is the sharpest of them: `requestCode` sets the address on
   * the status only where the code actually went out, so no name means nothing
   * was sent and the address is what to ask for again. `answered` splits on
   * the state for the same reason — `error` there is a refused code, and
   * asking for a passphrase to a session that does not exist would send the
   * user round the whole flow to find out.
   *
   * `cloudLocked` overrides all of it: a box that will not open is the
   * passphrase's own failure whenever it happens, including on a link that was
   * live an hour ago.
   */
  const asking: Asking = cloudLocked
    ? "passphrase"
    : cloudStatus.state === "off" || !cloudStatus.name
      ? "email"
      : signIn.stage === "sent"
        ? "code"
        : signIn.stage === "answered" && cloudStatus.state === "error"
          ? "code"
          : "passphrase";

  /** The life the grid would draw with what is set right now — the row prints
   *  where it ends, so the number beside it is never an abstraction. Plain
   *  derivation, not a memo: this card renders when it is opened. */
  const birthDate = /^\d{4}-\d{2}-\d{2}$/.test(birth) ? fromDayKey(birth) : null;
  const span = birthDate ? lifeSpan(birthDate, lifeExpectancy) : null;

  /**
   * The stamps *this app* applied, and the places they name — scoped to
   * `stampedZones`, never "every event with a zone on it". An imported `.ics`
   * lands in the same list carrying zones out of a file, and a colleague's
   * 09:00 New York standup is not this row's to flatten.
   *
   * Both derivations come from what the events actually carry rather than from
   * the setting alone, so a remembered zone that has outlived its events
   * counts nothing and shows no row.
   */
  const stampCount = countStamped(events, stampedZones);
  const stampPlaces = stampedPlaces(events, stampedZones);

  /** Undoable, and it says so: the stamp was a decision made in one click,
   *  and so is taking it off. */
  function clearStamps() {
    const cleared = store.clearEventZones();
    if (cleared > 0) {
      notify(`${cleared} event${cleared === 1 ? "" : "s"} floating again`);
    }
  }

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

  /**
   * The three gestures. Each is one round trip and each records that it was
   * made — never that it worked, which is the transport's word and is already
   * on the status by the time this returns. `asking` reads the two together.
   *
   * `finally`, in every one of them: a verb that throws before its reset — a
   * failed supabase-js chunk fetch was the measured case — left `signingIn`
   * wedged `true` and every cloud button dead until a reload, since this
   * panel stays mounted across open and close.
   */
  async function sendCode() {
    const email = signIn.email.trim();
    if (!email || signingIn) return;
    setSigningIn(true);
    try {
      await cloud.requestCode(email);
      setSignIn((flow) => ({ ...flow, stage: "sent", code: "" }));
    } finally {
      setSigningIn(false);
    }
  }

  async function submitCode() {
    const code = signIn.code.trim();
    if (!code || signingIn) return;
    setSigningIn(true);
    try {
      await cloud.submitCode(signIn.email.trim(), code);
      setSignIn((flow) => ({ ...flow, stage: "answered", code: "" }));
    } finally {
      setSigningIn(false);
    }
  }

  /** The passphrase is dropped from state the moment it has been used: the
   *  key it derives lives in the transport for the session, and a field this
   *  panel keeps holding it is a copy nothing needs. */
  async function unlockCloud() {
    const passphrase = signIn.passphrase;
    if (!passphrase || signingIn) return;
    setSigningIn(true);
    try {
      await cloud.unlock(passphrase);
      setSignIn((flow) => ({ ...flow, stage: "opened", passphrase: "" }));
    } finally {
      setSigningIn(false);
    }
  }

  /**
   * Back to the address, which is the whole reason the code is a step of its
   * own: a mistyped address sends a code to somebody else, and a flow that
   * cannot go back leaves a reload as the only way out.
   *
   * It signs out rather than merely rewinding, so a code already requested
   * against the old address is dropped with it rather than left able to
   * complete. The address itself is kept, which makes correcting it an edit
   * rather than a retype.
   */
  async function changeAddress() {
    await cloud.disconnect();
    setSignIn((flow) => ({ ...flow, stage: "email", code: "", passphrase: "" }));
  }

  async function signOut() {
    await cloud.disconnect();
    setSignIn({ stage: "email", email: "", code: "", passphrase: "" });
  }

  /**
   * The row goes, and the link goes with it — the transport does both, in that
   * order, because a link left live over a deleted row publishes it again on
   * the next edit.
   *
   * The confirm is dropped either way. On success the row is gone and there is
   * nothing left to ask about; on failure the transport has put the link back
   * and printed why, and a confirm strip still standing over that sentence
   * would be asking the user to press through an error.
   */
  async function deleteCopy() {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await cloud.deleteCopy();
    } finally {
      setSigningIn(false);
      setDeleting(false);
      setSignIn({ stage: "email", email: "", code: "", passphrase: "" });
    }
  }

  /**
   * Whichever of the three the flow is on. One renderer rather than a copy
   * per state, because `prompt` and a recoverable `error` ask for exactly the
   * same thing — the difference between them is the sentence above it, which
   * is the transport's to write.
   */
  function cloudFields() {
    if (asking === "email") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <TextField
            type="email"
            inputMode="email"
            autoComplete="email"
            value={signIn.email}
            onChange={(email) => setSignIn((flow) => ({ ...flow, email }))}
            onEnter={() => void sendCode()}
            label="Email address"
            placeholder="you@example.com"
            className="flex-1 basis-[140px]"
          />
          <DataButton
            icon={<Mail size={13} strokeWidth={1.75} />}
            onClick={() => void sendCode()}
            disabled={!signIn.email.trim() || signingIn}
          >
            Send code
          </DataButton>
        </div>
      );
    }

    if (asking === "code") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <TextField
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_MAX}
            value={signIn.code}
            onChange={(code) => setSignIn((flow) => ({ ...flow, code }))}
            onEnter={() => void submitCode()}
            label="Sign-in code"
            placeholder="Code from the email"
            className="flex-1 basis-[150px] tabular-nums"
          />
          <DataButton
            icon={<Link2 size={13} strokeWidth={1.75} />}
            onClick={() => void submitCode()}
            disabled={!signIn.code.trim() || signingIn}
          >
            Sign in
          </DataButton>
          <DataButton
            icon={<ArrowLeft size={13} strokeWidth={1.75} />}
            onClick={() => void changeAddress()}
          >
            Change address
          </DataButton>
          {/* An expired or lost code should not cost the round trip through
              Change address, which signs the session out on its way. Same
              verb as the first send; the transport reprints "a code is on
              its way" over the status. */}
          <DataButton
            icon={<Mail size={13} strokeWidth={1.75} />}
            onClick={() => void sendCode()}
            disabled={signingIn}
          >
            Send a new code
          </DataButton>
        </div>
      );
    }

    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <TextField
            type="password"
            autoComplete="current-password"
            value={signIn.passphrase}
            onChange={(passphrase) => setSignIn((flow) => ({ ...flow, passphrase }))}
            onEnter={() => void unlockCloud()}
            label="Passphrase"
            placeholder="passphrase"
            className="flex-1 basis-[140px]"
          />
          <DataButton
            icon={<KeyRound size={13} strokeWidth={1.75} />}
            onClick={() => void unlockCloud()}
            disabled={!signIn.passphrase || signingIn}
          >
            Unlock
          </DataButton>
          <DataButton
            icon={<Unlink2 size={13} strokeWidth={1.75} />}
            onClick={() => void signOut()}
          >
            Sign out
          </DataButton>
        </div>
        {deleteStrip}
        {/* The trade, at the moment the decision is made, and nowhere else —
            including not here once something has already gone wrong: the
            transport's own sentence is above this one then, and repeating what
            a passphrase costs beside "nothing was written" reads as a warning
            about the wrong thing. */}
        {cloudStatus.state !== "error" && (
          <span className="caption">
            Seals the copy; never sent, never stored. Lose it and only the cloud copy is lost
          </span>
        )}
      </>
    );
  }

  /**
   * The two-press delete, shared by the live branch and the locked one. On
   * the locked branch it is the way out of a lost passphrase — without it the
   * locked box was a dead end: Delete lived only on the live branch, so the
   * one person who most needs to start over could never reach it. Deleting
   * needs the session, never the key.
   */
  const deleteStrip =
    cloudStatus.state === "live" || cloudLocked ? (
      deleting ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <DataButton
              icon={<Trash2 size={13} strokeWidth={1.75} />}
              onClick={() => void deleteCopy()}
              disabled={signingIn}
              danger
            >
              Delete the copy
            </DataButton>
            <DataButton
              icon={<X size={13} strokeWidth={1.75} />}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </DataButton>
          </div>
          <span className="caption">
            {cloudLocked
              ? "The locked copy on the server goes; sign in again to set a new passphrase. This browser\u2019s calendar is untouched"
              : "The copy on the server goes and this browser\u2019s calendar is untouched. Your email address stays in the project\u2019s account list, with nothing attached to it"}
          </span>
        </>
      ) : (
        <DataButton
          icon={<Trash2 size={13} strokeWidth={1.75} />}
          onClick={() => setDeleting(true)}
          danger
        >
          {cloudLocked ? "Forgot it? Delete the copy and start over" : "Delete cloud copy"}
        </DataButton>
      )
    ) : null;

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
            className="relative flex max-h-[min(900px,92vh)] min-h-[min(560px,82vh)] w-[min(1240px,94vw)] flex-col overflow-hidden rounded-[14px] border border-hairline bg-surface shadow-[0_32px_80px_-20px_rgba(0,0,0,0.9)]"
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

            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              {/* One tablist, orientation by breakpoint: a rail on the left
                  where there is width, a bar of stacked icon-plus-word tabs
                  under the header where there is not. Roving tabIndex; the
                  arrows move selection and focus together. */}
              {/* A `div`, not `nav`: `tablist` may not sit on a landmark
                  element, and the tabs are one widget, not site navigation. */}
              <div
                role="tablist"
                aria-label="Settings sections"
                className="flex shrink-0 gap-0.5 border-b border-hairline p-2 sm:w-[150px] sm:flex-col sm:gap-1 sm:border-r sm:border-b-0"
              >
                {TABS.map(({ id, label, icon: Icon }) => {
                  const on = id === tab;
                  return (
                    <button
                      key={id}
                      id={`settings-tab-${id}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls="settings-tab-panel"
                      tabIndex={on ? 0 : -1}
                      onClick={() => setTab(id)}
                      onKeyDown={onTabKey}
                      className={cn(
                        "flex flex-1 flex-col items-center gap-1 rounded-[8px] px-1 py-1.5 transition-colors",
                        "sm:h-8 sm:flex-none sm:flex-row sm:justify-start sm:gap-2 sm:px-2.5 sm:py-0 sm:pointer-coarse:h-10",
                        on
                          ? "bg-(--veil-05) text-ink"
                          : "text-ink-2 hover:bg-(--veil-05) hover:text-ink",
                      )}
                    >
                      <Icon
                        size={14}
                        strokeWidth={1.75}
                        className={on ? "text-accent" : "text-ink-3"}
                      />
                      <span className="label text-[10px] sm:text-[11px]">{label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Two elements, still: the scroll container may not *be* the
                  multi-column box. With a definite height Firefox fragments a
                  multicol scroller along the inline axis — extra columns past
                  the right edge, `.no-scrollbar` hiding the evidence — where
                  Chromium grows it downwards. The inner box has auto height,
                  so there is no fragmentainer to overflow and the scroll stays
                  vertical in every browser. Keyed by tab: the remount resets
                  the scroll, so no tab inherits another's position. */}
              <motion.div
                key={tab}
                role="tabpanel"
                id="settings-tab-panel"
                aria-labelledby={`settings-tab-${tab}`}
                className="no-scrollbar min-w-0 flex-1 overflow-y-auto p-2.5 [--field-label:80px] sm:p-3 sm:[--field-label:88px]"
                initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.14, ease: EASE }}
              >
                <div className="columns-[320px] gap-3">
                  {tab === "face" && (
                    <>
                      <Section
                        title="Theme"
                        onInfo={setInfo}
                        info={
                          <p>
                            Chrome comes in three greyscales; a slider is a thousand faces nobody
                            tested. Event colours stay the same on all of them. Colour belongs to
                            events; the theme only moves the ground they sit on
                          </p>
                        }
                      >
                        <FieldRow label="Chrome" last>
                          <Segmented
                            value={theme}
                            onChange={store.setTheme}
                            options={[
                              { id: "midnight" as const, label: "Midnight" },
                              { id: "ember" as const, label: "Ember" },
                              { id: "paper" as const, label: "Paper" },
                            ]}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Dial"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Totals">
                              Booked and free hours, printed on the face. Booked counts the whole
                              day; free only your waking hours.
                            </InfoEntry>
                            <InfoEntry name="Arc names">
                              When an event's name is drawn along its arc.
                            </InfoEntry>
                            <InfoEntry name="Event marks">
                              On, an event with no mark of its own borrows its calendar's. Sensible
                              with one calendar per kind of thing; redundant with one per person.
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="Clock">
                          <Segmented
                            value={clock}
                            onChange={actions.setClock}
                            options={[
                              { id: "12h" as const, label: "12 h" },
                              { id: "24h" as const, label: "24 h" },
                            ]}
                          />
                        </FieldRow>
                        <FieldRow label="Totals">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                            <Toggle
                              label="On"
                              name="Day totals"
                              checked={totals}
                              onChange={(on) => store.setToggle("totals", on)}
                            />
                            {totals && (
                              <PositionField
                                value={totalsAt}
                                onChange={store.setTotalsAt}
                                options={TOTALS_OPTIONS}
                                label="Where the totals sit"
                              />
                            )}
                          </div>
                        </FieldRow>
                        <FieldRow label="Arc names">
                          <Segmented
                            value={arcLabels}
                            onChange={store.setArcLabels}
                            options={[
                              { id: "always" as const, label: "Always" },
                              { id: "hover" as const, label: "Hover" },
                              { id: "off" as const, label: "Off" },
                            ]}
                          />
                        </FieldRow>
                        {/* "Event marks", not "Marks": the Life card has a
                          Marks row of its own, about milestone rings. One
                          label per meaning, or the panel stops being a map. */}
                        <FieldRow label="Event marks" last>
                          <Toggle
                            label="Inherit"
                            name="Bare events show the calendar's mark"
                            checked={inheritMarks}
                            onChange={(on) => store.setToggle("inheritMarks", on)}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Rings"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="2nd ring">
                              Another timezone's hours on a ring of their own, measured against your
                              clock, with that place's own daylight.
                            </InfoEntry>
                            <InfoEntry name="Lightcycle">
                              Your place's daylight and moonlight on the rim, in place of the
                              elapsed trail.
                            </InfoEntry>
                          </>
                        }
                      >
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

                        <FieldRow label="Lightcycle" align={place ? "top" : "center"} last>
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
                          {place && (
                            <span className="caption tabular-nums">
                              {sun?.polar === "day"
                                ? "Midnight sun"
                                : sun?.polar === "night"
                                  ? "Polar night"
                                  : sun?.sunrise != null && sun.sunset != null
                                    ? `${formatTimeShort(atMinutes(new Date(), sun.sunrise), clock)} – ${formatTimeShort(atMinutes(new Date(), sun.sunset), clock)}`
                                    : "No sunrise today"}
                            </span>
                          )}
                        </FieldRow>
                      </Section>

                      {/* Ambient is a display mode, so what it shows is its own
                        question — and every switch here can only take away what
                        the working face already draws. */}
                      <Section
                        title="Ambient"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Ambient">
                              Chrome away, dial to the window. A display mode: its switches only
                              take away what the working face already draws.
                            </InfoEntry>
                            <InfoEntry name="Starts">
                              After this long with no input, the dial goes ambient on its own.
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="Starts" align="top">
                          <Select
                            value={String(ambientAfter)}
                            onChange={(next) => store.setAmbientAfter(Number(next))}
                            label="Start ambient after"
                            options={AMBIENT_OPTIONS}
                          />
                          <span className="caption">
                            Chrome away, dial to the window. <Kbd>F</Kbd>, or <Kbd>⇧F</Kbd> for the
                            whole screen
                          </span>
                        </FieldRow>
                        {/* Every one of these annotates something that has to
                          exist first, so with a bare dial the row is not empty —
                          it is not there. */}
                        {(place || secondZone) && (
                          <FieldRow label="Shows" align="top">
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
                          </FieldRow>
                        )}
                        <FieldRow label="Arc names" last>
                          <Segmented
                            value={ambientArcLabels}
                            onChange={store.setAmbientArcLabels}
                            options={[
                              { id: "always" as const, label: "Always" },
                              { id: "hover" as const, label: "Hover" },
                              { id: "off" as const, label: "Off" },
                            ]}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Feedback"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Sound">
                              A click as a drag crosses a step; a sound per key.
                            </InfoEntry>
                            <InfoEntry name="Vibration">
                              The same cues as a pulse. Offered only where the device has a motor.
                            </InfoEntry>
                          </>
                        }
                      >
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
                    </>
                  )}

                  {tab === "views" && (
                    <>
                      <Section
                        title="Week"
                        onInfo={setInfo}
                        info={
                          <p>
                            One setting moves the week strip, the mini-month and the life grid's
                            columns together, so no surface can disagree about where a week starts
                          </p>
                        }
                      >
                        <FieldRow label="Starts on" last>
                          <Segmented
                            value={String(weekStart) as "1" | "0" | "6"}
                            onChange={(next) => store.setWeekStart(Number(next) as WeekStart)}
                            options={[
                              { id: "1" as const, label: "MON" },
                              { id: "0" as const, label: "SUN" },
                              { id: "6" as const, label: "SAT" },
                            ]}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Year"
                        onInfo={setInfo}
                        info={
                          <p>
                            A line of yours, printed inside the ring under the year. Empty leaves it
                            bare, and it shows only at rest; pointing at a day replaces it with that
                            day's readout
                          </p>
                        }
                      >
                        <FieldRow label="Quote" last>
                          <input
                            type="text"
                            value={yearQuote}
                            onChange={(e) => store.setYearQuote(e.target.value)}
                            maxLength={YEAR_QUOTE_MAX}
                            placeholder="Say something"
                            aria-label="The line under the year ring"
                            className="h-8 w-full min-w-0 rounded-[8px] bg-surface-2 px-2 text-[13px] text-ink placeholder:text-ink-3"
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Life"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Span">
                              Birth date to life expectancy, one dot per day. The date stays in this
                              browser, with your calendar.
                            </InfoEntry>
                            <InfoEntry name="Marks">
                              Rings the round days: the ten-thousandth, the twenty-thousandth, the
                              midpoint. Click one for what it means.
                            </InfoEntry>
                            <InfoEntry name="Loupe">
                              Point at a day and its whole year comes up on a card, big enough to
                              read and to drag a range across.
                            </InfoEntry>
                          </>
                        }
                      >
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
                              ? `${formatCount(span.days)} days, one dot each, ending around ${formatLifeDate(span.death)}`
                              : "One dot per day for a whole life"}
                          </span>
                        </FieldRow>
                        <FieldRow label="Marks">
                          <Toggle
                            label="Milestones"
                            checked={milestones}
                            onChange={(on) => store.setToggle("milestones", on)}
                          />
                        </FieldRow>
                        <FieldRow label="Loupe" last>
                          <Toggle
                            label="Magnify the year"
                            checked={lifeLoupe}
                            onChange={(on) => store.setToggle("lifeLoupe", on)}
                          />
                        </FieldRow>
                      </Section>

                      {/* The moon is the one thing here that draws something the
                        calendar does not contain, and it lives in the sidebar —
                        never on the dial. */}
                      <Section
                        title="Sidebar"
                        onInfo={setInfo}
                        info={
                          <p>
                            The selected day's moon, drawn as the astronomy: one disc, the
                            terminator over it. Arrow through a week and it walks with you
                          </p>
                        }
                      >
                        <FieldRow label="Moon" last>
                          <Toggle
                            label="Phase"
                            name="Moon phase in the sidebar"
                            checked={moon}
                            onChange={(on) => store.setToggle("moon", on)}
                          />
                        </FieldRow>
                      </Section>
                    </>
                  )}

                  {tab === "events" && (
                    <>
                      <Section
                        title="New event"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Length">
                              The span a new event starts with when nothing names one.
                            </InfoEntry>
                            <InfoEntry name="Calendar">
                              Where {MOD}N, a drag on the dial and a quick-add line put an event.
                              Subscriptions are read-only and never offered.
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="Length">
                          <NumberField
                            label="Default event length"
                            value={defaultDuration}
                            onChange={store.setDefaultDuration}
                            suffix="min"
                            min={MIN_DURATION}
                            max={MINUTES_PER_DAY}
                          />
                        </FieldRow>
                        <FieldRow label="Calendar" last>
                          <Select
                            label="Calendar for new events"
                            value={defaultCalendar}
                            onChange={store.setDefaultCalendar}
                            options={[
                              { value: "", label: "First one" },
                              ...calendars
                                .filter((c) => !c.feed)
                                .map((c) => ({ value: c.id, label: c.name })),
                            ]}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Day"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Hours">
                              What "free" means here: the dial's totals line and the palette's slot
                              search both measure free time against these hours
                            </InfoEntry>
                            <InfoEntry name="Auto-schedule">
                              Plans your unplanned tasks into free gaps by itself, once on load and
                              when a task arrives: soonest deadline first, inside these hours, never
                              over a block you placed. The sidebar's Fill free time runs the same
                              rule by hand
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="Hours">
                          <div className="flex flex-wrap items-center gap-2">
                            <TimeField
                              label="Waking hours start"
                              clock={clock}
                              value={atMinutes(new Date(), wakingFrom)}
                              onCommit={(minutes) => store.setWaking(minutes, wakingTo)}
                            />
                            <span className="text-ink-3">–</span>
                            <TimeField
                              label="Waking hours end"
                              clock={clock}
                              value={atMinutes(new Date(), wakingTo)}
                              onCommit={(minutes) => store.setWaking(wakingFrom, minutes)}
                            />
                          </div>
                        </FieldRow>
                        <FieldRow label="Tasks" last>
                          <Toggle
                            label="Auto-schedule"
                            checked={autoSchedule}
                            onChange={(on) => store.setToggle("autoSchedule", on)}
                          />
                        </FieldRow>
                      </Section>

                      <Section
                        title="Reminders"
                        onInfo={setInfo}
                        info={
                          <p>
                            Reminders fire only while circal is open: with the tab closed they would
                            need a server pushing them at you, and circal runs nowhere but this
                            browser. All-day events never fire; timed tasks do
                          </p>
                        }
                      >
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
                          <span className="caption">Only while circal is open, in this tab</span>
                        </FieldRow>
                      </Section>
                    </>
                  )}

                  {tab === "data" && (
                    <>
                      <Section
                        title="Data"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Feeds">
                              Public ICS subscriptions, mirrored read-only and refreshed on launch.
                            </InfoEntry>
                            <InfoEntry name="Backup">
                              Events live in this browser, and "Clear site data" erases them.
                              Without a live mirror or cloud copy, a backup is the only copy that
                              survives it.
                            </InfoEntry>
                            <InfoEntry name="Nudge">
                              A line on the main screen when no backup has been saved in a while.
                              Silent while a mirror or cloud copy is live; that copy already is one.
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="Feeds" align="top">
                          {subscriptions.length === 0 && (
                            <span className="caption">
                              Paste a public ICS link. Read-only, refreshed on launch
                            </span>
                          )}
                          {subscriptions.map((calendar) => (
                            <div key={calendar.id} className="flex items-center gap-2">
                              <CalendarMark icon={calendar.icon} color={calendar.color} size={14} />
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[13px] text-ink">
                                  {calendar.name}
                                </span>
                                <span
                                  className={feedMetaClass(calendar.feed?.error)}
                                  title={calendar.feed?.error || calendar.feed?.url}
                                >
                                  {pulling === calendar.id
                                    ? "PULLING…"
                                    : calendar.feed?.error ||
                                      relativeAge(calendar.feed?.fetchedAt ?? 0)}
                                </span>
                              </span>
                              <IconButton
                                label={`Refresh ${calendar.name}`}
                                onClick={() => pull(calendar)}
                              >
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
                          <div className="flex flex-wrap items-center gap-2">
                            <TextField
                              type="url"
                              inputMode="url"
                              value={feedUrl}
                              onChange={setFeedUrl}
                              onEnter={() => void addFeed()}
                              label="Feed URL"
                              placeholder="https://…/basic.ics"
                              className="flex-1 basis-[140px]"
                            />
                            <button
                              type="button"
                              onClick={() => void addFeed()}
                              disabled={!feedUrl.trim()}
                              className="h-8 shrink-0 rounded-[8px] border border-hairline bg-surface-2 px-3 text-[13px] text-ink transition-colors hover:bg-(--veil-10) disabled:pointer-events-none disabled:opacity-35"
                            >
                              Add
                            </button>
                          </div>
                        </FieldRow>

                        {/* Only when there is something to say: after the travel
                          notice was answered with "move", or on a browser that
                          never travelled, nothing carries a stamp and a row
                          offering to clear nothing is worse than no row. */}
                        {stampCount > 0 && (
                          <FieldRow label="Zones" align="top">
                            {/* The place is in the verb, not only in the
                              sentence: "Clear 24 Berlin stamps" says what is
                              about to happen where a bare number does not. */}
                            <DataButton
                              icon={<RotateCcw size={13} strokeWidth={1.75} />}
                              onClick={clearStamps}
                            >
                              Clear {stampCount}{" "}
                              {stampPlaces.length === 1 ? `${stampPlaces[0]} ` : ""}
                              stamp{stampCount === 1 ? "" : "s"}
                            </DataButton>
                            {/* Says what the scope actually is, including the
                              part it cannot tell apart: an imported .ics event
                              naming one of these cities is indistinguishable
                              from a stamped one. */}
                            <span className="caption">
                              Stamped when this browser arrived from {stampPlaces.join(", ")}.
                              Cleared, they follow this browser's clock again; an imported event
                              naming the same place is cleared with them
                            </span>
                          </FieldRow>
                        )}

                        <FieldRow label="Backup">
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
                        </FieldRow>

                        <FieldRow label="Nudge" last>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                            <Toggle
                              label="On"
                              name="Warn when a backup is overdue"
                              checked={backupNudge}
                              onChange={(on) => store.setToggle("backupNudge", on)}
                            />
                            {backupNudge && (
                              <Select
                                value={String(backupInterval)}
                                onChange={(next) => store.setBackupInterval(Number(next))}
                                label="How long between backups"
                                options={BACKUP_OPTIONS}
                              />
                            )}
                          </div>
                        </FieldRow>
                      </Section>

                      {/* Same subject as Backup above — the only copy of the
                        user's calendar — but this copy is *live*: a file on
                        disk the app keeps in sync. It is also the one surface
                        an outside program (an AI assistant, a script) can read
                        and write without circal growing a server. */}
                      <Section
                        title="Mirror"
                        onInfo={setInfo}
                        info={
                          <>
                            <InfoEntry name="Mirror">
                              A live .json copy of the calendar in a file you choose, kept in sync
                              as you edit. It survives "Clear site data", and a local AI assistant
                              can read and write it; "Set up an assistant" walks through that.
                            </InfoEntry>
                            <InfoEntry name="One live copy">
                              One live copy at a time: while the cloud copy is signed in, the file
                              waits, and the other way round.
                            </InfoEntry>
                          </>
                        }
                      >
                        <FieldRow label="File" align="top" last>
                          {!canMirror ? (
                            <span className="caption">
                              This browser can't hold a file handle for a live mirror; a .json
                              backup still works
                            </span>
                          ) : (
                            <>
                              {/* `DataButton`, not `ActionPill` — the pill is
                                the top bar's vocabulary, where an icon is the
                                whole control. These sit beside
                                Export/Backup/Import and speak the same way. */}
                              {mirrorStatus.state === "off" && (
                                <DataButton
                                  icon={<Link2 size={13} strokeWidth={1.75} />}
                                  onClick={() => void mirror.connect()}
                                  disabled={cloudEngaged}
                                >
                                  Connect a file…
                                </DataButton>
                              )}
                              {mirrorStatus.state === "prompt" && (
                                <>
                                  <DataButton
                                    icon={<Link2 size={13} strokeWidth={1.75} />}
                                    onClick={() => void mirror.reconnect()}
                                    disabled={cloudEngaged}
                                  >
                                    Resume
                                  </DataButton>
                                  <span className="caption truncate">{mirrorStatus.name}</span>
                                </>
                              )}
                              {mirrorStatus.state === "live" && (
                                <>
                                  <span className="flex min-w-0 flex-col">
                                    <span className="truncate text-[13px] text-ink">
                                      {mirrorStatus.name}
                                    </span>
                                    <span className="caption tabular-nums">
                                      synced {mirrorAge(mirrorStatus.at)}
                                    </span>
                                  </span>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <DataButton
                                      icon={<RefreshCw size={13} strokeWidth={1.75} />}
                                      onClick={() => void mirror.syncNow()}
                                    >
                                      Sync now
                                    </DataButton>
                                    <DataButton
                                      icon={<Unlink2 size={13} strokeWidth={1.75} />}
                                      onClick={() => void mirror.disconnect()}
                                    >
                                      Disconnect
                                    </DataButton>
                                    {/* Anchor, not button — an assistant reads
                                      this file once it is live, and setup is a
                                      page, not an action. */}
                                    <a
                                      href="/assistant/"
                                      target="_blank"
                                      rel="noopener"
                                      className="flex h-8 w-fit items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-(--veil-10)"
                                    >
                                      <ArrowUpRight size={13} strokeWidth={1.75} />
                                      Set up an assistant
                                    </a>
                                  </div>
                                </>
                              )}
                              {mirrorStatus.state === "error" && (
                                <>
                                  {/* Plain `.caption`, not `text-danger`: a link
                                    that is down is not a destructive action, and
                                    the calendar is whole in `localStorage`
                                    either way. */}
                                  <span className="caption">{mirrorStatus.message}</span>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <DataButton
                                      icon={<Link2 size={13} strokeWidth={1.75} />}
                                      onClick={() => void mirror.reconnect()}
                                      disabled={cloudEngaged}
                                    >
                                      Resume
                                    </DataButton>
                                    <DataButton
                                      icon={<Unlink2 size={13} strokeWidth={1.75} />}
                                      onClick={() => void mirror.disconnect()}
                                    >
                                      Disconnect
                                    </DataButton>
                                  </div>
                                </>
                              )}
                              {/* Why the verb above is dead rather than missing:
                                the handle is still remembered and Disconnect is
                                still the way out of it. */}
                              {cloudEngaged && (
                                <span className="caption">
                                  One live copy at a time. Sign out of the cloud copy to mirror to a
                                  file instead
                                </span>
                              )}
                              {/* Said plainly, once, regardless of state: a
                                property of the feature, not a warning that goes
                                away once you already trust it. */}
                              <span className="caption">
                                Anything that can read the file can change your calendar
                              </span>
                            </>
                          )}
                        </FieldRow>
                      </Section>

                      {/* Absent, not disabled and not explained, where no
                        project is configured: a fork that never set the two env
                        vars should not learn from this panel that the feature
                        exists. */}
                      {canCloud && (
                        <Section
                          title="Cloud"
                          onInfo={setInfo}
                          info={
                            <>
                              <InfoEntry name="Cloud copy">
                                One encrypted copy of this calendar on a server, so another device
                                can read it. Signing in is a code by email, never a link to click.
                              </InfoEntry>
                              <InfoEntry name="Passphrase">
                                Set once, typed on every new device. It seals the copy in this
                                browser and is never sent; lose it and the cloud copy is lost, this
                                browser's calendar is not.
                              </InfoEntry>
                              <InfoEntry name="Stay unlocked">
                                Keeps the derived key on this device, never the passphrase. Anyone
                                with this device and browser profile can then read and change the
                                calendar on every device on the account.
                              </InfoEntry>
                              <InfoEntry name="Privacy">
                                Whoever runs the project knows the email you sign in with;
                                encrypting the calendar does not change that.
                              </InfoEntry>
                            </>
                          }
                        >
                          <FieldRow label="Account" align="top" last>
                            {mirrorEngaged ? (
                              <>
                                <span className="caption">
                                  One live copy at a time. Disconnect the mirror file to sync
                                  through the cloud instead
                                </span>
                                {/* The retreat, and only where there is
                                  something to retreat from: a session
                                  remembered from before the file was picked is
                                  the one way both are held at once. */}
                                {cloudEngaged && (
                                  <DataButton
                                    icon={<Unlink2 size={13} strokeWidth={1.75} />}
                                    onClick={() => void signOut()}
                                  >
                                    Sign out
                                  </DataButton>
                                )}
                              </>
                            ) : (
                              <>
                                {cloudStatus.state === "off" && (
                                  <>
                                    {cloudFields()}
                                    <span className="caption">
                                      An encrypted copy on a server, for your other devices
                                    </span>
                                  </>
                                )}
                                {/* The transport's own sentence, printed rather
                                  than paraphrased — a second wording is a second
                                  vocabulary to drift. */}
                                {(cloudStatus.state === "prompt" ||
                                  cloudStatus.state === "error") &&
                                  cloudStatus.message && (
                                    <span className="caption">{cloudStatus.message}</span>
                                  )}
                                {cloudStatus.state === "prompt" && cloudFields()}
                                {cloudStatus.state === "live" && (
                                  <>
                                    <span className="flex min-w-0 flex-col">
                                      <span className="truncate text-[13px] text-ink">
                                        {cloudStatus.name}
                                      </span>
                                      <span className="caption tabular-nums">
                                        synced {mirrorAge(cloudStatus.at)}
                                      </span>
                                    </span>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <DataButton
                                        icon={<RefreshCw size={13} strokeWidth={1.75} />}
                                        onClick={() => void cloud.syncNow()}
                                      >
                                        Sync now
                                      </DataButton>
                                      <DataButton
                                        icon={<Unlink2 size={13} strokeWidth={1.75} />}
                                        onClick={() => void signOut()}
                                      >
                                        Sign out
                                      </DataButton>
                                      {/* The Mirror card's anchor, for the same
                                        reason: setup is a page, not an
                                        action. */}
                                      <a
                                        href="/assistant/"
                                        target="_blank"
                                        rel="noopener"
                                        className="flex h-8 w-fit items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-(--veil-10)"
                                      >
                                        <ArrowUpRight size={13} strokeWidth={1.75} />
                                        Set up an assistant
                                      </a>
                                    </div>
                                    {/* Only while this session's sign-in found an
                                      empty slot. The auth layer cannot refuse a
                                      mistyped address — any email silently mints
                                      a fresh account — so a copy that started
                                      from nothing is the one visible symptom of
                                      "wrong address". Plain caption, never
                                      danger: nothing is lost. */}
                                    {cloudStartedEmpty() && (
                                      <span className="caption">
                                        This address had no cloud copy before this sign-in. Expected
                                        events here? They may be under a different address; any
                                        inbox holding a &ldquo;Your circal sign-in code&rdquo; email
                                        names it
                                      </span>
                                    )}
                                    {/* Only while the link is live: there is
                                      nothing to remember before a key exists.
                                      What is kept carries *write* authority over
                                      every device on the account — the card's
                                      info spells that out. */}
                                    <Toggle
                                      label="Stay unlocked"
                                      name="Remember the key for the cloud copy on this device"
                                      checked={remembering}
                                      onChange={(on) => void setRemember(on)}
                                    />
                                    {/* The other intention, and deliberately not
                                      behind Sign out: one press is "not on this
                                      device", this one is "not at all".
                                      `deleteStrip` is shared with the locked
                                      branch, where it is the way out of a lost
                                      passphrase. */}
                                    {deleteStrip}
                                  </>
                                )}
                                {/* Two failures, two remedies: a locked box
                                  wants the passphrase again, and so does a link
                                  that never completed a pass (`at` still 0).
                                  Anything else has a key in memory and a row it
                                  merely could not reach, where the retry is the
                                  whole of the fix. */}
                                {cloudStatus.state === "error" &&
                                  (cloudLocked || !cloudStatus.at ? (
                                    cloudFields()
                                  ) : (
                                    <div className="flex flex-wrap items-center gap-2">
                                      <DataButton
                                        icon={<RefreshCw size={13} strokeWidth={1.75} />}
                                        onClick={() => void cloud.syncNow()}
                                      >
                                        Try again
                                      </DataButton>
                                      <DataButton
                                        icon={<Unlink2 size={13} strokeWidth={1.75} />}
                                        onClick={() => void signOut()}
                                      >
                                        Sign out
                                      </DataButton>
                                    </div>
                                  ))}
                              </>
                            )}
                          </FieldRow>
                        </Section>
                      )}
                    </>
                  )}

                  {tab === "about" && (
                    <Section title="About">
                      <FieldRow label="Manifesto" align="top" last={!!reducedMotion}>
                        {/* An anchor rather than a button: it is a real page, so
                          middle-click and "open in new tab" have to work. It
                          opens in one deliberately — installed standalone there
                          is no back button, and navigating away would cost a
                          reload of a running clock. */}
                        <a
                          href="/manifesto/"
                          target="_blank"
                          rel="noopener"
                          className="flex h-8 w-fit items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-(--veil-10)"
                        >
                          <ArrowUpRight size={13} strokeWidth={1.75} />
                          Why a day is a circle
                        </a>
                        <span className="caption">
                          One page on what this is, and what it will not become
                        </span>
                      </FieldRow>
                      {/* Nothing to offer a reader whose system has asked for no
                        motion: the sweep is the whole of it, and a button that
                        plays nothing is worse than an absent one. */}
                      {!reducedMotion && (
                        <FieldRow label="Intro" align="top" last>
                          <DataButton
                            icon={<RotateCcw size={13} strokeWidth={1.75} />}
                            onClick={actions.replayIntro}
                          >
                            Play again
                          </DataButton>
                          <span className="caption">
                            One revolution, the day arriving in day order. Shown once, on the first
                            visit
                          </span>
                        </FieldRow>
                      )}
                    </Section>
                  )}
                </div>
              </motion.div>
            </div>

            {/* The info card: a section's prose, on demand. Inside the dialog
                rather than a portal, so the panel's own focus trap still bounds
                Tab; the capture listener above owns Escape while it is up. */}
            {info && (
              <motion.div
                className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4"
                onClick={() => setInfo(null)}
                role="presentation"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.14, ease: EASE }}
              >
                <motion.div
                  ref={infoCard}
                  role="dialog"
                  aria-label={info.title}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                  className="no-scrollbar max-h-full w-[min(480px,100%)] overflow-y-auto rounded-[12px] border border-hairline bg-surface-2 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.8)]"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.16, ease: EASE }}
                >
                  <div className="flex min-h-[40px] items-center justify-between border-b border-hairline pr-1.5 pl-4">
                    <h3 className="label text-[12px] text-ink-2">{info.title}</h3>
                    <IconButton label="Close" onClick={() => setInfo(null)}>
                      <X size={14} strokeWidth={1.75} />
                    </IconButton>
                  </div>
                  {/* 15px ink, not `.caption`: this prose is the dialog's whole
                      content, so it reads at body size, not at the annotation
                      size that was hard to read at this remove. */}
                  <div className="flex flex-col gap-4 px-4 pt-3.5 pb-4.5 text-[15px] leading-relaxed text-ink">
                    {info.body}
                  </div>
                </motion.div>
              </motion.div>
            )}
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

/**
 * The panel's own named verb. `disabled` because two of them are now offers
 * this surface cannot keep — a second live link, and a request already in
 * flight — and the styling is the one the Add button beside the feed field
 * has always used, so a dead verb reads the same wherever it is.
 *
 * `danger` is the editor's Delete in this panel's vocabulary rather than a
 * second one: `AGENTS.md` reserves `text-danger` for a press that destroys
 * something, and exactly one press here does.
 */
function DataButton({
  icon,
  onClick,
  disabled,
  danger,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] transition-colors hover:bg-(--veil-10) disabled:pointer-events-none disabled:opacity-35",
        danger ? "text-danger" : "text-ink",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
