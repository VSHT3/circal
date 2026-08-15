#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * circal's MCP server: a stdio bridge onto the mirror file circal's
 * own browser tab writes. No account, no server, no second Worker
 * route — the same file `mirrorLink.ts` streams to, read and written
 * here through circal's own domain layer, so an agent and the app can
 * never disagree about what a legal event is.
 *
 * The file path is required and never guessed (`resolveFilePath`
 * fails fast, before the transport connects, if neither `CIRCAL_FILE`
 * nor `--file` was given) — a wrong guess here would write over the
 * wrong year's calendar.
 * ------------------------------------------------------------------ */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { resolveFilePath, type MirrorEnv } from "./file";
import { runFind } from "./find";
import { registerTools } from "./tools";

const HELP = `circal-mcp — reads and writes circal's mirror file over stdio (MCP)

Usage:
  circal-mcp --file <path>   Start the server against a mirror file
  circal-mcp --find          Search common locations for a mirror file and
                              print a ready-to-paste client config (read-only,
                              does not start the server)
  circal-mcp --help          Print this message

Environment:
  CIRCAL_FILE                 Mirror file path, same as --file
  CIRCAL_ALLOW_ZONE_MISMATCH   Set to 1 to allow writes when this process's
                              zone does not match the file's recorded zone
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

// Fails fast, before the transport ever connects: a client that cannot say
// where the file is should see one clear line on stderr, not a stack trace
// buried in a JSON-RPC error later.
let path: string;
try {
  path = resolveFilePath(argv, process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${message} Run \`circal-mcp --find\` to search common locations for one.`);
  process.exit(1);
}
const ctx: MirrorEnv = { path, env: process.env };

function createServer(): McpServer {
  const server = new McpServer({ name: "circal", version: "1.0.0" });
  registerTools(server, ctx);
  return server;
}

// stdout is the protocol channel — every log line here goes to stderr, or
// one stray write corrupts the JSON-RPC stream a client is trying to parse.
void serveStdio(createServer);
console.error("circal MCP server running on stdio");
