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

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  KeyRound,
  Link2,
  Mail,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlink2,
  Upload,
  X,
} from "lucide-react";
import { CODE_MAX, LOCKED, cloud, cloudSupported, useCloud } from "@/lib/cloudLink";
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
  events,
  calendars,
  actions,
}: SettingsPanelProps) {
  const {
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
  } = settings;
  const reducedMotion = useReducedMotion();
  const [feedUrl, setFeedUrl] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const dialog = useFocusTrap<HTMLDivElement>(open);
  const mirrorStatus = useMirror();
  const cloudStatus = useCloud();
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
      notify(`${cleared} event${cleared === 1 ? "" : "s"} floating again · ${MOD}Z to undo`);
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
            Set once, and typed on every new device — circal seals the copy with it and never sends
            it. Lose it and the cloud copy is lost with it; this browser's calendar and any mirror
            file are untouched
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

            {/* Two elements, and the split is the whole of it: the scroll
                container may not *be* the multi-column box. A multicol
                fragments into more columns along the inline axis once its
                content outgrows one fragmentainer, and the fragmentainer is
                this flex item's own height — definite, because the dialog caps
                at `min(900px,92vh)`. Chromium leaves the column height
                unconstrained for a scroll container and grows downwards, which
                is why this read correctly there; Firefox uses the definite
                height and put Data, Mirror, Cloud and About in columns four and
                five, past the right edge, with `.no-scrollbar` hiding the only
                affordance that said so — half a settings panel, silently. An
                inner box with auto height has no fragmentainer to overflow, so
                the columns balance and grow in the block axis and the scroll is
                vertical in every browser, which is what the header claims. */}
            <div className="no-scrollbar flex-1 overflow-y-auto p-3 [--field-label:88px]">
              <div className="columns-[320px] gap-3">
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
                        <span className="label text-ink-2">Where it sits on the face</span>
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
                      <span className="label text-ink-2">Arc names</span>
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
                      <span className="label text-ink-2">Start on its own</span>
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
                      <span className="label text-ink-2">Arc names</span>
                    </div>
                    <span className="caption">
                      Chrome away, dial to the window — <Kbd>F</Kbd>, or <Kbd>⇧F</Kbd> for the whole
                      screen
                    </span>
                  </FieldRow>
                </Section>

                {/* Its own card rather than a row inside Face: it is not
                  really about the dial, it is the mini-month and the life
                  grid's columns too, and filing it under Face would leave
                  the other two surfaces owning something they cannot see. */}
                <Section title="Week">
                  <FieldRow label="Starts on" align="top" last>
                    <Segmented
                      value={String(weekStart) as "1" | "0" | "6"}
                      onChange={(next) => store.setWeekStart(Number(next) as WeekStart)}
                      options={[
                        { id: "1" as const, label: "MON" },
                        { id: "0" as const, label: "SUN" },
                        { id: "6" as const, label: "SAT" },
                      ]}
                    />
                    <span className="caption">
                      Moves the strip, the mini-month and the life grid's columns together — the
                      three surfaces read one setting so they cannot disagree about where a week
                      starts
                    </span>
                  </FieldRow>
                </Section>

                {/* Also its own card: working hours are not a face setting
                  either, and the two rows they touch — the totals line and
                  the palette's slot search — are both elsewhere. */}
                <Section title="Day">
                  <FieldRow label="Hours" align="top" last>
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
                    <span className="caption">
                      What free time is measured against — the dial's totals line and the palette's
                      slot search both mean the same thing by "free" because they read this
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
                    <Toggle
                      label="Phase"
                      name="Moon phase in the sidebar"
                      checked={moon}
                      onChange={(on) => store.setToggle("moon", on)}
                    />
                    <span className="caption">
                      The phase of the selected day, drawn as the astronomy: one disc, the
                      terminator as an ellipse over it, no outline
                    </span>
                  </FieldRow>
                </Section>

                {/* What ⌘N and a quick-add line start from. Its own card rather
                  than a row inside Face, because neither of these is anything
                  the dial draws — they are what the app assumes when you have
                  not said. */}
                <Section title="New event">
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
                  <FieldRow label="Calendar" align="top" last>
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
                    <span className="caption">
                      Where {MOD}N, a drag on the dial and a quick-add line put an event. A
                      subscription is never offered: its events are a mirror
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
                        : "One dot per day for a whole life. The date is asked for once and kept with your own calendar, nowhere else"}
                    </span>
                  </FieldRow>
                  <FieldRow label="Marks" align="top">
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
                  <FieldRow label="Loupe" align="top" last>
                    <Toggle
                      label="Magnify the year"
                      checked={lifeLoupe}
                      onChange={(on) => store.setToggle("lifeLoupe", on)}
                    />
                    <span className="caption">
                      Point at a day and its whole year comes up on a card, large enough to read and
                      to drag a range across. The eighty years stay where they are
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
                      open is the reason nothing here runs on a server.
                      Leaving that to be discovered is how a missed meeting
                      becomes a bug report. The clause used to be "nothing
                      here leaves this browser", which the cloud copy three
                      cards down made false — a signed-in row is somewhere
                      else, and none of it runs circal's code. */}
                    <span className="caption">
                      Only while circal is open, in this tab. Reminders with it closed would need a
                      server pushing them at you, and circal runs nowhere but this browser
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
                        className="h-8 shrink-0 rounded-[8px] border border-hairline bg-surface-2 px-3 text-[13px] text-ink transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-35"
                      >
                        Add
                      </button>
                    </div>
                  </FieldRow>

                  {/* Only when there is something to say: after the travel
                    notice was answered with "move", or on a browser that never
                    travelled, nothing carries a stamp and a row offering to
                    clear nothing is worse than no row. */}
                  {stampCount > 0 && (
                    <FieldRow label="Zones" align="top">
                      {/* The place is in the verb, not only in the sentence:
                        "Clear 24 Berlin stamps" says what is about to happen
                        where a bare number does not. Two journeys kept in a
                        row name two places, and then the number leads and the
                        caption carries them. */}
                      <DataButton
                        icon={<RotateCcw size={13} strokeWidth={1.75} />}
                        onClick={clearStamps}
                      >
                        Clear {stampCount} {stampPlaces.length === 1 ? `${stampPlaces[0]} ` : ""}
                        stamp{stampCount === 1 ? "" : "s"}
                      </DataButton>
                      {/* Says what the scope actually is, including the part it
                        cannot tell apart: an imported .ics event naming one of
                        these same cities is indistinguishable from a stamped
                        one, and promising precision this does not have would
                        be worse than naming the edge. */}
                      <span className="caption">
                        Kept when this browser arrived from {stampPlaces.join(", ")}. Clearing makes
                        them floating again, drawn on whatever clock this browser is having — an
                        imported event naming the same place is cleared with them
                      </span>
                    </FieldRow>
                  )}

                  <FieldRow label="Backup" align="top">
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
                      Events live in this browser. With no live copy connected below, a backup is
                      the only one that survives it
                    </span>
                  </FieldRow>

                  <FieldRow label="Nudge" align="top" last>
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
                    {/* Said here because the nudge itself is one quiet line with
                      no room to explain why it only speaks in some browsers: a
                      live mirror is the better answer where it exists, and this
                      warning stands in for it where it cannot. */}
                    <span className="caption">
                      On the main screen, when no backup has been saved in a while. Silent while a
                      mirror file or the cloud copy is connected below — that copy is already live
                    </span>
                  </FieldRow>
                </Section>

                {/* Same subject as Data/Backup above — the only copy of the
                  user's calendar — but this copy is *live*: a file on disk
                  the app keeps in sync rather than a snapshot taken once and
                  set aside. That is also what makes it the one surface an
                  outside program (an AI assistant, a script) can read and
                  write without circal growing a server. */}
                <Section title="Mirror">
                  <FieldRow label="File" align="top" last>
                    {!canMirror ? (
                      <span className="caption">
                        This browser can't hold a file handle for a live mirror — Export above still
                        works
                      </span>
                    ) : (
                      <>
                        {/* `DataButton`, not `ActionPill` — the pill is the top
                          bar's vocabulary, where `label` is only ever the
                          aria-label and an icon is the whole control. In a
                          settings row that renders as a bare glyph with no
                          words on it, which is a poor thing for the one
                          button that turns a feature on. These sit directly
                          under Export/Backup/Import and speak the same way. */}
                        {mirrorStatus.state === "off" && (
                          <>
                            <DataButton
                              icon={<Link2 size={13} strokeWidth={1.75} />}
                              onClick={() => void mirror.connect()}
                              disabled={cloudEngaged}
                            >
                              Connect a file…
                            </DataButton>
                            <span className="caption">
                              Circal keeps a live .json copy in a file you choose. That file is a
                              backup that survives "Clear site data", and it's the file a local AI
                              assistant reads and writes
                            </span>
                          </>
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
                              {/* Anchor, not button — an assistant reads this
                                file once it is live, and setup is a page,
                                not an action. Opens in a new tab for the
                                same reason as the Manifesto link below. */}
                              <a
                                href="/assistant/"
                                target="_blank"
                                rel="noopener"
                                className="flex h-8 w-fit items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] text-ink transition-colors hover:bg-white/10"
                              >
                                <ArrowUpRight size={13} strokeWidth={1.75} />
                                Set up an assistant
                              </a>
                            </div>
                          </>
                        )}
                        {mirrorStatus.state === "error" && (
                          <>
                            {/* Plain `.caption`, not `text-danger`: a link that
                              is down is not a destructive action, and the
                              calendar is whole in `localStorage` either way.
                              It was red until the cloud half arrived beside it
                              printing the same kind of sentence in grey, and
                              two neighbouring sections disagreeing about
                              whether this is an emergency is worse than either
                              answer. `feedMetaClass` keeps its red for a
                              different claim — a subscription that is failing
                              is showing stale events right now. */}
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
                        {/* Why the verb above is dead rather than missing: the
                          handle is still remembered and Disconnect is still
                          the way out of it, so hiding the row would trap a
                          reader who arrived with both remembered. Said once
                          for all four states, since it is true of all four. */}
                        {cloudEngaged && (
                          <span className="caption">
                            One live copy at a time — sign out of the cloud copy below to mirror to
                            a file instead
                          </span>
                        )}
                        {/* Said plainly, once, regardless of state: a file
                          circal keeps open for an assistant to write is a
                          file anything that can read it can write to, and
                          that is a property of the feature, not a warning
                          that goes away once you already trust it. */}
                        <span className="caption">
                          While the file is connected, anything that can read it can read and change
                          your calendar
                        </span>
                      </>
                    )}
                  </FieldRow>
                </Section>

                {/* Absent, not disabled and not explained, where no project is
                  configured: `SYNC.md` opens Phase 2 with "the app must be
                  byte-identical for somebody who never signs in", and a fork
                  that never set the two env vars is that person a step
                  earlier. The Mirror section above is the sibling this reads
                  as — same subject, same verbs, one transport over. */}
                {canCloud && (
                  <Section title="Cloud">
                    <FieldRow label="Account" align="top" last>
                      {mirrorEngaged ? (
                        <>
                          <span className="caption">
                            One live copy at a time — disconnect the mirror file above to sync
                            through the cloud instead
                          </span>
                          {/* The retreat, and only where there is something to
                            retreat from: a session remembered from before the
                            file was picked is the one way both are held at
                            once, and it has to be droppable from here. */}
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
                                One encrypted copy of this calendar on a server, so another device
                                can read it. Signing in is a code by email, never a link to click
                              </span>
                            </>
                          )}
                          {/* The transport's own sentence, printed rather than
                            paraphrased — it is the one place either state has
                            anything to say, and a second wording of "a code is
                            on its way" is a second vocabulary to drift. */}
                          {(cloudStatus.state === "prompt" || cloudStatus.state === "error") &&
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
                              </div>
                              {/* Only while the link is live: there is nothing
                                to remember before a key exists, and a switch
                                offering to keep one would be a switch about a
                                thing that has not happened. The caption is the
                                whole of the decision — the passphrase is not
                                what is kept, and what is kept carries *write*
                                authority over every device on the account,
                                which is the half a user would otherwise
                                assume away. */}
                              <Toggle
                                label="Stay unlocked"
                                name="Remember the key for the cloud copy on this device"
                                checked={remembering}
                                onChange={(on) => void setRemember(on)}
                              />
                              <span className="caption">
                                The passphrase is never stored; the key it derives is. Anyone with
                                this device and browser profile can then read and change the
                                calendar on every device on the account
                              </span>
                              {/* The other intention, and deliberately not
                                behind Sign out: one press is "not on this
                                device", this one is "not at all". Two presses,
                                the editor's own shape — a `pending` flag swaps
                                the verb for the confirm and a Cancel beside it
                                — rather than a confirm widget this panel does
                                not otherwise have. The reassurance sits on the
                                second press because that is where somebody
                                hesitates, and it says the two things a person
                                fears here: the calendar is not what is being
                                deleted, and this is not account erasure.
                                `deleteStrip` is shared with the locked branch,
                                where it is the way out of a lost passphrase. */}
                              {deleteStrip}
                            </>
                          )}
                          {/* Two failures, two remedies, and the panel picks
                            between them off facts it already has rather than
                            off a second reading of the message: a locked box
                            wants the passphrase again (`cloudLocked`), and so
                            does a link that never completed a pass at all
                            (`at` still 0, so `unlock` itself is what failed).
                            Anything else has a key in memory and a row it
                            merely could not reach — a paused project — where
                            retyping a passphrase would be busywork and the
                            retry is the whole of the fix. Neither sentence is
                            about lost data and neither is printed in danger
                            colour: nothing here is destructive. */}
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
                          {/* Said plainly, once, in every state — the mirror's
                            own argument one transport over: an account is a
                            thing somebody else knows about you, and that is a
                            property of the feature rather than a warning that
                            stops being true once you trust it. */}
                          <span className="caption">
                            Whoever runs the project knows the email you sign in with; encrypting
                            the calendar does not change that
                          </span>
                        </>
                      )}
                    </FieldRow>
                  </Section>
                )}

                <Section title="About">
                  <FieldRow label="Manifesto" align="top" last={!!reducedMotion}>
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
              </div>
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
        "flex h-8 items-center gap-1.5 rounded-[8px] border border-hairline bg-surface-2 px-2.5 text-[13px] transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-35",
        danger ? "text-danger" : "text-ink",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
