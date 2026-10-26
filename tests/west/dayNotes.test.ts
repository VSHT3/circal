import { expect, it, vi } from "vitest";
import { at, MemoryStorage } from "../helpers";
import { dayNoteId, readDayNote } from "@/lib/dayNotes";
import { addDays, dayKey } from "@/lib/time";

it("keeps the selected local day west of UTC, including after UTC midnight", async () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  // The store is a singleton; reload its module to exercise persisted hydration.
  vi.resetModules();
  const { store } = await import("@/lib/store");
  const evening = at("2026-03-08 23:30");
  const next = addDays(evening, 1);
  store.setDayNote(dayKey(evening), "Sunday after the DST jump");
  store.setDayNote(dayKey(next), "Monday");
  vi.resetModules();
  const reloaded = await import("@/lib/store");
  expect(
    reloaded.store.snapshot().dayNotes.map(({ id, day, text }) => ({ id, day, text })),
  ).toEqual([
    { id: dayNoteId("2026-03-08"), day: "2026-03-08", text: "Sunday after the DST jump" },
    { id: dayNoteId("2026-03-09"), day: "2026-03-09", text: "Monday" },
  ]);
  expect(readDayNote({ day: "2024-02-29", text: "Leap day" })?.day).toBe("2024-02-29");
  expect(readDayNote({ day: "2026-02-29", text: "Invalid" })).toBeNull();
});
