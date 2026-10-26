# Mcp Attachment

### Claude Code

`--mcp-config` accepts JSON strings or file paths. `--strict-mcp-config` excludes
other MCP configuration, so do **not** use strict mode for ordinary Foom launches:
retain the user's integrations. Use a unique server name per launch rather than
shadowing an existing `foom` entry. `--settings` continues to carry observer hooks.
`--plugin-dir` can load a local plugin for the invocation; a plugin could contain
skills later, but no plugin or skill is needed here.
[CLI reference](https://code.claude.com/docs/en/cli-reference).

Illustrative argv fragment (the actual grant includes every registered Foom tool),
represented as JSON rather than a shell command:

```json
["--mcp-config", "/private/foom/launch-id/mcp.json", "--allowedTools", "mcp__foom_launch_id__open_preview", "mcp__foom_launch_id__list_previews", "mcp__foom_launch_id__close_preview"]
```

The file is in Foom's private launch directory, outside the checkout:

```json
{
  "mcpServers": {
    "foom_launch_id": {
      "type": "http",
      "url": "http://127.0.0.1:32199/mcp",
      "headers": { "Authorization": "Bearer ${FOOM_CONTROL_TOKEN}" }
    }
  }
}
```

When MCP is attached, Foom pre-approves every registered tool on its own random
per-launch server through Claude Code's `--allowedTools`, using exact names
`mcp__<server>__<tool>`: previews (`open_preview`, `list_previews`, `close_preview`),
reads (`whoami`, `sessions`, `session_state`, `manual`), child reports (`handoff`), and
orchestration (`create_worktree`, `launch`, `stop`, `close`, `remove_worktree`,
`tail`, `wait_for`, `read_handoff`, `prompt`, `send_keys`, `operation_status`). The launch builder
derives grants from the real server registry, restricted to the manifest's reviewed
tool names; a test requires every tool to be classified and included.

User default allow rules (including `--allowed-tools`, `=` forms and
variadic/comma-separated lists) are merged into one option with duplicates removed;
argument patterns retain their internal spaces and commas. Foom adds no grants
for other MCP servers or non-Foom tools. Managed policy and deny rules still win.
This only removes Claude Code's per-call prompt: orchestration tools are refused
server-side until the human grants the role. `remove_worktree` still
needs human confirmation in Foom; the existing explicit Auto-remove merged worktrees
setting remains the sole removal exception. `handoff` remains restricted to live
owned children. No global agent or repository configuration is edited. Codex needs
no corresponding grant; launches without MCP keep their defaults unchanged.
[CLI allow options](https://code.claude.com/docs/en/cli-reference),
[permission precedence](https://code.claude.com/docs/en/permissions).

The port and name are illustrative. Claude documents environment expansion in MCP
headers and HTTP transport. Supply the variable only in the launched process's
environment. Verify expansion for an externally supplied config file in a synthetic
handshake before enabling this adapter; refuse attachment if it fails. Do not put a
literal token in argv or silently replace user MCP configuration. Managed policies
can disallow a server; report that condition and expose the authorized CLI fallback.
[MCP configuration](https://code.claude.com/docs/en/mcp).

`PermissionRequest` identifies a tool approval; `Notification` with
`permission_prompt` is delayed evidence. Stop and idle notifications do not prove
a prose question. Even structured question tools are distinct from ordinary prose,
and hooks may be disabled or delayed. Foom's hooks remain observers and never
return approval decisions. [Hook reference](https://code.claude.com/docs/en/hooks).

### Codex

Use a unique server table in a per-invocation `-c` override. HTTP supports an
environment-sourced bearer token; stdio supports command, argument and environment
configuration. Neither requires `codex mcp add` or a user config edit.
[MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Invocation HTTP argv fragment:

```json
["-c", "mcp_servers.foom_launch_id={url=\"http://127.0.0.1:32199/mcp\",bearer_token_env_var=\"FOOM_CONTROL_TOKEN\"}"]
```

Parser-probe evidence and limits: [#119](https://github.com/scott-r-lindsey/foom/issues/119).

Keep existing hook `notify` attachment and its replacement disclosure separate.
The external completion notification does not expose every approval request;
terminal notifications are a different mechanism. Input authority comes from the
granted orchestrator role and child ownership, never completion or missing callbacks.
[Notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

### Antigravity

The documented CLI MCP setup uses global or workspace configuration. Installed help
lists `mcp add/remove/list/enable/disable`, but no invocation-scoped MCP config flag.
This is a verified absence in the inspected interface, not a claim that no future
version can support it. Do not run `agy mcp add`, relocate HOME, or create
`.agents/mcp_config.json` to simulate per-launch attachment.
[MCP documentation](https://www.antigravity.google/docs/mcp/).

The explicitly installed opt-in Foom lifecycle plugin version 4 adds one stdio
server in `mcp_config.json` (`mcpServers.foom.command` and `args`). Its native
`mcp.sh` / `mcp.ps1` launcher targets Foom's CLI in `FOOM_CLI_DIRECTORY` and runs
`foom mcp`. Settings stages absolute paths into the validated CLI-owned plugin
installation, discloses the server and scripts, and uses only the existing fixed
install/uninstall/enable commands. Older installations show Update; nothing is
installed silently. See [agy 1.4.2 measurements](../agents.md#antigravity-plugin-mcp-agy-142-855)
for manifest keys, inherited environment evidence and probe isolation limits.

The launcher and bridge fail closed without valid `FOOM_CONTROL_URL`,
`FOOM_CONTROL_TOKEN`, and `FOOM_SESSION`. No token is written into plugin files,
argv, logs or configuration. The bridge uses only that environment's literal
loopback endpoint; it never discovers another app, pairs, follows redirects, or
falls back to a stored credential. Main authenticates every MCP request and owns
roles, child ownership and revocation. Ordinary sessions remain read-only; a
human-elevated orchestrator gets its main-assigned role.

Launch still supplies those environment variables and prepends Foom's CLI directory
to the process PATH. Without an enabled, intact current plugin and agy 1.4.2+
verification, short CLI guidance is composed with the initial prompt through
`--prompt-interactive`. Current plugin MCP launches omit that fallback guidance.
Hook enablement is independent of MCP: disabling observers does not grant or revoke
control authority. Outside a Foom launch, the installed MCP launcher exits silently
without reading stdin or accessing the network.

Permissions and sandboxing remain the user's settings. Prompt text is not a stable
permission API; owned child input follows the same #629 policy as other adapters.
[Permissions](https://www.antigravity.google/docs/permissions/).
