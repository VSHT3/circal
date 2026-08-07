import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { keyDown, keyUp } from "@/lib/keys";

/**
 * The wall clock, aligned to the boundary of its own period so the readout
 * flips when the system clock does rather than at a random offset after
 * mount. Returns a new `Date` only when the displayed instant changes.
 *
 * The period is a second because the readout counts one down in its last
 * minute. Ambient asks for a minute instead: nothing on that face is finer
 * than the hand, and a desk clock left on all evening should not wake the
 * whole tree sixty times a minute to redraw the same pixels.
 */
export function useNow(periodMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, periodMs - (Date.now() % periodMs));
    };
    timer = window.setTimeout(tick, periodMs - (Date.now() % periodMs));
    return () => window.clearTimeout(timer);
  }, [periodMs]);

  return now;
}

/**
 * Keep the screen awake while `enabled`. Without it the best desk clock on
 * the web goes black after four minutes, which is the difference between a
 * mode and a demo.
 *
 * Re-requested on `visibilitychange`: the platform drops the lock whenever the
 * tab is hidden and never gives it back on its own. Every call is guarded —
 * the API is absent on older Safari and a request is rejected outright in some
 * embedded views, and neither is worth a word to the user.
 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const request = async () => {
      if (released || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied, or the document lost visibility mid-request. Either way the
        // screen sleeps, which is what it was going to do anyway.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
    };
  }, [enabled]);
}

/**
 * Whether the pointer has been still for `afterMs`, while `enabled`. Ambient
 * hides the cursor with it: an arrow parked over a clock is the one piece of
 * chrome the mode cannot remove by not rendering it.
 *
 * Pointer only. A keystroke is how you leave the mode, and a key that both
 * acts and wakes the cursor makes the exit look like a flicker.
 */
export function useIdle(enabled: boolean, afterMs: number): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), afterMs);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), afterMs);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, [enabled, afterMs]);

  return idle;
}

/**
 * Everything that counts as somebody being there. Wheel and touch are in it
 * because a page can be read for a long time without a pointer moving or a
 * key going down, and scrolling an agenda is not being away from the desk.
 */
const INPUT_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Call `onIdle` once, after `afterMs` without any input at all. `0` is off,
 * which is what the setting stores for "never".
 *
 * The callback rides a ref so that the listeners are hung once per delay
 * rather than once per render — the shell rebuilds this closure every second.
 */
export function useIdleAfter(afterMs: number, onIdle: () => void) {
  const latest = useRef(onIdle);
  useEffect(() => {
    latest.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (afterMs <= 0) return;
    let timer = window.setTimeout(() => latest.current(), afterMs);
    const wake = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), afterMs);
    };
    for (const type of INPUT_EVENTS) window.addEventListener(type, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, wake);
    };
  }, [afterMs]);
}

/**
 * Call `onInput` on the next input of any kind, while `enabled`, ignoring
 * anything inside the first `graceMs`.
 *
 * The other half of the timer: a mode that arrived because nobody was there
 * leaves the moment somebody is. Only that half — ambient entered on purpose
 * stays until it is dismissed on purpose, because there the pointer is how
 * you use it.
 *
 * The grace is not politeness. Withdrawing the chrome moves the whole layout
 * under a parked cursor, and a browser reports that as a `pointermove` from a
 * pointer that never went anywhere — so without it the mode would arrive and
 * leave in the same frame, forever.
 */
export function useOnInput(enabled: boolean, onInput: () => void, graceMs = 0) {
  const latest = useRef(onInput);
  useEffect(() => {
    latest.current = onInput;
  }, [onInput]);

  useEffect(() => {
    if (!enabled) return;
    const fire = () => latest.current();
    const arm = window.setTimeout(() => {
      for (const type of INPUT_EVENTS) window.addEventListener(type, fire, { passive: true });
    }, graceMs);
    return () => {
      window.clearTimeout(arm);
      for (const type of INPUT_EVENTS) window.removeEventListener(type, fire);
    };
  }, [enabled, graceMs]);
}

/**
 * The rendered size of an element. The dial is drawn in a 1000-unit viewBox
 * and scaled to fit, so the HTML overlay pinned to its centre needs the same
 * scale factor to stay in proportion with the SVG under it.
 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ w: box.width, h: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size.w, size.h];
}

/**
 * Global shortcuts. `combo` is `"mod+k"`, `"escape"`, `"arrowleft"` …; `mod` is
 * ⌘ on Apple and Ctrl elsewhere. Handlers are skipped while the user is typing,
 * unless the combo carries a modifier — ⌘↵ must still save from inside a field.
 *
 * `shift+` is part of the combo whenever Shift is held, including for a
 * printable key: `e.key` is already `"Z"` rather than `"z"` there, so without
 * it ⇧⌘Z and ⌘Z are the same string and redo silently becomes undo.
 */
export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  const latest = useRef(bindings);
  latest.current = bindings;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const combo = `${mod ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
      const handler = latest.current[combo];
      if (!handler) return;

      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");
      if (typing && !mod && e.key !== "Escape") return;

      e.preventDefault();
      handler(e);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * The keyboard's own voice, on every field in the app.
 *
 * Listeners on `window` rather than per-input, because "anything being typed"
 * is a property of the document, not of a component: the palette's field, the
 * editor's, the settings panel's and any that arrive later are all covered by
 * one pair, and none of them has to know about sound.
 *
 * Held keys are tracked by `e.code` so a release plays as whatever its press
 * did. The map is a ref, not state — nothing renders from it, and a keystroke
 * that re-rendered the shell would be a very expensive click.
 */
export function useTypingSound(enabled: boolean) {
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    const held = new Map<
      string,
      { voice: Parameters<typeof keyUp>[0]["voice"]; rate: number; gain: number }
    >();

    const onKeyDown = (e: KeyboardEvent) => {
      // Bare modifiers make no sound: nothing moved that the user asked to
      // move, and Shift held through a capital would otherwise click twice.
      // A combo is a command rather than typing, and the shell has its own
      // cue for the panels those open.
      if (!on.current || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (MODIFIERS.has(e.key)) return;
      // Auto-repeat is the OS talking, not a key being pressed. A held key was
      // struck once and makes one sound; the repeats are silent, and the
      // release still lands when the finger actually lifts. Rate-limiting them
      // instead was the first attempt and a held arrow still machine-gunned,
      // because a repeat interval of 30 ms clears any floor short enough to
      // pass a fast typist's digraphs.
      if (e.repeat) return;
      if (!isTypingInto(e.target)) return;
      keyDown(e.code, held);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const struck = held.get(e.code);
      held.delete(e.code);
      if (struck && on.current) keyUp(struck);
    };
    // Blur, not focusout: a field losing focus mid-hold never sees the keyup,
    // and the stale entry would fire on the next press of that key.
    const onBlur = () => held.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/**
 * Whether this event is someone typing text. The same test `useHotkeys` makes,
 * minus `SELECT` — a select is arrowed through, not typed into, and it has no
 * text to add a keystroke to.
 */
function isTypingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  // A date field is a spinner wearing an input, and `type=range` is a slider:
  // both take keys and neither is typing.
  return (
    el.tagName === "INPUT" &&
    !["date", "range", "checkbox", "radio"].includes((el as HTMLInputElement).type)
  );
}
