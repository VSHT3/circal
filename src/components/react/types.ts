/* Shared prop contracts between the shell (`App.tsx`) and its panels. */

import type { RefObject } from "react";
import type { Clock } from "@/lib/time";
import type { CalEvent, Calendar, Occurrence } from "@/lib/events";
import type { LifeStage } from "@/lib/life";
import type { Settings } from "@/lib/store";
import type { QuickAdd } from "@/lib/quickadd";

export type ViewMode = "day" | "year" | "life";

/**
 * How ambient was entered, because that is what decides how it leaves. Asked
 * for (`manual`), it stays until it is dismissed — the pointer is how you use
 * a dial, and a mode that fell over at a mouse movement could not be dragged
 * on. Arrived on its own (`auto`), it is a screensaver and leaves like one.
 */
export type AmbientMode = "off" | "manual" | "auto";

/**
 * The view change in progress, and the day it lands on.
 *
 * Read through a ref rather than passed as a value, because it is needed by
 * elements that are *leaving*: the props of a component being removed are
 * frozen at its last render, so nothing in them can name the view that is
 * arriving. Motion resolves a dynamic `exit` variant when the exit starts, and
 * `usePresence` fires then too — both read `.current` and get the truth.
 */
export interface ViewFlow {
  from: ViewMode;
  to: ViewMode;
  /** The selected day *after* the change — which day the zoom is about. */
  day: Date;
}

/** What the editor is currently editing: an existing event, or a new draft. */
export interface EditorTarget {
  /** `null` while creating — the event does not exist in the store yet. */
  id: string | null;
  draft: Omit<CalEvent, "id">;
  /** Set for an event pulled from a subscription: somebody else's data. */
  readOnly?: boolean;
  /**
   * The instant of the occurrence the editor was opened from, epoch ms —
   * what "skip this one" and "only this one" apply to. Unset for a fresh
   * draft or an event opened without one; those actions then fall back to
   * the series' own seed, which is the occurrence a bare `openEvent` means.
   */
  occurrenceStart?: number;
}

export interface ShellActions {
  goToday: () => void;
  goDay: (day: Date) => void;
  setView: (view: ViewMode) => void;
  newEvent: () => void;
  /** A draft over an explicit range on the selected day — the free-time rows. */
  newEventAt: (startMin: number, endMin: number) => void;
  /**
   * A whole event from one typed line in ⌘P. It creates and closes — a review
   * step would make a one-line gesture two — so the row that runs it prints
   * the span first, and undo covers the misfire.
   */
  quickAdd: (spec: QuickAdd) => void;
  toggleSidebar: () => void;
  /**
   * Chrome away, dial to the window. Not exposed in the top bar: the left
   * group's width is what fixes the date readout's clearance, and this is a
   * mode you leave running rather than one you reach for hourly.
   */
  toggleAmbient: () => void;
  openEvent: (event: CalEvent) => void;
  toggleCalendar: (id: string) => void;
  openPalette: () => void;
  openSettings: () => void;
  setClock: (clock: Clock) => void;
  undo: () => void;
  redo: () => void;
  exportIcs: () => void;
  exportBackup: () => void;
  importFile: () => void;
  /** Pull every subscription now, regardless of age. */
  refreshFeeds: () => void;
}

export interface TopBarProps {
  day: Date;
  view: ViewMode;
  sidebarOpen: boolean;
  /** −1 / +1: a day in day view, a year in year view. */
  onStep: (delta: number) => void;
  actions: ShellActions;
}

export interface SidebarProps {
  open: boolean;
  day: Date;
  now: Date;
  /** The selected day's agenda, all-day first, lanes already assigned. */
  occurrences: Occurrence[];
  events: CalEvent[];
  calendars: Calendar[];
  clock: Clock;
  actions: ShellActions;
}

export interface EventEditorProps {
  target: EditorTarget;
  clock: Clock;
  calendars: Calendar[];
  onSave: (draft: Omit<CalEvent, "id">) => void;
  /** Only rendered when `target.id` is set. */
  onDelete: () => void;
  onClose: () => void;
  /**
   * "Skip this one": excludes `target.occurrenceStart` from the series and
   * changes nothing else. Only rendered for a repeating, editable event.
   */
  onSkipOccurrence: () => void;
  /**
   * "Only this one": saves the edit as a standalone override of
   * `target.occurrenceStart`, leaving the series it came from untouched.
   */
  onOverrideOccurrence: (draft: Omit<CalEvent, "id">) => void;
}

export interface YearViewProps {
  year: number;
  /** Ticking, but read at day resolution: the face marks today with a pip. */
  today: Date;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  /** Whole, as everywhere: the ring reads the two tick channels for the cue a
   *  day makes as the pointer crosses it. */
  settings: Settings;
  /**
   * The life grid's geometry, resolved by the shell — the year ring owns both
   * halves of the unroll and needs to know where its row lands before that
   * grid exists. `null` when there is no life to unroll into, which falls the
   * pair back to a crossfade.
   */
  stage: LifeStage | null;
  flow: RefObject<ViewFlow>;
  onSelectDay: (day: Date) => void;
}

export interface LifeViewProps {
  /**
   * The span and the geometry, resolved by the shell — which needs the same
   * layout to know where the dial should land. `null` when there is nothing to
   * draw: no birth date yet, or a panel too small to be a field.
   */
  stage: LifeStage | null;
  flow: RefObject<ViewFlow>;
  /** `YYYY-MM-DD`, or `""` — which is what puts the prompt on screen. */
  birth: string;
  /** Years the grid runs for, from the birthday. */
  expectancy: number;
  /** Ticking on the minute. The percentage in the strip runs its own second
   *  clock; everything else here changes at midnight or not at all. */
  now: Date;
  /** Whether the grid names its round days. */
  milestones: boolean;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  /**
   * The query lighting the grid — what ⌘P has in its box while this view is on
   * screen, or `""`. Every day carrying a matching event keeps its colour and
   * the rest of the life recedes, which is the one question a field of eighty
   * years can answer that no other calendar surface can.
   */
  search: string;
  onClearSearch: () => void;
  onSelectDay: (day: Date) => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  day: Date;
  now: Date;
  view: ViewMode;
  sidebarOpen: boolean;
  ambient: boolean;
  events: CalEvent[];
  calendars: Calendar[];
  /** The selected day's agenda — what the free-time search works against. */
  occurrences: Occurrence[];
  clock: Clock;
  actions: ShellActions;
  /**
   * Every keystroke, while the life view is the one behind us. The shell holds
   * it rather than this panel because the grid outlives the palette: the
   * thread stays lit after ⌘P closes, so it can be read.
   */
  onSearchLife: (query: string) => void;
}

/**
 * The whole settings object, rather than one prop per field.
 *
 * Threading them individually meant six files had to change to add a single
 * boolean — this interface re-listed every field of `Settings`, `App.tsx`
 * forwarded each one, and the panel destructured them again. Passing the
 * object is the same bargain already struck for `actions`: one prop, and the
 * shell has nothing to forward.
 */
export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  calendars: Calendar[];
  actions: ShellActions;
}
