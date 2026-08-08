import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { keyDown, keyUp } from "@/lib/keys";

/**
 * The wall clock, aligned to the boundary of its own period so the readout
 * flips when the system clock does rather than at a random offset after
 * mount. Returns a new `Date` only when the displayed instant changes.
 *
 * The shell asks for a minute. Nothing in the app prints a second, and the
 * alignment is what makes that free rather than a compromise: a 60,000ms tick
 * fires at `:00`, which is the instant every `HH:MM` and every rounded
 * countdown in circal changes. A caller that genuinely needs a finer clock
 * asks for one in the leaf that prints it, so the rest of the tree stays
 * still.
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
 * Whether a scroll container has more to show below the fold — the truth
 * `.fade-b` needs to stay honest. A fade painted regardless of scroll
 * position reads as a rendering fault once you've actually reached the
 * bottom, and the icon grid's row count is not fixed: filtering it down
 * changes `scrollHeight` out from under a mount-only measurement, so the
 * element's own size (via `ResizeObserver`, same instrument as
 * `useElementSize`) and its scroll offset (a plain listener — no observer
 * for that) both have to stay live.
 */
export function useOverflowFade<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [hasMore, setHasMore] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setHasMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    measure();
    el.addEventListener("scroll", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  return [ref, hasMore];
}

/**
 * Global shortcuts. `combo` is `"mod+k"`, `"escape"`, `"arrowleft"` …; `mod` is
 * ⌘ on Apple and Ctrl elsewhere. Handlers are skipped while the user is typing,
 * unless the combo carries a modifier — ⌘↵ must still save from inside a field.
 *
 * `shift+` is part of the combo whenever Shift is held, including for a
 * printable key: `e.key` is already `"Z"` rather than `"z"` there, so without
 * it ⇧⌘Z and ⌘Z are the same string and redo silently becomes undo.
 *
 * `enabled` is how a modal switches the shell off. Typing is not the only way
 * to be somewhere else: focus on a button inside the event editor is not
 * typing, so without it ← stepped the day behind an open dialog.
 */
export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const latest = useRef(bindings);
  latest.current = bindings;
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!on.current) return;
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
 * What Tab can land on inside a dialog. `:disabled` covers the controls the
 * event editor switches off through its read-only fieldset — a form control
 * inside a disabled fieldset is disabled — and the rect test drops anything
 * a collapsed section has taken off the page. `offsetParent` is no use here:
 * it is null for everything under a `position: fixed` dialog.
 */
const TAB_STOPS =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * The last thing focused outside a dialog — one document listener for every
 * trap rather than one each, because the fact is the document's. A dialog
 * mounted only while it is open (the event editor) has no listener of its own
 * at the moment the button that opens it takes focus, so a per-hook listener
 * misses the one focus it exists to record.
 *
 * Membership is tested against `[role=dialog]` in the DOM rather than against
 * the trap's ref, which is not attached yet when a child autofocuses: React
 * commits a child's autofocus before it attaches the parent's ref, so the ref
 * test recorded the dialog's own first field as the thing that opened it.
 */
let opener: HTMLElement | null = null;
let watchers = 0;

function onFocusIn(e: FocusEvent) {
  const el = e.target as HTMLElement;
  if (!el.closest?.("[role=dialog]")) opener = el;
}

/**
 * Hold Tab inside the returned element while `active`, and hand focus back to
 * whatever opened it on the way out.
 *
 * A hook rather than a `<Modal>`, because the three dialogs share this one
 * behaviour and nothing else: the palette is a combobox, the editor a form,
 * settings a two-column sheet. Wrapping all three in one shell would be a
 * fourth layout pretending to be a primitive.
 *
 * Focus only moves in if the dialog has not claimed it already — the palette
 * and the editor autofocus their first field, and pulling that back to the
 * container would undo the thing the ARIA pattern asks for. A dialog with
 * nothing to autofocus carries `tabIndex={-1}` and takes it on the container.
 *
 * The element it is attached to must carry `role="dialog"`: that is how the
 * hook tells a focus arriving from the page behind from one the dialog gave
 * itself, and every caller has it for the assistive tree anyway.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (watchers++ === 0) document.addEventListener("focusin", onFocusIn);
    return () => {
      if (--watchers === 0) document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const stops = tabStops(root);
      // Nothing to land on: the container is holding focus, and Tab taking it
      // to the page behind is the whole bug.
      if (stops.length === 0) return e.preventDefault();

      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      // Backwards off the first, forwards off the last — and backwards from
      // the container itself, which is not a stop and would otherwise leave.
      const wraps = e.shiftKey ? at === first || at === root : at === last;
      if (!wraps) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    };
    root.addEventListener("keydown", onKeyDown);

    const back = opener;
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      // The dialog's own nodes are gone by the time a passive cleanup runs, so
      // focus has usually fallen to `body` — that, or focus still inside, is
      // what "the dialog was holding it" looks like from here. Anything else
      // moved focus deliberately and knows better than this does.
      const at = document.activeElement;
      if (!at || at === document.body || root.contains(at)) {
        if (back?.isConnected) back.focus();
      }
    };
  }, [active]);

  return ref;
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
