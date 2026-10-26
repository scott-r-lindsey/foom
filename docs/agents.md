# Agent signals: rules and evidence

Current rules are area-scoped; dated CLI measurements, payload captures, timing/cost results and migration history live in the linked issues and their implementation PRs. Synthetic transport tests establish native adapters, not real CLI trust or timing. Evidence is version/platform-specific and does not override current rules.

| Former section | Current rule / historical record |
| --- | --- |
| Recommendation | [Rules](areas/agent-launch.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Resume exited conversations (#115) | [Rules](areas/sessions.md) · [evidence #115](https://github.com/scott-r-lindsey/foom/issues/115) |
| Default launch arguments (#164) | [Rules](contracts/agent-launch.md) · [evidence #164](https://github.com/scott-r-lindsey/foom/issues/164) |
| Claude Code | [Rules](areas/agent-hooks.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Codex | [Rules](areas/execution.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Antigravity | [Rules](areas/execution.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Echo is not a password detector | [Rules](areas/agent-hooks.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Reproduction and measured cost | [Rules](areas/control-validation.md) · [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11) |
| Receiver implementation (#13) | [Rules](areas/agent-hooks.md) · [evidence #13](https://github.com/scott-r-lindsey/foom/issues/13) |
| Local title and screen detection (#161) | [Rules](areas/evaluator.md) · [evidence #161](https://github.com/scott-r-lindsey/foom/issues/161) |
| Stable Codex lifecycle observers (#181) | [Rules](areas/execution.md) · [evidence #181](https://github.com/scott-r-lindsey/foom/issues/181) |
| Opt-in Antigravity lifecycle plugin (#178) | [Rules](areas/execution.md) · [evidence #178](https://github.com/scott-r-lindsey/foom/issues/178) |
| Antigravity conversation resume (#249) | [Rules](areas/sessions.md) · [evidence #249](https://github.com/scott-r-lindsey/foom/issues/249) |
| Provider stalls (#339) | [Rules](contracts/control-identity.md) · [evidence #339](https://github.com/scott-r-lindsey/foom/issues/339) |
| Agent providers and config-authored plugins (#407) | [Rules](areas/providers.md) · [evidence #407](https://github.com/scott-r-lindsey/foom/issues/407) |

<a id="recommendation"></a>
See [current rules](areas/agent-launch.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="resume-exited-conversations-115"></a>
See [current rules](areas/sessions.md) and [evidence #115](https://github.com/scott-r-lindsey/foom/issues/115).

<a id="default-launch-arguments-164"></a>
See [current rules](contracts/agent-launch.md) and [evidence #164](https://github.com/scott-r-lindsey/foom/issues/164).

<a id="claude-code"></a>
See [current rules](areas/agent-hooks.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="codex"></a>
See [current rules](areas/execution.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="antigravity"></a>
See [current rules](areas/execution.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="echo-is-not-a-password-detector"></a>
See [current rules](areas/agent-hooks.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="reproduction-and-measured-cost"></a>
See [current rules](areas/control-validation.md) and [evidence #11](https://github.com/scott-r-lindsey/foom/issues/11).

<a id="receiver-implementation-13"></a>
See [current rules](areas/agent-hooks.md) and [evidence #13](https://github.com/scott-r-lindsey/foom/issues/13).

<a id="local-title-and-screen-detection-161"></a>
See [current rules](areas/evaluator.md) and [evidence #161](https://github.com/scott-r-lindsey/foom/issues/161).

<a id="stable-codex-lifecycle-observers-181"></a>
See [current rules](areas/execution.md) and [evidence #181](https://github.com/scott-r-lindsey/foom/issues/181).

<a id="opt-in-antigravity-lifecycle-plugin-178"></a>
See [current rules](areas/execution.md) and [evidence #178](https://github.com/scott-r-lindsey/foom/issues/178).

<a id="antigravity-conversation-resume-249"></a>
See [current rules](areas/sessions.md) and [evidence #249](https://github.com/scott-r-lindsey/foom/issues/249).

<a id="provider-stalls-339"></a>
See [current rules](contracts/control-identity.md) and [evidence #339](https://github.com/scott-r-lindsey/foom/issues/339).

<a id="agent-providers-and-config-authored-plugins-407"></a>
See [current rules](areas/providers.md) and [evidence #407](https://github.com/scott-r-lindsey/foom/issues/407).

### Antigravity plugin list compatibility (#723 / #467)

The orchestrator recorded agy 1.4.2 on Linux: `plugin list` prints plain text, while `plugin list --json` prints a top-level array with name, enabled, version, source, path and hooks (the existing Foom hook is `foom-observer-v1`). The older 1.3.1 fixture returns `{ "imports": [...] }` or `No imported plugins.`; fixture tests cover both. No real agy mutations or lifecycle measurements were run for this change.

Observer version 3 uses absolute paths into the validated CLI-owned installed plugin, rather than relying on an unmeasured hook cwd or an undocumented plugin-root variable. The hook ID remains `foom-observer-v1`; plugin metadata determines the observer ABI. Legacy v1/v2 installations offer Update, and owned installations offer Reinstall and Remove. Status unavailable offers Retry status. See [setup contract](contracts/agent-setup.md) for bounded probes, ownership, confirmation and partial reinstall failure.

The #723 review found that absolute paths into a disposable Foom profile disappear on exit. Hooks now target the canonical CLI-owned installation instead; no documented agy plugin-root variable is assumed. Modern reported install paths require exact native spellings (case variants on Windows/macOS additionally require matching realpath identity); noncanonical or foreign paths are unavailable. Reported paths never select inventory reads or execute commands. Status verifies installed hook/observer bytes and reports missing or changed targets as outdated. Fixture tests delete disposable staging, rescan from another profile, and verify consistent installed status and working hooks. Same-definition Dev/everyday profiles share the installed target without scan-time rewriting or alternating status.

### Antigravity plugin MCP (agy 1.4.2, #855)

Measured on Linux on 2026-10-25. Read-only discovery used `agy --version`,
`agy --help`, and `agy plugin --help` in a disposable HOME with a minimal
explicit environment. Version output was `1.4.2`. Root help has no per-invocation
plugin/config directory flag. HOME controls `.gemini/config` and
`.gemini/antigravity-cli`; a `strace -f -e trace=file,connect` audit confirmed
config/state accesses under the disposable root. XDG config/data/state/cache,
`GEMINI_CLI_HOME`, `GEMINI_CONFIG_DIR`, `AGY_CONFIG_HOME`, and `AGY_CONFIG_DIR`
were also redirected there; their individual support was not established.
No real user configuration or credentials were copied, read or linked. The CLI
completed the harmless print prompt without requesting login; no login was attempted.

A legacy plugin uses root `plugin.json` (`name`, `version`) and
`mcp_config.json` with `mcpServers`, a named server object, `command`, and `args`.
`agy plugin validate <fixture> --json` reported one MCP server and no findings;
`agy plugin install <fixture>` reported one processed MCP server. In contrast,
inline `plugin.json.mcpServers` is ignored, `.mcp.json` is never loaded, and
`mcp.json` requires the separate Agent Plugins schema. These were all disposable
fixtures, without lifecycle hooks or Foom credentials.

`agy --print "Reply with OK only." --print-timeout 10s` spawned the declared
Python fixture server. Its only behavior was to log argv and the **names**, never
values, of inherited `FOOM_*` variables, then exit. The log showed the declared
script argv and `FOOM_CONTROL_URL`, `FOOM_CONTROL_TOKEN`, `FOOM_SESSION`.
Values were synthetic and pointed at an unused loopback port. No bypass flags
were used. This proves process environment inheritance, not real Foom tool
execution, approval behavior, or Windows/macOS compatibility; fixture integration
tests cover the bridge and main-owned role checks.

The CLI also spawned its automatic `--bg-updater`, which accessed the executable
installation directory outside the temporary HOME (including update-test files
and cleanup of updater artifacts). HOME isolation does **not** isolate that
updater. No update command was requested. No further real-agent probes were run.
All probe process groups were terminated and disposable directories deleted.
Subcommand `--help` is not consistently read-only in 1.4.2: install interprets it
as a target, enable as a name, and uninstall reports removing that name. These
calls were confined to the deleted temporary HOME; use `agy plugin --help` for
command discovery.

### OpenCode v2.0.32 (#824)

Measured on Linux on 2026-10-24 using the installed CLI's `--version`, root help,
and `plugin`, `mcp`, `debug` and `serve` help. Version output was exactly
`opencode v2.0.32`. Four short PTY sessions ran in one disposable OS-temp directory,
with no bypass flags or global configuration edits. The first two reply-only
attempts were stopped while working; the subsequent file prompt and final
reply-only/plugin session completed on the configured local model. No agent config,
credential or state files were read. The agent's normal session writes were allowed.

The captured, redacted screen fragments at 120 columns by 40 rows were:

```text
Working (reply-only and file prompt):
  ⬝⬝⬝⬝■■■■ esc interrupt                 shift+tab agents  ctrl+p commands

Blocked (question tool, before the requested file write):
  ┃ Questions
  ┃ [question text omitted]
  ┃ 1. Yes
  ┃ 2. No
  ┃ 3. Type your own answer
  ┃ ↑↓ select  enter submit  esc dismiss

Idle (after ready, and after the file write):
  TITLE: OC | [session title omitted]
  ┃ Build · [model omitted]
  ╹━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  /tmp/[scratch]                         [usage omitted]  ctrl+p commands
```

The file prompt asked to create `ready.txt` containing `ready`, and to ask first.
The model used the question tool; selecting Yes produced the file. This is a
measured question blocker, not a claim that an edit-permission dialog was observed.
The bundled rules require the question footer conjunction, prioritize it over
`esc interrupt`, and treat the idle editor/footer as heuristic readiness/completion
only. The idle footer rule currently covers the measured Build agent label.
Other agent labels and permission-screen layouts rely on lifecycle events or
ordinary output evaluation until captured. The title alone does not identify working.

A Foom-owned per-launch config file loaded a temporary local plugin directory
through `OPENCODE_CONFIG` under `--standalone`. The module exported an object with
`id` and `setup(context)` and subscribed through `context.event.subscribe()`;
no SDK download/import or global plugin installation was needed. The harmless
reply-only session returned `ready` and emitted `session.execution.started` then
`session.execution.succeeded`. The explicitly assigned `ses_foom824_measure` was
accepted; later events carried that ID in `data.sessionID`. The stream envelope
contains `type` and `data`, not top-level session fields. The shipped adapter
forwards only declared primitive selector fields, never prompts, reasoning, tool
arguments, transcripts or model text. Failure/permission/form mappings are based
on the pinned public schema and fixture tests; they were not separately measured
with the shipped adapter. Hooks Off attaches no module.

The [v2.0.32 standalone server](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/server-process.ts)
reads `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` per process. Foom uses the
former for generated observer config and the latter for invocation-only MCP JSON.
`--standalone` keeps both on a private server instead of the shared background
service. The [config loader](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/config.ts)
merges explicit file and inline content without writing either to the global config.
The [session-ID schema](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/schema/src/session-id.ts)
requires a `ses` prefix; Foom generates `ses_` plus a UUID, uses `--session` for
new/resumed launches, and recognizes pasted `opencode --session ID` / `opencode -s ID`.

MCP uses v2's `mcp.servers`, `type: remote`, `oauth: false`, `codemode: false`,
and `Authorization: Bearer {env:FOOM_CONTROL_TOKEN}`. Foom does not substitute the
credential into files or argv. Each launch gets a random server name and exact
`server_tool` action rules for the same classified tool names as Claude, restricted
by the actual granted role; no other server/tool permission is added. See the
[v2.0.32 MCP schema](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/schema/src/mcp.ts),
[tool action construction](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/tool/mcp.ts),
and [MCP guide](https://dev.opencode.ai/v2/docs/mcp-servers).
MCP attachment is source-backed and fixture-tested, not a real orchestration
measurement. Managed policy can refuse either attachment. `--auto` (including
its equals form conservatively) uses Foom's existing bypass confirmation; unattended
children refuse it. Global OpenCode permission settings are not inferred.

### GitHub Copilot CLI (#410)

Measured by hand on Linux, 2026-10-24, using GitHub Copilot CLI **1.0.103**
in a disposable OS temporary directory outside every repository. Normal launch
and `--version` agreed on 1.0.103. `--no-auto-update` selected the installed
1.0.100 payload instead; that preliminary session was cancelled at folder trust
and supplies no 1.0.103 evidence. The shipped manifest adds no update flag.
No bypass arguments or `COPILOT_ALLOW_ALL` were used. Folder trust was accepted
for the current session only. No user config, credentials or transcripts were
read or edited; Copilot retained its own ordinary session writes.

`--help` confirmed `--plugin-dir`, `--additional-mcp-config` (inline JSON or
`@file`), `--session-id`, `--resume`/`-r`, and `--interactive`/`-i`.
`plugin --help` explicitly lists hooks as a plugin capability. `help permissions`
documents the exact `server(tool)` allow rule. `help environment` documents
case-insensitive, whitespace-trimmed `true`, `1`, `yes`, `on`, `y` for
`COPILOT_ALLOW_ALL`; exact `true` also trusts the working directory. Those values
and all five broad permission flags trigger Foom’s existing bypass disclosure.
These were inspected as help text only, never enabled in a measurement.

Observed screens (only the matching portions retained):

```text
Working, after “Reply with the word ready.”:
  ● Working esc esc interrupt

Idle, after “ready”:
  ❯
  ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab

Blocked, after asking to create ready.txt containing ready:
  Create file
  Do you want to create [scratch path]/ready.txt?
  ❯ 1. Yes
    2. Yes, and don't ask again for file operations when in this directory
    3. No, and tell Copilot what to do differently (Esc to stop)
  ↑/↓ to navigate · enter to select · esc to cancel
```

The initial Confirm folder trust dialog used the same navigation footer. The
file permission was cancelled with Escape; no write was approved. The
[redacted capture fixtures](../tests/fixtures/agent-detection/README.md) retain
these regions. Working and idle inspect the last nonblank line; blocked scans
the bottom 12 nonblank lines. Blocked wins over Working. Initial idle is only
readiness; attached hooks require `agentStop` before completion classification.
No OSC title or progress rule is claimed. Unknown modes, versions or terminal
widths may stay neutral; macOS and Windows real CLI behavior is not measured.

A temporary legacy plugin with `plugin.json` (`name`, `version`) and root
`hooks.json` (`version:1`) attached through `--plugin-dir`. Silent command hooks
observed `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse` and
`agentStop`; every payload included the assigned `sessionId`. `agentStop`
included `stopReason: end_turn`. Commands selected by event name are fixed
Foom observers; the event travels through the authenticated fixed event header.
Only the validated session ID and enumerated event/action survive reduction.
`permissionRequest` fired even for a pre-approved MCP ping, so it is deliberately
not mapped to Blocked: the measured visible confirmation form supplies that state.
No subagent stop event is treated as parent completion.

A disposable loopback HTTP MCP server attached through
`--additional-mcp-config @file`, with `type:http`, `url` and
`headers.Authorization: "Bearer ${FOOM_CONTROL_TOKEN}"`. The server observed
initialize, tools/list and tools/call, and verified environment expansion without
logging the token. A prompt called its harmless `ping` tool successfully with
only `--allow-tool foom_measure(ping)`. The same test succeeded without a `tools`
field. The shipped manifest grants the same named Foom tools as Claude, filtered
by the requesting role; it never grants a whole server or wildcard. These tests
used measurement-only credentials and no repository/orchestration authority.

A new session used a supplied UUID; exit displayed that UUID in
`copilot --resume=…`. A second launch with `--resume UUID`, the isolated plugin
and isolated MCP resumed the same conversation, fired `sessionStart` with the
same `sessionId`, called ping and returned idle. Paste recognition uses literal
three-token `copilot --resume UUID`, `copilot -r UUID` or
`copilot --session-id UUID`; the existing bounded paste grammar does not accept
the CLI’s displayed equals form, names or prefixes.

The CLI’s [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
and [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
supply documented context; the observations above establish the 1.0.103 Linux
attachment and payload evidence. Automated tests use synthetic fixtures only.
