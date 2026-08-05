import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

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
 */
export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  const latest = useRef(bindings);
  latest.current = bindings;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const combo = `${mod ? "mod+" : ""}${e.shiftKey && e.key.length > 1 ? "shift+" : ""}${e.key.toLowerCase()}`;
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
