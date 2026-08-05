/* ------------------------------------------------------------------ *
 * The chrome above the dial: view switch, day/year nav, date readout,
 * command palette and new-event entry points.
 * ------------------------------------------------------------------ */

import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Command,
  PanelLeft,
  Plus,
  Settings,
} from "lucide-react";
import { formatDayHeader } from "@/lib/time";
import type { TopBarProps } from "@/components/react/types";
import { ActionPill, IconButton, Segmented } from "@/components/react/ui/primitives";

export default function TopBar({ day, view, sidebarOpen, onStep, actions }: TopBarProps) {
  const { weekday, date } = formatDayHeader(day);

  return (
    <div className="relative flex h-12 shrink-0 items-center border-b border-hairline px-3">
      <div className="flex items-center gap-2">
        {/* The mark, which is the favicon: one thin circumference. It is
            identity, not a control — no hover, no click target — and it sits at
            `ink-2` because chrome is grey and a pure-white ring here would be
            the brightest thing on the face outside the dial.

            Below 1080px it is gone entirely, mark and divider both: the date
            readout is centred on the *bar*, not on the space left over, so the
            108px this lockup costs is 108px the readout stops having. 1080 is
            where the two still clear each other with the longest header
            `formatDayHeader` produces (`WEDNESDAY · SEP 30`). */}
        <span className="hidden items-center gap-2 pl-0.5 text-ink-2 min-[1080px]:flex">
          <Circle size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="font-mono text-[13px] tracking-[0.14em]">circal</span>
        </span>
        <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-hairline min-[1080px]:block" />

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
          keys={["⌘", "P"]}
          onClick={actions.openPalette}
        />
        <ActionPill
          label="New event"
          icon={<Plus size={15} strokeWidth={1.75} />}
          keys={["⌘", "N"]}
          onClick={actions.newEvent}
        />
        <IconButton label="Settings" onClick={actions.openSettings}>
          <Settings size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}
