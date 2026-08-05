/* ------------------------------------------------------------------ *
 * Detents.
 *
 * Every drag on the dial moves in fifteen-minute steps. A step you can only
 * *see* is half a step: the whole appeal of a physical dial is that the
 * mechanism counts for you while your eye is somewhere else. So each step
 * gets a click, and — where the hardware admits to having a motor — a tap.
 *
 * There are two of them, because the dial does two different things with a
 * step. `"step"` is an edge landing on a mark: drawing a new range, or moving
 * one end of an existing one. `"slide"` is a whole event travelling under the
 * pointer, which is a heavier object and gets a lower, rounder sound. Telling
 * them apart by ear is the point — it is how you know, without looking, that
 * you grabbed the middle of an arc when you meant to grab its end.
 *
 * Both are synthesised, not sampled — three milliseconds of noise struck
 * through two resonant filters, which is what a mechanical detent physically
 * is: a hard little impulse and whatever the housing around it does with that
 * impulse. Rendered offline `"step"` peaks near 0.25 and is over in three
 * milliseconds. The resonances are jittered a few percent per click, so a row
 * of them reads as a sequence rather than a machine gun.
 *
 * Everything here is best-effort and silent about failing. No Web Audio, a
 * context the browser refuses to start, no vibrator: the drag still snaps,
 * it is just quieter. Nothing in this file is allowed to throw into a
 * pointermove handler.
 * ------------------------------------------------------------------ */

/**
 * Gain into the resonators — not the peak of the result. A narrow bandpass
 * struck by three milliseconds of noise throws most of that noise away, so
 * the graph as tuned below lands at about a quarter of this at the speaker:
 * 0.9 in renders as a peak of 0.25. Measured, not guessed.
 */
const LEVEL = 0.9;
/** A flick across the ring can cross steps faster than the ear separates
 *  them, and forty clicks in a second is a buzz, not a count. Drop the ones
 *  that would land inside this window; the step itself still happens. */
const MIN_GAP_MS = 22;
/**
 * The exciter: 3 ms of noise with its own decay baked into the samples.
 *
 * This is the whole trick. A detent is not a *tone*, it is a hard little
 * impulse and then whatever the housing around it does with that impulse —
 * so the impulse is the buffer and the housing is two resonant filters. A
 * long noise burst through a wide filter is the other thing entirely, which
 * is a hiss.
 */
const BURST_SECONDS = 0.003;

/** Which of the dial's two gestures made the step. */
export type Detent = "step" | "slide";

interface Resonance {
  hz: number;
  q: number;
  /** Fraction of `LEVEL`. */
  level: number;
  /** Seconds to silence. Shorter than the filter's own ring-out, always. */
  decay: number;
}

interface Voice {
  /** The body of the mechanism — what gives the click its pitch. */
  body: Resonance;
  /** The edge of the snap, an octave and a half up: presence, not pitch. */
  edge: Resonance;
  /** Raw impulse over the top, high-passed. The contact itself. */
  contact: { hz: number; level: number };
  /** Vibration length in ms. A tap, never a rumble. */
  buzz: number;
}

/**
 * An edge landing on a mark, and a whole event sliding past one.
 *
 * The slide is the same mechanism an octave down, longer and softer: it reads
 * as weight, which is exactly the difference between moving one end of an
 * event and moving all of it. Its contact filter is lower too — with the
 * step's 2 kHz highpass the two sounded like the same click at two volumes.
 */
const VOICES: Record<Detent, Voice> = {
  step: {
    body: { hz: 1950, q: 8, level: 1, decay: 0.009 },
    edge: { hz: 4200, q: 16, level: 0.5, decay: 0.005 },
    contact: { hz: 2000, level: 0.35 },
    buzz: 8,
  },
  slide: {
    body: { hz: 920, q: 6, level: 0.9, decay: 0.014 },
    edge: { hz: 1900, q: 11, level: 0.28, decay: 0.007 },
    contact: { hz: 900, level: 0.16 },
    buzz: 5,
  },
};

/** The two moments worth a note rather than a click. */
export type Chime = "opened" | "created";

interface Note {
  hz: number;
  /** Where it lands after the pitch it starts on, if anywhere. */
  to?: number;
  /** Seconds after the chime begins. */
  at: number;
  decay: number;
  /** Peak amplitude, straight to the speaker — no filters in this path. */
  level: number;
  type: OscillatorType;
}

/**
 * Two little figures, both under a fifth of a second.
 *
 * `opened` is the pop of the pointer letting go and the editor arriving on
 * top of it: a falling sine, then a bright triangle a fifth and a half above
 * it — po-pink. `created` is the same shape resolved upwards instead, which
 * is the one unambiguously *finished* sound in the app and the only place a
 * rising interval belongs.
 *
 * Pitched, where every detent is noise: a note is a statement about a whole
 * gesture, and the clicks have the percussive register to themselves.
 */
const CHIMES: Record<Chime, { notes: Note[]; buzz: number }> = {
  opened: {
    notes: [
      { hz: 470, to: 380, at: 0, decay: 0.07, level: 0.16, type: "sine" },
      { hz: 1180, at: 0.05, decay: 0.1, level: 0.09, type: "triangle" },
    ],
    buzz: 9,
  },
  created: {
    notes: [
      { hz: 660, at: 0, decay: 0.09, level: 0.13, type: "triangle" },
      { hz: 990, at: 0.075, decay: 0.17, level: 0.11, type: "triangle" },
    ],
    buzz: 14,
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
      // Steep, and the same shape every time: the *impulse* is not what
      // varies between clicks, the resonances are.
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
 * One detent: an impulse struck through two resonators.
 *
 * Nothing here lasts more than about fifteen milliseconds and nothing reaches
 * below eight hundred hertz — a click with low frequencies in it is a knock,
 * and a click that outlives its transient is a blip.
 */
function click(voice: Voice) {
  const built = audio();
  if (!built) return;
  const { ctx: ac, burst: impulse } = built;
  const t = ac.currentTime;

  const burst = ac.createBufferSource();
  burst.buffer = impulse;

  // Both resonances a shade off the last click's. Identical clicks in a row
  // read as a machine gun; a few percent makes a row of them a sequence.
  const detune = 0.96 + Math.random() * 0.08;

  /** A resonator, struck by the impulse and cut short of its own ring-out. */
  const strike = ({ hz, q, level, decay }: Resonance) => {
    const res = ac.createBiquadFilter();
    res.type = "bandpass";
    res.frequency.value = hz * detune;
    res.Q.value = q;

    const env = ac.createGain();
    // No attack ramp: the impulse *is* the attack, and a ramp in front of it
    // only rounds off the one part of the sound that matters. Exponential to
    // a floor rather than to zero, which a ramp cannot reach.
    env.gain.setValueAtTime(LEVEL * level, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    burst.connect(res).connect(env).connect(ac.destination);
  };

  strike(voice.body);
  strike(voice.edge);

  // The contact. High-passed, because the impulse's own low end is the part
  // that made the first draft of this sound like a bubble.
  const contact = ac.createBiquadFilter();
  contact.type = "highpass";
  contact.frequency.value = voice.contact.hz;
  const contactGain = ac.createGain();
  contactGain.gain.value = LEVEL * voice.contact.level;
  burst.connect(contact).connect(contactGain).connect(ac.destination);

  burst.start(t);
  // One-shot and self-terminating, so the graph behind it is collected when
  // it ends. Nothing to disconnect by hand.
}

/** One note of a chime: an oscillator with a short envelope, straight out. */
function tone(ac: AudioContext, note: Note, from: number) {
  const t = from + note.at;
  const osc = ac.createOscillator();
  osc.type = note.type;
  osc.frequency.setValueAtTime(note.hz, t);
  // A falling note is a pop; a steady one is a latch. Both are the shape of
  // the gesture they report, not decoration.
  if (note.to !== undefined) osc.frequency.exponentialRampToValueAtTime(note.to, t + note.decay);

  const env = ac.createGain();
  // A 1.5 ms attack, unlike the detents': an oscillator started at full gain
  // begins with a step edge, and that edge is a click in front of the note.
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(note.level, t + 0.0015);
  env.gain.exponentialRampToValueAtTime(0.0001, t + note.decay);

  osc.connect(env).connect(ac.destination);
  osc.start(t);
  osc.stop(t + note.decay + 0.02);
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

function buzz(ms: number) {
  if (!canVibrate()) return;
  // Throws in no browser that has it, but this is called from a pointermove
  // and a vibrator is a device — treat it like one.
  try {
    navigator.vibrate(ms);
  } catch {
    /* no tap, then */
  }
}

/** One step of the dial, in whichever channels the user left on. */
export function detent(kind: Detent, { sound, haptics }: { sound: boolean; haptics: boolean }) {
  if (!sound && !haptics) return;
  const at = performance.now();
  if (at - lastAt < MIN_GAP_MS) return;
  lastAt = at;
  const voice = VOICES[kind];
  if (sound) click(voice);
  if (haptics) buzz(voice.buzz);
}

/**
 * The editor arriving, and an event actually existing. Outside the detents'
 * rate limit on purpose: these are one-shot and land straight after the last
 * click of a drag, which is exactly the gap that limit exists to swallow.
 */
export function chime(kind: Chime, { sound, haptics }: { sound: boolean; haptics: boolean }) {
  if (!sound && !haptics) return;
  const { notes, buzz: ms } = CHIMES[kind];
  if (sound) {
    const built = audio();
    if (built) for (const note of notes) tone(built.ctx, note, built.ctx.currentTime);
  }
  if (haptics) buzz(ms);
}
