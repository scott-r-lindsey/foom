# Agent attention signals

Research for #11, checked 2026-09-28 on Linux. This is a capability baseline, not a claim that every installed version behaves identically. Detect each resolved executable with `--version`, retain its full version string, and probe its `--help` before choosing flags. Unknown versions keep the output-evaluator fallback.

## Recommendation

| Agent | Version tested | Attention source | One-shot evaluator |
|---|---|---|---|
| Claude Code | `2.1.284` | Per-launch Stop + Notification hooks; completion still needs classification | `claude -p`, with tools and external integrations disabled |
| Codex | `codex-cli 0.155.1` | Per-launch `notify` for turn completion only; use the evaluator for approvals/questions | `codex exec`, conditional on enforcing the tail-only input boundary |
| Antigravity | `agy 1.1.13` | Output evaluator for now: hooks exist, but no per-launch attachment was verified | Headless mode exists; not recommended as a Foom inference source yet |

Only help/version, two synthetic model calls, and startup PTY behavior were tested locally. Notification timing, actual approval dialogs during tool use, password prompts, Windows, and macOS were not exercised. No global configuration was edited; normal CLI runtime state is separate from configuration. No repository content or real terminal tail was supplied to the model probes.

## Claude Code

`--settings <file-or-json>` loads additional settings for that invocation. Foom can supply a private temporary file without editing `~/.claude/settings.json`; the CLI itself may still write session/runtime data under `~/.claude`. The local Stop capture confirmed attachment through this flag. Keep ordinary user settings in interactive agent launches; the isolated evaluation probe below deliberately disabled them. [CLI reference](https://code.claude.com/docs/en/cli-reference)

Minimal Foom-owned settings (helper path is illustrative):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "/absolute/foom-hook" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "/absolute/foom-hook" }] }]
  }
}
```

Command hooks receive JSON on stdin. Notification adds `message`, optional `title`, and `notification_type` to session metadata. `permission_prompt` is delayed roughly six seconds without typing; `idle_prompt` roughly 60 seconds after a response. Neither is a universal immediate attention signal. `PermissionRequest` is an alternative for immediate tool-approval observation. Stop observes a response ending, not interruption or necessarily task success. The observer should exit successfully without returning blocking decisions. [Hook contract and timing](https://code.claude.com/docs/en/hooks)

The local Stop payload had this shape (identifiers and paths replaced):

```json
{
  "session_id": "session-id",
  "transcript_path": "/private/session.jsonl",
  "cwd": "/scratch",
  "prompt_id": "prompt-id",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "{\"state\":\"needs_input\"}",
  "background_tasks": [],
  "session_crons": []
}
```

Do not read `transcript_path`. Validate required event fields, tolerate additional fields, and bound payload size. Treat `permission_prompt` as Needs you; classify idle/Stop using the redacted tail, and retain Working/Quiet when background work remains. Other notification types need explicit mappings; an authentication-success notification is not an input request.

Approvals depend on permission mode and rules. Manual/default mode displays permission choices; `acceptEdits`, plan, and auto modes have different behavior. Do not weaken permissions to make attention detection easier. [Permissions](https://code.claude.com/docs/en/permissions)

`-p` is suitable for one-shot classification: it exits after returning the response, supports JSON output and schema constraints, and can disable tools with `--tools ""`. [Programmatic usage](https://code.claude.com/docs/en/headless)

## Codex

The installed CLI documents `-c key=value` as an invocation override with TOML values. Pass an argument array such as `["-c", "notify=[\"/absolute/foom-notify\"]"]`; do not pass a shell command string. This replaces the effective notify command for this launch, so Foom must disclose that an existing notifier is displaced or explicitly compose it. It does not edit the user's config.

The documented external notification event is `agent-turn-complete`. The notify program receives one JSON argument appended after its configured arguments, **not stdin**. `tui.notifications` can include `approval-requested`, but that is a separate terminal-notification mechanism and does not add approval callbacks to `notify`. [Notification contract](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)

The local `codex exec` probe received:

```json
{
  "type": "agent-turn-complete",
  "thread-id": "thread-id",
  "turn-id": "turn-id",
  "cwd": "/scratch",
  "client": "codex_exec",
  "input-messages": ["synthetic classifier prompt"],
  "last-assistant-message": "{\"state\":\"needs_input\"}"
}
```

Validate and correlate IDs locally. Drop `input-messages` from Foom logs and model inputs; these are user prompts, outside the tail-only contract. Do not interpolate message text into commands. Completion is evidence to run classification, not an unconditional Done verdict. Silence in the middle of a turn proves nothing.

Interactive approvals depend on the configured policy and sandbox. The tested help exposes `on-request` and `never`; a request may present a tool/command approval in the TUI. `never` returns failures to the model instead of asking. Keep the user's policy when launching interactive agents. Filesystem sandbox permissions do not constrain all connectors or other model tools. [Permission boundaries](https://learn.chatgpt.com/docs/permissions)

`codex exec --json` is usable for bounded evaluation and emits JSONL events, including completion usage. `--output-schema` constrains the final answer. [Non-interactive usage](https://learn.chatgpt.com/docs/non-interactive-mode)

However, read-only is not no-read. Before shipping this evaluator, disable file/command tools, MCP, web/connectors, hooks, skills, and instruction-file discovery, or use an independently enforced environment that exposes only the synthetic prompt/redacted tail and required authentication. A prompt saying “do not read files” is not enforcement. The successful probe below establishes the invocation and callback, not production isolation. If the installed version cannot enforce the boundary, use another inference source or rules only.

## Antigravity

The tested `agy --help` includes `-p`/`--print`, JSON and stream-JSON output, `--json-schema`, and `--print-timeout` (local default: five minutes). Thus “no headless mode” is incorrect. Headless output separates responses from diagnostics and supports structured results. [Headless mode](https://www.antigravity.google/docs/cli/headless/)

Hooks also exist: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`. Stop receives JSON on stdin with `executionNum`, `terminationReason`, optional `error`, `fullyIdle`, and common conversation/workspace metadata. Documented installation locations are workspace `.agents/hooks.json`, global configuration, or installed plugins. No Notification event or per-launch settings/hook flag was established by the docs or installed help. [Lifecycle hooks](https://www.antigravity.google/docs/hooks/)

Recommendation: keep output evaluation until a supported invocation-scoped hook mechanism is verified. Do not install a plugin or write workspace/global hook files merely to attach Foom. Headless support alone does not add Antigravity to the product's inference-source choices; tool isolation and end-to-end behavior remain unverified.

Interactive permission prompts cover actions requiring a grant, depending on rules and sandbox settings. Treat those as Needs you; do not enable `--dangerously-skip-permissions`. Exact prompt text is not a stable interface. [Permissions](https://www.antigravity.google/docs/permissions/)

## Echo is not a password detector

A five-second startup probe using Python `pty.openpty()` and `termios.tcgetattr(slave)` measured ECHO changing from enabled to disabled for **all three CLIs**, without submitting any prompt. Claude was at its workspace-trust dialog; Codex and Antigravity had not yielded a readable prompt in the capture. This establishes a startup false positive, not password-prompt behavior.

Whether each agent changes echo again for a password prompt is unverified; child tools and platforms can differ. Do not infer Needs you or a password from ECHO-off alone. Use a relevant visible prompt plus context. Never capture keystrokes to investigate secrets, and never send password text to an evaluator. Native Windows behavior requires separate testing.

## Reproduction and measured cost

Run from an empty scratch directory. The shared synthetic prompt was: `Classify this synthetic terminal tail: "Proceed? (y/n)". Reply only with {"state":"needs_input"}. Do not use tools or inspect files.` These probes test transport and overhead, not classification accuracy. A temporary capture helper wrote stdin for Claude and the final argv element for Codex to local scratch files; no transcript was opened.

- Claude: `claude -p <prompt> --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --settings <capture-settings.json> --no-session-persistence --output-format json --max-turns 1 --max-budget-usd 0.10`. Capture settings used the Stop/Notification structure above. Stop fired; Notification did not fire during this brief run.
- Codex: `codex exec --ignore-user-config --skip-git-repo-check --ephemeral --sandbox read-only -c project_doc_max_bytes=0 -c 'notify=["python3","/scratch/capture.py","/scratch/notify.json"]' --json <prompt>`. The helper's configured filename argument was followed by the JSON payload. The completion callback fired. No tool-call events appeared.

| Probe (one sample each) | Process wall time | Reported usage/cost |
|---|---|---|
| Claude, reported model `claude-opus-5-5` | 2.62 s; API time 1.551 s | 2 input + 2,061 cache-write + 531 cache-read + 13 output tokens; `total_cost_usd` $0.0168622 |
| Codex, default model not pinned | 4.45 s | 13,563 input, including 11,520 cached; 10 output tokens; no dollar cost reported |

These are observations, not latency guarantees or account billing quotes. Claude reported list-price cost; subscription usage need not be a per-call charge. Defaults, hidden system context, caching, model choice, and account limits affect both cost and latency. Benchmark the user's selected model at setup. Apply a hard timeout, bounded concurrency, and fallback to rules; do not run a model call for every output chunk.

Before implementing detection, repeat real approval/idle/interrupt tests on each supported OS, confirm hook coexistence and disabled-hook policies, and validate evaluator isolation. Keep uncertain events neutral rather than interpreting missing callbacks as success.

## Receiver implementation (#13)

The receiver now accepts `PermissionRequest` as immediate needs-input evidence, alongside delayed `permission_prompt` notifications. The [official hook contract](https://code.claude.com/docs/en/hooks#permissionrequest) says it runs when a tool needs a permission decision; Foom's adapter returns no decision and does not change permissions. This is a documented mapping, not a new end-to-end measurement of real approval timing. Real interactive approval and disabled-hook behavior still need the launch-time probes described above.

See [architecture](architecture.md#agent-signals) for the transport API, lifecycle, limits, and reduced signal contract. Synthetic transport tests execute the native OS adapter against the real listener; they do not call a model or read transcript files.
