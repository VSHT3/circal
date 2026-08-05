/* ------------------------------------------------------------------ *
 * The chrome above the dial: view switch, day/year nav, date readout,
 * command palette and new-event entry points.
 * ------------------------------------------------------------------ */

import { ChevronLeft, ChevronRight, Command, PanelLeft, Plus } from "lucide-react";
import { formatDayHeader } from "@/lib/time";
import type { TopBarProps } from "@/components/react/types";
import { ActionPill, IconButton, Segmented } from "@/components/react/ui/primitives";

export default function TopBar({ day, view, sidebarOpen, onStep, actions }: TopBarProps) {
  const { weekday, date } = formatDayHeader(day);

  return (
    <div className="relative flex h-12 shrink-0 items-center border-b border-hairline px-3">
      <div className="flex items-center gap-2">
        <IconButton label="Toggle sidebar" active={sidebarOpen} onClick={actions.toggleSidebar}>
          <PanelLeft size={15} strokeWidth={1.75} />
        </IconButton>

        <Segmented
          value={view}
          onChange={actions.setView}
          options={[
            { id: "day", label: "Day", keys: ["⌘", "D"] },
            { id: "year", label: "Year", keys: ["⌘", "Y"] },
          ]}
        />

        <div className="ml-1 flex items-center gap-0.5">
          <IconButton label="Previous" onClick={() => onStep(-1)}>
            <ChevronLeft size={15} strokeWidth={1.75} />
          </IconButton>
          <button
            type="button"
            onClick={actions.goToday}
            className="h-7 rounded-[8px] px-2 text-[13px] text-ink-2 transition-colors hover:bg-white/6 hover:text-ink"
          >
            Today
          </button>
          <IconButton label="Next" onClick={() => onStep(1)}>
            <ChevronRight size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      </div>

      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2">
        {view === "day" ? (
          <span className="label text-[12px] tracking-[0.22em] text-ink-2">
            {weekday} <span className="text-ink-4">·</span> {date}
          </span>
        ) : (
          <span className="label text-[12px] tracking-[0.22em] text-ink-2">
            {day.getFullYear()}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        <ActionPill
          label="Command palette"
          icon={<Command size={14} strokeWidth={1.75} />}
          keys={["⌘", "K"]}
          onClick={actions.openPalette}
        />
        <ActionPill
          label="New event"
          icon={<Plus size={15} strokeWidth={1.75} />}
          keys={["⌘", "N"]}
          onClick={actions.newEvent}
        />
      </div>
    </div>
  );
}
