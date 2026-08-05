/* ------------------------------------------------------------------ *
 * Detents.
 *
 * The dial's drag moves in fifteen-minute steps. A step you can only *see*
 * is half a step: the whole appeal of a physical dial is that the mechanism
 * counts for you while your eye is somewhere else. So each step gets a click,
 * and — where the hardware admits to having a motor — a tap.
 *
 * The click is synthesised, not sampled — three milliseconds of noise struck
 * through two resonant filters, which is what a mechanical detent physically
 * is: a hard little impulse and whatever the housing around it does with
 * that impulse. Rendered offline it peaks at about 0.14 and is over in three
 * milliseconds; the resonances are jittered a few percent per click, so a
 * row of them reads as a sequence rather than a machine gun.
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
/** Vibration length. A tap — long enough for the motor to move, short enough
 *  that ninety-six of them do not merge into a hum. */
const BUZZ_MS = 8;
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
 * The low resonator is the body of the mechanism, the high one is the edge of
 * the snap, and a little of the raw impulse over the top is the contact
 * itself. Nothing here lasts more than about twelve milliseconds and nothing
 * reaches below a kilohertz — a click with low frequencies in it is a knock,
 * and a click that outlives its transient is a blip.
 */
function click() {
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
  const strike = (hz: number, q: number, level: number, decay: number) => {
    const res = ac.createBiquadFilter();
    res.type = "bandpass";
    res.frequency.value = hz * detune;
    res.Q.value = q;

    const env = ac.createGain();
    // No attack ramp: the impulse *is* the attack, and a ramp in front of it
    // only rounds off the one part of the sound that matters. Exponential to
    // a floor rather than to zero, which a ramp cannot reach.
    env.gain.setValueAtTime(level, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    burst.connect(res).connect(env).connect(ac.destination);
  };

  strike(1950, 8, LEVEL, 0.009);
  strike(4200, 16, LEVEL * 0.5, 0.005);

  // The contact. High-passed, because the impulse's own low end is the part
  // that made the first draft of this sound like a bubble.
  const edge = ac.createBiquadFilter();
  edge.type = "highpass";
  edge.frequency.value = 2000;
  const edgeGain = ac.createGain();
  edgeGain.gain.value = LEVEL * 0.35;
  burst.connect(edge).connect(edgeGain).connect(ac.destination);

  burst.start(t);
  // One-shot and self-terminating, so the graph behind it is collected when
  // it ends. Nothing to disconnect by hand.
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

function buzz() {
  if (!canVibrate()) return;
  // Throws in no browser that has it, but this is called from a pointermove
  // and a vibrator is a device — treat it like one.
  try {
    navigator.vibrate(BUZZ_MS);
  } catch {
    /* no tap, then */
  }
}

/** One step of the dial, in whichever channels the user left on. */
export function detent({ sound, haptics }: { sound: boolean; haptics: boolean }) {
  if (!sound && !haptics) return;
  const at = performance.now();
  if (at - lastAt < MIN_GAP_MS) return;
  lastAt = at;
  if (sound) click();
  if (haptics) buzz();
}
