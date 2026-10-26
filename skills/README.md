# circal agent skill

The `circal` skill teaches an agent how to use circal's MCP tools, resources, prompts and subscriptions for agendas, availability, tasks, daily notes and preferences. It checks the connected document before writes and preserves recurrence scopes, timezone warnings and explicit write authorization.

It is distributed from this repository at `skills/circal/SKILL.md`. The skill supplies instructions. Configure the MCP connection separately using the [assistant setup page](https://circal.day/assistant/) or [MCP README](../mcp/README.md).

## Install

After these files are published to GitHub:

```sh
npx skills add VSHT3/circal
```

To select this skill explicitly:

```sh
npx skills add VSHT3/circal --skill circal
```

Discover the repository's available skills without installing:

```sh
npx skills add VSHT3/circal --list
```

The Skills CLI uses project scope by default and asks which agents to target. Add `--global` only if you want a user-wide installation. You can select supported agents explicitly, for example:

```sh
npx skills add VSHT3/circal --skill circal --agent claude-code codex cursor
```

The CLI also lists Gemini CLI, GitHub Copilot, Cline, Roo Code, OpenCode, Windsurf, Antigravity, Kiro CLI, Kilo Code and Goose among its supported targets. Support for a client's MCP connection does not imply support for skill installation. Check the [current CLI agent list](https://github.com/vercel-labs/skills#supported-agents) for your client.

For an agent with a documented custom skill directory, copy the whole `skills/circal/` folder there, including `references/`, and follow that agent's loading instructions. The Skills CLI documentation does not specify a custom destination flag. For clients without skill loading, you can supply the instructions and tool reference as context; this is not an installed or automatically discovered skill.

## Refresh an installed skill

MCP reloads and skill updates are separate. To refresh only a globally installed
Circal skill from its recorded source:

```sh
pnpm dlx skills update circal --global --yes
```

Use `--project` instead for a project-scoped installation. Start a new agent
session if the client caches skill text. Resources, prompts and resource-change
notifications also require MCP server 0.7.0 or newer; a skill update does not
install or authenticate that server.

## Local packaging check

Maintainers can check discovery and install from an unpublished checkout without installing into their normal agent directories. Run the following from the repository root. The isolated home, config and npm cache stay inside the disposable directory; no `--global` option is used.

```sh
repo="$PWD"
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/project"
(
  cd "$sandbox/project" || exit 1
  export HOME="$sandbox/home"
  export XDG_CONFIG_HOME="$sandbox/home/.config"
  export XDG_CACHE_HOME="$sandbox/home/.cache"
  export XDG_DATA_HOME="$sandbox/home/.local/share"
  export npm_config_cache="$sandbox/npm-cache"
  export npm_config_userconfig=/dev/null
  export DISABLE_TELEMETRY=1
  npx --yes skills add "$repo" --list &&
    npx --yes skills add "$repo" --skill circal --agent claude-code --copy --yes &&
    npx --yes skills list --agent claude-code
)
printf 'Disposable install: %s\n' "$sandbox"
```

Expected: discovery names `circal`; installation includes `SKILL.md` and `references/tools.md` under the disposable project's `.claude/skills/circal/`; the final command lists the installed skill. Inspect those copied files before removing the disposable directory. This checks packaging, not MCP connectivity or calendar mutations.

For standard frontmatter validation, the Agent Skills reference library offers `skills-ref validate skills/circal` when that validator is installed. The main skill uses the standard `name`, `description` and `compatibility` fields and has no agent-specific tool permissions or executable scripts.

## Sources

- [Agent Skills format specification](https://agentskills.io/specification), including frontmatter rules and relative references.
- [Skills installation documentation](https://skills.sh/docs).
- [Skills CLI source and documentation](https://github.com/vercel-labs/skills), including local sources, discovery paths, `--skill`, `--agent`, scope and copying.
- [circal tool reference](circal/references/tools.md), grounded in this repository's MCP schemas and domain model.
