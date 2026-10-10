export interface Client {
  value: string;
  label: string;
  destination: string;
  instruction: string;
  alternative: string;
  restart: string;
  docs: string;
  supported: boolean;
  limitation?: string;
}

export const clients: Client[] = [
  {
    value: "omp",
    label: "omp",
    destination: ".omp/mcp.json",
    instruction:
      "Add this configuration to .omp/mcp.json in your project. Merge circal into mcpServers if the file already contains servers.",
    alternative:
      "For all projects, use ~/.omp/agent/mcp.json. Named profiles use ~/.omp/profiles/<name>/agent/mcp.json. PI_CONFIG_DIR and PI_CODING_AGENT_DIR can change these locations.",
    restart: "Run /mcp reload in omp, followed by /mcp list to check the connection.",
    docs: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/mcp-config.md",
    supported: true,
  },
  {
    value: "claude-code",
    label: "Claude Code",
    destination: ".mcp.json",
    instruction:
      "Add this configuration to .mcp.json at your project root. Merge circal into mcpServers if the file already contains servers.",
    alternative:
      "Project servers require approval when you open Claude Code. Use this on your computer, where the mirror file or cloud credentials are stored.",
    restart: "Start Claude Code in this project, approve the server, and run /mcp to check circal.",
    docs: "https://code.claude.com/docs/en/mcp",
    supported: true,
  },
  {
    value: "claude-desktop",
    label: "Claude Desktop",
    destination: "claude_desktop_config.json",
    instruction:
      "Open Claude Desktop Settings → Developer → Edit Config. Merge circal into the existing mcpServers object in claude_desktop_config.json.",
    alternative:
      "On macOS the file is ~/Library/Application Support/Claude/claude_desktop_config.json; on Windows it is %APPDATA%\\Claude\\claude_desktop_config.json. This local setup does not connect Claude.ai.",
    restart:
      "Fully quit and reopen Claude Desktop. Check circal in Developer settings or Connectors.",
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    supported: true,
  },
  {
    value: "cursor",
    label: "Cursor",
    destination: ".cursor/mcp.json",
    instruction:
      "Add this configuration to .cursor/mcp.json in your project. Merge circal into mcpServers if the file already contains servers.",
    alternative:
      "For all projects, use ~/.cursor/mcp.json. Use the local editor or CLI; a hosted Cloud Agent cannot read this computer's mirror or saved cloud key.",
    restart: "Open Customize → MCP and enable circal. Restart Cursor if the change has not loaded.",
    docs: "https://cursor.com/docs/mcp",
    supported: true,
  },
  {
    value: "vscode",
    label: "VS Code",
    destination: ".mcp.json",
    instruction:
      "Add this portable configuration to .mcp.json at your project root. Merge circal into mcpServers. Use a local agent session on the computer holding your calendar connection.",
    alternative:
      "For all projects, use ~/.copilot/mcp-config.json (or $COPILOT_HOME/mcp-config.json). MCP: Open User Configuration uses the VS Code format with servers instead of mcpServers.",
    restart:
      "Run MCP: List Servers, start circal, and enable its tools in chat. Review workspace trust.",
    docs: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
    supported: true,
  },
  {
    value: "codex",
    label: "Codex",
    destination: "~/.codex/config.toml",
    instruction:
      "Add this TOML table to ~/.codex/config.toml. If mcp_servers.circal already exists, replace that table rather than adding it twice.",
    alternative:
      "For one trusted project, use .codex/config.toml. Local Codex clients share this configuration; hosted sessions do not gain access to your computer's files or credentials.",
    restart: "Start a new local Codex session and run /mcp. codex mcp list shows saved servers.",
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    supported: true,
  },
  {
    value: "grok",
    label: "Grok",
    destination: "~/.grok/config.toml",
    instruction:
      "For the local Grok Build CLI, add this TOML table to ~/.grok/config.toml. Replace an existing mcp_servers.circal table rather than duplicating it.",
    alternative:
      "For one project, use .grok/config.toml. Grok web connectors require a publicly reachable remote MCP server, so this stdio configuration works only in Grok Build.",
    restart:
      "Open /mcps in Grok Build and press r to refresh. grok mcp doctor circal checks the connection.",
    docs: "https://docs.x.ai/build/features/mcp-servers",
    supported: true,
    limitation:
      "Grok web cannot launch circal's local stdio server. Use Grok Build or omp locally.",
  },
  {
    value: "kimi-code",
    label: "Kimi Code",
    destination: ".kimi-code/mcp.json",
    instruction:
      "For Kimi Code CLI, add this configuration to .kimi-code/mcp.json in your project. Merge circal into mcpServers.",
    alternative:
      "For all projects, use ~/.kimi-code/mcp.json (or $KIMI_CODE_HOME/mcp.json). Project configuration overrides a same-named user server.",
    restart:
      "Start a new Kimi Code session and run /mcp. Servers added through file edits load in new sessions.",
    docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html",
    supported: true,
  },
  {
    value: "gemini-cli",
    label: "Gemini CLI",
    destination: "~/.gemini/settings.json",
    instruction:
      "Merge this mcpServers configuration into ~/.gemini/settings.json for Gemini CLI. Preserve the file's other settings.",
    alternative:
      "For one project, use .gemini/settings.json. Google's docs say unpaid and Google One users moved to Antigravity CLI on June 18, 2026; choose Antigravity below if that applies to your account.",
    restart: "Run /mcp reload in Gemini CLI and use /mcp to check circal's tools.",
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    supported: true,
  },
  {
    value: "github-copilot",
    label: "GitHub Copilot",
    destination: "~/.copilot/mcp-config.json",
    instruction:
      "For GitHub Copilot CLI on this computer, merge circal into mcpServers in ~/.copilot/mcp-config.json. The tools array enables circal's tools without granting automatic approval.",
    alternative:
      "For one project, use .mcp.json or .github/mcp.json and approve folder trust. For Copilot in VS Code, use the separate VS Code entry. Copilot cloud agent cannot access this computer's mirror or saved key.",
    restart:
      "Start a new Copilot CLI session and run /mcp to check circal. copilot mcp list shows saved servers.",
    docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    supported: true,
  },
  {
    value: "antigravity",
    label: "Antigravity",
    destination: "~/.gemini/config/mcp_config.json",
    instruction:
      "For local Antigravity IDE or CLI, merge circal into mcpServers in ~/.gemini/config/mcp_config.json. In the IDE, MCP Servers → Manage MCP Servers → View raw config opens this file.",
    alternative:
      "For one workspace, use .agents/mcp_config.json. Keep the server on the computer holding the mirror file or cloud credentials.",
    restart:
      "Refresh circal in the MCP manager. In Antigravity CLI, open /mcp and reload the configuration.",
    docs: "https://antigravity.google/docs/mcp",
    supported: true,
  },
  {
    value: "devin-desktop",
    label: "Devin Desktop",
    destination: ".devin/mcp_config.json",
    instruction:
      "Select the Devin Local agent in Devin Desktop. On v3000.3 (Local 3.6) or newer, merge this configuration into .devin/mcp_config.json in your project.",
    alternative:
      "For all projects, use ~/.config/devin/mcp_config.json (%APPDATA%\\devin\\mcp_config.json on Windows). Older versions stored mcpServers in config.json and migrate those entries on startup. Hosted Devin is a different execution environment.",
    restart:
      "Start a new Devin Local session and inspect MCP servers in Customizations. devin mcp list shows saved servers.",
    docs: "https://docs.devin.ai/cli/extensibility/mcp/configuration",
    supported: true,
  },
  {
    value: "warp",
    label: "Warp",
    destination: "~/.warp/.mcp.json",
    instruction:
      "For local agents in the Warp app, merge circal into mcpServers in ~/.warp/.mcp.json. Global Warp servers can start automatically.",
    alternative:
      "For one project, use .warp/.mcp.json and enable that server each session. You can also paste this JSON into Settings → Agents → MCP servers → Add. Warp cloud agents cannot read this computer's mirror or saved key.",
    restart: "Open Settings → Agents → MCP servers, start circal, and inspect its tools or logs.",
    docs: "https://docs.warp.dev/agents/capabilities/mcp",
    supported: true,
  },
  {
    value: "goose",
    label: "Goose",
    destination: "~/.config/goose/config.yaml",
    instruction:
      "Merge the circal entry into extensions in ~/.config/goose/config.yaml. Preserve other extensions and settings; Goose uses cmd, not command, for the executable.",
    alternative:
      "This YAML configures the local Goose extension. In Goose Desktop, Extensions → Add custom extension also supports Standard IO servers.",
    restart:
      "Start a new Goose session or reopen Goose Desktop. Check that the circal extension is enabled.",
    docs: "https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md#config-entry",
    supported: true,
  },
  {
    value: "factory",
    label: "Factory",
    destination: ".factory/mcp.json",
    instruction:
      "For Factory's local Droid CLI, add this configuration to .factory/mcp.json in your project. Merge circal into mcpServers.",
    alternative:
      "For all projects, use ~/.factory/mcp.json. Organization MCP policy can restrict servers. A hosted agent does not have this computer's mirror file or cloud credentials.",
    restart:
      "Droid reloads mcp.json changes automatically. Open /mcp to inspect circal's connection and tools.",
    docs: "https://docs.factory.com/harness/mcp",
    supported: true,
  },
  {
    value: "opencode",
    label: "OpenCode",
    destination: "opencode.json",
    instruction:
      "Merge this mcp configuration into opencode.json in your project. OpenCode uses type local and a command array containing the executable and its arguments.",
    alternative:
      "For all projects, use ~/.config/opencode/opencode.json. Preserve any existing model, provider, and tool settings.",
    restart:
      "Start a new local OpenCode session. opencode mcp list shows configured servers and connection status.",
    docs: "https://opencode.ai/docs/mcp-servers/",
    supported: true,
  },
  {
    value: "fx",
    label: "fx",
    destination: "~/.fx/mcp.json",
    instruction:
      "This entry is for the fx terminal coding agent by Vercel Labs (fx.sh). Merge circal into the mcp object in ~/.fx/mcp.json.",
    alternative:
      "For one project, fx accepts .mcp.json with mcpServers after approval. Other products named fx may use a different schema; this configuration is verified only for fx.sh.",
    restart: "Run /mcp reload in fx. Use /mcp or fx mcp list --connect to inspect the connection.",
    docs: "https://fx.sh/docs/capabilities/mcp/protocol",
    supported: true,
  },
  {
    value: "kiro",
    label: "Kiro",
    destination: ".kiro/settings/mcp.json",
    instruction:
      "For local Kiro IDE or CLI, merge circal into mcpServers in .kiro/settings/mcp.json. autoApprove stays empty so this configuration does not grant automatic tool approval.",
    alternative:
      "For all projects, use ~/.kiro/settings/mcp.json. Enable MCP support in Kiro IDE settings. Kiro Web runs servers in its sandbox, without this computer's mirror or saved cloud key.",
    restart:
      "Kiro IDE reconnects servers when you save. Inspect the MCP panel or run /mcp in Kiro CLI.",
    docs: "https://kiro.dev/docs/mcp/configuration/",
    supported: true,
  },
  {
    value: "claude-ai",
    label: "Claude.ai",
    destination: "Local stdio unavailable",
    instruction:
      "Claude.ai custom connectors reach remote MCP servers from Anthropic's cloud. They cannot launch circal-mcp on your computer.",
    alternative:
      "Use Claude Desktop, Claude Code, or omp locally with the same calendar connection.",
    restart: "Choose a compatible local client above to generate its configuration.",
    docs: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    supported: false,
    limitation:
      "Claude.ai requires a remote MCP server reachable from Anthropic's cloud. circal provides a local stdio server, not a hosted MCP URL, and --cloud still runs locally to decrypt your calendar. Use Claude Desktop or Claude Code.",
  },
  {
    value: "chatgpt",
    label: "ChatGPT",
    destination: "~/.codex/config.toml",
    instruction:
      "For the ChatGPT desktop app's local Codex host, add this TOML table to ~/.codex/config.toml. Replace an existing mcp_servers.circal table instead of duplicating it.",
    alternative:
      "The desktop app shares local MCP configuration with Codex CLI and its IDE extension. ChatGPT web does not read local Codex config; hosted plugins require remote tools. Use desktop or a local Codex client.",
    restart:
      "In ChatGPT desktop, open Settings → MCP servers and restart circal. Use /mcp in the composer to inspect connected servers.",
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=app",
    supported: true,
    limitation:
      "Supported in the ChatGPT desktop app's local Codex host. ChatGPT web and hosted chats cannot use this local stdio configuration.",
  },
  {
    value: "other",
    label: "Other MCP client",
    destination: "Local stdio MCP configuration",
    instruction:
      "Use your client's local stdio server settings. Clients that accept mcpServers can use this JSON; otherwise copy the command and args into the client's documented schema.",
    alternative:
      "The client must launch a process on this computer. circal does not provide a hosted MCP URL. Check your client's documentation before saving.",
    restart: "Reload the client's MCP servers and check that circal's tools are available.",
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    supported: true,
  },
];

// JSON escapes are also valid in TOML basic strings and YAML double-quoted strings.
function quoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function clientConfiguration(
  client: Client,
  connection: "file" | "cloud",
  filePath: string,
): string {
  if (!client.supported || (connection === "file" && !filePath)) return "";

  const args = [
    "-y",
    "circal-mcp@latest",
    ...(connection === "cloud" ? ["--cloud"] : ["--file", filePath]),
  ];
  const server = { command: "npx", args };

  switch (client.value) {
    case "codex":
    case "chatgpt":
    case "grok":
      return `[mcp_servers.circal]\ncommand = "npx"\nargs = [${args.map(quoted).join(", ")}]`;
    case "goose":
      return [
        "extensions:",
        "  circal:",
        "    name: circal",
        "    type: stdio",
        "    cmd: npx",
        `    args: [${args.map(quoted).join(", ")}]`,
        "    enabled: true",
      ].join("\n");
    case "opencode":
      return JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: { circal: { type: "local", command: ["npx", ...args], enabled: true } },
        },
        null,
        2,
      );
    case "fx":
      return JSON.stringify(
        { mcp: { circal: { type: "local", command: ["npx", ...args] } } },
        null,
        2,
      );
    case "kiro":
      return JSON.stringify(
        { mcpServers: { circal: { ...server, disabled: false, autoApprove: [] } } },
        null,
        2,
      );
    case "github-copilot":
      return JSON.stringify(
        { mcpServers: { circal: { type: "stdio", ...server, tools: ["*"] } } },
        null,
        2,
      );
    case "omp":
    case "claude-code":
    case "cursor":
    case "vscode":
      return JSON.stringify({ mcpServers: { circal: { type: "stdio", ...server } } }, null, 2);
    default:
      return JSON.stringify({ mcpServers: { circal: server } }, null, 2);
  }
}
