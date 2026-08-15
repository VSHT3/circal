/* ------------------------------------------------------------------ *
 * `--find`: locates a circal mirror file for a user who has none of
 * this to go on. A `FileSystemFileHandle` never exposes the path it
 * came from (deliberate browser privacy design), so circal's own
 * Settings panel cannot tell anyone where the file it just started
 * mirroring lives. This is the other half of that gap: search the
 * places a mirror file plausibly landed, validate each candidate
 * through circal's own `readMirrorFile` (the one authority on whether
 * a `.json` is a mirror), and print something the user can paste
 * straight into a client config.
 *
 * Read-only, stdout-only, exits on its own — it must never touch the
 * transport `index.ts` opens for the protocol session.
 * ------------------------------------------------------------------ */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readMirrorFile, type MirrorContents } from "@/lib/mirror";

/** Directory names never descended into, wherever they appear. `Library` is
 *  where macOS keeps caches, mail, and every app's private state — the one
 *  exception is the iCloud Drive root below, which is a fixed path, not
 *  something this list walks into. */
const SKIP_DIR_NAMES: Record<string, true> = { node_modules: true, Library: true, ".git": true };

/** Above this, a `.json` is not worth reading just to find out it is not a
 *  mirror file — a mirror file is somebody's calendar, not a dataset. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function roots(home: string): string[] {
  return [
    home,
    join(home, "Documents"),
    join(home, "Desktop"),
    join(home, "Downloads"),
    join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), // iCloud Drive (Documents)
    join(home, "Dropbox"),
    join(home, "Sync"),
  ];
}

/** A root's own `.json` files, plus one level of subdirectories' `.json`
 *  files. Depth-bounded on purpose: not a whole-disk walk, and a mirror file
 *  a user can find again by hand is one they didn't bury three folders deep. */
async function jsonFilesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const top = await listDir(root);
  for (const entry of top) {
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isFile()) {
      if (entry.name.toLowerCase().endsWith(".json")) found.push(full);
      continue;
    }
    if (!entry.isDirectory() || SKIP_DIR_NAMES[entry.name]) continue;
    for (const sub of await listDir(full)) {
      if (sub.name.startsWith(".") || !sub.isFile()) continue;
      if (sub.name.toLowerCase().endsWith(".json")) found.push(join(full, sub.name));
    }
  }
  return found;
}

async function listDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

interface Hit {
  path: string;
  contents: MirrorContents;
}

async function asMirror(path: string): Promise<Hit | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const text = await readFile(path, "utf8");
    const contents = readMirrorFile(text);
    return contents ? { path, contents } : null;
  } catch {
    return null;
  }
}

/** Scans `home` for candidate mirror files, validates each, and prints the
 *  result to stdout. Never starts a server, never opens a transport, always
 *  returns (the caller exits after it). */
export async function runFind(home: string = homedir()): Promise<void> {
  const searchRoots = roots(home);
  const candidates = new Set<string>();
  for (const root of searchRoots) {
    for (const path of await jsonFilesUnder(root)) candidates.add(path);
  }

  const hits: Hit[] = [];
  for (const path of [...candidates].sort()) {
    const hit = await asMirror(path);
    if (hit) hits.push(hit);
  }

  if (hits.length === 0) {
    console.log("No circal mirror file found.\n");
    console.log("Searched these locations (their own files, and one level of subdirectories):");
    for (const root of searchRoots) console.log(`  ${root}`);
    console.log(
      "\nTurn the mirror on from circal's Settings panel to create a file, then run this again.",
    );
    return;
  }

  console.log(`Found ${hits.length} circal mirror file${hits.length === 1 ? "" : "s"}:\n`);
  for (const hit of hits) {
    const zone = hit.contents.zone || "not recorded";
    console.log(`  ${hit.path}`);
    console.log(
      `    events: ${hit.contents.events.length}, calendars: ${hit.contents.calendars.length}, zone: ${zone}, rev: ${hit.contents.rev}`,
    );
  }

  const first = hits[0]!.path;
  const config = JSON.stringify(
    { mcpServers: { circal: { command: "npx", args: ["-y", "circal-mcp", "--file", first] } } },
    null,
    2,
  );
  console.log(
    "\nPaste this into your client's MCP config. Swap the path below if this picked up the wrong file.\n",
  );
  console.log("Claude Desktop (claude_desktop_config.json) / Cursor (.cursor/mcp.json):\n");
  console.log(config);
  console.log("\nClaude Code:\n");
  console.log(`  claude mcp add circal -- npx -y circal-mcp --file ${first}`);
}
