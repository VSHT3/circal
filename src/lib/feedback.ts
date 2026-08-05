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
 * struck by three milliseconds of noise throws most of that noise away, so the
 * graph as tuned below lands at about a quarter of this at the speaker.
 *
 * It was 0.9, tuned before the keyboard existed and measured against nothing
 * but itself. Beside a keystroke it was plainly quiet: the cues carried 0.66×
 * a letter click's *energy*, which is what the ear compares — not peak, since a
 * 3 ms noise burst and a 12 ms sinusoid at the same peak are nowhere near the
 * same loudness. 1.35 is the factor that closes that gap, applied to the whole
 * family at once so their balance with each other survives (`slide` stays the
 * soft one at 0.41× a letter, `deleted` the loud one at 1.5×).
 */
const LEVEL = 1.35;
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

/** One damped sinusoid, optionally gliding, optionally late. */
export interface Layer {
  /** Hz at the attack. */
  from: number;
  /** Hz it arrives at, exponentially, after `glide`. */
  to: number;
  /** Seconds of glide; the pitch holds after it. */
  glide: number;
  /** Seconds for the amplitude to fall by `e`. */
  tau: number;
  /** Relative to the loudest layer of the voice. Omitted means 1. */
  level?: number;
  /**
   * Seconds after the voice begins. This is how a thing lands twice: a second
   * contact is a second layer a few milliseconds late, not a second sound
   * scheduled by the caller — one buffer per voice keeps it one `start()`, and
   * the pair has to survive `playbackRate` as a unit or the gap between the
   * contacts stops tracking the pitch.
   */
  at?: number;
}

/** A voice: layers summed, then scaled so the sum peaks where asked. */
export interface Synth {
  layers: Layer[];
  /** Seconds of buffer. Four time constants of tail, then silence. */
  length: number;
  /** Peak of the finished sum, in output amplitude. */
  peak: number;
}

interface Sound {
  /** Struck: noise through resonators. Every cue but `opened`. */
  strikes?: Strike[];
  /** Raw impulse over the top, high-passed: the contact itself, at t=0. */
  contact?: { hz: number; level: number };
  /** Sounded: damped sinusoids, the keyboard's mechanism. `opened` only. */
  voice?: Synth;
  /** Vibration, in ms — a pattern for the cues that want two taps. */
  buzz: number | number[];
  /** Rate-limited, because it can fire dozens of times a second. */
  gated?: true;
}

/**
 * Five cues, now out of two mechanisms.
 *
 * `step` is an edge landing on a mark. `slide` is the same mechanism an
 * octave down, longer and softer — it reads as weight, which is exactly the
 * difference between moving one end of an event and moving all of it.
 *
 * `created` and `deleted` are struck three times:
 *
 * - `created` — a solid low body with a click on it, then a bright tick a
 *   moment later. Pitches rising, because the gesture finished.
 * - `deleted` — the same three hits with the pitches falling and the last
 *   one hollow and long, so it reads as something being dropped away rather
 *   than filed. Two taps of haptics too: it is the one destructive cue.
 *
 * `opened` is the exception and is *sounded* rather than struck — two damped
 * sinusoids, the keyboard's mechanism, no noise in it at all. It was a knock
 * and a bright tick like the others and it read as thin and high beside a
 * keystroke, which is what this cue now lands next to: ⌘P fires it. Lowering
 * its resonances did nothing measurable, because the brightness was never the
 * resonances — 86% of a struck cue's energy sits above 3 kHz, against a
 * keystroke's 4.5%, and that is the impulse itself. Cutting the impulse fixes
 * the tone by making the cue quiet. So: a low landing at 900 → 180 Hz, then a
 * second contact 50 ms later at 520 → 130 Hz, half the level — a thing being
 * set down, in the same voice as the keys around it.
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
    voice: {
      layers: [
        { from: 900, to: 180, glide: 0.012, tau: 0.006 },
        { from: 520, to: 130, glide: 0.01, tau: 0.01, level: 0.55, at: 0.05 },
      ],
      length: 0.11,
      // A shade over a letter click (0.24): this is a panel arriving, and it
      // answers a deliberate ⌘P rather than accompanying a keystroke.
      peak: 0.28,
    },
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
 * The context, built on first use. That first use is inside a pointerdown or
 * keydown handler, which is what the autoplay policies want to see — a context
 * constructed at module load would start `suspended` and stay there.
 *
 * Exported because `lib/keys.ts` plays through the same graph. Two contexts
 * for one app is two output devices to keep resumed and two sets of latency,
 * and the browser only promises a handful of them per page.
 */
export function audioContext(): AudioContext | null {
  if (mute) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      mute = true;
      return null;
    }
  }
  // Suspended happens anyway: a tab that was backgrounded mid-session comes
  // back with the context asleep. Ask, do not wait — the resume lands long
  // before the drag ends, and the first click is not worth blocking on.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function audio(): { ctx: AudioContext; burst: AudioBuffer } | null {
  const ac = audioContext();
  if (!ac) return null;
  if (!burstBuffer) {
    const length = Math.ceil(ac.sampleRate * BURST_SECONDS);
    burstBuffer = ac.createBuffer(1, length, ac.sampleRate);
    const samples = burstBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      samples[i] = (Math.random() * 2 - 1) * Math.exp((-6 * i) / length);
    }
  }
  return { ctx: ac, burst: burstBuffer };
}

/**
 * A voice into a buffer: sum the layers, then scale the sum so it peaks at the
 * level asked for. Normalising the *sum* rather than trusting the layer levels
 * is the only way a multi-layer voice stays predictable — two partials add to
 * somewhere between 1.0 and 1.5 depending on where their phases land, and
 * guessing that is how one voice ends up twice its neighbours.
 *
 * Exported because `lib/keys.ts` builds every key with it. It lives here
 * rather than there because this module owns the `AudioContext`, and the
 * dependency has to run one way.
 */
export function renderVoice(ac: AudioContext, voice: Synth): AudioBuffer {
  const rate = ac.sampleRate;
  const length = Math.max(1, Math.ceil(rate * voice.length));
  const buffer = ac.createBuffer(1, length, rate);
  const out = buffer.getChannelData(0);

  for (const layer of voice.layers) {
    const ratio = layer.to / layer.from;
    const level = layer.level ?? 1;
    const start = Math.min(length, Math.round(rate * (layer.at ?? 0)));
    let phase = 0;
    for (let i = start; i < length; i += 1) {
      // Time since *this layer* began, not since the voice did: a late layer is
      // its own contact, with its own glide, decay and attack from zero.
      const t = (i - start) / rate;
      // Exponential glide, held once it arrives, integrated as it goes: the
      // phase has to be the running integral of frequency, not `f(t) * t`, or
      // the pitch heard is the wrong one everywhere except t=0.
      const hz = layer.from * Math.pow(ratio, Math.min(t / layer.glide, 1));
      phase += (2 * Math.PI * hz) / rate;
      // A 0.2 ms ramp on the front. The attack is the sound, so it is as short
      // as it can be without the layer opening on a step, which is a click of
      // its own on top of the one intended.
      out[i] += Math.sin(phase) * Math.exp(-t / layer.tau) * level * Math.min(1, t / 0.0002);
    }
  }

  let max = 0;
  for (let i = 0; i < length; i += 1) max = Math.max(max, Math.abs(out[i]));
  const scale = max > 0 ? voice.peak / max : 0;
  // A 3 ms fade on the tail. The envelope is already inaudible by then, but
  // "inaudible" and "zero" differ by a step, and a step is a click.
  const fade = Math.min(length, Math.ceil(rate * 0.003));
  for (let i = 0; i < length; i += 1) {
    const tail = i > length - fade ? (length - i) / fade : 1;
    out[i] = out[i] * scale * tail;
  }
  return buffer;
}

/** Rendered once, on the cue's first use. `opened` is the only one so far. */
const voices = new Map<Synth, AudioBuffer>();

/**
 * One cue. A sounded one is a single buffer; a struck one is an impulse per
 * distinct strike time, each through its own resonators.
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

  if (sound.voice) {
    let buffer = voices.get(sound.voice);
    if (!buffer) {
      buffer = renderVoice(ac, sound.voice);
      voices.set(sound.voice, buffer);
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    // The same trick the resonances get, applied to the whole voice: one
    // buffer heard twice at the same rate is the machine gun this avoids.
    source.playbackRate.value = detune;
    source.connect(ac.destination);
    source.start();
    return;
  }
  if (!sound.strikes || !sound.contact) return;
  const contactSpec = sound.contact;

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
    contact.frequency.value = contactSpec.hz;
    const gain = ac.createGain();
    gain.gain.value = LEVEL * contactSpec.level * Math.max(...strikes.map((s) => s.level));
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
