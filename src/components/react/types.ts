/* Shared prop contracts between the shell (`App.tsx`) and its panels. */

import type { Clock } from "@/lib/time";
import type { CalEvent, Calendar, Occurrence } from "@/lib/events";
import type { Place } from "@/lib/sun";

export type ViewMode = "day" | "year";

/** What the editor is currently editing: an existing event, or a new draft. */
export interface EditorTarget {
  /** `null` while creating — the event does not exist in the store yet. */
  id: string | null;
  draft: Omit<CalEvent, "id">;
  /** Set for an event pulled from a subscription: somebody else's data. */
  readOnly?: boolean;
}

export interface ShellActions {
  goToday: () => void;
  goDay: (day: Date) => void;
  setView: (view: ViewMode) => void;
  newEvent: () => void;
  /** A draft over an explicit range on the selected day — the free-time rows. */
  newEventAt: (startMin: number, endMin: number) => void;
  toggleSidebar: () => void;
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
}

export interface YearViewProps {
  year: number;
  today: Date;
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  onSelectDay: (day: Date) => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  day: Date;
  now: Date;
  view: ViewMode;
  sidebarOpen: boolean;
  events: CalEvent[];
  calendars: Calendar[];
  /** The selected day's agenda — what the free-time search works against. */
  occurrences: Occurrence[];
  clock: Clock;
  actions: ShellActions;
}

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  clock: Clock;
  /** `""` = the dial's second ring is off. */
  secondZone: string;
  place: Place | null;
  calendars: Calendar[];
  actions: ShellActions;
}
