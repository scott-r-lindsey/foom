# Mcp Attachment

## Tool approval by bundled agent (#1202)

Evidence reviewed on 2026-11-15: the documented client configuration surfaces
linked below and the checked-in manifests/launch tests. “Settings defaults” means
user-supplied default arguments in Settings → Agents; Foom has no universal
permission mode for those arguments. These are configuration findings, not a live
model/permission-dialog measurement. No real agent CLI or provider request is
needed by the regression tests.

| Agent | Empty default arguments | With Settings default arguments | Invocation-scoped Foom approval |
| --- | --- | --- | --- |
| Claude Code | Foom adds exact tool names to `--allowedTools` | User allow lists are merged; deny/managed rules still apply | Existing manifest `toolPermissions`; random launch server only |
| Codex | Foom adds `default_tools_approval_mode="approve"` to its launch server | Defaults remain in order; the Foom override follows them, without changing other servers or the sandbox/approval policy | Manifest MCP `-c` override, including manual-only attachments |
| Antigravity | Unconfigured MCP tools default to Ask | Explicit rules and execution/toolPermission modes determine prompting; Foom adds no approval | No scoped startup grant documented for agy 1.5.16. See the [Antigravity recheck](#antigravity) |
| GitHub Copilot | Foom adds exact server/tool allow arguments | Defaults remain; client deny/policy rules apply | Existing manifest `toolPermissions` using `--allow-tool` |
| OpenCode | Foom supplies exact action/resource allow rules | User policy can still refuse tools | Existing manifest `toolPermissions.fileRules` in private launch configuration |
| Pi | Core has no per-call permission popups | User permission extensions may intercept MCP calls | No built-in per-tool approval option in the documented registration/CLI API; Foom preserves extension handlers |

Codex's old “needs no corresponding grant” statement was stale. Its current
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
provides server defaults and per-tool approval overrides. Tests in
`tests/unit/main/agents/mcp-launch.test.ts` parse the generated approval TOML with
empty, Settings-style and explicit sandbox/approval defaults, check preservation
of another server's configuration, and cover manual-only attachment. The bundled
Codex test also checks Resume/observer/prompt ordering. The native Electron manual
fixture rejects launches missing the scoped approval argument, including config
sessions. The remote launch unit test checks that the override survives conversion.
Unsupported or unattached
launches add no approval. The separate approval argument survives remote HTTP to
stdio conversion and applies only to the same generated server name.

Pi documents [MCP permission handlers](https://docs.pi.dev/latest/mcp#permissions)
and [process-local project trust](https://docs.pi.dev/latest/cli): `--approve`
trusts project resources, rather than approving individual tool calls. Its
[core behavior](https://pi.dev/#what-we-didnt-build) has no permission popups.
No built-in Foom-only approval setting was found; user extensions can still block
or ask. The existing fixed adapter tests exercise registration and tool filtering,
not the behavior of arbitrary installed permission extensions.

Client pre-approval never grants a Foom role. `read_handoff` is always in the local
control MCP catalog with the orchestrator-only description, including before a
human grant. Each call still checks the live role and child ownership. Clients
can use their cached catalog after a grant without reconnecting. The isolated
manual-only and restricted remote servers keep their existing smaller catalogs.


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
orchestration (`create_worktree`, `review`, `launch`, `stop`, `close`, `remove_worktree`,
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
owned children. No global agent or repository configuration is edited. Launches without MCP
keep their defaults unchanged.
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
["-c", "mcp_servers.foom_launch_id={url=\"http://127.0.0.1:32199/mcp\",bearer_token_env_var=\"FOOM_CONTROL_TOKEN\"}", "-c", "mcp_servers.foom_launch_id.default_tools_approval_mode=\"approve\""]
```

Parser-probe evidence and limits: [#119](https://github.com/scott-r-lindsey/foom/issues/119).

Keep existing hook `notify` attachment and its replacement disclosure separate.
The external completion notification does not expose every approval request;
terminal notifications are a different mechanism. Input authority comes from the
granted orchestrator role and child ownership, never completion or missing callbacks.
[Notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

### Antigravity

On 2026-11-24, the public documentation review for #1308 found no documented
startup option in agy 1.5.16 that grants approval only to Foom's MCP server.
Google lists 1.5.16 as the latest CLI release on that date. Its notes describe
changes to Auto mode's file-write policy and list no new MCP approval flag.
[Antigravity CLI 1.5.16 release notes](https://antigravity.google/docs/changelog#rel-cli-1.5.16).

The CLI documents server-specific `mcp(server/*)` rules, tool-specific
`mcp(server/tool)` rules, and Deny > Ask > Allow precedence. `/permissions` saves
rules at project, shared, or global scope. An interactive MCP approval can cover
an expanded scope for the rest of the turn. `--project` selects a project with
its saved settings, `--mode` selects an execution mode, and
`--dangerously-skip-permissions` applies across tool permission requests. Foom
leaves MCP approvals to the client and user.
[CLI permissions](https://antigravity.google/docs/permissions/#cli-fine-grained-permissions),
[`/permissions`](https://antigravity.google/docs/cli/commands/permissions/),
[startup flags](https://antigravity.google/docs/cli/reference/#command-line-flags).

The public docs establish the documented surface. The installed Linux 1.5.16
binary remains unverified for this recheck. With user authorization, run
`agy --version` to confirm 1.5.16, then inspect both stdout and stderr from
`agy --help` for a startup flag that accepts an MCP server or tool selector, or
loads invocation-only permission rules. If help exposes a candidate, verify in
an isolated test launch that a Foom tool skips the prompt, a tool on a second MCP
server still prompts, and a fresh launch without the candidate prompts for the
Foom tool again. Any launch argument needs user approval before implementation.

The documented CLI MCP setup uses global or workspace configuration. Installed help
lists `mcp add/remove/list/enable/disable`, but no invocation-scoped MCP config flag.
This is a verified absence in the inspected interface, not a claim that no future
version can support it. Do not run `agy mcp add`, relocate HOME, or create
`.agents/mcp_config.json` to simulate per-launch attachment.
[MCP documentation](https://www.antigravity.google/docs/mcp/).

The explicitly installed opt-in Foom lifecycle plugin version 4 adds one stdio
server in `mcp_config.json` (`mcpServers.foom.command` and `args`). Its native
`mcp.sh` / `mcp.ps1` launcher targets Foom's CLI in `FOOM_CLI_DIRECTORY` and runs
`foom mcp`. Windows relays raw stdin/stdout/stderr bytes, closes CLI stdin at
caller EOF, and exits with the CLI even if the caller leaves stdin open. Settings stages absolute paths into the validated CLI-owned plugin
installation, discloses the server and scripts, and uses only the existing fixed
install/uninstall/enable commands. Older installations show Update; nothing is
installed silently. See [agy 1.4.2 measurements](../agents.md#antigravity-plugin-mcp-agy-142-855)
for manifest keys, inherited environment evidence and probe isolation limits.

agy 1.5.3 first sends `server/discover` with object `params._meta` containing
`io.modelcontextprotocol/clientCapabilities`, `io.modelcontextprotocol/clientInfo`
and `io.modelcontextprotocol/protocolVersion`. Foom supports the legacy initialize
protocols and returns JSON-RPC Method not found for this authenticated probe,
without allocating a protocol session. agy then sends `initialize`,
`notifications/initialized`, `tools/list` and `notifications/roots/list_changed`.
The measured initialize has `clientInfo.name`/`version`, `protocolVersion` and
`capabilities.elicitation`/`roots`. See the
[agy 1.5.3 capture](../agents.md#antigravity-discovery-capture-agy-153-reopened-1124)
for types, isolation and limits. Discovery metadata never grants capabilities;
authentication and legacy session checks still apply to tool requests.

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

### Pi (#834)

Pi 1.4.0's `registerMcpServer` extension API supports a session-only HTTP server
with headers and exact per-tool exposure. The fixed `pi-v1` adapter registers the
random launch server through this API, with a bearer token from the process's
environment. No token enters argv, the extension source, generated JSON or renderer.

The existing MCP catalog includes tools a role might be granted later. Pi's
adapter exposes only names in the authenticated `whoami` capability list,
intersected with main's classified registry, with all other tools hidden. It
refreshes at session start and before new work and withdraws the registration if
that bounded lookup fails. Config sessions expose only `manual`; verification
probes expose only `ping` through their independent listeners. Pi's normal tool
validation and permission handlers still run. Every Foom call rechecks current
server-side authority, including revocation while a turn is running.

The built-in MCP connector must be enabled; Foom never overrides user policy or
installs a replacement. See the [manual spike](../agents.md#pi-140-extension-spike-834)
and [fixed attachment rules](agent-launch.md#fixed-extension-attachment-834).
