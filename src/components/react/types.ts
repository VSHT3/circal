/* Shared prop contracts between the shell (`App.tsx`) and its panels. */

import type { RefObject } from "react";
import type { Clock } from "@/lib/time";
import type { CalEvent, Calendar, Occurrence } from "@/lib/events";
import type { LifeStage } from "@/lib/life";
import type { PickedPlace } from "@/lib/places";
import type { TotalsPosition } from "@/lib/store";

export type ViewMode = "day" | "year" | "life";

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
  /** Ticking: the readout is a live percentage of a life. */
  now: Date;
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
  showZoneName: boolean;
  showZoneOffset: boolean;
  zoneDaylight: boolean;
  zoneMoonlight: boolean;
  /** Where the lightcycle is computed for; `null` = no band. */
  place: PickedPlace | null;
  daylight: boolean;
  moonlight: boolean;
  /** Whether the centre prints the day's totals, and where on the stage. */
  totals: boolean;
  totalsAt: TotalsPosition;
  tickSound: boolean;
  tickHaptics: boolean;
  /** The life span, as stored: `""` = never asked for. */
  birth: string;
  lifeExpectancy: number;
  calendars: Calendar[];
  actions: ShellActions;
}
