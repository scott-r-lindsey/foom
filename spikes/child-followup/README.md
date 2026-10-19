# Child follow-up research (#336)

Checked **2026-10-13, Linux, Node 24.17.0**. Research only; no application adapter
or authorization change. Feeds the open tier proposal [#343](https://github.com/scott-r-lindsey/foom/issues/343).
The recommendation in [the earlier follow-up research](../../docs/research/child-follow-up.md)
was **proposed, not decided** at the time of this spike. The historical Reply gate
and follow-up restrictions are superseded by #629: a granted orchestrator may
send prompts and keys to its own children without per-message human approval.
See the current [child input policy](../../docs/orchestration.md#child-input-629).

## Reproduce

From the repository root after `npm ci`, with the CLIs on PATH:

```sh
node spikes/child-followup/probe.mjs
node spikes/child-followup/probe.mjs --remote-tui
python3 spikes/child-followup/antigravity.py
python3 spikes/child-followup/antigravity.py --live
```

`probe.mjs` uses actual Claude/Codex executables, disposable homes, and a scripted
loopback SSE model. No real provider calls, credentials, user config, repository
content, terminal tails, or transcript-file reads. Only synthetic prompts enter
requests. Per-process dummy authentication and provider overrides point to the
loopback fixture; they do not change the user's credentials. Each agent gets an
actual Git fixture worktree. Git uses the repository's isolated test helper.
Temporary CLI runtime state is removed after terminating the process groups.
The script requires Linux and the repository's existing `node-pty` dependency.
It checks prior prompt retention in every conversation request, session IDs and
results. The remote TUI may also issue a separate title-generation request; that
request does not carry conversation history and is excluded from recall assertions.
It does not test model reasoning: the fixture responds according to the received
history. No command/file tools are exercised.

`--remote-tui` additionally starts a scratch Codex WebSocket listener on loopback
and a real TUI in a pseudoterminal. It asserts old conversation and new response
are rendered while RPC sends the follow-up. **No PTY bytes are written.** The
listener carries synthetic data only and is shut down with the probe. Its
unauthenticated scratch TCP listener is not a production transport recommendation;
Foom should prefer private stdio or a protected local socket, never expose this
full RPC API to an orchestrator. The temporary port reservation has a bind race;
a conflicting listener makes the probe fail, not a supported deployment scheme.

`antigravity.py` defaults to version-only. `--live` explicitly uses the existing
login and ordinary HOME/XDG locations for **three synthetic provider turns**;
expect normal provider usage and CLI conversation/runtime records. No credentials
are copied or changed, no plugin is installed, and no config file is written by
the script. It strips inherited `FOOM_*` variables so the scratch session does not
report into a real Foom session. It uses an empty temporary directory, plan mode,
and the advertised sandbox. It requests no tools and never sends real project
content. It tests a fixed cwd, not Git-worktree metadata. All prompts are constants;
child replies are assertions, never instructions for the next turn.

## Observed results

| CLI | Version tested | Result |
| --- | --- | --- |
| Claude Code | `2.1.296 (Claude Code)` | PASS: two stream turns, concurrent second headless resume, post-exit resume |
| Codex | `codex-cli 0.162.1` | PASS: two RPC turns, restart/resume, concurrent exec refusal, post-exit exec resume, remote TUI rendering |
| Antigravity | `1.3.3` | PASS: two stream turns and post-exit conversation resume with recall |

Claude/Codex base probe made eight scripted model requests; remote-TUI variant
made nine conversation requests (plus optional auxiliary title requests). Antigravity live probe completed all three provider turns. Versions
and help were also inspected; these results establish only these Linux versions.
The scripts print fixed result labels, not provider responses, IDs, or transcripts.

### Claude Code

Launch argv is `claude -p --verbose --input-format stream-json --output-format
stream-json`, with no tools and isolated settings/MCP for the fixture. Keep stdin
open. One NDJSON message per prompt:

```json
{"type":"user","message":{"role":"user","content":"bounded follow-up text"}}
```

Wait for `type: result`; check `is_error` and the returned `session_id`. Both turns
retained the original prompt. `--resume ID` after exit retained the same ID and
history in the same Foom-owned worktree; no `--fork-session` or `--continue` selector
is needed. The worktree persists because Foom chooses cwd, not because the
stream protocol creates one.

A second headless process resumed the same ID successfully **while the first
remained alive and idle**. Thus this interface does not enforce one writer; the
first process may have stale in-memory history. We did not race simultaneous turns
or establish transcript consistency under competing writers. Do not use this as a
sidecar for an existing TUI. Stream stdout is protocol data, not a terminal UI.
Human visibility needs a main-owned structured view, then exclusive stop/resume
into `claude --resume ID` in the terminal tile. Actual interactive handoff, trust,
and tool-permission routing were not tested. Help's background `--bg`/`attach` and
Remote Control features are separate interfaces; they were not exercised and do
not establish an input path to an arbitrary existing PTY session.

[CLI reference](https://code.claude.com/docs/en/cli-reference) documents the flags;
[programmatic usage](https://code.claude.com/docs/en/headless) documents result
streaming, resume and permission-host behavior. Plain user messages must not be
confused with SDK control responses or permission decisions.

### Codex

The app-server accepted newline-delimited RPC on private stdio: `initialize`,
`initialized`, `thread/start`, then two `turn/start` requests. Each input was only
`[{"type":"text","text":"bounded follow-up text","text_elements":[]}]`.
`turn/completed` returned `completed`; both agent messages and model request
history matched the synthetic word. Thread ID and cwd persisted across app-server
termination and `thread/resume`. Approval policy was `on-request`, sandbox
`read-only`; no bypass or automatic approval was added.

`codex exec resume --json ID -` with stdin prompt text was rejected with exit 1
and **already has an active writer** while the idle app-server held that thread.
After app-server exit it succeeded with the same ID and history. This is a useful
serial compatibility fallback, but cannot inject work beside the existing TUI.
Exec does not provide the same interactive approval-host UX as app-server.

An important separate path **does work locally**: `codex resume ID --remote
ws://127.0.0.1:PORT --no-alt-screen` attaches a TUI to the **same** app-server.
It rendered saved conversation; a subsequent RPC turn completed and its response
rendered while the TUI stayed alive. This is one shared runtime, not two independent
thread writers. It can retain the terminal tile while main brokers follow-ups.
This experiment did not type into the TUI, test concurrent human input, exercise
approval requests, or demonstrate that the TUI is read-only before takeover.

The [app-server reference](https://learn.chatgpt.com/docs/app-server) describes
thread/turn RPC, interrupts, distinct approval requests, remote TUI attachment and
experimental transports. Installed help advertises Unix-socket remote endpoints
as well. Unix sockets, authentication, disconnected-client approval ownership,
Windows/macOS and managed policy were not tested. No daemon start/install or global
configuration command was run. Do not infer production readiness from this probe.

### Antigravity

Installed help and [headless documentation](https://www.antigravity.google/docs/cli/headless/)
now advertise a long-lived NDJSON input mode, rather than output streaming only:

```json
{"event":"user","message":{"content":"bounded follow-up text"}}
```

Two turns returned the same `result.conversation_id` and recalled the synthetic
word. After closing stdin and waiting for exit 0, `--conversation ID` resumed it
with the same ID and recall in the same cwd. A real backend completed these turns;
this was not a scripted-model test. Stream mode implicitly enters print mode.
The observed protocol is different from Claude's (`event`, not `type`).

No invocation-scoped permission-response/control protocol or local app-server was
found in inspected help/docs. Remote-control daemon commands exist, but we did
not start or modify one; they do not establish a local prompt API. A structured
conversation view plus exclusive post-exit `agy --conversation ID` terminal resume
would be needed. Concurrent TUI/stream writers and interactive takeover were not
tested. The earlier [#249 probe](../../docs/agents.md#antigravity-conversation-resume-249)
observed unknown IDs silently start a new conversation with exit 0: an adapter
must compare the actual ID before accepting continuity, and never automatically
continue a mismatch. The new probe used only known IDs.

## Boundaries and failure cases

- A prompt turn is different from a reply to an active question, tool approval,
  credential request, RPC method, keypress, or command. The parent receives only a
  narrow Foom `follow_up` capability, never CLI stdin, arbitrary RPC, config,
  model/sandbox/approval overrides, session selectors, attachments or control frames.
- Main must enforce exactly one writer per child, actual protocol idle state,
  no pending approval/elicitation/question/background work, an expected revision,
  pinned conversation ID, canonical worktree and parent generation. A Done light,
  missing hook, quiet screen or idle PTY is insufficient. Unsupported adapters refuse.
- Bound text in UTF-8 bytes (proposed 16 KiB); reject control characters (including
  ESC, CR/LF, C1), slash-command prefixes and unknown fields. Serialize text as JSON
  data or exec stdin, never shell argv interpolation or terminal input. CLI protocol
  output is untrusted and also needs byte/event limits, schema checks and rendering
  as text. Size bounds alone do not prevent harmful instructions in valid prose.
- Retain ordinary child permissions. Pending approvals go to the human only; a
  follow-up cannot answer or clear them. No `never`, bypass, allow-all-tools or
  permission suppression setting is a substitute for human approval routing.
- #303 revoke/transfer/parent exit, takeover and #343 expiry must invalidate queued
  turns and recheck authority at dispatch under the same child lock. A sent prompt
  cannot be recalled; record its accepted turn and transfer it to human ownership.
  For takeover, interrupt explicitly if requested, await resolution/exit before
  replacing a runtime, and keep pending approvals human-visible. Failed interruption
  or lost delivery acknowledgment is indeterminate, not a reason to resend.
- Persist intent/idempotency before send. Busy, unknown/mismatched ID, moved/deleted
  worktree, provider stall/capacity, malformed protocol, oversized output, process
  exit, approval wait and failed audit writes stop automation. No automatic retry
  with a fresh key or fallback to PTY. Background work and user typing races need
  implementation tests; they were not proven by the constant-text probes.
- Child output can say “retry”, request elevated access, or propose instructions to
  another child. Never loop output back automatically as a new prompt. Redact/bound
  any explicit parent observation, mark it untrusted, and preserve the existing
  privacy disclosure. Budgets, expiry, rate limits and stall detection cap an
  adversarial parent/child loop even when every prompt is syntactically valid.

## Recommendation

Prototype **Codex app-server with a shared remote TUI first**, behind per-version
capability probes and the separately approved #343 follow-up grant. Preserve the
terminal tile and independent shell; main owns RPC and arbitrates TUI input with
Take over. This is a runtime integration project, not a new PTY write method.

Keep serial `exec resume` as a compatibility experiment after exclusive exit, not
an invisible sidecar. Claude/Antigravity support real structured continuations but
need a structured child view and verified terminal handoff before enablement.
Existing PTY children remain unsupported for unattended follow-ups. Approval UX,
revocation races, crash recovery and all supported platforms are implementation
acceptance work; none is authorized by this research PR.
