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
