import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { keyDown, keyUp } from "@/lib/keys";

/**
 * The wall clock, re-read once a second and aligned to the second boundary so
 * the readout flips when the system clock does rather than a random offset
 * after mount. Returns a new `Date` only when the displayed second changes.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 1000 - d.getMilliseconds());
    };
    timer = window.setTimeout(tick, 1000 - new Date().getMilliseconds());
    return () => window.clearTimeout(timer);
  }, []);

  return now;
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
