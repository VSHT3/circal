import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Grip, StickyNote, X } from "lucide-react";
import { store, type TotalsPosition } from "@/lib/store";
import { dayKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "./hooks";
import { IconButton, Segmented } from "./ui/primitives";

interface DailyNoteProps {
  day: Date;
  text: string;
  position: TotalsPosition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DailyNotePreview = lazy(() => import("./DailyNotePreview"));

export default function DailyNote({ day, text, position, open, onOpenChange }: DailyNoteProps) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
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
    // The preview arrives from a lazy chunk after the scroll box is mounted.
    const content = new MutationObserver(measure);
    content.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      content.disconnect();
    };
  }, [open, mode, text, day]);
  const resizeLeft = position.endsWith("right");
  const resizeTop = position.startsWith("bottom");
  function resize(width: number, height: number) {
    setSize({
      width: Math.min(window.innerWidth - 32, Math.max(240, width)),
      height: Math.min(window.innerHeight - 96, Math.max(180, height)),
    });
  }
  const dialog = useFocusTrap<HTMLDivElement>(open);
  const titleId = useId();
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
        label={`Daily note · ${date}`}
        className="pointer-events-auto"
        active={open || text.length > 0}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-haspopup="dialog"
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
              ref={dialog}
              id={dialogId}
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
              className="pointer-events-auto relative flex max-h-full max-w-full flex-col overflow-hidden rounded-xl border border-hairline bg-surface pt-3 pb-5 text-ink shadow-xl"
              style={{ width: size.width, height: size.height }}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
                <StickyNote size={14} strokeWidth={1.75} className="shrink-0 text-ink-2" />
                <h2 id={titleId} className="min-w-0 flex-1 text-[13px] font-medium">
                  {date}
                </h2>
                <IconButton label="Close daily note" onClick={() => onOpenChange(false)}>
                  <X size={14} strokeWidth={1.75} />
                </IconButton>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { id: "edit", label: "Edit" },
                    { id: "preview", label: "Preview" },
                  ]}
                />
                <span className="caption text-ink-3">Saved automatically</span>
              </div>
              {mode === "edit" ? (
                <textarea
                  key={key}
                  ref={(node) => {
                    scroll.current = node;
                  }}
                  aria-label={`Daily note for ${date}, Markdown`}
                  value={text}
                  onChange={(event) => store.setDayNote(key, event.currentTarget.value)}
                  placeholder="Write a note for this day…"
                  spellCheck
                  className={cn(
                    "no-scrollbar min-h-0 w-full flex-1 resize-none overflow-auto bg-transparent px-3 pb-3 font-mono text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-3",
                    overflow && "fade-b",
                  )}
                />
              ) : (
                <div
                  ref={(node) => {
                    scroll.current = node;
                  }}
                  className={cn(
                    "no-scrollbar min-h-0 flex-1 overflow-auto px-3 pb-3",
                    overflow && "fade-b",
                  )}
                >
                  <Suspense fallback={null}>
                    <DailyNotePreview text={text} />
                  </Suspense>
                </div>
              )}
              <IconButton
                label="Resize daily note; arrow keys change width and height"
                className="absolute size-5 touch-none pointer-coarse:size-7"
                style={{
                  left: resizeLeft ? 0 : undefined,
                  right: resizeLeft ? undefined : 0,
                  top: resizeTop ? 0 : undefined,
                  bottom: resizeTop ? undefined : 0,
                  cursor: resizeLeft === resizeTop ? "nwse-resize" : "nesw-resize",
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !dialog.current) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = dialog.current.getBoundingClientRect();
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
                  const bounds = dialog.current?.getBoundingClientRect();
                  if (bounds) resize(bounds.width + width, bounds.height + height);
                }}
              >
                <Grip size={12} strokeWidth={1.75} />
              </IconButton>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
