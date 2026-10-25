# Agent Hooks

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/attention.md).

## Agent signals

Claude and Codex hooks attach per launch. Antigravity has an explicit opt-in plugin exception:

- Claude Code: `claude --settings <inline-json>` with UserPromptSubmit, PreToolUse, Stop, PermissionRequest and Notification hooks; JSON arrives on stdin. Prompt/tool hooks establish Working. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
- Codex: supported 0.161+ releases receive six invocation-only lifecycle definitions (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse and Stop), with JSON on stdin. The separate `-c notify=[...]` fallback receives its JSON as the final argument and reports turn completion, not approval requests; it replaces the effective notify command for that launch until lifecycle health permits its omission. See [Execution](execution.md#stable-codex-hook-health) for trust, turn and health semantics.
- Antigravity: agy 1.4.2 reports a JSON array with `plugin list --json`; legacy 1.3.1 fixture objects and `No imported plugins.` remain supported through a failed-command fallback. Observer version 3 invokes absolute paths inside the validated CLI-owned installation, independent of the session cwd. Settings discloses and installs the static Foom observer with `agy plugin install <bundled-directory>`. Remove uses `agy plugin uninstall foom`; enable uses `agy plugin enable foom`. All calls use resolved executables, argument arrays, bounded output and deadlines. No direct global configuration writes occur. Without the plugin, launch uses output evaluation.

See [agent research](../agents.md) for versions, payloads, local probes, sources, and remaining verification. Completion events trigger classification; they do not unconditionally set Done. Echo-off alone is not a password signal: all three tested CLIs disabled echo at startup.

**Today:** `src/main/agents/hook-receiver.ts` provides an independently usable main-process service. `HookReceiver.listen(onSignal)` binds only `127.0.0.1` on an OS-assigned port. `register(terminalId, agent)` returns fresh `FOOM_SESSION`, `FOOM_TOKEN`, and `FOOM_HOOK_URL` environment additions and an idempotent `revoke()` capability. The launcher must revoke on launch failure, terminal exit, or removal; application shutdown must call `close()`. The workspace maps receiver keys back to terminal IDs before signals reach the evaluator. The app doesn't start a listener until a launch needs one.

Requests POST JSON to `/hooks`, with `X-Foom-Session` and `Authorization` containing the launch session and raw token. Tokens contain 256 random bits; comparison uses constant-time equality of fixed-length SHA-256 digests, including for unknown sessions. The listener rejects browser origins and nonliteral Host headers, limits headers to 8 KiB and bodies to 64 KiB (including chunked requests), caps connections, and times out stalled requests. It checks revocation again before delivery. Unknown/revoked sessions and incorrect tokens all receive 401. Unsupported events are acknowledged without changing state; malformed events receive 400.

The receiver validates each event against its launch-bound channel mapping and pins
conversation identity according to that mapping. Codex notify additionally requires
a turn ID; lifecycle mappings reduce only their declared identity fields. The
reduced `shared/hooks.d.ts` signal carries `terminalId`, enumerated `action` and
`signal`, optional validated `conversationId`, channel/case IDs, turn-ending and
recovery flags, and bounded `terminationReason` / `fullyIdle` facts. Actions are
`working`, `ready`, `needs_input`, `classify` or `failed`. SessionStart is readiness
metadata; prompt/tool hooks establish Working, permission hooks request attention,
and completion hooks permit classification. No event directly sets Done. See
[Execution](execution.md) for precedence, turn recovery and health semantics.
The validated conversation ID is saved locally through `orchestration-commands.ts`
and the coordinator. Raw payload text, paths, tool inputs and Codex
`input-messages` are discarded, never logged, executed or forwarded to the evaluator.
Classification still uses only the redacted terminal tail.

The hook command cannot run Node from the packaged app because the RunAsNode fuse is disabled. `src/main/agents/providers/v2-observers.ts` generates observer scripts from each manifest channel for stdin or the CLI's final JSON argument: POSIX `sh` plus `curl`, and Windows PowerShell plus `Invoke-WebRequest`. The launcher writes the returned source to a private launch directory, invokes POSIX files with `sh` or Windows files with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, supplies the launch environment, and removes the files afterward. On Windows it first runs the generated script in probe mode; a missing interpreter or enforced policy that blocks the script rejects launch with an error and cleans up the script. The execution policy applies only to that PowerShell invocation; user and machine settings are unchanged. Codex's configured notify argument array must end at the script's configured arguments so the CLI can append its JSON argument. Payloads remain data throughout; generated scripts emit no output or approval decisions and exit successfully even when the receiver is unavailable. Transport deadlines are channel-specific: bundled Claude lifecycle and Codex notify use 3000 ms; stable Codex lifecycle uses 1000 ms. Antigravity uses its separate detached one-second transport described below. See [launch rules](agent-launch.md) for attachment and tool checks, and [Execution](execution.md#stable-codex-hook-health) for notify fallback.

## Observer safety

Command hooks receive bounded JSON on stdin; Codex notify receives its JSON as the final argv entry. Validate required fields, tolerate additional vendor fields, and never open transcript paths. Unknown notification types require explicit mappings; authentication success is not an input request. PermissionRequest/permission_prompt request attention; Stop/idle request local classification. Keep Working while background work remains. Never weaken CLI permissions to improve detection.

Echo-off alone cannot identify passwords. Use a relevant visible prompt plus context; never capture keystrokes to investigate secrets or send password text to an evaluator. Native Windows behavior requires separate verification. [Evidence: #11](https://github.com/scott-r-lindsey/foom/issues/11).

Bump the stable observer filename version when behavior changes so the user can review the definition. Startup health must not rely on a timer before any prompt is submitted. Foom never computes Codex's private trust hashes, reads its trust store, opens review, grants trust, retries launches or types `/hooks` for the user.

Codex setup reports Not reviewed, Trusted · observed working, Declined or unavailable, or Outdated. These are Foom observations: absent callbacks cannot distinguish declined/disabled hooks from failed transport. A matching review screen or a turn without prompt hooks explains fallback. The establishing launch retains notify; later launches omit it only after startup + prompt + Stop. Notify attachment needs no disclosure or confirmation.

The fixed Windows Codex command uses `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` with a UTF-16LE program quoting the installed script path and fixed `codex` argument. Encoding protects spaces, apostrophes and `$` through cmd.exe and PowerShell; it contains no credentials.

Antigravity observers return `{}` before bounded stdin and detached one-second transport, and are inert without all launch credentials. Counter failure drops a report without blocking the agent. The Windows worker writes UTF-8 bytes to stdin and uses a native handle allowlist containing only its input pipe and NUL output, so it cannot inherit agent output handles. Native adapter tests do not establish real Windows CLI timing or trust behavior.

External manifest channels (#635) expose [public protocol 1](../agent-plugins.md#user-authored-extensions-public-hook-protocol-1-635)
for user-installed code extensions. `foom hook EVENT [--channel ID]` is a silent,
bounded stdin client of this same receiver, with no pairing or control authority.
External attachment creates no observer files or arguments and never edits agent
configuration. Existing bundled adapters retain their compatibility behavior.

## Per-launch executable extensions (#834)

`launch.extension` selects an application-owned, integrity-locked ABI and its
attachment argv. The first ABI, `pi-v1`, is fixed JavaScript loaded by Pi through
`--extension`; the shared manifest engine writes `extension/pi-v1.mjs` and
nonsecret `extension/launch.json` beneath the existing private launch root.
Files use 0600 and directories 0700 (current-user DACLs on Windows). The extension
is removed on exit, failed preparation/spawn, kill and shutdown, after credential
revocation. Missing launch credentials make it inert before reading attachment
data. Its versioned name and code-owned SHA-256 lock change with reviewed bytes.
Config manifests cannot provide executable bytes or nominate a file to load.

The Pi adapter uses the existing external hook channel and authenticated receiver.
Session start is readiness; agent/turn/tool starts and turn end mean Working.
Turn end is not completion. Blocking extension UI start means Needs input, with
no title/text forwarded; UI end observes `ctx.isIdle()` and reports progress or
requests classification without ending the turn. Pi has no universal permission
notification. Foom neither registers a permission gate nor changes decisions.
`agent_before_settle` only copies the enumerated outcome, returning no entries or
continuation; final `agent_settled` classifies completed runs and reports error or
aborted runs as failure evidence. `agent_end` cannot declare idle. Classification
still decides attention and success locally; settlement never directly means Done.

Only constant event names, a bounded conversation ID, boolean idle and an enumerated
outcome are sent. Prompts, tools, messages, UI titles, paths and results are omitted.
The receiver validates these fields, pins the launch conversation and discards the
raw payload through the same reducer as other agents. Node's explicit loopback HTTP
transport uses no proxy, emits no output, and has a one-second absolute deadline;
receiver loss never gates permissions or agent work. MCP exposure refreshes at session start and before new work from the existing
authenticated `whoami` capability list, bounded to 64 KiB and one second. Lookup
failure withdraws the registration; role revocation also takes effect immediately
at the server for in-flight calls. Config/manual and isolated probe attachments
use their fixed minimal tool sets without control-plane discovery. MCP registers through Pi's
normal client with the independent control credential, without writing Pi config.
