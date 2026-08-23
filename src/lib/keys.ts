/* ------------------------------------------------------------------ *
 * The keystroke.
 *
 * One mechanism, all the way down: every key is a sum of damped sinusoids,
 * and there is no noise in any of it. That is the point — a recorded switch is
 * broadband hiss with resonance on it, and a screenful of that is fatigue.
 * Nothing here is fetched, decoded or shipped; the whole keyboard is this
 * table, rendered into six short buffers on the first keystroke of a session.
 *
 * The two letter clicks are not invented. Measured out of its bundle and refitted here: one
 * glides 2600 → 200 Hz over 8 ms, one holds 2325 Hz, both decaying with a
 * 1.4 ms time constant, and neither has a thing above 3.5 kHz. Fitted to a
 * spectral correlation of 0.96 against the originals, so this is the sound
 * arrived at from its parameters rather than a copy of the file — which makes
 * it exact at whatever sample rate the device runs at, and free.
 *
 * The three big keys are the same mechanism sized to the job:
 *
 * - space is the letter click dropped most of an octave and given half again
 *   the decay. It is a *bigger key*, not a different instrument.
 * - delete starts lower and glides less far, so it reads as duller than a
 *   letter rather than brighter — taking a character away should not sound
 *   like typing one.
 * - return lands twice, 9 ms apart, because that is what a stabilised key
 *   physically does and it is the only key whose job is to end something.
 *
 * All three were recordings first — an Everglide Oreo board — and all three
 * lost to this. The recorded space boomed against clicks this dry; the
 * recorded delete's *release* came back 1.8× louder than its press, which
 * reads as a key that cannot make its mind up; and once a layer could start
 * late, the recorded return's two-stage clunk was reachable from parameters,
 * which took the last asset out of the app.
 *
 * Like `feedback.ts`, everything here fails silently. No Web Audio or a
 * context the browser refuses: the app still works, it is just quieter.
 * Nothing in this file is allowed to throw into a keydown handler.
 * ------------------------------------------------------------------ */

import { audioContext, renderVoice, type Synth } from "@/lib/feedback";

/**
 * Peak amplitude of a letter click at the speaker. The dial's detent measures
 * 0.27, and typing happens hundreds of times to a drag's once — it sits just
 * under, never over. Every other key is a multiple of this one, so the whole
 * keyboard moves together.
 */
const LETTER_PEAK = 0.24;
/**
 * Plays its two clicks with ±8% of rate jitter, and that number is
 * doing more work than it looks: at 12 ms, a few percent of playback rate is
 * the difference between a row of identical taps and a row of keys.
 */
const RATE_JITTER = 0.08;
/** Struck harder or softer, as a hand does. Kept small — this is one finger. */
const GAIN_JITTER = 0.12;
/**
 * Two keys landing inside this window are one sound to the ear, so the second
 * is dropped. Auto-repeat is *not* what this is for — repeats are refused
 * outright in `useTypingSound`, because one press is one sound however long
 * the finger stays down. This is only for a fast hand's overlapping digraphs.
 */
const MIN_GAP_MS = 18;

/**
 * The two letter clicks, alternating. One drops in pitch and one does not,
 * which is what makes a run of them sound like a hand crossing a keyboard
 * rather than one key hit twice — the ear tracks the contour, not the level.
 */
const CLICKS: Synth[] = [
  {
    layers: [{ from: 2600, to: 200, glide: 0.008, tau: 0.0014 }],
    length: 0.0116,
    peak: LETTER_PEAK,
  },
  {
    layers: [{ from: 2350, to: 2300, glide: 0.008, tau: 0.0014 }],
    length: 0.0071,
    peak: LETTER_PEAK,
  },
];
/**
 * The upstroke: the second click a little higher, shorter and well down. A
 * letter key releasing is the quietest thing a keyboard does, and leaving it
 * out is instantly noticeable — the keyboard sounds like it is being tapped
 * through glass.
 */
const LETTER_RELEASE: Synth = {
  layers: [{ from: 2700, to: 2700, glide: 0.008, tau: 0.0011 }],
  length: 0.009,
  peak: LETTER_PEAK * 0.275,
};

type Big = "space" | "backspace" | "enter";

/**
 * The three big keys, each a press and its release.
 *
 * Space is 1820 → 140 Hz at τ 2.0 ms — the letter click, lower and longer. It
 * was a two-layer voice first, a click over a 145 Hz partial ringing 14 ms, on
 * the theory that a bar needs a tail to sound like a bar. It does not: the tail
 * read as boom next to clicks this dry, and the plain lower click is what
 * actually sounds like the same keyboard's biggest key.
 *
 * Delete starts at 1500 rather than 2600 and glides less far. Its release is
 * 30% of its press, like every other release here; the recording's was 180%,
 * which is the single thing that made it sound unreliable.
 *
 * Return lands twice — 2200 → 300 Hz, then 1500 → 200 Hz nine milliseconds
 * later at half the level — and lets go the same way. Fourteen milliseconds
 * apart was the first draft and read as two separate keys; nine is close
 * enough to fuse into one heavier key. Its release is 42% rather than 30%,
 * because Return is the one key whose let-go is the sound of the thing having
 * happened.
 */
const BIG: Record<Big, { press: Synth; release: Synth }> = {
  space: {
    press: {
      layers: [{ from: 1820, to: 140, glide: 0.008, tau: 0.002 }],
      length: 0.016,
      peak: LETTER_PEAK * 1.1,
    },
    release: {
      layers: [{ from: 1900, to: 1900, glide: 0.008, tau: 0.0014 }],
      length: 0.012,
      peak: LETTER_PEAK * 1.1 * 0.32,
    },
  },
  backspace: {
    press: {
      layers: [{ from: 1500, to: 220, glide: 0.009, tau: 0.0018 }],
      length: 0.015,
      peak: LETTER_PEAK * 0.92,
    },
    release: {
      layers: [{ from: 2200, to: 2200, glide: 0.008, tau: 0.0011 }],
      length: 0.009,
      peak: LETTER_PEAK * 0.92 * 0.3,
    },
  },
  enter: {
    press: {
      layers: [
        { from: 2200, to: 300, glide: 0.008, tau: 0.0014 },
        { from: 1500, to: 200, glide: 0.008, tau: 0.0018, level: 0.5, at: 0.009 },
      ],
      length: 0.026,
      peak: LETTER_PEAK * 1.1,
    },
    release: {
      layers: [
        { from: 2100, to: 2100, glide: 0.008, tau: 0.0013 },
        { from: 1450, to: 220, glide: 0.008, tau: 0.0018, level: 0.45, at: 0.008 },
      ],
      length: 0.02,
      peak: LETTER_PEAK * 1.1 * 0.42,
    },
  },
};

/** What a key was struck as. */
type Voice = Big | "letter";

/**
 * `e.code`, not `e.key`: the physical key is what makes the sound, so a
 * shifted `2` and a `@` are one key, and a remapped layout still sounds like
 * the board under the hand. Delete is the same bar as Backspace on the boards
 * that have both, and the numpad's Enter is an Enter.
 */
function voiceFor(code: string): Voice {
  if (code === "Space") return "space";
  if (code === "Backspace" || code === "Delete") return "backspace";
  if (code === "Enter" || code === "NumpadEnter") return "enter";
  return "letter";
}

interface Keyboard {
  clicks: AudioBuffer[];
  letterRelease: AudioBuffer;
  big: Record<Big, { press: AudioBuffer; release: AudioBuffer }>;
}

let keyboard: Keyboard | null = null;
let lastAt = 0;

/**
 * Every voice, rendered once on the first keystroke of the session — eight
 * short buffers at the device's own sample rate, well under a millisecond all
 * told, and never again for the life of the page.
 */
function build(ac: AudioContext): Keyboard {
  const big = {} as Keyboard["big"];
  for (const key of Object.keys(BIG) as Big[]) {
    big[key] = {
      press: renderVoice(ac, BIG[key].press),
      release: renderVoice(ac, BIG[key].release),
    };
  }
  return {
    clicks: CLICKS.map((click) => renderVoice(ac, click)),
    letterRelease: renderVoice(ac, LETTER_RELEASE),
    big,
  };
}

function shot(ac: AudioContext, buffer: AudioBuffer, rate: number, gain: number) {
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const level = ac.createGain();
  level.gain.value = gain;
  source.connect(level).connect(ac.destination);
  // One-shot: the graph behind it is collected when it ends, nothing to
  // disconnect by hand.
  source.start();
}

/** The hand: which click came last, so the same one never lands twice. */
let alternate = 0;

/**
 * One keystroke down. `held` is written with what this key was struck as, so
 * the release can match it — a key that goes down as a space must come up as
 * one, at the same pitch and force, even if the modifiers changed mid-hold.
 */
export function keyDown(
  code: string,
  held: Map<string, { voice: Voice; rate: number; gain: number }>,
) {
  const at = performance.now();
  if (at - lastAt < MIN_GAP_MS) return;
  lastAt = at;

  const ac = audioContext();
  if (!ac) return;
  keyboard ??= build(ac);

  const voice = voiceFor(code);
  const rate = 1 + (Math.random() * 2 - 1) * RATE_JITTER;
  const gain = 1 + (Math.random() * 2 - 1) * GAIN_JITTER;
  held.set(code, { voice, rate, gain });

  if (voice !== "letter") {
    shot(ac, keyboard.big[voice].press, rate, gain);
    return;
  }
  // Two clicks, strictly alternating rather than randomly picked. Random
  // repeats about half the time on a two-item bag, and a repeat is the one
  // thing this is here to avoid.
  alternate = (alternate + 1) % keyboard.clicks.length;
  shot(ac, keyboard.clicks[alternate], rate, gain);
}

/**
 * The same keystroke coming up, at the pitch and force it went down with.
 * Not rate-limited: a release cannot repeat, and it lands in the window
 * `MIN_GAP_MS` exists to swallow.
 */
export function keyUp(struck: { voice: Voice; rate: number; gain: number }) {
  const ac = audioContext();
  if (!ac || !keyboard) return;
  const buffer =
    struck.voice === "letter" ? keyboard.letterRelease : keyboard.big[struck.voice].release;
  shot(ac, buffer, struck.rate, struck.gain);
}
