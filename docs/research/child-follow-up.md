# Giving an orchestrator child a follow-up turn

Research for [#336](https://github.com/scott-r-lindsey/foom/issues/336), checked
2026-10-14. **Historical proposal, superseded by #629:** the current
[child input policy](../orchestration.md#child-input-629) allows the granted
orchestrator to send prompts and keys to its own children without per-message
human approval, including permission and provider prompts. The idle-only,
question-only and separate-grant restrictions below describe the earlier research,
not current Foom behavior. See also the [recorded spike](../../spikes/child-followup/README.md).
No application code was changed, real agent CLI (including help) or session was
run, agent account was used, global configuration was changed, or real-agent probe
was executed for this write-up. Public docs are moving
references, not proof that a locally installed version implements their interface.

## Problem and evidence

#336 distinguishes a new task from an answer to a question. At the time of this research, `reply` proposed
an answer to a classified question for human review; it cannot reopen a finished
task. The issue records a capacity stall on #322 and cold children/worktrees for
review and merge-conflict fixes on #319/#322 during 2026-10-12/13.

The task brief supplies another example: an orchestrator could not send a review
change to the finished child on [PR #447](https://github.com/scott-r-lindsey/foom/pull/447)
and made the change itself. The public record independently establishes the
[review finding](https://github.com/scott-r-lindsey/foom/pull/447#issuecomment-6179816260)
about agent-triggered macOS activation and the PR body's orchestrator update at
`0423ba9`, restricting activation to human-started quit. The public record does
not establish the failed delivery mechanism; that part remains task-brief evidence.
Keeping the original child's context would have helped, but no follow-up grant
should imply permission to merge or approve a security change.

[The #343 discussion](https://github.com/scott-r-lindsey/foom/issues/343)
proposes human-granted, time-boxed unattended capabilities. Its
[2026-10-14 comment](https://github.com/scott-r-lindsey/foom/issues/343#issuecomment-6178867798)
reports child CI failures unnoticed until the human intervened. Its
[correction](https://github.com/scott-r-lindsey/foom/issues/343#issuecomment-6181570446)
(2026-10-15 UTC, still October 14 in America/Los_Angeles) says `wait_for` already
wakes for required-check changes. Remaining gaps are the 30-second wait ceiling,
coverage limited to PRs bound to live children, and missing draft/readiness and
mergeability. Better notifications improve observation; they grant no task,
approval or merge authority. The proposed tier names and presets are unresolved,
so this research requires an explicit follow-up capability rather than assuming
the existing orchestrator role already includes it.

## Candidate mechanisms

The following are documented interfaces or existing measurements, not new tests.
An idle live process and an exited process need different delivery paths. Neither
a Done verdict nor a Stop observer establishes that new input is safe.

| Agent / mechanism | Documented task path | Recorded evidence and limits | Product fit |
| --- | --- | --- | --- |
| Claude Code stream input | Print mode with `--input-format stream-json` and `--output-format stream-json`; resume an explicit ID | Spike: 2.1.296 on Linux retained history across two turns and post-exit resume; simultaneous headless writers were allowed | Structured child view and exclusive terminal handoff; no invisible sidecar beside a live TUI |
| Codex app-server | `thread/resume` then `turn/start` with text input | Spike: 0.162.1 on Linux retained ID/history/cwd; a remote TUI rendered an RPC follow-up | Preferred prototype: main owns one runtime, terminal tile attaches to it |
| Codex non-interactive continuation | `codex exec resume <SESSION_ID>` with a new prompt | Spike: refused an active app-server writer, succeeded after exit | Serial fallback experiment only; approval and takeover UX unverified |
| Antigravity stream input | NDJSON stdin and explicit `--conversation ID` on restart | Spike: 1.3.3 on Linux retained recall; #249 showed unknown IDs silently create a new conversation | Structured child view and exclusive terminal handoff; no verified local approval-control API |
| Copilot programmatic resume | `-p` with explicit `--resume=SESSION-ID` | Repo records only 1.0.95 help/version, no continuation session | Unverified serial candidate; keep disabled pending measurements |

### Claude Code

The [CLI reference](https://code.claude.com/docs/en/cli-reference) documents print
mode, stream input/output, `--resume`, and replayed user-message acknowledgments.
Use a pinned ID; `--continue` selects recent history rather than proving child
identity. Queued stream messages can start later turns, so Foom must own admission
and send at most one accepted task at a time. The
[programmatic guide](https://code.claude.com/docs/en/headless) documents session
continuation and tool permission choices; output streaming alone does not provide
a human approval UI. A text message must never become a permission response.
The guide describes permission hosts through an SDK callback or
`--permission-prompt-tool` MCP tool. This is an approval-host candidate, not an
MCP task inbox; its Foom integration is unverified. With no host, print-mode
requests needing approval are denied. Do not suppress prompts or auto-approve
tools to substitute for the human route.

The recorded spike, rather than public flags alone, establishes multi-turn history
for the measured release. Its simultaneous writer result makes main-owned
exclusivity essential. A stream child would replace the agent display with a
structured view, retaining an independent worktree shell. Human takeover must
stop the stream runtime, await exit and resume the same ID in a terminal. That
handoff and safe approval routing remain unverified.

### Codex

The [app-server reference](https://learn.chatgpt.com/docs/app-server) documents
initialization, thread resume, text turns, completion events and interruption.
Approval requests and user-input/elicitation requests are separate server requests.
Its turn API can also override cwd and policy, so parents must receive only Foom's
narrow operation, never raw RPC. Main fixes those fields and routes decisions to
the human. Unknown request types suspend automation. Active-turn steering is
outside this idle/finished-child proposal.

The spike's shared remote TUI result supports retaining the terminal tile. It
does not prove the TUI is passive or that approval ownership survives disconnect.
Before enabling dispatch, main must arbitrate every human input path through Take
over and use a protected local connection. Private stdio suits a runtime without
an attached TUI; an unauthenticated loopback full-RPC endpoint is unsuitable.
The public reference labels app-server/WebSocket transport experimental and
unsupported for production workloads; the recommendation is a gated prototype.

The [non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode)
documents `exec resume` with an explicit session ID and JSON event output. Use
that only after exclusive runtime exit; avoid `--last`. Do not replace interactive
approval with `never` or a bypass flag to make a batch task finish. If ordinary
permissions cannot be served safely, the candidate stays unavailable. CLI resume
does not itself preserve Foom child ownership, concurrency budgets or launch
credentials; main must supply those checks again.

### Antigravity and Copilot

Antigravity's [headless guide](https://www.antigravity.google/docs/cli/headless/)
documents a continuous conversation process using stream input, one result per
turn and the `event: user` envelope. It differs from Claude's `type: user`
envelope. The repo's earlier measurements establish known-ID resume but also
unknown-ID replacement. Compare the returned ID before accepting continuity;
exit zero is insufficient. Approval control, competing writers and terminal
takeover remain unverified. The existing opt-in lifecycle plugin is an observer,
not authorization to install a task-delivery plugin or edit global configuration.

Copilot's [public CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
documents programmatic prompts and explicit resume selectors. Its matching can
include names/prefixes, and `--session-id` can create a new session for a missing
UUID. Foom should supply only a full pinned ID and verify the returned identity.
The repo's v2 draft keeps Copilot hook/MCP verification false. Public documentation
does not fill those measurement gaps or prove safe concurrent continuation.

## MCP tasks and hook-delivered prompts

MCP is useful as the **parent-to-Foom request interface**, independent of the
child runtime. An authenticated `follow_up` tool could call main's service; main
then delivers through a verified structured adapter. An MCP tool result containing
task text is only data returned to an already calling client. An idle/exited child
does not necessarily call another tool to fetch it.

The [MCP prompts specification](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
defines client retrieval of user-controlled templates. A changed prompt list is
not a standard command to begin a turn. The
[sampling specification](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
allows server-requested generation under client control and recommends human
oversight. It does not establish continuation of a particular CLI conversation or
Foom worktree. A cooperative task-inbox tool is possible research, but needs a
documented wake-up facility, authenticated delivery/acknowledgment and bounded
waits. Polling inside a still-running agent turn is neither an exited-child resume
nor proof that a new user task was received. No such idle wake-up contract was
verified here for these clients.

Claude's [hook reference](https://code.claude.com/docs/en/hooks) documents
context injection at lifecycle points and Stop feedback that can continue a
conversation. A Stop hook could consult an authorized queue before stopping, but
it cannot fire after the process has already exited, and later arrivals need a
separate wake-up. A prompt-submit hook also requires a submitted prompt first.
Permission hooks are decision interfaces, never task inboxes. Hook-driven
continuation risks loops, stale tasks and altered completion semantics.

Foom's existing observers intentionally return no decisions (or the fixed empty
response). Changing them to emit work would change a decided security boundary
and their reviewed ABI/trust definitions. The Codex recorded hook measurement
shows definition changes require review; it does not establish a safe task-injection
contract. No Antigravity or Copilot hook wake-up was verified. Prefer a separate
structured runtime channel; preserve observer-only hooks across all providers.

## Authority, provenance and safety

The transport must distinguish **new task**, **question answer**, **permission
decision**, **credential input** and **protocol control**. Follow-up grants only
the first. Reject when any question, approval, elicitation, background work or
queued input remains unresolved; normal child permissions stay unchanged. Current
That proposal retained the human reply gate; #629 replaces it with scoped child
input authority, including permission decisions.

Main authenticates the current parent and checks repository, own-child relationship,
invocation, canonical worktree, pinned conversation, expected execution revision
and the separately human-granted capability. Grant review happens in trusted Foom
UI, with scope, expiry and finite budgets. Neither manifest approval nor model,
hook, child or PR output raises a role. No grandchildren or merge permission are
added. Revalidate all gates under the same ownership lock immediately before send.

Retain the existing proposed request: child ID, expected revision, idempotency key
and nonempty prompt of at most 16 KiB UTF-8. Reject unknown fields, control bytes,
CR/LF, ESC/C1 and slash-command prefixes as the current proposal requires. Main
selects paths, IDs, transport and fixed argv; serialize prompt data once. Never
interpret it as a shell string, CLI flags, attachments, method name or PTY input.
The framing newline in NDJSON is generated by the serializer, not prompt text.
These bounds do not make valid prose trustworthy.

Every turn carries main's fixed provenance line,
`Task from your Foom orchestrator (another agent, not the user):`, and main-owned
operation/parent identity visible in the child view. This preserves origin even
where a CLI encodes the text as a user message. It is not a claim of human consent
to the contents. Child output and review text remain untrusted evidence; never
automatically feed output back as a task. Credentials stay environment-only and
launch-scoped, absent from renderer, argv, generated task text and logs.

Persist intent/idempotency before delivery; record fixed outcomes and accepted turn
IDs without prompts/transcripts. A lost acknowledgment is indeterminate, not a
retry with a new key. Revoke, expiry, parent exit and Take over cancel unsent tasks.
Accepted work remains visible and becomes human-owned; revocation cannot undo it.
Interruption requires acknowledgment; replacement writers require confirmed exit.
Restart restores no unattended grant or queued dispatch automatically. Capacity
stalls, identity mismatch, protocol error, audit failure and missing approval UI
stop automation; there is no PTY fallback.

Structured runtime output is also untrusted: bound records/queues, validate schemas
and IDs, escape rendered text, and keep unknown requests human-visible. The renderer
receives typed display state through the sandboxed bridge, never raw process/RPC
or secret capabilities. No terminal tail is sent to a model. A new structured view
must explicitly specify its transient content/privacy contract; the current
metadata-only hook/log contract must not silently become transcript storage.

## Fit with the v2 manifest

Read [agent-plugins.md](../agent-plugins.md) as the schema authority. On this
checkout, `providers/v2.ts` rejects hooks/health declarations as unavailable;
launch/resume/MCP preparation is implemented. `launch.resume` plus `launch.prompt`
describes spawning, not a live turn protocol. `execution`/hook attention is
observation, not proof of admission safety. Do not smuggle task delivery into
`hooks.mapping`, setup actions or preview tool permissions.

A future reviewed schema extension should select an engine-owned, versioned
protocol capability by transport/ABI, with fixed launch/resume templates, identity
and completion mapping, verification gates and supported human visibility/handoff.
Those are design requirements, **not valid v2 fields today**. No `agent === codex`
branches, privileged bundled-only capability names, manifest scripts, arbitrary
RPC templates or downloaded modules. The same approved manifest duplicated under
a different provider ID must behave equivalently. Protocol differences belong in
bounded declarative data or shared reviewed ABI implementations; if a protocol
cannot fit that model safely, extend the common engine rather than add an escape
hatch. Availability and human role authorization remain separate main decisions.

Current launch code in `src/main/agents/providers/{cli-launch,hook-launch,mcp-launch}.ts`
already owns fixed child provenance, private attachments, environment credentials
and cleanup. `hook-receiver.ts` authenticates and reduces untrusted events;
`execution.ts` tracks invocation/revision separately from output. Reuse these
boundaries without treating today's heuristic idle snapshot as protocol-confirmed
readiness. Existing built-in agent-specific implementation is not a pattern for
new follow-up code.

## Recommendation and roadmap-sized steps

Retain the **Codex-first shared-runtime prototype** recommendation. It has recorded
conversation continuation and terminal rendering evidence. Claude/Antigravity
stream runtimes and serial resumes follow only after structured visibility and
exclusive handoff are verified. Existing PTY children remain unsupported for
unattended follow-up; a finished retained child may resume in its original worktree,
but a closed child needs separate adoption/ownership design (#337).

| Proposed step | Dependencies | Acceptance criteria |
| --- | --- | --- |
| Approve capability policy | #343 and its observability prerequisites #339/#340; inspect their live state before implementation | Trusted explicit follow-up grant; expiry/budgets, revoke/Take over and restart rules; no implied merge or bypass grant |
| Specify common runtime/manifest extension | v2 engine/conversion work and policy decision | Closed schema, versioned protocols, approval/idle admission contract, duplicate-provider parity and digest-bound disclosure; unsupported facts fail closed |
| Implement structured runtime host with fixture clients | Accepted common schema | Main-owned process/transport, bounded typed events, pinned identity/cwd, ordinary policy, visible blockers, cleanup; no real agent CLIs in tests |
| Add child follow-up control operation | Policy and runtime host | Own-child-only, revision/lock checks, idempotency/intents, budgets and action log; race tests for revoke/expiry/takeover, disconnect and hostile output |
| Prove shared terminal visibility and human takeover | Runtime host; human measurements below | All input paths arbitrate ownership; protected transport, one writer, human approval routing, failure-visible handoff on all supported platforms |
| Enable measured protocol manifests; expand later | All previous gates | Human version/platform evidence attached; availability distinct from authority; stream/serial adapters remain disabled until equivalent gates pass |

These are proposed issue scopes, not filed issues or permission to implement.
#343 is open. This docs-only work does not start its dependent implementation.
Monitoring subscriptions can be a separate observation improvement and need no
follow-up grant.

## Human-run measurements still required

Use explicitly authorized disposable profiles/worktrees and synthetic tasks; record
CLI versions, OS, fixed assertion results and limitations, never credentials or real
terminal/model content. This research did not run these measurements.

- Can the shared TUI be made passive until Take over, including paste, shortcuts,
  reconnect and second clients? Race human submission against dispatch and confirm
  exactly one accepted turn. Test protected local transport on Linux/macOS/Windows.
- Exercise command/file/network approvals, structured questions, connector
  elicitation and unknown requests. Which client owns each decision after a
  disconnect? Can any turn start clear a pending question? Suspend until these
  cases have a tested human-only route; test managed policy and disabled hooks.
- Does protocol completion exclude background jobs, queued prompts and pending
  approvals? Measure cancel/interrupt acknowledgment, provider capacity failure
  and resume after crash without duplicate work.
- For each serial/stream adapter, verify retained history, exact ID, cwd and policy
  after exit and terminal takeover. Unknown/missing/expired IDs must fail closed,
  including Antigravity's recorded silent replacement of unknown IDs.
- Verify fresh per-launch hook/MCP credentials and any trust re-review during resume;
  ensure observer definitions remain observer-only. Copilot programmatic continuation
  and its approval behavior have no session measurement in this repo.
- Measure revoke/expiry/Take over at every delivery boundary and grant restart.
  Show the human an accepted-but-indeterminate operation without automatic resend.
  Validate prompt provenance in history and the UI without persisting prompt text
  in Foom's action log.
