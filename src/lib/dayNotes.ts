import { readStamp } from "./events";

export interface DailyNote {
  id: string;
  day: string;
  text: string;
  updatedAt: number;
}

/** Calendar dates, not instants: validation must not shift a day with the reader's zone. */
export function isDayNoteDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function dayNoteId(day: string): string {
  return `day-note:${day}`;
}

export function readDayNote(value: unknown): DailyNote | null {
  if (!value || typeof value !== "object") return null;
  const note = value as Record<string, unknown>;
  if (!isDayNoteDay(note.day) || typeof note.text !== "string") return null;
  return {
    id: dayNoteId(note.day),
    day: note.day,
    text: note.text,
    updatedAt: readStamp(note.updatedAt),
  };
}

/** One record per local date; blank records retain a clear across offline merges. */
export function readDayNotes(value: unknown): DailyNote[] {
  if (!Array.isArray(value)) return [];
  const notes = new Map<string, DailyNote>();
  for (const item of value) {
    const note = readDayNote(item);
    if (!note) continue;
    const previous = notes.get(note.id);
    if (
      !previous ||
      note.updatedAt > previous.updatedAt ||
      (note.updatedAt === previous.updatedAt &&
        JSON.stringify(note.text) < JSON.stringify(previous.text))
    ) {
      notes.set(note.id, note);
    }
  }
  return [...notes.values()];
}
