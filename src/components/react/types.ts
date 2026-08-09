/* Shared prop contracts between the shell (`App.tsx`) and its panels. */

import type { RefObject } from "react";
import type { Clock } from "@/lib/time";
import type { CalEvent, Calendar, Occurrence } from "@/lib/events";
import type { LifeStage } from "@/lib/life";
import type { WeekStage } from "@/lib/week";
import type { MoonStyle, Settings } from "@/lib/store";
import type { QuickAdd } from "@/lib/quickadd";

export type ViewMode = "day" | "week" | "year" | "life";

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
  /** Where that day's face in the week strip is, as a transform of the whole
   *  panel. Carried here for the same reason the rest of this is: the element
   *  that has to apply it is the dial on its way out. */
  face: ZoomFrame;
}

/**
 * A panel scaled down onto a smaller copy of itself somewhere else in the box.
 *
 * `dx`/`dy` are a translation of the panel's *centre*, already corrected for
 * whatever `transform-origin` the panel is carrying — the life zoom needs that
 * origin to be its own dot, and the week zoom has to land correctly regardless
 * of it. `App.originPoint` does the arithmetic once, so nothing downstream has
 * to know which of the two is in force.
 */
export interface ZoomFrame {
  scale: number;
  dx: number;
  dy: number;
}

/** Where a draft sits, whether it is all-day, and what colour it is:
 *  everything a face needs to draw an event that is still only in the editor. */
export interface DraftMark {
  start: number;
  /** Exclusive, as everywhere. */
  end: number;
  /** No arc on the dial, exactly as a saved all-day event has none. */
  allDay: boolean;
  /** A pip rather than an arc, and the reason the mark cannot simply be
   *  derived from `start === end`: the switch is what says so. */
  task: boolean;
  /** The event's own override, `""` for "follow the calendar". */
  color: string;
  calendarId: string;
}

/**
 * Which part of a repeating event an edit or a delete lands on. Asked at the
 * moment of committing rather than offered as standing controls, because it is
 * a property of the press, not of the event: a one-off never has to answer it.
 */
export type EditScope = "one" | "future" | "all";

/** What the editor is currently editing: an existing event, or a new draft. */
export interface EditorTarget {
  /** `null` while creating — the event does not exist in the store yet. */
  id: string | null;
  draft: Omit<CalEvent, "id">;
  /** Set for an event pulled from a subscription: somebody else's data. */
  readOnly?: boolean;
  /**
   * The instant of the occurrence the editor was opened from, epoch ms — the
   * one an `EditScope` is measured against. Unset for a fresh draft or an event
   * opened without one; the scope then falls back to the series' own seed,
   * which is the occurrence a bare `openEvent` means.
   */
  occurrenceStart?: number;
  /**
   * The draft as the open modal currently has it — where it sits and what
   * colour it is, so a face behind the editor can draw the event that does not
   * exist yet. Unset until the first change, which is why every reader falls
   * back to `draft`.
   *
   * Four fields rather than the whole draft on purpose: this updates on every
   * change in the modal, and a title keystroke must not repaint a ring of 365
   * marks. It lives on the target so that it dies with it — a preview outliving
   * the modal it came from is a mark nothing can clear.
   */
  live?: DraftMark;
}

export interface ShellActions {
  goToday: () => void;
  goDay: (day: Date) => void;
  setView: (view: ViewMode) => void;
  newEvent: () => void;
  /** A dated task on the selected day, at the same hour ⌘N would open on: a
   *  task and an event are the same question about a different width, so they
   *  must not disagree about when. */
  newTask: () => void;
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
  /** The calendar card, empty. Colour is the only category encoding this app
   *  has, so making one is a first-class verb rather than a settings chore. */
  newCalendar: () => void;
  editCalendar: (id: string) => void;
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
  /**
   * `push` puts the column beside the dial and lets the stage shrink around
   * it; `drawer` lays it over the face on a scrim. The shell decides, and it
   * decides by geometry rather than by a breakpoint — see `SIDEBAR_W`.
   */
  mode: "push" | "drawer";
  day: Date;
  now: Date;
  events: CalEvent[];
  calendars: Calendar[];
  /**
   * How the moon is drawn at the foot of the column, or `off`. A scalar
   * rather than the whole `Settings` object: this panel reads one field of
   * it, and it should not be able to re-render on a twenty-eighth changing.
   */
  moonPhase: MoonStyle;
  actions: ShellActions;
}

export interface EventEditorProps {
  target: EditorTarget;
  clock: Clock;
  calendars: Calendar[];
  /** `scope` is `"all"` for anything that does not repeat: there is nothing
   *  else it could mean, and the editor does not ask. */
  onSave: (draft: Omit<CalEvent, "id">, scope: EditScope) => void;
  /** Only reachable when `target.id` is set. */
  onDelete: (scope: EditScope) => void;
  onClose: () => void;
  /**
   * The draft as it now stands, on every change that could move or recolour it.
   * The shell keeps it on the target as `live` so the face behind the modal can
   * draw the event before it exists — see `EditorTarget.live`.
   */
  onDraftChange: (draft: Omit<CalEvent, "id">) => void;
}

export interface CalendarEditorProps {
  /** The calendar being edited, or `null` for one that does not exist yet. */
  target: Calendar | null;
  /**
   * What deleting would cost — how many of your own events it holds, and the
   * calendar they would move to — or `null` when it may not be deleted at all.
   * The last calendar that is not a feed stays, because every new event needs
   * somewhere to be written; a disabled verb with the reason on it is a better
   * answer than a verb that fails.
   */
  removal: { holds: number; into: string } | null;
  onSave: (name: string, color: string, icon: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export interface ScopeChoicesProps {
  /** The label above the answers: what the press is about to do. */
  heading: string;
  /** Destructive, so the three answers take the danger colour. */
  danger?: boolean;
  onPick: (scope: EditScope) => void;
  onCancel: () => void;
}

export interface ScopeDialogProps extends ScopeChoicesProps {
  /** The event being changed. A gesture is over by the time this appears, so
   *  the card has to say what it is asking about. */
  title: string;
  /** Where the gesture has just put it — the span, in the app's clock. */
  detail: string;
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
  /**
   * The event the open editor is about to create, on the days it covers and in
   * the colour it currently carries — the range you dragged stays lit and
   * answers the swatch you are picking, rather than reverting the moment the
   * modal arrives. Both ends inclusive. `null` when there is nothing pending,
   * which includes an existing event: that already has marks on this face, and
   * a second set over them would draw the same event twice.
   */
  pending: { from: Date; to: Date; color: string } | null;
  onSelectDay: (day: Date) => void;
  /**
   * A drag across the ring: an all-day event running `days` days from `from`,
   * both ends inclusive. It is the dial's own ring gesture one scale up — a
   * range of minutes becomes a timed event, a range of days becomes a
   * multi-day one — and the shell turns both into a draft in the editor.
   */
  onCreateSpan: (from: Date, days: number) => void;
}

export interface WeekViewProps {
  /**
   * The strip's geometry, resolved by the shell — which needs the same layout
   * to know where the dial has to zoom *to* before the strip is mounted, the
   * same contract `LifeStage` has. `null` before the panel is measured.
   */
  stage: WeekStage | null;
  /** Ticking. Only today's face draws a ramp or a hand, so the rest of the
   *  strip is indifferent to it. */
  now: Date;
  /** The day the strip is *about*: its face carries the selection ring, and it
   *  is the face the zoom leaves from and lands on. */
  selected: Date;
  events: CalEvent[];
  calendars: Calendar[];
  /** Whole: the strip reads the clock, the arc marks and both tick channels. */
  settings: Settings;
  /** Name a day — which leaves this view for the dial, exactly as the year
   *  ring's click does. */
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
  /** As `SidebarProps.inheritMarks` — its event rows resolve a mark too. */
  inheritMarks: boolean;
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
