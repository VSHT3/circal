/* ------------------------------------------------------------------ *
 * Cues.
 *
 * Everything the dial says without words, and all of it built the same way:
 * a three-millisecond noise impulse struck through resonant filters. That is
 * what a mechanical sound physically *is* — a hard little hit, and then
 * whatever the housing around it does with the hit. Nothing here is a tone.
 * The first draft of the two-note cues was a pair of oscillators, and a
 * clean sine among these clicks sounds like a notification from a different
 * application: mechanisms have bodies, and bodies ring dirty and briefly.
 *
 * So a cue is a list of strikes on one impulse. A detent is one strike-pair
 * at t=0; the longer cues are the same thing hit two or three times a few
 * tens of milliseconds apart, with the *order of the pitches* carrying the
 * meaning. Up is completion, down is removal, and a bright hit before a dull
 * one is something letting go.
 *
 * Everything here is best-effort and silent about failing. No Web Audio, a
 * context the browser refuses to start, no vibrator: the app still works, it
 * is just quieter. Nothing in this file is allowed to throw into a
 * pointermove handler.
 * ------------------------------------------------------------------ */

/**
 * Gain into the resonators — not the peak of the result. A narrow bandpass
 * struck by three milliseconds of noise throws most of that noise away, so
 * the graph as tuned below lands at about a quarter of this at the speaker:
 * 0.9 in renders as a peak of 0.25 for a detent. Measured, not guessed.
 */
const LEVEL = 0.9;
/** A flick across the ring can cross steps faster than the ear separates
 *  them, and forty clicks in a second is a buzz, not a count. Drop the ones
 *  that would land inside this window; the step itself still happens. */
const MIN_GAP_MS = 22;
/**
 * The exciter: 3 ms of noise with its own decay baked into the samples. The
 * impulse is never what varies between cues — the resonances are.
 */
const BURST_SECONDS = 0.003;

/** Everything the app can say. */
export type Cue = "step" | "slide" | "opened" | "created" | "deleted";

interface Strike {
  hz: number;
  /** Sharpness of the resonance. Low is wooden, high is metallic. */
  q: number;
  /** Fraction of `LEVEL`. */
  level: number;
  /** Seconds to silence. Shorter than the filter's own ring-out, always. */
  decay: number;
  /** Seconds after the cue begins; the first hit leaves it out. */
  at?: number;
}

interface Sound {
  strikes: Strike[];
  /** Raw impulse over the top, high-passed: the contact itself, at t=0. */
  contact: { hz: number; level: number };
  /** Vibration, in ms — a pattern for the cues that want two taps. */
  buzz: number | number[];
  /** Rate-limited, because it can fire dozens of times a second. */
  gated?: true;
}

/**
 * Five cues out of one mechanism.
 *
 * `step` is an edge landing on a mark. `slide` is the same mechanism an
 * octave down, longer and softer — it reads as weight, which is exactly the
 * difference between moving one end of an event and moving all of it.
 *
 * The three long ones are struck two or three times:
 *
 * - `opened` — a low knock, then a brighter tick as the editor arrives on
 *   top of it. Wooden Qs and a long-ish body: this is a thing being set
 *   down, not a chime.
 * - `created` — a solid low body with a click on it, then a bright tick a
 *   moment later. Pitches rising, because the gesture finished.
 * - `deleted` — the same three hits with the pitches falling and the last
 *   one hollow and long, so it reads as something being dropped away rather
 *   than filed. Two taps of haptics too: it is the one destructive cue.
 */
const SOUNDS: Record<Cue, Sound> = {
  step: {
    strikes: [
      { hz: 1950, q: 8, level: 1, decay: 0.009 },
      { hz: 4200, q: 16, level: 0.5, decay: 0.005 },
    ],
    contact: { hz: 2000, level: 0.35 },
    buzz: 8,
    gated: true,
  },
  slide: {
    strikes: [
      { hz: 920, q: 6, level: 0.9, decay: 0.014 },
      { hz: 1900, q: 11, level: 0.28, decay: 0.007 },
    ],
    contact: { hz: 900, level: 0.16 },
    buzz: 5,
    gated: true,
  },
  opened: {
    // Levels above 1 on purpose: a resonance this narrow keeps a fraction of
    // what is struck into it, and these have to sit level with a detent's
    // 0.27 rather than under it.
    strikes: [
      { hz: 540, q: 5, level: 1.6, decay: 0.045 },
      { hz: 1150, q: 9, level: 0.6, decay: 0.012 },
      { hz: 1560, q: 9, level: 0.85, decay: 0.03, at: 0.055 },
    ],
    contact: { hz: 700, level: 0.2 },
    buzz: 9,
  },
  created: {
    strikes: [
      { hz: 380, q: 4, level: 1.25, decay: 0.06 },
      { hz: 1300, q: 8, level: 0.8, decay: 0.016 },
      { hz: 2050, q: 12, level: 0.68, decay: 0.028, at: 0.075 },
    ],
    contact: { hz: 900, level: 0.26 },
    buzz: 14,
  },
  deleted: {
    strikes: [
      { hz: 1250, q: 9, level: 1.3, decay: 0.018 },
      { hz: 760, q: 6, level: 1.45, decay: 0.03, at: 0.05 },
      { hz: 330, q: 3.5, level: 1.55, decay: 0.11, at: 0.1 },
    ],
    contact: { hz: 1400, level: 0.22 },
    buzz: [10, 45, 16],
  },
};

let ctx: AudioContext | null = null;
let burstBuffer: AudioBuffer | null = null;
/** Set once audio has proven unavailable, so we stop paying to find out. */
let mute = false;
let lastAt = 0;

/**
 * The context, built on first use. That first use is inside a pointerdown
 * handler, which is what the autoplay policies want to see — a context
 * constructed at module load would start `suspended` and stay there.
 */
function audio(): { ctx: AudioContext; burst: AudioBuffer } | null {
  if (mute) return null;
  if (!ctx || !burstBuffer) {
    try {
      ctx = new AudioContext();
      const length = Math.ceil(ctx.sampleRate * BURST_SECONDS);
      burstBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const samples = burstBuffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) {
        samples[i] = (Math.random() * 2 - 1) * Math.exp((-6 * i) / length);
      }
    } catch {
      mute = true;
      return null;
    }
  }
  // Suspended happens anyway: a tab that was backgrounded mid-session comes
  // back with the context asleep. Ask, do not wait — the resume lands long
  // before the drag ends, and the first click is not worth blocking on.
  if (ctx.state === "suspended") void ctx.resume();
  return { ctx, burst: burstBuffer };
}

/**
 * One cue: an impulse per distinct strike time, each struck through its own
 * resonators.
 *
 * A separate impulse per hit rather than one long-lived source, because the
 * hits *are* separate contacts — and because the noise is different each
 * time, which is why three hits from one recipe do not sound like a machine
 * repeating itself.
 */
function play(sound: Sound) {
  const built = audio();
  if (!built) return;
  const { ctx: ac, burst: impulse } = built;
  const now = ac.currentTime;

  // Every resonance a shade off the last cue's. Identical cues in a row read
  // as a machine gun; a few percent makes a row of them a sequence.
  const detune = 0.96 + Math.random() * 0.08;

  /** The strikes of one hit, keyed by when it lands. */
  const hits = new Map<number, Strike[]>();
  for (const strike of sound.strikes) {
    const at = strike.at ?? 0;
    hits.set(at, [...(hits.get(at) ?? []), strike]);
  }

  const exciters = new Map<number, AudioBufferSourceNode>();
  for (const [at, strikes] of hits) {
    const burst = ac.createBufferSource();
    burst.buffer = impulse;
    burst.start(now + at);
    exciters.set(at, burst);

    // Every hit gets its own contact, scaled by how hard it lands — a hit
    // *is* a contact, and the second and third of a cue sounded like tape
    // hiss with resonance on it until they had one. High-passed, because the
    // impulse's own low end is the part that made the first draft of the
    // detent sound like a bubble.
    const contact = ac.createBiquadFilter();
    contact.type = "highpass";
    contact.frequency.value = sound.contact.hz;
    const gain = ac.createGain();
    gain.gain.value =
      LEVEL * sound.contact.level * Math.max(...strikes.map((strike) => strike.level));
    burst.connect(contact).connect(gain).connect(ac.destination);
  }

  for (const strike of sound.strikes) {
    const at = strike.at ?? 0;
    const burst = exciters.get(at);
    if (!burst) continue;

    const res = ac.createBiquadFilter();
    res.type = "bandpass";
    res.frequency.value = strike.hz * detune;
    res.Q.value = strike.q;

    const env = ac.createGain();
    // No attack ramp: the impulse *is* the attack, and a ramp in front of it
    // only rounds off the one part of the sound that matters. Exponential to
    // a floor rather than to zero, which a ramp cannot reach.
    env.gain.setValueAtTime(LEVEL * strike.level, now + at);
    env.gain.exponentialRampToValueAtTime(0.0001, now + at + strike.decay);

    burst.connect(res).connect(env).connect(ac.destination);
  }
  // Every source is one-shot, so the graph behind it is collected once it
  // ends. Nothing to disconnect by hand.
}

/**
 * Whether this device has a vibrator to offer. False on every desktop
 * browser and on iOS, which has no Vibration API at all — the settings panel
 * uses this to not offer a switch it cannot honour.
 *
 * Read on demand rather than cached: the panel only asks while it is open.
 */
export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function buzz(pattern: number | number[]) {
  if (!canVibrate()) return;
  // Throws in no browser that has it, but this is called from a pointermove
  // and a vibrator is a device — treat it like one.
  try {
    navigator.vibrate(pattern);
  } catch {
    /* no tap, then */
  }
}

/**
 * Say something, in whichever channels the user left on.
 *
 * Only the two drag cues are rate-limited. The others are one-shot and land
 * straight after a drag's last click, which is exactly the gap `MIN_GAP_MS`
 * exists to swallow.
 */
export function cue(kind: Cue, { sound, haptics }: { sound: boolean; haptics: boolean }) {
  if (!sound && !haptics) return;
  const voice = SOUNDS[kind];
  if (voice.gated) {
    const at = performance.now();
    if (at - lastAt < MIN_GAP_MS) return;
    lastAt = at;
  }
  if (sound) play(voice);
  if (haptics) buzz(voice.buzz);
}
