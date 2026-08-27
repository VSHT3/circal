#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * circal's MCP server: a stdio bridge onto the user's own calendar
 * document, through circal's own domain layer, so an agent and the app
 * can never disagree about what a legal event is. No second Worker
 * route either way.
 *
 * Two transports, one tool table. `--file` serves the mirror file the
 * browser tab streams to disk (`mirrorLink.ts`); the path is required
 * and never guessed (`resolveFilePath` fails fast, before the transport
 * connects) — a wrong guess would write over the wrong year's calendar.
 * `--cloud` serves the one Supabase row the browser's cloud sync writes,
 * decrypted and re-sealed on this machine with the key `circal-mcp
 * login` left behind — client #3 of the row two browsers already share.
 * ------------------------------------------------------------------ */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { cloudStore, credentialsPath, readCredentials, runLogin, runLogout } from "./cloud";
import { fileStore, resolveFilePath } from "./file";
import { runFind } from "./find";
import type { Store } from "./store";
import { registerTools } from "./tools";

const HELP = `circal-mcp — reads and writes a circal calendar over stdio (MCP)

Usage:
  circal-mcp --file <path>   Start the server against a mirror file
  circal-mcp --cloud         Start the server against the cloud copy
                              (sign in first with \`circal-mcp login\`)
  circal-mcp login           Sign in to the cloud copy and remember the
                              derived key on this machine (interactive:
                              email, emailed code, passphrase; asks circal.day
                              which project it uses — --site <url> for a fork,
                              or --url and --key to name one outright)
  circal-mcp logout          Forget the remembered key and session
  circal-mcp --find          Search common locations for a mirror file and
                              print a ready-to-paste client config (read-only,
                              does not start the server)
  circal-mcp --help          Print this message

Environment:
  CIRCAL_FILE                 Mirror file path, same as --file
  CIRCAL_CLOUD_CREDENTIALS    Where \`login\` keeps its record (default:
                              the platform config dir, circal/cloud.json)
  CIRCAL_ALLOW_ZONE_MISMATCH   Set to 1 to allow writes when this process's
                              zone does not match the document's recorded zone
`;

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (argv.includes("--find")) {
  await runFind();
  process.exit(0);
}

if (argv[0] === "login" || argv[0] === "logout") {
  try {
    if (argv[0] === "login") await runLogin(argv, process.env);
    else await runLogout(process.env);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Either transport fails fast, before the protocol ever connects: a client
// that cannot reach its document should see one clear line on stderr, not a
// stack trace buried in a JSON-RPC error later.
let store: Store;
if (argv.includes("--cloud")) {
  const path = credentialsPath(process.env);
  const credentials = await readCredentials(path);
  if (!credentials) {
    console.error(
      `circal-mcp --cloud needs a sign-in and found none at ${path}. Run \`circal-mcp login\` first.`,
    );
    process.exit(1);
  }
  store = cloudStore({ credentials, path, env: process.env });
} else {
  let path: string;
  try {
    path = resolveFilePath(argv, process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message} Run \`circal-mcp --find\` to search common locations for one.`);
    process.exit(1);
  }
  store = fileStore({ path, env: process.env });
}

function createServer(): McpServer {
  const server = new McpServer({ name: "circal", version: "1.0.0" });
  registerTools(server, store);
  return server;
}

// stdout is the protocol channel — every log line here goes to stderr, or
// one stray write corrupts the JSON-RPC stream a client is trying to parse.
void serveStdio(createServer);
console.error("circal MCP server running on stdio");
