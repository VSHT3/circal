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
import { addDays, formatDayHeader, formatDayRange, startOfWeek } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TopBarProps } from "@/components/react/types";
import { ActionPill, IconButton, MOD, Segmented } from "@/components/react/ui/primitives";

/**
 * Where the wordmark and the readout give up — and it is a pair of numbers,
 * because the modifier chip is not one width.
 *
 * `Ctrl` is 40px where `⌘` is 18, and the view switch carries three of them
 * (the active segment shows none), so the left group is 67px wider on a
 * Windows or Linux keyboard and the right group 44px. Both thresholds were
 * re-measured against the longest header `formatDayHeader` produces, on both
 * spellings, by sweeping 360 → 1700: the readout clears the stepper from
 * 1220 / 1450, and the wordmark's 108px lockup fits from 1430 / 1660.
 *
 * Written as whole class strings rather than composed, because Tailwind reads
 * this file as text and a class it cannot see is a class it does not emit.
 */
const WIDE_MOD = MOD !== "⌘";
const WORDMARK = WIDE_MOD ? "min-[1660px]:flex" : "min-[1430px]:flex";
const WORDMARK_RULE = WIDE_MOD ? "min-[1660px]:block" : "min-[1430px]:block";
const READOUT = WIDE_MOD ? "min-[1450px]:block" : "min-[1220px]:block";

export default function TopBar({
  day,
  view,
  sidebarOpen,
  onStep,
  weekStart,
  actions,
}: TopBarProps) {
  const { weekday, date } = formatDayHeader(day);

  return (
    <div className="relative flex h-12 shrink-0 items-center border-b border-hairline px-3">
      <div className="flex items-center gap-2">
        {/* The mark, which is the favicon: one thin circumference. It is
            identity, not a control — no hover, no click target — and it sits at
            `ink-2` because chrome is grey and a pure-white ring here would be
            the brightest thing on the face outside the dial.

            Below `WORDMARK` it is gone entirely, mark and divider both: the
            date readout is centred on the *bar*, not on the space left over,
            so the 108px this lockup costs is 108px the readout stops having.
            The threshold is where the two still clear each other with the
            longest header `formatDayHeader` produces (`WEDNESDAY · SEP 30`) —
            1080 when the view switch had two segments, 1180 at three, 1430 at
            four, 1660 when the modifier reads `Ctrl` — and it has to be
            re-measured every time anything joins this group. The wordmark is
            what yields, every time, because it is the only thing here that is
            identity rather than information. */}
        <span className={cn("hidden items-center gap-2 pl-0.5 text-ink-2", WORDMARK)}>
          <Circle size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="font-mono text-[13px] tracking-[0.14em]">circal</span>
        </span>
        <span
          aria-hidden="true"
          className={cn("mx-1 hidden h-4 w-px bg-hairline", WORDMARK_RULE)}
        />

        <IconButton label="Toggle sidebar" active={sidebarOpen} onClick={actions.toggleSidebar}>
          <PanelLeft size={15} strokeWidth={1.75} />
        </IconButton>

        <Segmented
          value={view}
          onChange={actions.setView}
          options={[
            { id: "day", label: "Day", keys: [MOD, "D"] },
            { id: "week", label: "Week", keys: [MOD, "E"] },
            { id: "year", label: "Year", keys: [MOD, "Y"] },
            { id: "life", label: "Life", keys: [MOD, "L"] },
          ]}
        />

        {/* Gone below 480px, where a fourth segment stopped leaving room for
            it: the three groups need about 475px and a phone has 390. What
            goes is the one thing the phone has another way to do — the
            drawer's mini-month is a day picker, tapping a face in ⌘E names a
            day, and ⌘P jumps to one by typing. Hiding a *view* or the drawer's
            own button would each cost something with no second route to it. */}
        <div className="ml-1 hidden items-center gap-0.5 min-[480px]:flex">
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

      {/* The readout names what is on screen: the day on the dial, the year in
          the grid, and in the life view the one word that view is about —
          every date it could print is already in its own header.

          Gone below `READOUT`, measured the way the wordmark's own threshold
          was: it is centred on the *bar* rather than on the space the two
          groups leave, so it collides with the left group rather than
          shrinking, and the number is where the longest header this can print
          (`Wednesday · Sep 30`) stops clearing that group with the wordmark
          already withdrawn — 1220 with a ⌘ chip, 1450 with a `Ctrl` one. It
          was 820 with three segments. Nothing is lost — the dial's interior
          prints the date, the week its own range and the year ring the year.
          Anything added to the left group has to re-measure this as well as
          the wordmark's. */}
      <div className={cn("pointer-events-none absolute left-1/2 hidden -translate-x-1/2", READOUT)}>
        <span className="label text-[12px] tracking-[0.22em] text-ink-2">
          {view === "day" ? (
            <>
              {weekday} <span className="text-ink-4">·</span> {date}
            </>
          ) : view === "week" ? (
            formatDayRange(startOfWeek(day, weekStart), addDays(startOfWeek(day, weekStart), 6))
          ) : view === "year" ? (
            day.getFullYear()
          ) : (
            "Life"
          )}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <ActionPill
          label="Command palette"
          icon={<Command size={14} strokeWidth={1.75} />}
          keys={[MOD, "P"]}
          onClick={actions.openPalette}
        />
        <ActionPill
          label="New event"
          icon={<Plus size={15} strokeWidth={1.75} />}
          keys={[MOD, "N"]}
          onClick={actions.newEvent}
        />
        <IconButton label="Settings" onClick={actions.openSettings}>
          <Settings size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}
