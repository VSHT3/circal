/* ------------------------------------------------------------------ *
 * The mirror, connected: a file handle, a poll and a write.
 *
 * The pure half is `mirror.ts` — what the file says and who wins. This half
 * is the browser's side of it, and it is all external systems: a handle kept
 * in IndexedDB (a `FileSystemFileHandle` is structured-cloneable and
 * `localStorage` is not), a permission that has to be re-granted from a
 * gesture, and a poll.
 *
 * Its own tiny external store rather than a field on the snapshot, for
 * `notify.ts`'s reason one step further: the snapshot is written to
 * `localStorage` on every mutation *and now to a file as well*, so putting
 * the mirror's own status inside it would make the status a thing the mirror
 * mirrors.
 *
 * A poll rather than a watcher because the platform offers no change event
 * for a user-picked file. It is one `getFile()` per tick — a stat, not a read
 * — and it stops while the tab is hidden, because a background tab racing an
 * agent for the same file is contention nobody asked for.
 * ------------------------------------------------------------------ */

import { useSyncExternalStore } from "react";
import { notify } from "./notify";
import { store, subscribe } from "./store";
import {
  localZone,
  mirrorDigest,
  mirrorVerdict,
  readMirrorFile,
  serialiseMirror,
  zonesAgree,
} from "./mirror";

/* ------------------------------ the platform ------------------------------ */

/**
 * The File System Access API, as much of it as this file touches.
 *
 * Hand-declared because `showSaveFilePicker` and the two permission methods
 * are not in TypeScript's DOM library — they are a WICG draft Chromium
 * shipped and the other two engines have not. Declaring the four members used
 * is the honest alternative to `any`, which is banned here anyway.
 */
type HandlePermissionState = "granted" | "denied" | "prompt";

interface PermissionDescriptor {
  mode: "read" | "readwrite";
}

interface MirrorHandle extends FileSystemFileHandle {
  queryPermission?(descriptor: PermissionDescriptor): Promise<HandlePermissionState>;
  requestPermission?(descriptor: PermissionDescriptor): Promise<HandlePermissionState>;
}

interface FilePickerWindow {
  showSaveFilePicker?(options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<MirrorHandle>;
}

function picker(): FilePickerWindow["showSaveFilePicker"] {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as FilePickerWindow).showSaveFilePicker;
}

/**
 * The macOS shell's side of the same file, injected as `window.__circalMirror`
 * (see `mac/main.swift`). It exists because `WKWebView` ships none of the File
 * System Access API — measured, not assumed: `showSaveFilePicker`,
 * `showOpenFilePicker` and `showDirectoryPicker` are all `undefined` there. The
 * mirror is the only way an assistant reads this calendar, so a shell without
 * this is a shell that quietly drops the feature.
 *
 * A path is deliberately not in this interface. The panel prints a file's name
 * and nothing here needs more, so the shell keeps the path on its own side and
 * the app's copy stays true on every platform.
 */
interface NativeMirror {
  /** `""` when the save panel was dismissed. */
  pick(suggestedName: string): Promise<string>;
  /** `""` when the shell is holding nothing. */
  remembered(): Promise<string>;
  read(): Promise<string>;
  write(body: string): Promise<void>;
  forget(): Promise<void>;
}

interface ShellWindow {
  __circalMirror?: NativeMirror;
}

function nativeMirror(): NativeMirror | undefined {
  if (typeof window === "undefined") return undefined;
  // Injected by `mac/main.swift` before the first script of the page runs, so
  // it is unexpressible in the DOM types — the same boundary `picker()` crosses
  // one function up, and the cast is named rather than read through inline.
  const shell = window as unknown as ShellWindow;
  return shell.__circalMirror;
}

/**
 * A `MirrorHandle` over the shell's file, so everything downstream — the poll,
 * the digest, the three verdicts, the settle timer — runs unchanged.
 *
 * No permission methods, on purpose: `permitted` reads their absence as
 * granted, which is the truth for an app that was handed a file at a save
 * panel. The writable buffers rather than streams, because `write` above hands
 * over a whole calendar in one call and a half-written mirror is the one
 * outcome this feature may not produce.
 */
function nativeHandle(native: NativeMirror, name: string): MirrorHandle {
  const shell = {
    kind: "file" as const,
    name,
    isSameEntry: async (other: FileSystemHandle) => other.name === name,
    getFile: async () => new File([await native.read()], name, { type: "application/json" }),
    createWritable: async () => {
      let body = "";
      return {
        write: (chunk: string) => {
          body += chunk;
        },
        close: () => native.write(body),
      };
    },
  };
  // One cast, at the boundary: the shape above is every member this file
  // touches, and the DOM interface declares several a shell cannot answer.
  return shell as unknown as MirrorHandle;
}

export function mirrorSupported(): boolean {
  return picker() !== undefined || nativeMirror() !== undefined;
}

/* -------------------------------- the handle ------------------------------ */

const DB_NAME = "circal.mirror";
const DB_STORE = "handle";
const DB_KEY = "current";

/**
 * What survives a reload: the handle, and the revision this browser last
 * wrote. The revision has to persist with it — a reload that reset it to zero
 * would read its own file back as somebody else's write and adopt it, which
 * is harmless exactly once and a loop if the clock is unlucky.
 */
interface StoredLink {
  /**
   * `null` under the macOS shell, which remembers the file itself: a bookmark
   * outlives a move and needs no second gesture, so the revision is the only
   * part left for the browser to keep — and a native handle carries methods,
   * which structured clone refuses outright.
   */
  handle: MirrorHandle | null;
  rev: number;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

/* --------------------------------- status --------------------------------- */

export type MirrorState = "off" | "prompt" | "live" | "error";

export interface MirrorStatus {
  state: MirrorState;
  /** File name, when one is remembered. */
  name: string;
  /** Epoch ms of the last successful sync in either direction. */
  at: number;
  /** Only meaningful when `state === "error"`. */
  message: string;
}

const OFF: MirrorStatus = { state: "off", name: "", at: 0, message: "" };

let status: MirrorStatus = OFF;
const listeners = new Set<() => void>();

function setStatus(next: Partial<MirrorStatus>) {
  status = { ...status, ...next };
  for (const listener of listeners) listener();
}

export function useMirror(): MirrorStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
    () => OFF,
  );
}

/* ------------------------------- the session ------------------------------ */

/** How often the file is stat-ed while the tab is visible. Fast enough that an
 *  agent's write lands within a breath, slow enough to be free. */
const POLL_MS = 2_000;

/**
 * How long a burst of store writes is allowed to settle before one file write.
 * A drag commits once on release, but an editor's Save and the toast that
 * follows are two commits in a frame, and the file should see one of them.
 */
const SETTLE_MS = 400;

let handle: MirrorHandle | null = null;
let localRev = 0;
/** The last contents written or adopted, so a change that is not a change —
 *  a feed re-pull, a settings toggle that set the same value — costs no write. */
let lastDigest = "";
let writing: Promise<void> = Promise.resolve();
/** `window.setTimeout`, not the bare global: with `@types/node` in the project
 *  the bare one is typed as Node's `Timeout` object, and this file is browser
 *  only. `0` is the id no live timer has. */
let settleTimer = 0;
let pollTimer = 0;

function fail(message: string) {
  setStatus({ state: "error", message });
}

/**
 * Persist the handle and the revision beside it, and never fail a sync over
 * it.
 *
 * This is bookkeeping: losing it costs the *next* session a reconnect, where
 * the write it follows has already put the user's calendar safely on disk.
 * Reporting that write as failed because the note about it did not stick is
 * the wrong way round, and it is the exact shape of a browser with
 * IndexedDB refused — private mode, or storage blocked — where the file
 * itself is written perfectly well.
 */
async function remember(): Promise<void> {
  try {
    const stored: StoredLink = { handle: nativeMirror() ? null : handle, rev: localRev };
    await withStore("readwrite", (s) => s.put(stored, DB_KEY));
  } catch {
    // Deliberately silent: the sync worked, and there is nothing the user
    // could do about this that reconnecting next time does not already do.
  }
}

/**
 * Serialised behind `writing`: two overlapping writes to one file interleave
 * their chunks, and the loser is a truncated calendar.
 *
 * The failure is swallowed into the chain rather than left on it. A rejected
 * `writing` is a poisoned queue — every later `.then` inherits the rejection
 * and never runs — so one refused write would silently stop the mirror for
 * the rest of the session, which is the failure mode this whole feature
 * exists to prevent.
 */
function write(next: number): Promise<void> {
  const done = writing
    .then(async () => {
      if (!handle) return;
      const snapshot = store.snapshot();
      const body = serialiseMirror(snapshot, next);
      const stream = await handle.createWritable();
      await stream.write(body);
      await stream.close();
      localRev = next;
      lastDigest = mirrorDigest(snapshot);
      await remember();
      setStatus({ state: "live", message: "", at: Date.now() });
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : "Could not write the mirror file");
    });
  writing = done;
  return done;
}

/**
 * One pass over the file. Reads the revision, and acts on the three answers
 * `mirrorVerdict` gives — including `stale`, where the browser re-asserts
 * rather than letting an older copy of the file pull the calendar backwards.
 */
async function poll(): Promise<void> {
  if (!handle) return;
  let text: string;
  try {
    text = await (await handle.getFile()).text();
  } catch (error: unknown) {
    // A handle whose permission lapsed, or a file that has been moved out
    // from under us. Both want the same thing from the user: a gesture.
    setStatus({ state: "prompt", message: error instanceof Error ? error.message : "" });
    return;
  }

  // An empty file is the one the picker just made. Nothing to adopt; the next
  // write fills it.
  const contents = text.trim() === "" ? null : readMirrorFile(text);
  if (!contents) {
    if (text.trim() !== "") {
      fail("That file is not a circal backup");
      return;
    }
    await write(localRev + 1);
    return;
  }

  const verdict = mirrorVerdict(contents.rev, localRev);
  if (verdict === "stale") {
    await write(localRev + 1);
    return;
  }
  if (verdict === "ours") {
    setStatus({ state: "live", message: "", at: Date.now() });
    return;
  }

  // Somebody else wrote. Refuse a file whose days are not our days rather
  // than silently importing a calendar shifted by an offset — the reason the
  // zone is in the file at all.
  if (!zonesAgree(contents.zone, localZone())) {
    fail(`That file was written in ${contents.zone}, this browser is in ${localZone()}`);
    return;
  }

  localRev = contents.rev;
  lastDigest = mirrorDigest(contents);
  store.adopt(contents);
  await remember();
  setStatus({ state: "live", message: "", at: Date.now() });
  notify(`Calendar updated from ${handle.name} — ⌘Z to undo`);
}

/** The store moved. Write, unless what moved is not in the file. */
function onStoreChange() {
  if (!handle || status.state === "error") return;
  if (mirrorDigest(store.snapshot()) === lastDigest) return;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => void write(localRev + 1), SETTLE_MS);
}

/* -------------------------------- the actions ----------------------------- */

async function permitted(candidate: MirrorHandle): Promise<boolean> {
  // Both methods are optional in the draft and absent in engines that ship
  // the handle without the permission model; a handle we cannot interrogate
  // is assumed usable, and the first read says otherwise if it is not.
  const state = (await candidate.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state === "granted") return true;
  return ((await candidate.requestPermission?.({ mode: "readwrite" })) ?? "denied") === "granted";
}

/**
 * Pick up the file the shell is already holding, which is the whole of the
 * native side's restore: no picker, no permission, no gesture.
 *
 * The revision still comes out of IndexedDB and nowhere else. The file cannot
 * supply it — its own `rev` is the thing being compared against — and starting
 * from zero would read our own last write as somebody else's and adopt it.
 */
async function resumeNative(native: NativeMirror): Promise<void> {
  const name = await native.remembered();
  if (!name) return;
  const link = await withStore<StoredLink | undefined>("readonly", (s) => s.get(DB_KEY)).catch(
    () => undefined,
  );
  handle = nativeHandle(native, name);
  localRev = link?.rev ?? 0;
  lastDigest = "";
  setStatus({ state: "live", name, message: "", at: 0 });
  await poll();
}

/** The browser's own restore: a handle out of IndexedDB, and the permission
 *  question it may answer with `prompt`. */
async function resumeStored(): Promise<void> {
  const link = await withStore<StoredLink | undefined>("readonly", (s) => s.get(DB_KEY));
  if (!link?.handle) return;
  const state = (await link.handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (state !== "granted") {
    setStatus({ state: "prompt", name: link.handle.name, at: 0, message: "" });
    return;
  }
  handle = link.handle;
  localRev = link.rev;
  setStatus({ state: "live", name: link.handle.name, message: "", at: 0 });
  await poll();
}

export const mirror = {
  /**
   * Pick a file and start mirroring into it.
   *
   * A file that already holds a calendar is **adopted**, not overwritten —
   * the destructive direction is the one that cannot be undone, and this one
   * can (`adopt` records a step). It is also what somebody reconnecting after
   * clearing site data means by choosing their own mirror file.
   */
  async connect(): Promise<void> {
    const native = nativeMirror();
    if (native) {
      // No cancel exception to catch: a save panel that was dismissed answers
      // with an empty name, which is the same non-event as the picker's throw.
      const name = await native.pick("circal.json");
      if (!name) {
        if (!handle) setStatus(OFF);
        return;
      }
      handle = nativeHandle(native, name);
      localRev = 0;
      lastDigest = "";
      setStatus({ state: "live", name, message: "", at: 0 });
      await remember();
      await poll();
      return;
    }

    const show = picker();
    if (!show) return;
    try {
      const picked = await show({
        suggestedName: "circal.json",
        types: [{ description: "circal calendar", accept: { "application/json": [".json"] } }],
      });
      if (!(await permitted(picked))) {
        fail("circal was not allowed to write that file");
        return;
      }
      handle = picked;
      localRev = 0;
      lastDigest = "";
      setStatus({ state: "live", name: picked.name, message: "", at: 0 });
      await remember();
      await poll();
    } catch {
      // The picker throws on cancel, which is not a failure worth a red line.
      if (!handle) setStatus(OFF);
    }
  },

  /** Re-grant a lapsed permission on the handle already remembered. The shell
   *  has none to lapse, so there this is a plain restore. */
  async reconnect(): Promise<void> {
    const native = nativeMirror();
    if (native) {
      await resumeNative(native);
      if (!handle) setStatus(OFF);
      return;
    }
    const link = await withStore<StoredLink | undefined>("readonly", (s) => s.get(DB_KEY));
    if (!link?.handle) {
      setStatus(OFF);
      return;
    }
    if (!(await permitted(link.handle))) {
      fail("circal was not allowed to write that file");
      return;
    }
    handle = link.handle;
    localRev = link.rev;
    lastDigest = "";
    setStatus({ state: "live", name: link.handle.name, message: "", at: 0 });
    await poll();
  },

  async disconnect(): Promise<void> {
    handle = null;
    localRev = 0;
    lastDigest = "";
    clearTimeout(settleTimer);
    // The shell is holding a bookmark, not a permission: forgetting it is what
    // "disconnect" means on that side, and it must happen before the record
    // goes, or a restart resumes the file this just let go of.
    await nativeMirror()?.forget();
    await withStore("readwrite", (s) => s.delete(DB_KEY));
    setStatus(OFF);
  },

  async syncNow(): Promise<void> {
    await poll();
  },
};

/* --------------------------------- lifetime ------------------------------- */

/**
 * Called once from the island root. Restores the remembered handle without
 * asking for anything — a permission prompt nobody clicked towards is a
 * prompt that gets dismissed — and leaves the panel showing `prompt` when a
 * gesture is what it needs.
 */
export function startMirror(): () => void {
  if (!mirrorSupported()) return () => {};

  let live = true;
  const native = nativeMirror();
  void (native ? resumeNative(native) : resumeStored())
    .then(() => {
      // Unmounted while the restore was in flight — development's double effect,
      // or a fast navigation. Drop what it picked up rather than leaving a
      // handle nothing is polling.
      if (!live) handle = null;
    })
    .catch(() => setStatus(OFF));

  const unsubscribe = subscribe(onStoreChange);

  const tick = () => {
    if (document.visibilityState === "visible") void poll();
  };
  pollTimer = window.setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);

  return () => {
    live = false;
    unsubscribe();
    document.removeEventListener("visibilitychange", tick);
    clearInterval(pollTimer);
    clearTimeout(settleTimer);
  };
}
