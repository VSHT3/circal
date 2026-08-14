# circal-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that reads and writes
circal's own mirror file — the `.json` a browser tab keeps in sync on disk
through the File System Access API (see `src/lib/mirror.ts` and
`src/lib/mirrorLink.ts`). It imports circal's own domain layer
(`src/lib/events.ts`, `recur.ts`, `quickadd.ts`, `mutate.ts`, `backup.ts`, …),
so an agent and the app can never disagree about what a legal event, an
occurrence, or a recurrence rule is.

Built on `@modelcontextprotocol/server` v2, implementing MCP protocol
revision 2026-07-28.

**The browser tab does not need to be open.** The mirror file is the only
thing this server reads or writes; if circal's tab is open and connected, it
picks up the change and its own next write moves the file's `rev` forward
again, the same as any second writer would.

## Build

```sh
pnpm build:mcp
```

Produces a single ESM bundle at `mcp/dist/circal-mcp.mjs`. `pnpm mcp` builds
and runs it directly, for local testing.

## Configure the file

Every client below needs an **absolute path** to a mirror file and an
absolute path to the built bundle. Turn mirroring on once from circal's
Settings panel to create the file (or point at an existing circal `.json`
backup — a mirror file _is_ one, plus a zone and a revision).

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "circal": {
      "command": "node",
      "args": ["/absolute/path/to/circal/mcp/dist/circal-mcp.mjs"],
      "env": { "CIRCAL_FILE": "/absolute/path/to/your/calendar.json" }
    }
  }
}
```

## Claude Code

```sh
claude mcp add circal --env CIRCAL_FILE=/absolute/path/to/your/calendar.json \
  -- node /absolute/path/to/circal/mcp/dist/circal-mcp.mjs
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "circal": {
      "command": "node",
      "args": ["/absolute/path/to/circal/mcp/dist/circal-mcp.mjs"],
      "env": { "CIRCAL_FILE": "/absolute/path/to/your/calendar.json" }
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "circal": {
      "command": "node",
      "args": ["/absolute/path/to/circal/mcp/dist/circal-mcp.mjs"],
      "env": { "CIRCAL_FILE": "/absolute/path/to/your/calendar.json" }
    }
  }
}
```

## What it refuses, and why

- **No `CIRCAL_FILE` (or `--file <path>`).** The path is never guessed — a
  wrong guess here means writing over the wrong year's calendar. The server
  exits with one line on stderr before it ever connects.
- **A zone mismatch.** Every day boundary in circal is local time. If the
  file's own recorded zone does not match the zone this process is running
  in, reads go through with a warning line; writes are refused, because a
  write meant for "today" could land on the file's yesterday or tomorrow.
  Override with `CIRCAL_ALLOW_ZONE_MISMATCH=1` if you are certain.
- **A feed calendar.** A calendar with a subscription attached is a mirror of
  somebody else's ICS feed. Its events are pulled, not written — the same
  read-only rule the event editor already enforces — so no tool here can
  create, edit, delete, or tick an event on one.
- **A repeating event with no `scope`.** `update_event`, `delete_event` and
  similar ask for `"one"`, `"future"`, or `"all"` before touching a series,
  and name the event in the refusal rather than guessing.
- **A moved file.** Every mutation reads the file, applies the change,
  re-reads to confirm nothing else wrote in between, then writes `rev + 1`
  through a temp file plus rename (so a crash mid-write cannot truncate the
  file). One retry on a conflicting write, then a refusal naming both
  revisions.
