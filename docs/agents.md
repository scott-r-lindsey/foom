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

### Pi 1.4.0 measurement (#823)

Measured manually on Linux on 2026-10-25, using `/home/slindsey/.local/bin/pi`
in a disposable OS temporary directory, outside the repository. No bypass flags
were used and no Pi configuration or credential files were inspected or edited.
`pi --version` returned `1.4.0`.

`pi --help` advertises positional interactive messages, `--session-id <id>`
(exact project session ID, creating it if missing), and `--session <path|id>`
(session file or partial UUID). On exit, the observed resume instruction was
`To resume this session: pi --session <UUID>`.

The help exposes `--extension, -e <path>` for extension code, but no per-launch
command-hook attachment. `pi mcp --help` says it reads `~/.pi/agent/mcp.json`
and trusted projects' `.pi/mcp.json`; its add/remove commands persist settings.
Neither help output advertises a per-launch MCP configuration file or inline
override. These measurements do not establish a supported declarative hook or
per-launch MCP attachment; no extension or MCP configuration was installed.
`--approve, -a` is documented as trusting project-local files for one run.

Three short PTY sessions attempted a reply-only prompt with the configured
`gpt-5.5`, the same prompt with `--model gpt-5.3-codex`, and a request to create
`ready.txt` containing `ready` with `--model gpt-5.4`. Each returned an OpenAI
400 `model_not_found` error saying that model was not supported with a ChatGPT
account. The redacted screen fragments were:

```text
Working: ── ⠋ Working ─────────────────────────────────
Error:   Error: OpenAI API error (400):
         {"type":"invalid_request_error","code":"model_not_found", ...}
Footer:  ─────────────────────────────────────────────
         <temporary directory>
         $0.000 (sub) 0.5%/272k (auto)     <model> • medium
Title:   π - <temporary directory basename>
```

The title stayed unchanged while working and after the error. The editor has a
plain divider even while working, so a divider alone is not evidence of idle.
With the user-specified `--model gpt-6.1-sol`, the reply-only prompt returned
`ready` and the file prompt created `ready.txt` containing `ready`, without any
permission prompt or bypass flag. Both turns showed the Working divider and then
returned to plain editor dividers. The usage footer contained `(auto)` and the
selected model. The shipped idle rule requires that footer and excludes Working;
the higher-priority Working rule wins while its divider remains visible. These
are screen heuristics, not proof of success. Startup and error-returned editors
also have idle editor dividers. The measured OpenAI `model_not_found` error
has a higher-priority blocked rule so it cannot be mistaken for a completed turn.
Other unmeasured error variants remain a limitation.

The same session's `/model` picker supplied a measured blocked screen:

```text
Only showing models from configured providers. Use /login to add providers.
> <search field>
→ ✓ <selected model> [<provider>]
  Model Name: <selected model name>
  Model catalogs refreshed.
<temporary directory>
```

Escape dismissed the picker without selecting or persisting a different model.
The blocked rule requires both the configured-provider notice and `Model Name:`
in the bounded bottom region. File approval remains unobserved because this
installation wrote the requested file without prompting. No file-permission rule
is inferred. The working/idle and model-selection rules are captured in the
bundled manifest tests; no automated test invokes real Pi.

### Pi 1.4.0 extension spike (#834)

Measured manually on Linux on 2026-10-25 in a disposable temporary directory,
with `--model gpt-6.1-sol`, harmless reply/ping prompts, no bypass flags, and
`--no-session`. No Pi configuration or credential files were inspected or edited.
The installed package is `@earendil-works/pi-coding-agent`; its
`docs/extensions.md`, `docs/mcp.md`, exported `dist/core/extensions/types.d.ts`,
and `pi --help` provided the API evidence.

Extensions are TypeScript or JavaScript modules loaded by `--extension` / `-e`.
Pi loads TypeScript through jiti in its own process, with the same OS permissions
as Pi, including potential access to files, credentials and session history.
A default factory receives `ExtensionAPI`. This is executable code, so a manifest
must never supply its source or nominate an arbitrary module for Foom to write.

The reply-only session observed `session_start`, `agent_start`, `turn_start`,
`turn_end`, `agent_end`, then `agent_settled`. The custom-tool session observed two
model turns before settlement, and a stable `ctx.sessionManager.getSessionId()`
within each session. `agent_end` is not final idle: retries, recovery, compaction
or queued work can follow it. `agent_settled` is the documented notification after
automatic processing stops, with an `aborted` boolean; it does not prove success.
No dedicated permission-request event is declared. `ui_prompt_start` and
`ui_prompt_end` observe blocking extension UI (select/confirm/input/editor/custom),
which may include a permission extension's question but are not universal approval
signals. An observer must never implement a permission gate or return decisions.

`registerTool` successfully exposed a harmless custom ping tool to the model.
`registerMcpServer(name, config)` registers a session-only streamable HTTP server,
including headers and tool exposure, without writing `mcp.json`. Its tools retain
Pi's normal validation and permission pipeline. A manual local HTTP probe observed initialization, tools/list and one authenticated
tools/call, returning `pong` through Pi's registered MCP tool.
Registered servers require Pi's
built-in MCP connector (or a compatible replacement); `--no-extensions` disables
that connector unless `--extension builtin:mcp` explicitly restores it. These API
findings support a private per-launch Foom extension for lifecycle observation and
role-filtered MCP, with server-side Foom authorization remaining authoritative.

The shipped adapter selects the fixed `pi-v1` ABI through the shared v2 engine.
It emits only bounded event/session/outcome/idle facts. Current-role MCP exposure
comes from the authenticated `whoami` capability list before new work, narrowed to
classified Foom names; lookup failure withdraws the registration. It registers the per-launch
MCP server through Pi's normal client. Hook-only and MCP-only launches are supported;
files and credentials share ordinary launch cleanup. The before-settlement outcome
is observed without returning entries or continuation decisions. Error and aborted
settlements are failure evidence; completed settlement requests local classification.
Permission detection remains limited to blocking extension UI and measured screens.
Windows/macOS delivery is covered by fixture tests; these manual API sessions were
Linux-only. The built-in MCP connector must remain enabled; Foom does not override
user extension policy or edit Pi configuration to enforce it.

A final disposable session loaded the exact integrity-locked `pi-v1.mjs` bytes
with the built-in MCP connector explicitly enabled for the isolated probe. It
completed a ping through a synthetic local `whoami` capability response and HTTP
MCP server. The receiver observed session/agent/turn/tool events and final
`agent_settled` with `outcome: completed`; no prompt, tool arguments or results
appeared in those lifecycle payloads. All probe credentials were disposable.

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

### Antigravity contract capture (agy 1.4.12, #1000)

Measured manually on Linux on 2026-11-02 against a private loopback logging
stand-in, with fresh synthetic control/hook credentials and this worktree's built
CLI. All inherited `FOOM_*` variables were removed before each real agy launch.
No user Gemini files were inspected or edited. The machine was reported as
1.4.11 before investigation, but interactive startup and a subsequent `--version`
reported 1.4.12; agy's automatic updater was not invoked explicitly. These captures
therefore establish 1.4.12 behavior, not an independently pinned 1.4.11 result.

Initialize requested `2025-11-25`, with clientInfo
`{"name":"antigravity-client","version":"v1.0.0"}`. The stand-in answered
successfully through the unchanged bridge. An unknown requested protocol version
is therefore not the cause in this capture. The stand-in has no ControlService
grant, so this does not establish whether the originally failing real session's
actor was active. No request used the user's real Foom endpoint.

With the existing installed observer and default login, a no-tool print turn
reported PreInvocation then Stop, approximately 2.2 seconds apart. An interactive
read-only tool turn and later no-tool turn also reported PreInvocation; completed
tool attempts reported PostToolUse, then PreInvocation before final Stop.
PreInvocation was not missing on subsequent turns. One outside-workspace file
request was declined through the normal permission UI; no approval policy or
bypass flag was changed. A later harmless temp-file read used a disposable plugin
installed by agy into a disposable HOME, with no copied login/configuration.
That capture reported SessionStart, PreInvocation, PreToolUse, PostInvocation,
PreInvocation, PostInvocation, Stop. PreToolUse preceded PostInvocation by about
26 ms; Stop followed the last PostInvocation by about 24 ms. PostToolUse was
absent in that attempted tool turn. A PreToolUse callback proves progress, not
that a permission prompt is visible or a tool completed.

Only timestamps, event order, payload field names and initialize protocol/client
metadata were retained in untracked `test-results/agy-1000/`. Common hook keys:
`artifactDirectoryPath`, `conversationId`, `lastUserInput`, `modelName`,
`transcriptPath`, `workspacePaths`. PreInvocation/PostInvocation additionally
carried `initialNumSteps`, `invocationNum`; PreToolUse added `stepIdx`, `toolCall`;
PostToolUse added `error`, `stepIdx`, `toolCall`; Stop added `error`,
`executionNum`, `fullyIdle`, `terminationReason`. No payload values, prompt,
response, tool content, transcript or credentials were captured. Neither the
original initialize failure nor a missing PreInvocation reproduced here; macOS
and real Windows behavior remain unverified. Fixture tests cover live/revoked
grants and the captured shapes without invoking a real agent.
