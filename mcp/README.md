# circal-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that reads and writes
the user's own circal calendar, through circal's own domain layer
(`src/lib/events.ts`, `recur.ts`, `quickadd.ts`, `mutate.ts`, `backup.ts`, …),
so an agent and the app can never disagree about what a legal event, an
occurrence, or a recurrence rule is.

Two transports, one tool table:

- **`--file <path>`** — the mirror file, the `.json` a browser tab or the
  macOS app keeps in sync on disk (see `src/lib/mirror.ts`,
  `src/lib/mirrorLink.ts` and `mac/main.swift`'s `MirrorFile`).
- **`--cloud`** — the cloud copy, the one encrypted Supabase row the app's
  cloud sync writes (see `src/lib/cloudLink.ts`, `SYNC.md`). Sign in once
  with `circal-mcp login`; every tool call then reads the row, decrypts it
  **on this machine**, mutates, re-seals and swaps it back on `rev` — the
  same compare-and-swap two browsers already use against each other, so the
  server is simply the row's third client. Supabase still holds only
  ciphertext: the derived key never leaves this machine, which is why this
  server must run on the user's own hardware, never hosted.

Built on `@modelcontextprotocol/server` v2, implementing MCP protocol
revision 2026-07-28.

**The browser tab does not need to be open.** The mirror file (or the row) is
the only thing this server reads or writes; if circal's tab is open and
connected, it picks up the change — instantly over Realtime for the cloud
copy — and its own next write moves the `rev` forward again, the same as any
second writer would.

## Quick start

A `FileSystemFileHandle` (what a browser hands circal when the mirror is turned on there) never
exposes the full path it came from: that is deliberate browser privacy design, so circal cannot print
it for you. The macOS app does not have this problem — it mints and adopts a mirror at a fixed path
on first launch, no gesture required — so `--find` checks that path first, by name, then falls back
to the browser case and searches the places a mirror file usually lands.

```sh
npx -y circal-mcp --find
```

It prints every mirror file it located (path, event and calendar counts,
zone, revision) plus a ready-to-paste config block. Paste that block into
your client below, swap the path if it picked up the wrong file, then
restart the client.

> **Use `circal-mcp@0.5.0` or newer** (`npx -y circal-mcp` resolves it).
> The cautionary tale behind that floor: `0.1.0` predated ten fields in
> `src/lib` (`free`, `travel`, `remindLead`, `organizer` and the guest pair
> on an event; `backupNudge`, `backupInterval`, `deviceZone`, `stampedZones`
> in settings), and every write round-trips the whole document through its
> reader, so it silently dropped all ten — measured, same fixture, two
> bundles.
>
> **The version gate does not save you from this, and the floor is why.** It
> refuses a document whose _envelope_ is newer than the server's, and an
> envelope version is bumped only when a whole key changes meaning — the
> `tasks` list going missing was one. A new field on an event is not: `travel`
> shipped at `MIRROR_VERSION` 3 like `free` before it, so a `0.4.1` bundle
> reads `3 <= 3`, writes happily, and erases the field from every event in the
> file. The gates stop only what they can see coming (`src/lib/mirror.ts`).
> Reads are always safe; it is writes that lose data. So: **republish and
> reinstall the server whenever a `CalEvent` or `Settings` field lands**, and
> raise this floor in the same commit. Contributors run against their own
> build with `pnpm build:mcp` → `node mcp/dist/circal-mcp.mjs`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "circal": {
      "command": "npx",
      "args": ["-y", "circal-mcp", "--file", "/absolute/path/to/your/calendar.json"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add circal -- npx -y circal-mcp --file /absolute/path/to/your/calendar.json
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "circal": {
      "command": "npx",
      "args": ["-y", "circal-mcp", "--file", "/absolute/path/to/your/calendar.json"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "circal": {
      "command": "npx",
      "args": ["-y", "circal-mcp", "--file", "/absolute/path/to/your/calendar.json"]
    }
  }
}
```

No mirror file yet: on the Mac app there is almost always one already (`--find` should have caught
it); in a browser, turn the mirror on from circal's Settings panel, then run `--find` again. Run
`npx -y circal-mcp --help` for the full flag and environment variable list.

### Pinning a calendar

`--calendar <c>` (or `CIRCAL_CALENDAR`), beside either transport, pins the
connection's default calendar — an id or a unique name prefix. Every write
that names no `calendarId` lands there instead of on the user's default,
which is how an agent working one calendar stays on it. A create that was
neither named nor pinned says so in its own summary
(`calendar defaulted, not named`), so a wrong-calendar write is loud rather
than discovered by whoever gets the reminder.

## From source (contributors)

Building from a checkout instead of the published package:

```sh
pnpm install
pnpm build:mcp
```

Produces the same single-file ESM bundle at `mcp/dist/circal-mcp.mjs`.
`pnpm mcp` builds and runs it directly, for local testing. Point a client's
`command`/`args` at `node` and the absolute path to that bundle instead of
`npx`, with the same `env`/`--file` as above.

## The cloud copy

```sh
circal-mcp login    # email → sign-in code → passphrase; interactive
circal-mcp --cloud  # serve against the row
circal-mcp logout   # withdraw this machine's key, now
```

`login` asks the site which Supabase project it uses (`https://circal.day/mcp.json`,
see `src/pages/mcp.json.ts`; `--site <url>` points a fork at its own
deployment, `--url`/`--key` name a project outright). Then three prompts:
email, the emailed sign-in code, the passphrase. The passphrase is proven
against the row's own box before anything is written, and what is left behind
is a `0600` record at the platform config dir
(`~/Library/Application Support/circal/cloud.json` on macOS;
`CIRCAL_CLOUD_CREDENTIALS` overrides) holding the session and the
**derived key — never the passphrase**. This is the browser's "stay
unlocked" record in Node clothes: same authority, same threat model, one
honest step weaker in that a file's bytes are readable where a
non-extractable `CryptoKey`'s are not — the price of a runtime with no
IndexedDB. Whoever can read that file can read the calendar; `logout`
deletes it immediately.

Sign-in is once per machine: the session renews itself, and each rotated
refresh token is persisted before it is spent. A browser's own session is
deliberately never borrowed — Supabase rotates refresh tokens with reuse
detection, so two clients sharing one session sign each other out.

The row must already exist: this server never mints the box. Enrolment — the
account, the passphrase, the first seal — belongs to the app's own Settings
panel, where the passphrase's meaning is explained before it is chosen.

Client config is the same as above with `--cloud` in place of
`--file <path>`.

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
- **A moved document.** Every mutation reads, applies the change, and writes
  `rev + 1` only if nothing else wrote in between — a confirm-read under an
  advisory lock plus temp-file-and-rename for the file (so a crash mid-write
  cannot truncate it), a conditional `update … where rev = N` for the row.
  One retry against a fresh read, then a refusal naming both revisions.
- **Cloud only: an account with no row yet** (enrolment is the app's job, see
  above), **a row re-sealed under a new passphrase** (the kept key cannot
  open it; the refusal sends you back to `circal-mcp login`, and nothing is
  written blind), and **a document one format version ahead** — a write here
  round-trips the whole document, so an older server writing a newer file
  would silently drop every field it has no name for. Reads still answer.
