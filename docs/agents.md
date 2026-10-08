# Agent attention signals

Research for #11, checked 2026-09-28 on Linux. This is a capability baseline, not a claim that every installed version behaves identically. Detect each resolved executable with `--version`, retain its full version string, and probe its `--help` before choosing flags. Hook discovery accepts stable numeric Claude Code versions >= 2.1.284 (` (Claude Code)` is an optional product label) and `codex-cli` versions >= 0.155.1, with no upper bound. Help must still advertise the complete `--settings` or `-c` flag. Older, unparseable, prerelease, and custom-suffixed versions use the output-evaluator fallback. Missing or failed help probes also fall back.

## Recommendation

| Agent | Version tested | Attention source | One-shot evaluator |
|---|---|---|---|
| Claude Code | `2.1.284` | Per-launch Stop + Notification hooks; completion still needs classification | `claude -p`, with tools and external integrations disabled |
| Codex | `codex-cli 0.155.1` | Per-launch `notify` for turn completion only; use the evaluator for approvals/questions | `codex exec`, conditional on enforcing the tail-only input boundary |
| Antigravity | `agy 1.1.13` | Output evaluator for now: hooks exist, but no per-launch attachment was verified | Headless mode exists; not recommended as a Foom inference source yet |

Discovery regression tests cover the baseline, Claude 2.1.285 / 2.2.0 / 3.0.0 and Codex 0.155.2 / 0.156.0 / 1.0.0, older releases, malformed strings, suffixes, and missing flags. These are synthetic discovery/launch tests, not additional real hook measurements. Runtime verification of missing hooks after a completed turn remains part of service/evaluator integration (#50/#14); accepting a version does not prove hooks fired.

Only help/version, two synthetic model calls, and startup PTY behavior were tested locally. Notification timing, actual approval dialogs during tool use, password prompts, Windows, and macOS were not exercised. No global configuration was edited; normal CLI runtime state is separate from configuration. No repository content or real terminal tail was supplied to the model probes.

## Resume exited conversations (#115)

Checked installed CLI help on Linux on 2026-10-07: Claude Code supports
`--resume <id>`; Codex supports `resume <SESSION_ID>`; Antigravity supports
`--conversation <id>`. Foom offers Resume for Claude and Codex only: Antigravity
has no verified invocation-scoped adapter for capturing its conversation ID.

The authenticated receiver captures Claude `session_id` and Codex `thread-id`
from supported hook/notify events. IDs must be 1–200 ASCII letters, digits,
underscores or hyphens, starting with a letter or digit. Options, paths, whitespace,
control characters and shell syntax are rejected. Each launch pins its first ID;
mismatched subsequent events are rejected. IDs are local metadata, never model input.
No transcript or agent runtime file is read. Codex notifies at turn completion;
if it exits or updates before any notification, Foom cannot recover an unknown ID.
Hooks-disabled launches likewise cannot capture an ID.

Session metadata is saved privately in Foom's profile and restores as exited rows.
Resume revalidates repository/worktree membership and identity, resolves the agent
executable, and uses argument arrays with fresh per-launch hooks, current defaults
and the existing shared-checkout/notifier confirmations. It preserves the terminal
ID, row, name and checkout. New conversation clears the old ID only after launch
succeeds. Copy session ID copies the full value. Close forgets Foom's record without
removing the checkout or the agent's conversation. The CLI owns conversation retention;
if it has removed a conversation, its resume error remains visible in the terminal.

## Default launch arguments (#164)

Re-verified installed `--version` and `--help` on Linux on 2026-10-06:
Claude Code `2.1.291 (Claude Code)`, `codex-cli 0.160.1`, and Antigravity `1.3.0`.
These are help/version observations only; the hook/model measurements above remain
from the original baseline, not fresh live-agent tests.

| Policy | Claude Code 2.1.291 | Codex 0.160.1 | Antigravity 1.3.0 |
|---|---|---|---|
| Plan / read-only | `--permission-mode plan` | `--sandbox read-only` | `--mode plan` |
| Auto-edit | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--mode accept-edits` |
| Auto-review | `--permission-mode auto` | `--approve-for-me` | Not advertised |
| Bypass | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |

The table uses conventional CLI notation; in Settings, each flag and value occupies
its own line. All three help outputs advertise `--model`; Claude and Antigravity
advertise `--effort`, while Codex accepts `-c` followed by
`model_reasoning_effort="high"`. Values and quotes are passed unchanged as argv,
not evaluated by a shell. LF and CRLF line endings are accepted; trailing empty
lines are ignored. Interior empty lines remain errors, and validation identifies
the agent and line. Empty defaults preserve the prior launch behavior.

Settings stores arrays in main (maximum 64 arguments per agent, 1–4096 characters
each, no control characters). User defaults precede Foom's own arguments.
On profile load, an invalid or newly reserved list is discarded only for that
agent; other agents' defaults and unrelated settings are retained. Save requests
remain strict and reject the entire invalid patch.
Claude `--settings` (including `=` form), `--safe-mode` and `--bare` are reserved
to protect hooks (`--bare` skips hooks defined in settings and plugins).
`--no-alt-screen` is reserved for Foom's display. Codex overrides whose key path sets `notify` or `hooks` are rejected, including `-c notify=…`,
`--config=notify=…`, attached short forms and nested keys. The `--` terminator is
also rejected because it would turn Foom's flags into positional arguments.

Conversation selectors are reserved for Foom's session actions: Claude resume,
continue, session-ID and fork-session flags; Codex `resume`/`fork` commands and
`--last`/`--fork`; Antigravity conversation/continue flags. This prevents launch
defaults from redirecting Resume or turning New conversation into a continuation.
Other agent arguments retain the existing validation and literal argv behavior.

The fixed bypass table includes the three Bypass flags above and Claude's
`--permission-mode bypassPermissions` and `--permission-mode=bypassPermissions`.
Codex `danger-full-access` also triggers disclosure and the badge: `--sandbox`
or `-s` (separate, `=` or attached short value), and `-c`/`--config`
`sandbox_mode` overrides (bare, single-quoted or double-quoted values). This is
conservative: full filesystem access is flagged even when approvals are still
required, and a later flag does not cancel the disclosure.
The first save of any of those forms per agent requires a main-owned confirmation:
a worktree is not a sandbox, and the agent can act as the user anywhere on the
machine. A successful save persists that agent's acknowledgement; cancelling or
a failed write does not. Renderer requests cannot set acknowledgement themselves.
Rows show a neutral ◇ Bypass label based on the arguments at launch. This does not
infer policy from global settings or every possible combination of arguments.
`--allow-dangerously-skip-permissions` alone does not enable bypass mode.

PR #169 (issue #128) has not landed, so disclosure currently uses
the existing parented native main-process confirmation with Cancel as the default.
Whichever PR lands second must move `confirmBypass` to `TrustedDialog`.
Orchestrator children are outside this feature's scope; see [orchestration](orchestration.md).

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

Interactive launches add `--no-alt-screen` when the bounded `codex --help` probe lists
that complete flag. This is independent of hook version gating and whether hooks are enabled.
Codex then draws inline, so normal terminal scrollback is available to wheel scrolling,
peek and evaluator tails. Missing/failed help probes omit the flag. Launch arguments remain
an array, and no global configuration is changed.

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

Interactive approvals depend on the configured policy and sandbox. The tested help exposes `on-request` and `never`; a request may present a tool/command approval in the TUI. `never` returns failures to the model instead of asking. Interactive policy is the user's global agent config plus their Foom default launch arguments, followed by Foom's own display and hook flags. Foom never edits global config. Filesystem sandbox permissions do not constrain all connectors or other model tools. [Permission boundaries](https://learn.chatgpt.com/docs/permissions)

`codex exec --json` is usable for bounded evaluation and emits JSONL events, including completion usage. `--output-schema` constrains the final answer. [Non-interactive usage](https://learn.chatgpt.com/docs/non-interactive-mode)

However, read-only is not no-read. Before shipping this evaluator, disable file/command tools, MCP, web/connectors, hooks, skills, and instruction-file discovery, or use an independently enforced environment that exposes only the synthetic prompt/redacted tail and required authentication. A prompt saying “do not read files” is not enforcement. The successful probe below establishes the invocation and callback, not production isolation. If the installed version cannot enforce the boundary, use another inference source or rules only.

## Antigravity

The tested `agy --help` includes `-p`/`--print`, JSON and stream-JSON output, `--json-schema`, and `--print-timeout` (1.3.0 help default: 0, wait until the turn completes). Thus “no headless mode” is incorrect. Headless output separates responses from diagnostics and supports structured results. [Headless mode](https://www.antigravity.google/docs/cli/headless/)

Hooks also exist: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`. Stop receives JSON on stdin with `executionNum`, `terminationReason`, optional `error`, `fullyIdle`, and common conversation/workspace metadata. Documented installation locations are workspace `.agents/hooks.json`, global configuration, or installed plugins. No Notification event or per-launch settings/hook flag was established by the docs or installed help. [Lifecycle hooks](https://www.antigravity.google/docs/hooks/)

The opt-in lifecycle plugin in #178 is the scoped exception to invocation-only attachment. Foom never installs it silently or writes Antigravity configuration directly; Settings calls the plugin CLI after explicit disclosure. Headless support alone does not add Antigravity to the product's inference-source choices; tool isolation and end-to-end behavior remain unverified.

Interactive permission prompts cover actions requiring a grant, depending on rules and sandbox settings. Treat those as Needs you. Foom never adds `--dangerously-skip-permissions` itself; users may explicitly save it as a default after the bypass disclosure. Exact prompt text is not a stable interface. [Permissions](https://www.antigravity.google/docs/permissions/)

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

## Local title and screen detection (#161)

Checked on Linux on 2026-10-06 with Claude Code **2.1.291**, Codex **0.160.1**,
and Antigravity **1.3.0**. The versioned, redacted captures in
[`tests/fixtures/agent-detection`](../tests/fixtures/agent-detection/) are the
shipping gate: every bundled rule must match a capture. They are real CLI output,
not the fake agent used by Electron tests. They do not establish cross-platform
or cross-version reliability.

- Claude: a half-circle title prefix means Working; `✳ ` means turn-ended evidence.
  The trust confirmation and question-form footer after the last horizontal rule
  mean Needs you. The question capture has an idle title: screen blockers must win
  over idle. Older braille titles, background tasks, MCP elicitation, overlays and
  other unobserved Herdr variants are omitted.
- Codex: the braille title prefix means Working; `Action Required` means Approval
  requested. Other nonempty titles without either marker are idle evidence. The
  approval capture used a harmless `printf` escalation request and was terminated
  without approving it. A startup spinner-to-idle sequence is also captured.
- Antigravity: the captured trust dialog is recognized from the bottom eight
  nonempty lines. Uncaptured approval/working/question variants remain subject to
  generic rules and the evaluator.

The host parses OSC 0/2 titles, caps them at 512 UTF-16 code units and strips control
and format characters. OSC 9;4 accepts only states 0–4 and optional integer values
0–100; state 0 means no progress/busy indication. Invalid sequences leave the prior
metadata intact. These probes did not emit OSC 9;4, so progress is retained locally
but no progress-only rule is shipped without capture evidence. No title or progress
is sent to inference. Rules are packaged JSON, never downloaded or supplied by a CLI.
Matched signals are `rules:<agent>:<rule-id>`; reasons are authored by Foom.

**Codex notifier decision at #161 (superseded for confirmed lifecycle hooks by #181 below):** retain the invocation-only `notify` override and its
existing disclosure. One Linux version's title captures do not prove dependable
turn completion across supported installations, interrupts, reconnects and user
TUI configuration. An idle title can also mean initial readiness or a question,
not successful completion. Removing the notifier is therefore premature.

The current [Codex hook documentation](https://learn.chatgpt.com/docs/hooks) lists
`PermissionRequest`, `Stop` and `UserPromptSubmit`, and supports inline hooks next
to active config layers. Non-managed hooks require trust before execution. A real 0.160.1 startup probe using
`-c 'hooks.SessionStart=[{hooks=[{type="command",command="true"}]}]'`
confirmed invocation-scoped discovery: Codex displayed **Hooks need review** before
starting the session. The probe ended without trusting the hook; no callback or
coexistence behavior was claimed. Thus a per-launch override is discoverable, but
unattended attachment would require a trust workflow. Foom does not bypass hook
trust or write user/project hook configuration. A verified
invocation-scoped adapter can replace the notifier separately; this change retains
the established adapter.

## Stable Codex lifecycle observers (#181)

Probed on Linux with **codex-cli 0.161.0**, 2026-10-07/08. The test used an empty
scratch workspace and a private Codex state directory bind-mounted over the normal
state directory with Bubblewrap. The ordinary user's config and trust entries were
never exposed for writing. Codex's own `/hooks` screen granted trust in that disposable
profile; no trust hashes were written by the probe or by Foom. The observer recorded
only event names, field names, timestamps, a synthetic environment marker and the
conversation ID. It never opened a transcript or saved prompts/tool inputs.

The invocation attached each event with a separate argument pair:

```text
-c 'hooks.SessionStart=[{hooks=[{type="command",command="python3 /scratch/observe.py"}]}]'
```

The same definition was used for UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse and Stop. Production uses the bundled native observer and a three-second
hook timeout, not Python. The [official hook contract](https://learn.chatgpt.com/docs/hooks)
describes review through `/hooks` and trust bound to the current definition.

### Measured trust and lifecycle behavior

- Trust **persists for identical `-c` definitions**. After reviewing SessionStart,
  the next launch requested review for only the five newly attached events. After
  reviewing those, a subsequent `codex resume <id>` needed no review.
- Codex wrote state keys shaped like
  `/<session-flags>/config.toml:session_start:0:0`, with a `sha256:` trusted hash.
  Identical commands attached to different events had different hashes. Adding
  `timeout=3` to the six previously trusted definitions made all six need review.
  Editing only the observer's file contents did **not** invalidate trust. These
  observations establish event/definition sensitivity and exclude script contents;
  they do not reverse-engineer Codex's complete hash serialization. Foom does not
  compute or depend on that private hash algorithm.
- Environment data reached the observer and was absent from the definition. A Foom
  reinstall at a different path changes the command and needs review. A same-path
  update preserves trust only while the definition stays identical. **Bump the
  observer filename version when its behavior changes** so the user can review it.
- SessionStart ran just before the **first submitted prompt**, rather than while
  the initial input box was idle. UserPromptSubmit followed it. A real `printf`
  turn produced PreToolUse, PostToolUse, then Stop. Startup health must not use an
  arbitrary timer while the user has not submitted anything.
- With `-a on-request`, a harmless escalation request produced PreToolUse followed
  by PermissionRequest while the approval screen waited. The silent observer did
  not approve it. Esc interrupted that turn, returned an idle title, and produced
  **no Stop**. An earlier probe with the default never-approval policy rejected
  escalation before an approval dialog; it is not evidence for PermissionRequest.
- Resume retained the conversation ID and produced SessionStart/UserPromptSubmit
  when the next prompt was submitted. The same environment marker reached it.
- Choosing **Continue without trusting** allowed a real text-only turn to finish
  with normal working/idle titles and **no observer callbacks**. The helper's event
  log remained unchanged. Foom must keep its existing notify/title fallback.

The Windows command form is a fixed `powershell.exe -NoProfile -NonInteractive
-ExecutionPolicy Bypass -EncodedCommand <base64>` invocation. The UTF-16LE encoded
program invokes the quoted installed `.ps1` path with a fixed `codex` argument.
Encoding protects spaces, apostrophes and `$` in installation paths through both
cmd.exe and PowerShell command parsing; it contains no credentials. Native Windows
unit integration tests execute that command through cmd.exe, with stdin and the
real receiver, and exercise missing-variable and stopped-receiver behavior.
**The real Codex Windows TUI was not available on this Linux host**; its trust and
approval timing remains a platform verification limitation. The PR requests full
platform CI, which can validate the native adapter but cannot replace that real-CLI
probe. No plugin fallback is needed: per-launch trust persisted in the Linux probe.

### Shipping behavior

Stable releases from 0.161.0 attach these six observers per launch. Older supported
Codex releases keep notify only. The generated scripts live at fixed installed
`build/observers/codex-v1.sh` / `.ps1` paths, unpacked beside ASAR in packaged apps.
Their definitions contain no launch paths, ports, tokens or session IDs. The scripts
exit silently before reading stdin when any of FOOM_HOOK_URL, FOOM_SESSION or
FOOM_TOKEN is absent. Reporting has a one-second transport timeout and never emits
permission decisions. Foom never passes the hook-trust bypass flag, and rejects it
in saved launch defaults.

The receiver authenticates the launch, pins `session_id` (shared with notify's
`thread-id`), validates event-specific fields and discards prompt text, tool inputs,
outputs and transcript paths. SessionStart records readiness without ending a turn;
UserPromptSubmit/PreToolUse/PostToolUse mean Working, PermissionRequest means Blocked,
and Stop ends the turn for classification. Once lifecycle hooks are observed, a
plain idle title without Stop stops Working but cannot announce successful completion.

Agent setup shows **Not reviewed**, **Trusted · observed working**, **Declined or
unavailable**, or **Outdated**, with `/hooks` instructions. These are Foom health
observations, not a read of Codex's trust database: absence cannot distinguish a
user declining from disabling hooks or a broken transport. A matching review screen
or an observed turn without its prompt hook explains the fallback. Foom never
opens review, grants trust, retries launches, or types `/hooks` for the user.

Only a launch that reports SessionStart, UserPromptSubmit and Stop establishes
working completion hooks. Later launches omit the notify override and its disclosure;
the establishing launch keeps its already-attached fallback. Duplicate notify after
Stop does not classify that same execution turn again. A later turn without prompt
callbacks restores fallback health and can still complete through an attached notify. A private `codex-hook-health.json` in **Foom's profile**
persists only a definition fingerprint and health state. A changed definition
invalidates that observation. Late events from older launches cannot overwrite a
newer launch's health. If hooks subsequently fail, title rules remain available in
the current launch; later launches restore notify and its existing disclosure.
No user or repository Codex configuration, plugins or trust entries are edited.


## Opt-in Antigravity lifecycle plugin (#178)

Linux probe on 2026-10-08, installed Antigravity **1.3.1**. All plugin mutations
ran with a disposable HOME and XDG directories beneath the development worktree;
the user's global configuration was unchanged. `agy plugin install <directory>`
copied `plugin.json`, `hooks.json` and observer files into
`~/.gemini/config/plugins/foom`. No trust prompt appeared. `plugin uninstall foom`
removed that installation; `plugin disable foom` changed the CLI-owned enabled
preference. `plugin list` returned JSON with `imports` (or `No imported plugins.`),
but omitted plugin version and enabled state. Foom therefore reads bounded, fixed
manifest/config paths for status and uses argument-array CLI calls for all changes.
It refuses to replace or remove an unrecognized plugin named `foom`.

A real synthetic `--print` turn (“Reply with exactly OK. Do not use tools.”)
completed in 2.46 seconds. PreInvocation arrived first, Stop 2.43 seconds later.
Both received the three FOOM launch environment variables, and both returned `{}`.
The turn completed successfully, establishing that an empty Stop result allows stopping.
A repeat with the bundled detached observer and ordering counter completed in 1.96 seconds;
PreInvocation and Stop arrived with sequence numbers 1 and 2.
The observer recorded only field names and lifecycle metadata, never model output,
workspace paths or transcript contents.

The embedded guide differs from observed behavior: its Stop example says
`terminationReason: "model_stop"`, but 1.3.1 sent **`"NO_TOOL_CALL"`** with
`fullyIdle: true`. The receiver accepts that measured alias and normalizes it to
`model_stop`; it also validates the documented `error` and `max_steps_exceeded`
values. Unknown values fail closed. An error or step limit is failure evidence;
a model stop completes only when fully idle. Background work keeps Working.
PreInvocation and PostToolUse establish Working; screen rules still detect blocking.
No PreToolUse or permission-decision handler is registered.

The bundled versioned plugin contains no credentials. Without all three launch
variables its observer returns `{}` without reading stdin or contacting Foom.
With credentials it returns `{}` first, bounds stdin, and starts an independent
one-second transport. POSIX uses sh/curl; Windows uses PowerShell launched through
`cmd /c`, with a detached transport process and redirected standard handles.
Handlers have a three-second deadline. A private per-launch counter contains only
an integer, never credentials; observers allocate its sequence before detaching.
The receiver ignores duplicate or older reports so a delayed working event cannot
undo Stop and an old Stop cannot end a newer turn. Counter failure drops the report
without blocking the agent. The receiver authenticates each launch,
pins conversation identity, and discards all fields except the fixed event and
validated completion facts. Antigravity conversation resumption remains unavailable.

Native Windows tests exercise `cmd /c`, Windows PowerShell, inherited credentials,
literal UTF-8 stdin and detached reporting. The first CI run caught use of
`ProcessStartInfo.StandardInputEncoding`, which Windows PowerShell's .NET Framework
does not provide; the observer now writes UTF-8 bytes to the child's input stream.
The unresponsive-receiver case also caught inherited PowerShell host handles keeping
the caller pipes open. The worker uses an explicit native handle allowlist containing
only its input pipe and NUL output, so it cannot inherit the agent's output handles.
Real Windows CLI timing and plugin trust behavior remain unmeasured; the real-client
measurements above are Linux-only.

## Read-only review launches (#114)

Checked 2026-10-08 against installed CLI help and the official
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Claude permission modes](https://code.claude.com/docs/en/permission-modes), and
[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
Claude uses `--permission-mode plan`; Codex uses `--sandbox read-only` and
`-c approval_policy="never"`. Foom gates each action on complete help flags and
mode names, and refuses an unsupported launch. Ordinary Foom argument defaults
are omitted, including prompts, permission switches and profiles. No global
configuration is edited. Per-session hooks remain attached when supported.

Plan mode limits source edits through Claude's permission system; it is not a
filesystem sandbox, and approved shell commands or configured integrations may
have side effects. Codex's sandbox applies to local tool execution, not external
integrations. Both interactive CLIs let users change permissions after launch;
Foom's reason label records how it launched the session, not subsequent mode changes.
