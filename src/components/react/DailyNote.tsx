import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoveDiagonal2, StickyNote, X } from "lucide-react";
import { store, type Settings } from "@/lib/store";
import { dayKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import { focusQuietly } from "./hooks";
import { IconButton } from "./ui/primitives";

interface DailyNoteProps {
  day: Date;
  text: string;
  settings: Settings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DailyNoteEditor = lazy(() => import("./DailyNoteEditor"));

export default function DailyNote({ day, text, settings, open, onOpenChange }: DailyNoteProps) {
  const { dailyNoteAt: position, dailyNoteFont } = settings;
  const [size, setSize] = useState({ width: 340, height: 320 });
  const resizing = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const scroll = useRef<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const node = scroll.current;
    if (!open || !node) return;
    const measure = () => setOverflow(node.scrollHeight > node.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The editor arrives from a lazy chunk after the scroll box is mounted.
    const content = new MutationObserver(measure);
    content.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      content.disconnect();
    };
  }, [open, text, day]);
  const resizeLeft = position.endsWith("right");
  const resizeTop = position.startsWith("bottom");
  function resize(width: number, height: number) {
    setSize({
      width: Math.min(window.innerWidth - 32, Math.max(240, width)),
      height: Math.min(window.innerHeight - 96, Math.max(180, height)),
    });
  }
  const panel = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  useEffect(() => {
    if (!open) return;
    const root = panel.current;
    const trigger = document.getElementById(triggerId);
    return () => {
      if (
        trigger?.isConnected &&
        (document.activeElement === document.body || root?.contains(document.activeElement))
      )
        focusQuietly(trigger);
    };
  }, [open, triggerId]);
  const dialogId = useId();
  const key = dayKey(day);
  const date = day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <>
      <IconButton
        id={triggerId}
        label={`Daily note · ${date}`}
        className={cn(
          "pointer-events-auto bg-transparent hover:bg-transparent",
          open || text.length > 0 ? "text-ink" : "text-ink-3",
        )}
        aria-pressed={open}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <StickyNote size={15} strokeWidth={1.75} />
      </IconButton>
      {open &&
        createPortal(
          <div
            className="pointer-events-none fixed inset-x-0 top-16 bottom-0 z-40 flex p-4"
            style={{
              paddingTop: position.startsWith("top") ? 56 : 16,
              paddingBottom: position.startsWith("bottom") ? 56 : 16,
              alignItems: position.startsWith("top")
                ? "flex-start"
                : position.startsWith("bottom")
                  ? "flex-end"
                  : "center",
              justifyContent: position.endsWith("left")
                ? "flex-start"
                : position.endsWith("right")
                  ? "flex-end"
                  : "center",
            }}
          >
            <div
              ref={panel}
              id={dialogId}
              role="region"
              data-note-font={dailyNoteFont}
              data-resize-top-right={resizeTop && !resizeLeft ? true : undefined}
              aria-label={`Daily note for ${date}`}
              className="daily-note-panel pointer-events-auto relative flex max-h-full max-w-full flex-col overflow-hidden rounded-xl text-ink"
              style={{ width: size.width, height: size.height }}
            >
              <IconButton
                label="Close daily note"
                className={cn(
                  "absolute top-2 z-10 text-ink-3 opacity-60 hover:opacity-100 focus-visible:opacity-100",
                  resizeTop && !resizeLeft ? "right-8" : "right-2",
                )}
                onClick={() => onOpenChange(false)}
              >
                <X size={13} strokeWidth={1.5} />
              </IconButton>
              <div
                ref={(node) => {
                  scroll.current = node;
                }}
                className={cn("no-scrollbar min-h-0 flex-1 overflow-auto", overflow && "fade-b")}
              >
                <Suspense fallback={null}>
                  <DailyNoteEditor
                    key={key}
                    text={text}
                    date={date}
                    onChange={(markdown) => store.setDayNote(key, markdown)}
                  />
                </Suspense>
              </div>
              <IconButton
                label="Resize daily note; arrow keys change width and height"
                className="absolute size-5 touch-none text-ink-3 opacity-25 hover:opacity-80 focus-visible:opacity-100 pointer-coarse:size-7"
                style={{
                  left: resizeLeft ? 0 : undefined,
                  right: resizeLeft ? undefined : 0,
                  top: resizeTop ? 0 : undefined,
                  bottom: resizeTop ? undefined : 0,
                  cursor: resizeLeft === resizeTop ? "nwse-resize" : "nesw-resize",
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !panel.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = panel.current.getBoundingClientRect();
                  resizing.current = {
                    x: event.clientX,
                    y: event.clientY,
                    width: bounds.width,
                    height: bounds.height,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const start = resizing.current;
                  if (!start) return;
                  event.stopPropagation();
                  const xScale =
                    position === "top" || position === "bottom" || position === "center" ? 2 : 1;
                  const yScale =
                    position === "left" || position === "right" || position === "center" ? 2 : 1;
                  resize(
                    start.width + (event.clientX - start.x) * (resizeLeft ? -1 : 1) * xScale,
                    start.height + (event.clientY - start.y) * (resizeTop ? -1 : 1) * yScale,
                  );
                }}
                onPointerUp={(event) => {
                  resizing.current = null;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  resizing.current = null;
                }}
                onLostPointerCapture={() => {
                  resizing.current = null;
                }}
                onKeyDown={(event) => {
                  const width =
                    event.key === "ArrowRight" ? 20 : event.key === "ArrowLeft" ? -20 : 0;
                  const height = event.key === "ArrowDown" ? 20 : event.key === "ArrowUp" ? -20 : 0;
                  if (!width && !height) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = panel.current?.getBoundingClientRect();
                  if (bounds) resize(bounds.width + width, bounds.height + height);
                }}
              >
                <MoveDiagonal2 size={10} strokeWidth={1.25} />
              </IconButton>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
