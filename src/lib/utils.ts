import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The project's one object guard, for parsing external input — a backup file,
 * a pasted blob. There is no schema validator in this project and no reason to
 * add one for two call sites; this narrows to "an object", and every field is
 * then checked individually where it is read.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
