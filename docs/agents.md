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
