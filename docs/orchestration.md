# Foom control plane

Research for [#119](https://github.com/scott-r-lindsey/foom/issues/119), checked
2026-10-05 on Linux. This document specifies the complete target. The security and
HTTP foundation is implemented in #152; see the [current architecture](architecture.md#control-plane)
for its exposed methods and storage contract. Read-only MCP is implemented in #153,
the console CLI and pairing in #154, and orchestrators with their children in #155;
reviewed replies (#156) and the full hierarchy and log view (#157) remain. The
original #119 research changed no application code.

## Decision

One main-process control service owns authorization and operations. A Streamable
HTTP MCP server and the `foom` console CLI are thin adapters to it. Attach MCP per
launch to supported agents; use the CLI fallback for Antigravity. Never install
agent configuration, plugins or skills globally or into a repository. MCP server
instructions and tool descriptions explain the workflow and limits.

Only the human grants orchestration, from a running agent session's menu: **Make
orchestrator…** (a trusted confirmation) and **Revoke orchestrator** (#303). There
is no orchestrator launch; any Foom-launched agent session can be elevated,
including one running with bypass permissions. Main permits one active orchestrator
per canonical repository, with a configurable limit of
running children (Settings → General → Concurrent children per orchestrator; default
4, integer 1–16), each in a new worktree in that repository. Children get ordinary
read-only credentials and cannot create grandchildren through Foom. Agent-native
subagents and processes outside Foom are not controlled by this limit.

Per-agent default launch arguments (#164) apply to user launches. Orchestrator
children (#155) must not inherit bypass defaults unless their design explicitly
allows it with its own authorization rules. A user's acknowledgement for manual
launches does not authorize an orchestrator to grant bypass to children.

**Reply finding:** none of the three current PTY integrations proves that a prose
question is still the active input destination when bytes are written. An absent
permission hook is not proof of safety. Ship observation, launch and stop first;
question replies initially require review in Foom. Unattended replies remain
unavailable until a tested adapter can enforce the question/permission boundary.

## Evidence and limits

| Agent | Local version | Observed without model calls | Not established |
|---|---|---|---|
| Claude Code | `2.1.289 (Claude Code)` | Help advertises `--mcp-config`, `--strict-mcp-config`, `--settings`, `--plugin-dir` | Live MCP handshake, policy coexistence, reliable question routing |
| Codex | `codex-cli 0.160.0` | Help and `mcp get --json` accept whole HTTP and stdio server tables via `-c` | Live header delivery, approval callback coverage, question routing |
| Antigravity | `1.2.13` | Top-level and `mcp --help`; no invocation-scoped MCP option advertised | Any supported per-launch MCP attachment or reliable question routing |

Version/help probes ran in the research worktree; Codex parser probes ran in an
empty temporary directory with a temporary `CODEX_HOME`. No model calls, real
terminal tails, global config edits, repository config writes, or MCP installation
commands were used. Windows and macOS were not exercised. Documentation findings
below are distinct from these local observations; implementation must test supported
versions and managed-policy restrictions rather than infer support from a minimum
version alone.

### Claude Code

`--mcp-config` accepts JSON strings or file paths. `--strict-mcp-config` excludes
other MCP configuration, so do **not** use strict mode for ordinary Foom launches:
retain the user's integrations. Use a unique server name per launch rather than
shadowing an existing `foom` entry. `--settings` continues to carry observer hooks.
`--plugin-dir` can load a local plugin for the invocation; a plugin could contain
skills later, but no plugin or skill is needed here.
[CLI reference](https://code.claude.com/docs/en/cli-reference).

Proposed argv fragment, represented as JSON rather than a shell command:

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

When MCP is attached, Foom pre-approves exactly `open_preview`, `list_previews`
and `close_preview` on its random per-launch server through Claude Code's
`--allowedTools`. User default allow rules (including `--allowed-tools`, `=` forms
and variadic/comma-separated lists) are merged into one option with duplicate rules
removed; argument patterns retain their internal spaces and commas. No other Foom
tool is added. This permits view changes without an approval prompt, not broader
file, process or network access. Managed policy and deny rules still win. Codex
needs no corresponding grant; launches without MCP keep their defaults unchanged.
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

Proposed HTTP argv fragment:

```json
["-c", "mcp_servers.foom_launch_id={url=\"http://127.0.0.1:32199/mcp\",bearer_token_env_var=\"FOOM_CONTROL_TOKEN\"}"]
```

The local parser test used `codex -c <table> mcp get foom_probe --json`, once with
`{url="http://127.0.0.1:32199/mcp",bearer_token_env_var="FOOM_CONTROL_TOKEN"}` and
once with `{command="/nonexistent/foom",args=["mcp"],env_vars=["FOOM_CONTROL_TOKEN"]}`.
Both returned exit 0 with the corresponding transport and no `config.toml` written.
The stdio executable was deliberately nonexistent: this establishes configuration
parsing, not connection success. Codex warned that helper aliases could not be
created under `/tmp`; it still returned the effective configuration.

Keep existing hook `notify` attachment and its replacement disclosure separate.
The external completion notification does not expose every approval request;
terminal notifications are a different mechanism. No unattended PTY reply is
justified by a completed turn or missing callback.
[Notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

### Antigravity

The documented CLI MCP setup uses global or workspace configuration. Installed help
lists `mcp add/remove/list/enable/disable`, but no invocation-scoped MCP config flag.
This is a verified absence in the inspected interface, not a claim that no future
version can support it. Do not run `agy mcp add`, relocate HOME, or create
`.agents/mcp_config.json` to simulate per-launch attachment.
[MCP documentation](https://www.antigravity.google/docs/mcp/).

Launch with `FOOM_CONTROL_URL`, `FOOM_CONTROL_TOKEN`, and `FOOM_SESSION` plus Foom's
CLI directory prepended to that process's PATH. Provide short CLI guidance through
the initial prompt, using the documented-in-help `--prompt-interactive` option;
compose it with the user's prompt as data. Ordinary sessions receive read-only
access; an explicitly launched orchestrator gets its main-assigned role. When MCP
becomes verifiably available, the same control API can replace this fallback.

Permissions and sandboxing remain the user's settings. Prompt text is not a stable
permission API; Antigravity remains human-review-only for replies.
[Permissions](https://www.antigravity.google/docs/permissions/).

## Proposed child follow-up channel (#336)

**Proposed, not decided.** This research does not change the Decision or Reply
gate, grant a new capability, or enable unattended PTY writes. Implementation is
separate and depends on the access design in open [#343](https://github.com/scott-r-lindsey/foom/issues/343),
including its observability prerequisites #339 and #340. Reproducible scripts,
versions, detailed results and limits are in the [child follow-up spike](../spikes/child-followup/README.md).

Linux experiments on 2026-10-13 used Claude Code 2.1.296, Codex 0.162.1 and
Antigravity 1.3.3. Claude/Codex used a scripted loopback model and disposable state,
with no provider credentials; Antigravity used three synthetic prompts with the
existing login, without changing credentials or global configuration. No real
terminal content, transcript files or project content was supplied to a model.

| Candidate | Measured continuation | Human visibility and coexistence |
| --- | --- | --- |
| Claude stream-JSON / `--resume ID` | Two turns and post-exit resume retain ID/history in the same Git worktree | A second headless writer was allowed while the first was idle; this does not establish safe TUI coexistence. Needs a structured view and exclusive terminal handoff |
| Codex app-server / `thread/resume` | Two RPC turns and restart retain thread/history/cwd | A TUI attached to the same app-server with `resume ID --remote` rendered both history and a new RPC response, with no PTY input |
| Codex `exec resume ID` | Post-exit continuation retains ID/history | Rejected beside idle app-server with active-writer conflict; serial fallback only |
| Antigravity stream-JSON / `--conversation ID` | Two real-provider turns and post-exit resume retain ID and recall in the same cwd | No shared TUI/control protocol verified; needs structured visibility and exclusive handoff |

**Recommend a Codex-first prototype** with main owning app-server and a terminal
TUI connected to that same runtime. Preserve the terminal tile; the RPC transport
runs beside its display connection, never as a second conversation writer. The
remote transport is experimental. Private stdio is preferred when no TUI is
attached; a shared TUI needs a protected local transport, not an exposed full RPC
endpoint. Main must arbitrate human TUI input through Take over before enabling
parent dispatch. The spike proves rendering/continuation, not that arbitration or
approval routing works. Claude/Antigravity would require a new structured child
view replacing the agent display until an exclusive human terminal resume; retain
an independent shell in the worktree. Do not ship an invisible resume sidecar for
an existing PTY child. None of these adapters is enabled by this proposal.

Proposed `follow_up` accepts only a child ID, expected execution revision,
idempotency key and at most 16 KiB UTF-8 prompt text. Main maps the child to its
pinned conversation and canonical worktree; the parent cannot choose paths,
commands, conversation selectors, attachments, RPC methods, permission responses,
model settings or launch flags. Reject unknown fields, all control characters
(including CR/LF, ESC and C1) and slash-command prefixes. Prompts are serialized
text data, never shell strings or PTY bytes. This capability starts a new turn;
it does not answer a question or approval and does not relax the Reply gate.

Only a separately human-granted follow-up capability under the proposed #343
Unattended tier could authorize dispatch; today's orchestrator role is insufficient.
Require protocol-confirmed idle with no pending permission, credential,
elicitation, question, queued input or background work. A light, screen pattern or
Stop hook is insufficient. Keep child permissions unchanged and route approval
requests only to trusted human controls. Bound and validate protocol events;
render their text safely. An adapter without this approval/idle boundary refuses.

Serialize dispatch, revocation and Take over under main's child ownership lock.
Bind each operation to the live principal object/generation, child invocation,
conversation ID, worktree and expected revision. Recheck authority and #343
expiry/budget immediately before send; persist intent/idempotency first. #303
revoke/transfer/parent exit and Take over cancel unsent turns and permanently end
that parent's child access. Already accepted work becomes human-owned and remains
visible; revocation cannot undo a prompt. Human-requested interruption must await
protocol resolution, and exclusive terminal resume must await old runtime exit.
If handoff fails, keep the child visible and report failure; never start a competing
writer. New launch credentials/hooks must be attached per launch on a serial resume.

Record fixed action/outcome metadata and accepted turn IDs, never prompt text or
transcripts. Lost acknowledgments, crashes and incomplete interruption produce
indeterminate outcomes requiring reconciliation, never blind retry or PTY fallback.
An unknown/mismatched conversation ID fails closed: Antigravity's earlier #249
probe showed that an unknown ID can start a fresh conversation with exit 0.
Provider capacity/stalls (#339), busy states, moved worktrees, malformed/oversized
protocol, process exit and audit failure suspend automation.

Treat child output as untrusted evidence, never an instruction or automatic next
prompt. No output-to-prompt feedback loop is added. Explicit observations retain
existing redaction, bounds and privacy disclosure; main's capability checks,
per-child rate limits and finite turn/launch/time budgets remain necessary even
when prompt text passes validation. This does not constrain agents' existing shell
or filesystem access outside Foom.

Before enabling: test human typing versus dispatch, pending approvals and unknown
elicitation types, background work, busy-turn refusal, same-ID writer races,
revoke/expiry/takeover at every send boundary, stale invocation/worktree IDs,
idempotency after disconnect/crash, malformed protocol, hostile output loops,
managed policy and disabled hooks. Verify actual interactive handoff and approval
visibility for each adapter on Linux, Windows and macOS. The spike did not exercise
these security boundaries, tool execution or human keyboard takeover.

## Transport, packaging and discovery

Choose **Streamable HTTP on `127.0.0.1` with an OS-assigned port**. Main hosts
`/mcp` and a versioned CLI endpoint `/control/v1`; both call the same service.
This avoids spawning an MCP proxy for every agent and lets read-only MCP ship
before the console helper. HTTP is supported by both verified MCP clients.
Stdio `foom mcp` would still need an authenticated local app connection and a
packaged console helper; it is not selected and need not ship as a third adapter.

Authenticate every request, including initialization, tool listing, and stream
reconnection. Reject browser Origin headers and any Host other than the actual
loopback literal and bound port; no CORS, redirects, URL tokens, or nonloopback
binding. An MCP session ID is protocol state, never authorization. Bind it to the
principal and recheck revocation on every request. Initially use JSON responses
and bounded `wait_for` calls rather than an unbounded event stream. Negotiate the
MCP protocol version and reject unsupported versions. Bound headers to 8 KiB,
bodies to 64 KiB, connections to 32, and concurrent calls to four per principal.
[MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The Electron executable is not the CLI runtime. Keep `RunAsNode` disabled and
retain sandbox, context isolation, CSP and asset restrictions.
[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

Package `foom` / `foom.exe` as a **separate console executable**, built from bundled
TypeScript under `src/cli/` with Node 24's single-executable application machinery.
It only parses arguments and calls the API; main still owns git, PTYs and policy.
This is a packaging proposal, not a validated binary. Build and test on each target
OS/architecture; Windows must retain a console subsystem and usable stdout, stderr
and exit codes. It requires no user-installed Node. Include runtime licenses and
integrity/version checks; production signing follows the existing release work.
[Node SEA documentation](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html).

| Platform | Bundled helper and optional PATH setup |
|---|---|
| macOS | Helper inside the app's resources; explicit Install CLI action creates a symlink in a user-selected bin directory already on PATH, or explains how to add it |
| Linux | Helper beside packaged resources; same explicit user-bin symlink flow, with relocation/stale-link detection |
| Windows | Console `foom.exe` in a dedicated app helper directory; explicit Install CLI action adds that directory to the user's PATH and explains that new shells are needed |

Never overwrite an unrelated `foom` command or silently edit shell startup files.
Removal undoes only Foom-owned PATH entries/links. ZIP builds can run the helper by
absolute path without installation. Foom-launched agents receive a process-local
PATH addition, independent of human PATH installation. Package tests must cover
spaces, Unicode paths, moved installations, and execution without system Node.

The app atomically publishes a private discovery file containing only protocol
version, loopback endpoint and random app-instance ID. Validate ownership, file
permissions and endpoint before use; refuse symlinks/reparse-point substitution.
Use a 0700 user-data directory and 0600 file on Unix, an explicit current-user DACL
on Windows. Remove discovery on clean exit; after a crash, an instance handshake
rejects stale metadata. Credentials are never stored in this file.

## Identity and capability model

Reuse the hook receiver's launch identity and lifecycle, **not `FOOM_TOKEN`**.
Mint a separate random 256-bit `FOOM_CONTROL_TOKEN`; hook credentials must never
authorize control operations. `FOOM_SESSION` is correlation only. Main maps token
digests to a principal with immutable role, repository identity, terminal ID,
parent ID and generation. Neither a tool argument nor an environment role flag can
promote it; only main changes a grant's role, when the human makes the session the
orchestrator or revokes it (see [elevation](#elevation-303)). Compare fixed-length digests in constant time; unknown and revoked
tokens produce the same authentication error.

Bind credentials before exposing a session; revoke on spawn failure, exit, removal
and shutdown. No control registration depends on hooks being enabled. Scrub all
inherited Foom credentials before constructing each child's environment, then add
fresh child-scoped values. Never return tokens to the renderer, logs, MCP results
or error text. New Foom instances and resumed sessions receive fresh credentials;
automatic restore may re-grant orchestrator control only from Foom's main-owned session store, when restore is enabled, the orchestrator was active at quit, the same repository identity is still registered and the CLI is a verified Claude Code or Codex release. Hook data, conversation metadata, agent output and environment flags never grant roles. Otherwise the session resumes ordinarily and its panel says the role was not restored. Every re-grant has a new principal generation and token. The verified repository identity is carried into the launch and rechecked before spawning. Tokens, confirmations, replies, waits and in-flight mutations never survive; unresolved persisted operation intents still require human reconciliation.

Restored parents launch before their running, non-taken-over children. Those children keep child launch rules (no user defaults and an orchestrator prompt prefix), count toward the configured child limit, and may be stopped, tailed and waited for by the new parent. Stop returns a conflict while a restored child is still starting; it cannot report success for a PTY that does not exist yet. Taken-over children and children without a re-granted parent resume ordinarily. The active panel and its action history continue without a restore badge.

The parent record also persists owned checkout paths, identities and unused/used
state, plus the uncertain-creation budget. Restore checks the live Git inventory
and identity: only existing Foom-managed linked worktrees in that repository qualify,
never the main checkout. Saved identity mismatches cannot be overridden by child
records. Legacy child records recover ownership from the host's current branch
and identity. Exited children recover used ownership for cleanup without occupying
live child slots. Unused checkouts remain available for their one launch, within
the unused budget; used checkouts remain unavailable for another launch. Starting
launches are saved as used because shutdown may leave their outcome ambiguous.

A CLI invocation with agent credentials uses exactly that scope. It never falls
back to a stronger principal when authentication fails. A person running `foom`
outside an agent starts with no authority: a bounded pairing request shows a
matching code in the CLI and Foom, and the user grants a short-lived,
repository-scoped CLI session in the app. Token delivery uses the pending local
connection; a persistent CLI process holds it only in memory. Scripts receive an
explicit expiring grant through the same UI flow, not a reusable human token file.
Mutating operations still require app-owned confirmations where specified below.
Pairing is rate-limited, expires after 60 seconds, and cannot be approved via MCP.
`foom --validate-config` performs offline schema validation without pairing or
running config content; #84 defines the eventual config-only API role.

This is a capability boundary against unauthenticated clients and accidental
cross-session access, not isolation from hostile processes running as the same OS
user. Such a process may inspect another process's environment or memory. Separate
worktrees are not sandboxes. Do not claim the no-grandchildren or repository rule
constrains arbitrary shell commands an agent can already run outside this API.

### Tools and confirmations

Every request has a validated schema, bounded strings, known IDs, and an explicit
protocol version. Reject unknown fields and cross-repository/foreign IDs. Agent
names select detected enabled executables, never caller-supplied commands. Main
chooses worktree paths and validates branch names and canonical git membership
under the existing launch/removal locks. Git and processes use argument arrays.

| Tool | Principal and scope | Contract |
|---|---|---|
| `whoami` | Every authenticated agent | Own session, role, repository/worktree and capability names; no secrets |
| `sessions` | Every agent, own repository only | Paginated metadata, 100 rows maximum; no output, prompts, arbitrary reasons or environment |
| `session_state` | Every agent, own repository only | State, server-generated reason, revision and attention kind; no terminal content |
| `create_worktree` | Orchestrator | New validated branch/worktree, or adoption by open same-repository PR number; main-owned provenance |
| `launch` | Orchestrator | One ordinary child in its newly created empty worktree; enabled agent and ≤16 KiB initial prompt; no role/permission-policy arguments |
| `tail` | Orchestrator, own child only | Latest 1–40 physical lines, redacted, ≤16 KiB UTF-8 result, no historical pagination |
| `reply` | Orchestrator, own child only | Exact question revision plus ≤4 KiB proposal; gate below, never general terminal input |
| `stop` | Orchestrator, own child only | Graceful stop with existing bounded termination fallback; retains worktree and final screen |
| `remove_worktree` | Orchestrator, own created worktree only | Requests an app confirmation unless Auto-remove merged worktrees is enabled in Settings → General; no force option or deleting branches |
| `wait_for` | Orchestrator, own children only | Up to the configured child limit of IDs, after-revision cursor, timeout 0–30 seconds; returns state metadata or timeout |
| `operation_status` | Orchestrator or authorized human CLI grant, own operations only | Exactly one of operation ID or idempotency key; returns the operation record described below, never child output |

`create_worktree({ pullRequest: N, idempotencyKey })` (#337) uses the #340
forge provider and the user's read-only `gh` login to resolve the PR head. Main
selects `origin`; the API accepts no remote, branch override or path. Both
`isCrossRepository` and `headRepositoryOwner` must establish the selected repository:
a fork is refused even when its branch name also exists locally. Fixed refusal
codes are `forge_unavailable` (no provider or failed lookup/default discovery),
`pr_not_open`, `pr_from_fork`, `default_branch`, `invalid_branch`, `branch_in_use`
and `branch_diverged` (local commits absent from the PR head). Existing branch
validation and remote default discovery precede fetching. Main fetches the validated head with argument arrays and creates a
checkout tracking `origin/<branch>` and sets its branch-specific `pushRemote` to
origin, so plain `git push` targets that PR branch even with another default push
remote.
An existing local branch is fast-forwarded to the fetched PR head when behind,
and left unchanged when equal. Local commits absent from that head refuse adoption
with `branch_diverged`, including a branch ahead of origin; adoption never resets
a branch or discards commits. This also applies to reused checkouts. A checkout
already owned by this orchestrator and still unused may be reused after its
identity and session eligibility are rechecked. Other checked-out branches are
refused. Adopted checkouts count against the four-unused-worktree budget and are
registered with forge tracking by the requested PR number for child session PR
metadata, including when multiple open PRs share a head branch. The console fallback
is `foom create-worktree --pull-request N --idempotency-key KEY`.

Ordinary agents never see orchestration tools in `tools/list`; the service also
rejects direct calls to hidden methods. Config-only tools for #84 are a separate
role, not privileges inherited by orchestrators. #67 remote access is out of scope.
A human CLI grant exposes only its approved operations through the same validators.

Reserve the repository orchestrator slot and child slots atomically before async
work. Count starting and stopping children until exit is confirmed; reject a launch above the configured limit, concurrent second orchestrator, and occupied worktrees. Bound unused
orchestrator-created worktrees to four. Changing the child limit applies at the
next reservation; lowering it never stops existing children, and blocks new launches
until the count falls below the new limit. `wait_for` validates its ID count against
the current setting too. Release reservations on failure;
retain successfully created worktrees for explicit cleanup. Idempotency keys on
mutations return the prior operation result, rejecting reuse with different input;
a timed-out client must query the operation rather than launch again blindly.

Both adapters expose the same read-only lookup: MCP `operation_status` takes
exactly one of `operationId` or `idempotencyKey`; CLI
`foom operation-status --operation-id <id>` or
`foom operation-status --idempotency-key <key>` returns the same JSON record.
Scope both selectors to the authenticated actor's immutable principal generation
and repository, never a caller-supplied actor. Recheck authorization on every
lookup; revoked grants cannot query, and replacement orchestrators do not inherit
records. Unknown and foreign selectors return the same `not_found` response.

The record contains `operationId`, `action`, scoped target/result IDs when known,
`status`, creation/update timestamps and a fixed reason code. Status is one of
`pending_confirmation`, `running`, `succeeded`, `failed`, `declined`, `cancelled`
or `indeterminate`. Human refusal of removal is `declined`; completed deletion is
`succeeded`; a known failure is `failed`. Ambiguous side effects are
`indeterminate`, never reported as a definite failure. Do not include credentials,
prompts, reply text, terminal content or raw exception messages. `wait_for`
continues to report child state only; it does not report operation completion.

Persist the actor-scoped idempotency-key mapping and operation intent before side
effects, so losing the original response does not require knowing its operation
ID. Keep lookup records and deduplication mappings for the grant's lifetime,
independent of action-log rotation or clearing. Bound their storage and refuse new
mutations when full rather than evicting records for an active grant. Lookup never
replays a mutation. A timeout, `not_found` or `indeterminate` result does not prove
that no side effect occurred and must not trigger an automatic retry with a new
key; unresolved outcomes require human reconciliation.

Removal confirmation is tied to the actor, worktree identity and dirty state;
recheck all three before deletion using the existing service. Pending removals from
one orchestrator are reviewed together in a trusted dialog listing each worktree
path, branch, clean/dirty state and changed files. Approve all or selected items;
when the action includes dirty items its button explicitly says **Discard changes
and remove all** or **Discard changes and remove selected**. Dirty rows carry an
amber warning icon and outline as well as the Dirty label. Decline has initial
focus, so Enter never discards changes by default.
Decline (or closing the dialog) declines the batch. Unselected items are declined.
Each operation independently rechecks and completes, so one stale checkout or
removal failure does not stop the others. Poll `operation_status` for each outcome.
New arrivals and per-item cancellation invalidate answers to the older displayed
list and reset selection. An aborted item is declined immediately and leaves the
review; other items remain pending. Aborting every item closes the dialog. No GitHub or forge lookup is used. Pending confirmation
returns an operation ID, so agents cannot hold the HTTP connection indefinitely.
Stopping a child needs no extra confirmation after the user has made its parent the
orchestrator; stopping unrelated sessions is forbidden. Parent exit revokes its
authority and cancels pending mutations/replies, but leaves children running for
the human. Revoking the role has the same effect. A replacement orchestrator does not inherit those children; automatic restore reattaches saved children that had not been taken over, including exited children for worktree cleanup, under the re-grant checks above. Quit keeps
the existing confirmation and stops all PTYs.

### Provider stalls (#339)

`session_state`, `sessions` and `wait_for` report a current provider blocker as
`state: "needs_input"`, `reason: "provider_unavailable"`, `attentionKind: "provider"`.
This single fixed reason covers capacity, rate/usage limits and provider model-switch
prompts; it never includes model names, retry times, error bodies or terminal text.
Provider attention never permits `reply`, including a human-reviewed proposal.
The existing Needs you light is amber and retains its label; short fixed reasons
identify Provider unavailable, Provider rate limit, Provider usage limit or Model switch requested.
No automatic retry, model change or terminal input is performed.

| Adapter | Provider detection | Limits |
| --- | --- | --- |
| Codex | Bounded local screen rules for the reported capacity message, recorded rate-limit error and rate/usage-limit choice screens | Heuristic untrusted evidence, not a structured provider API; uncaptured variants are unsupported |
| Claude Code | Not supported | Current observers expose permission and lifecycle events, not a verified provider-specific signal; no recorded provider screen rule |
| Antigravity | Not supported | Plugin Stop error/step-limit facts indicate failure but do not identify provider capacity or rate limiting; no recorded provider screen rule |

Codex provider screens beat working titles during classification. Permission hooks
and process exit keep their existing precedence: a generic nonzero exit cannot
identify a provider failure. Stale screens outside the rule's bounded bottom region
are ignored; fresh working evidence after the screen clears resumes execution.
Metadata retains existing output/input/execution freshness checks; a changing screen
can briefly report unknown attention until reclassified. Silence is never evidence
of a provider stall. Recorded evidence provenance and the distinction between the
reported capacity line and upstream render snapshots are in
[`tests/fixtures/agent-detection/README.md`](../tests/fixtures/agent-detection/README.md).

## Child PR and required checks (#340)

Main tracks branches only in orchestrator-owned worktrees, choosing a read-only
forge provider from the repository's origin URL (or its sole remote). GitHub on
`github.com` is supported first, through the user's existing `gh` login. Unknown
hosts, missing or logged-out CLIs and unavailable/malformed PR results omit PR
metadata; they do not fail a control request. Unavailable check results preserve
verified PR fields with an `unknown` conclusion. No additional opt-in is required by
the 2026-10-13 decision. GitLab and enterprise hosts await providers.

The provider's branch lookup is reusable by #337. It runs only fixed `gh pr list`,
`gh pr view`, `gh pr checks --required` and read-only `gh api graphql` queries
with execFile argument arrays,
explicit repository selection, disabled prompts, 10-second command deadlines and
256 KiB output limits. Initial discovery requires one unambiguous open PR with a same-repository head:
`isCrossRepository` must be false and `headRepositoryOwner.login` must match the
selected repository owner (case-insensitively), as for PR adoption. Missing ownership
or a fork head is refused, including on bound lookups and the final recheck. A closed PR from an older
use of the same branch cannot claim a newly created worktree. The same open lookup
is reusable by #337. Once
bound, its number is used to follow OPEN, CLOSED and MERGED states. Output is
untrusted: main exposes only a positive PR number, a 40-character head SHA, the
fixed state and `requiredChecks` (`pending`, `success`, `failure`, `none`, `unknown`). Cancelled
checks count as failure; skipped checks count as success; an empty required-check
set is `none`. gh's exit-1, empty-stdout diagnostic for no required checks (or
no checks at all) is recognized only for the required-check command with a validated
branch name; arbitrary empty output, unsupported flags and other failures still use
the fallback. Main rereads the PR head after checks and suppresses a sample if a
push or state change raced it. The forge's required checks, including Quality gate
when configured as required, determine the conclusion; optional checks do not.

Compatibility fallback (#374): `gh` 2.45.0 (Ubuntu 24.04's package) supports PR
metadata but lacks `pr checks --json`. If that command fails, main reads the PR's
validated GraphQL ID with `pr view --json id`, then sends a fixed GraphQL query
through `gh api graphql --hostname github.com`. It reads the head commit's status
rollup and each CheckRun/StatusContext's `isRequired(pullRequestId: ...)`, the same
required-check discovery used by gh 2.45 itself. Only required contexts contribute;
neutral/skipped checks count as success, cancelled/failed/error/timed-out/action-required
checks as failure, and unfinished checks as pending. The queried commit must match
the sampled head. No branch-protection write or additional admin permission is needed.

The fallback bounds its rollup to 100 contexts and refuses a partial page rather
than guessing from incomplete data. A null status rollup on the verified head commit, an empty complete context page,
or only optional contexts yields `none`. Missing rollup fields, invalid/unknown states,
GraphQL errors, denied/rate-limited calls and malformed check JSON yield `unknown`.
This contract addition is persisted and exposed like the other conclusions;
`unknown` is neither success nor proof that no checks are required. A verified PR
with unknown checks refreshes at the normal 30-second interval and changes session
revisions when its conclusion recovers. The final PR head/state recheck is required
for every conclusion, including `unknown`. Newer gh versions keep the existing
`pr checks --required --json bucket` path. No minimum-version upgrade is needed
for the tested 2.45.0 fallback. Read-only verification for #366 on 2026-10-13:
`/usr/bin/gh` 2.45.0 rejects `--json` and PR #1 in this repository returns exit 1,
empty stdout and `no required checks reported` with `--required`. The
[current manual](https://cli.github.com/manual/gh_pr_checks) documents the newer
JSON buckets and pending exit code; the
[current implementation](https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go)
returns the no-check diagnostic before JSON export.

`sessions`, `session_state` and `wait_for` include an optional `pullRequest` object.
Its validated fields participate in the session revision, so `wait_for` wakes on
check-conclusion changes as well as child state. The existing 30-second wait bound
and child-ownership checks remain. Reviewed replies validate the full caller cursor
initially, then bind to the terminal revision: a forge update cannot cancel a
human review, while terminal changes still do. A new generation can read previous children's
mapping through repository-scoped session metadata, without gaining stop, tail or
wait authority over those children.

Successful observations are refreshed every 30 seconds. Unavailable results or
branches without a PR back off to 60, 120, 240, 480 and at most 600 seconds, resetting
to 30 seconds on success. Polls process one worktree at a time with at least one
second between samples; there are no overlapping processes or catch-up bursts.
Large sets therefore take longer. A failed/rate-limited PR metadata call is treated as
unavailable and receives this same backoff; a check-only failure yields `unknown`
without hiding verified PR metadata. Tracking is bounded to 1,000 worktrees.
Main checks managed-worktree identity and branch before each sample; removal or
replacement retires the observation. Polling ends at app shutdown.

A private, atomically written `control/forge.json` stores checkout identity, branch,
remote and the narrowed PR mapping separately from launch grants. It survives app
restart, parent exit and a new orchestrator generation; saved data grants no
capabilities and remains absent from public metadata until ownership and the forge
result have been checked again. Local worktree paths and identities never enter
MCP results. The CLI contacts GitHub using its own authentication and sends only
repository, branch/PR identifiers and read-only status requests. Foom stores no
tokens, makes no forge writes and sends no terminal content. No terminal/model
output is used to discover PRs.

## Reply gate

The `reply` request names a child `id`, the `revision` and `verdictId` from
`session_state`, an `idempotencyKey`, and `text`. The console spelling is
`foom reply ID --revision REVISION --verdict-id VERDICT --idempotency-key KEY
--text TEXT`. It creates a pending human review; use `operation_status` to
observe the result. It never accepts an approval or unattended-delivery flag.
The trusted Foom dialog shows fresh, redacted child context and the exact
proposed text. Terminal output is untrusted data in this dialog, too.

Current Claude Code, Codex and Antigravity PTY adapters have no verified atomic
question-specific routing, including versions with lifecycle hooks. Disabled
or delayed hooks cannot improve this guarantee. Screen patterns can distinguish
attention for review, but cannot authorize unattended input. A silent PTY mode
switch can occur while a human reviews a proposal; the dialog discloses this
remaining race. Approval policies and per-launch agent settings are unchanged.

Proposals also bind to the live principal object: changing a role invalidates
them even when its token and generation stay the same. Terminal activity makes
the last classified attention stale until a fresh classification. The child
panel's **Reset reviewed replies** command resets the three-send budget and
cooldown, cancels pending review, and preserves the one-proposal-per-verdict
limit. **Take over** permanently ends the parent's access to that child.

Add an attention kind independent of the visible light:
`question`, `permission`, `credential`, `provider`, or `unknown`. Today `needs_input` and model
confidence do not carry this distinction; neither can authorize `reply`.
Permission hooks, `(y/n)`, Allow/confirm prompts, password context, and uncertain
cases remain human-only Needs you (amber plus a label). Echo-off alone does not
classify a credential prompt. A model may suggest `question`, but cannot grant a
terminal-input capability. Treat all hook and model data as untrusted evidence.

For current adapters, `reply` can only create a **proposal** for a question verdict.
Show the child, fresh context and exact text in Foom; do not send bytes automatically.
If permission, credential, provider or unknown evidence appears, reject the proposal and
focus the terminal for the human. Approval of a proposal is a human action, not an
orchestrator permission decision. It is not advertised as eliminating the race
between review and a changing PTY. The human can always take over directly.

Any future automatic adapter must prove a question-specific input channel, or an
equivalent atomic routing guarantee that cannot feed a permission prompt. A PTY
write serialized in main is insufficient: the agent can change its input mode
before emitting output. Test this explicitly before enabling automatic replies
for any agent/version. Do not weaken agent approval policies to obtain the guarantee.

Bind a proposal to child ID, principal generation, verdict ID and output/input
revision; invalidate it on output, input, dismissal, permission signal, exit,
parent revocation or takeover. At send time recheck all gates, consume a single-use
reply ID, and record the operation before writing. Reject control characters,
Escape, CR/LF and slash-command prefixes in the first implementation; send one
plain-text line with one submit through the tested adapter. A transport failure
after writing is an indeterminate result, never an automatic retry.

Limit to one proposal per verdict, one sent reply per child per ten seconds and
three replies per child before human reset. Repeated questions or no progress
suspend replies and leave Needs you visible. **Take over** cancels pending proposals
and disables further orchestrator replies until the user explicitly resumes them.
An optional review-every-reply preference will remain even if a future adapter
qualifies for automatic delivery; it is mandatory with today's adapters.

## Output, privacy and visibility

`tail` reads only the child's headless screen through main's existing host client,
without attaching a view or pausing a hidden terminal. Apply the evaluator's
`prepareTail` redaction before final line/byte truncation; oversize input fails
closed. Rate-limit to one snapshot per child per second. Return structured data
with child ID, revision, timestamp, truncation flag and `untrusted: true`, and a
fixed instruction that contents are data, never requests to run commands or change
policy. Marking data does not solve prompt injection; capability checks remain
mandatory. Redact and bound user-controlled metadata too.

No file, diff, transcript, keystroke, raw hook or unlimited scrollback endpoint is
added. Terminal output can itself contain file contents, diffs or echoed input;
redaction is heuristic. Tails returned to an orchestrator can go to **that agent's
model provider**, independently of the evaluator's configured provider. Repeated
bounded reads can accumulate substantial output. Disclose this at orchestrator
launch and in [product privacy](product.md#orchestration-and-privacy-planned).
Foom's API limits do not restrict the agent's pre-existing filesystem tools.

Every action records an operation ID, actor/parent/child IDs, repository/worktree
IDs, action, timestamp, outcome and fixed reason. For replies retain a bounded
redacted proposal and delivery status, never raw input or tails; initial prompts
are omitted. Store a separate private action log, rotate at 10 MiB, retain at most
five files and 30 days, and support clearing it. Audit intent must be persisted
before mutations; log failure refuses automation but never blocks human terminal
input. Record indeterminate outcomes on recovery rather than replaying operations.

Children appear under their own worktree in the repository sidebar, each with a
small, dim child glyph, a parent-naming tooltip and an independent light. Hover,
focus and selection highlight the parent/child relationship across worktrees.
Parent history stays while children remain; show an exited parent as such.
No view attachment changes are implied by highlighting.
Expose the action log and takeover affordance through the board source. Minimal
action visibility and takeover must ship with mutations; the final UI issue adds
the full hierarchy and searchable log. No silent orchestration period is acceptable.

## Delivery and verification

Implementation issues below are ordered, with explicit dependencies and acceptance
criteria. #113 is closed. #114 (read-only review), #115 (resume), #84 (configuration)
and #67 (remote mirror) remain open; this design reserves their boundaries without
implementing or depending on those features. A reviewer can be a normal child in a
fresh worktree; enforced read-only review remains #114.

1. [#152: Control plane: core API, session authentication and capability checks](https://github.com/scott-r-lindsey/foom/issues/152) — depends on #119.
2. [#153: Control plane: read-only MCP tools and per-launch attachment](https://github.com/scott-r-lindsey/foom/issues/153) — depends on #152 and #119.
3. [#154: Control plane: packaged foom CLI and explicit local pairing](https://github.com/scott-r-lindsey/foom/issues/154) — depends on #153 and #119.
4. [#155: Control plane: launch a repository orchestrator and manage children](https://github.com/scott-r-lindsey/foom/issues/155) — depends on #154 and #119.
5. [#156: Control plane: reviewed question replies and enforceable reply gate](https://github.com/scott-r-lindsey/foom/issues/156) — depends on #155 and #119.
6. [#157: Control plane: sidebar child nesting and action log view](https://github.com/scott-r-lindsey/foom/issues/157) — depends on #156 and #119. Also builds on closed #113.

Before enabling attachment: synthetic HTTP initialize/tools-list/tool-call tests
for Claude and Codex, bearer header validation, existing user MCP coexistence,
managed-policy refusal, disabled hooks, token revocation and no config writes.
Before enabling mutations: cross-role/foreign-ID denial, simultaneous launch and
removal races, idempotency, parent exit, log failure and human confirmations. Test
operation lookup through MCP and CLI after a lost mutation response, by both ID
and idempotency key; cover pending, successful, failed and declined removal,
cancellation, indeterminate outcomes, foreign actors, revocation and record limits.
Before enabling replies: permission/question/password fixtures plus adversarial
mode switches, stale proposals, duplicate delivery, takeover and loop limits;
current PTY adapters must remain unable to auto-send. Before shipping the CLI:
packaged Linux, macOS and Windows console tests with no system Node, stale discovery,
wrong file ownership, pairing expiry and PATH installation/uninstallation.

### Read-only MCP implementation verification (#153)

`node scripts/probe-mcp.mjs` exercises the real CLI clients against Foom's production
HTTP adapter and a synthetic loopback model endpoint. It uses temporary profiles,
synthetic identity only, and no provider credentials or external model requests.
Set `FOOM_CLAUDE_EXECUTABLE` / `FOOM_CODEX_EXECUTABLE` to select an installed binary.
The script requires Linux and `bwrap`; administrator refusal is tested with private
mounts at the clients' system-policy locations, never edits to the host's `/etc`.

Verified on Linux: Claude Code **2.1.293**, Codex **0.161.0**. Both initialize,
list, and call `whoami` with environment-sourced bearer authentication, retain an
existing user-configured server, and refuse servers under a synthetic managed
allowlist denying all MCP. The probe checks the existing server definition is
preserved. Claude may update its own temporary profile bookkeeping. Codex sends
`_meta.progressToken` on listing; the adapter accepts protocol metadata without
passing it to the control service. Hook settings are independent of MCP attachment. The probe also verifies a final
child prompt preceded by `--`, including Claude's variadic `--mcp-config` with
hooks off; the prompt is accepted by both verified releases.

These tested releases establish the minimum supported stable versions: Claude Code
2.1.293 with `--mcp-config` in help, and Codex 0.161.0 with `-c` in help. Later stable
versions with the flag are available too; malformed and prerelease versions, older
versions, missing flags and Antigravity remain unavailable. The probe exercises any
supplied binary without an exact-release assertion.

The **Real CLI MCP probe** CI job (#254) runs nightly even when main is unchanged,
and on manual CI dispatch. Optional `claude_version` and `codex_version` inputs
accept stable x.y.z releases (default `latest`) to reproduce a regression. It installs
both packages into temporary prefixes and logs the validated CLI versions. The
existing temporary homes, loopback model and `bwrap` policy mounts remain in use;
no provider credentials or global agent configuration are used. Child output is
captured privately and discarded. Reports contain only validated versions and
fixed assertion names. A failure fails this independent job and opens or updates
one issue labeled `mcp-probe`; a later green run comments on the same issue.
Closed issues are reopened on regression. The job serializes issue updates, has
issues write and contents read only, and neither publishes nor blocks nightly
packages. Setup/API failures remain job failures; no raw logs are uploaded.

Rechecked for #252 on Linux with installed Claude Code **2.1.296** and Codex
**0.162.1**: authenticated initialize/list/call, existing-server coexistence and
managed-policy refusal all passed, using the same isolated synthetic model setup.

For each attached launch, main waits up to 30 seconds after binding the terminal
for its first successful authenticated MCP request. The session panel shows
**Connecting…**, then **Connected**, or **Not connected** after the deadline.
Not connected is a magenta failure only for orchestrators; ordinary session panels
record it neutrally, without an alert. A later successful MCP request changes it to
Connected. CLI requests and rejected MCP requests do not count. The observation is
bound to the live launch principal and cleared on revocation or shutdown; it is
not a continuous liveness check and is never persisted. Managed policy is still enforced by the client and
can deny an otherwise supported attachment; Foom does not override that policy.
Windows/macOS real-client policy probes remain unverified. The packaged CLI fallback
remains #154; this change does not promise a fallback executable before it exists.

### Console helper and local pairing (#154)

`foom` is a Node 24 SEA under `resources/app.asar.unpacked/build/console/`
(`Contents/Resources/` on macOS), separate from Electron's executable. ZIP users
can call its absolute path. `--version --json` reports application and protocol
versions; Node's runtime notices and a SHA-256/version manifest accompany it.
The build bundles only console and shared Node utilities, injects the SEA on the
build platform, disables runtime argument extension (including `NODE_OPTIONS`),
and ad-hoc signs the macOS helper. Electron's fuses remain unchanged.

Online commands are `whoami`, `sessions [--limit N] [--cursor ID]`,
`session-state ID`, and `operation-status --operation-id ID` (or
`--idempotency-key KEY`). Orchestrators also have the commands below; each maps
to the same control API used by MCP. Main's existing API decides authorization; ordinary
agents and human CLI grants cannot query orchestration operations. Responses use
stable `{result}` / `{error}` envelopes; `--json` also makes offline output JSON.
Exit status is 0 for success, 2 for usage/schema errors, 3 for authentication or
scope denial, and 4 for unavailable services, capacity, not-found or I/O errors.
No exception text or credentials are printed. Responses are bounded to 256 KiB,
including full 100-session pages with Unicode names; pairing responses are limited
to 4 KiB.

Orchestrator commands (all support `--json`):

```text
foom create-worktree BRANCH --idempotency-key KEY
foom launch WORKTREE_ID --agent claude|codex|agy [--prompt TEXT] --idempotency-key KEY
foom stop ID --idempotency-key KEY
foom close ID --idempotency-key KEY
foom remove-worktree WORKTREE_ID --idempotency-key KEY
foom tail ID [--lines 1-40]
foom wait-for ID... [--after '{"ID":"REVISION"}'] [--timeout-ms 0-30000]
```

The four mutations require an idempotency key. After losing a response, query
`operation-status --idempotency-key KEY`; reusing a key with different input is
refused. Removal still needs the trusted app confirmation. `tail` retains secret
redaction, the 40-line/16 KiB cap and one request per child per second; `wait-for`
accepts one to the configured child limit of distinct IDs and waits at most 30 seconds. The console gives
that wait a 35-second transport deadline. Arguments are validated in both the
console and main. Tokens are never accepted as arguments or printed. Ordinary
sessions, children (including taken-over children), and human pairing grants
cannot mutate or read child output through these commands; denial is exit 3.

Human invocations add `--repository ABSOLUTE_REGISTERED_PATH` and optionally
`--profile ABSOLUTE_PROFILE_PATH` (needed for Foom Dev or custom profiles). Without
inherited credentials, Foom displays the same eight-hex-digit code as the console
in its trusted confirmation window. Approval grants only repository session metadata
for ten minutes. The request expires after 60 seconds; disconnect, shutdown,
rejection and removed registration refuse it. One request can await review,
requests are spaced by ten seconds, and at most four human grants are live.
The token is delivered over the pending connection, held only in console memory,
and released on completion or expiry. Discovery has no credentials. Ordinary
commands pair for one invocation; `foom pair --repository PATH --json` keeps one
process open and reads JSON argv arrays, one per line, for scripts or interactive
use, for example `["sessions","--limit","10"]`. No shell or arbitrary program is
executed. Any inherited session scope, including invalid or partial credentials,
prevents a fallback to pairing or another profile.

On Unix, `foom --install-cli /absolute/bin` creates an exclusive symlink and an
ownership record; `--uninstall-cli /absolute/bin` removes only the recorded link,
including a stale link after moving the ZIP. Existing commands and changed links
are refused. Foom does not edit shell startup files. On Windows, invoke the helper
by absolute path with `--install-cli` to add its dedicated directory to the user's
PATH; `--uninstall-cli` removes only its recorded entry, including the old entry
after moving the installation. Both actions broadcast the Windows environment
change so newly opened shells can inherit it. Existing shells must be reopened.
Unrelated PATH entries and registry value kind are retained. Foom-launched agents
get a process-local PATH addition independently of human installation. Antigravity
with `--prompt-interactive` support receives CLI guidance composed with initial
prompt data; no MCP configuration is installed.

`--validate-config PATH` is reserved for #84's offline, non-executing schemas.
Until those schemas ship, it returns `config_schema_unavailable` and exit 2,
without reading the path, pairing, opening a window, or accessing profile data.
#84's earlier Electron-based console recipe is superseded by this standalone
helper; its validation schemas and config-only capabilities remain #84's work.

### Orchestrators and children (#155)

**Launch.** Superseded by [elevation](#elevation-303): the repository panel's
orchestrator launch and the disabled New orchestrator menu item were removed. As
#155 shipped them, the panel listed **Launch <agent> as Foom orchestrator…**, which
launched an agent in the main checkout with an orchestrator grant and a prompt
naming the CLI and MCP tools. Every agent still gets the console directory on its
process-local PATH, and the CLI works when MCP attachment is unavailable or denied
by client policy. Antigravity uses only the CLI, without any MCP configuration.

**Tools.** Every mutation takes an `idempotencyKey` (`[a-zA-Z0-9_-]{1,200}`) and
returns the operation record. Limits and foreign targets are recorded as
`failed`/`refused` and then rejected (`capacity`, `conflict` or `not_found`), so a
retry with the same key returns that record.

| Tool | Parameters | Result |
|---|---|---|
| `create_worktree` | Exactly one of `branch` or `pullRequest` | New local branch, or continue an open same-repository PR; `resultId` is the opaque worktree ID |
| `launch` | `worktreeId`, `agent` (`claude`, `codex`, `agy`), optional `prompt` ≤16 KiB | `resultId` is the child session ID |
| `stop` | `id` | Existing graceful stop; an already exited child succeeds; a stop error is `indeterminate` |
| `remove_worktree` | `worktreeId` | Returns an operation (`pending_confirmation` when review is needed); poll `operation_status` |
| `tail` | `id`, optional `lines` 1–40 | `{ id, revision, timestamp, lines, truncated, untrusted: true, notice }` |
| `wait_for` | `ids` (1–configured child limit), optional `after` map of ID → revision, `timeoutMs` 0–30000 | `{ sessions, changed, timedOut }` |

Prompts and branch names reject control characters other than newline and tab,
Unicode format characters, and a leading `-`, so they cannot become options.
Children receive no default arguments, never share a checkout, and get a read-only
grant naming their parent. The prompt follows a fixed line naming the orchestrator
as its author, so the argv entry can never equal a subcommand such as `logout`.
Claude Code and Codex take it as the final positional argument; Antigravity composes
it with the CLI guidance through `--prompt-interactive` and refuses a prompt on
releases without that option.

**Limits.** The configured number of children that have not confirmed exit, including starting ones and
any the human took over, and four created worktrees that no child has used,
including creations in progress, launches still starting, and creations that ended
`indeterminate` because Git may have added the checkout before a later step failed.
A worktree serves exactly one launch; a failed spawn returns it for reuse. Each
worktree ID is bound to the checkout identity captured at creation; launch and
removal recheck it, so a replacement at the same path is refused. A human Resume or
New conversation on a child's row ends the orchestrator's ownership of that ID. Tails are rate-limited to one per child per second,
read 80 host lines, redact with `prepareTail` (which fails closed above 128 KiB),
then keep the requested lines and trim whole lines from the start to 16 KiB (a
single oversized line keeps its end on a UTF-8 boundary). The HTTP adapter extends
the socket deadline to 35 seconds after a request body arrives, for `wait_for`.

**Removal.** Settings → General offers one **Auto-remove merged worktrees** checkbox
for all repositories, off by default, stored in the profile rather than agent-editable
config. Saved per-repository lists migrate to on when non-empty and off when empty;
new settings accept only a boolean. With it on, an orchestrator can remove only its own created worktree without
review when no session (including a starting child) runs there, there are no
uncommitted, untracked or unpushed changes, and its current branch tip is an
ancestor of the freshly fetched default branch (`git merge-base --is-ancestor`).
Main checks under the removal lock and rechecks immediately before deletion,
including actor authority, checkout identity and the current setting. Any failed
or indeterminate Git check, including fetch failure, falls back to the trusted
dialog. Main checkouts and another actor's worktrees remain forbidden. This is
local Git ancestry only: squash and rewritten rebase merges still prompt. Branches
are retained. Automatic completions use the same `operation_status` and action-log
outcomes as reviewed removals. Main records a running intent before the final
check; losing eligibility returns it to pending confirmation. Parent revocation
after that intent is indeterminate, so cancellation never claims deletion could
not have occurred.

Otherwise removal asks through the trusted dialog, clean or not, naming the
worktree path, branch (which is kept), clean/dirty state and any changed files.
Pending requests from that orchestrator share one review with Approve all,
Approve selected and Decline; actions including dirty items explicitly name
Discard changes and remove. Decline is focused by default. Each reviewed item needs
explicit human approval. Removal is refused while any session
in that worktree is running, checked again under the removal lock before and after
the dialog, so a human-controlled session is never stopped by it.
The answer is bound to the actor, operation and the worktree ID plus the dirty state
shown, and the workspace sequence rechecks identity and changes before deletion.
Parent exit aborts the dialog; a later acceptance cannot remove anything.

**Visibility and takeover.** The orchestrator's session panel shows Active or Exited,
its running children and its last actions as text with outcomes; failures are also
magenta. A child's panel names its orchestrator and offers **Take over**, after which
the orchestrator can no longer stop, tail or wait for it. Takeover does not stop the
child, and the child keeps counting toward the limit until it exits. The full
nested hierarchy and searchable log remain #157.

As of #217, Foom never emits `checking` in control API or MCP session states. Any existing client schema may retain it as deprecated for backward compatibility. Quiet debounce and classification do not introduce an intermediate state.

### Child board placement and close (#377)

A newly orchestrator-launched child fills the board's landing spot, then an empty
space, otherwise follows sidebar placement (add a column or replace the least
recently focused non-attention tile). Placement targets the parent's board window,
or the current board if the parent is hidden, without focusing the window, tile
or terminal input. The current tile is never replaced by a background arrival;
when it is the only candidate, placement splits instead. Existing layout limits
still apply. Restored children keep their saved placement and are not placed again.

An orchestrator can `close` its own exited child with `id` and `idempotencyKey`
(`foom close ID --idempotency-key KEY`). It uses the normal exited-session close
path, removing the tile and sidebar row and leaving an empty landing space.
Closing discards the final screen; nothing is retained. Tail first if output is
needed. The worktree, branch and review state remain; worktree removal is separate.
Running and stopping children return `conflict`, taken-over children `forbidden`,
and other orchestrators' children or unknown IDs `not_found`. Close is recorded in
the action log and supports the same operations and idempotency as other mutations.

### Elevation (#303)

Roles are no longer fixed at launch. Every agent launch gets an ordinary grant; the
session menu's **Make orchestrator…** asks through the trusted dialog, then main
replaces that grant's principal with an orchestrator principal for the same token
and generation, reserves the repository's slot and binds it to the running session.
Nothing is relaunched or re-attached. When another orchestrator is active, the same
dialog names it; accepting revokes it first and its children stay with the human.
Children that the human has not taken over cannot be elevated. **Revoke
orchestrator** swaps the principal back and retires the parent exactly as exit does:
in-flight operations end as `revoked` or `indeterminate`, confirmations close, and
the panel keeps the history. Elevating the same session again continues that
history. Automatic restore re-grants an orchestrator that was active at quit under
the rules above, without a launch prompt.

MCP protocol sessions are keyed by grant generation, so they survive the swap, and
the next request sees the new role. Clients fetch tools once: checked 2026-10-12
with Claude Code 2.1.296 and Codex 0.162.1 against a stub Streamable HTTP server and
a scripted loopback model (no credentials, no provider), Claude Code opened the GET
stream and refetched `tools/list` within milliseconds of
`notifications/tools/list_changed`, and its next turn used the new tool. Codex opened
the GET stream but ignored the notification, sent there or inline in a POST
response, and kept its startup list for the session. Foom therefore sends no
notification and lists every orchestration tool to every agent from the start.
Each orchestration tool's description begins "Orchestrator only: the human grants
this role, and whoami shows whether you hold it"; a call without the role returns
an error naming `whoami`. Server instructions and Antigravity's launch guidance
describe both roles. Codex's TUI asked to approve an MCP tool without
annotations, so the tools keep accurate `readOnlyHint` and `destructiveHint`.

### Sidebar nesting and action log (#157)

The board source now supplies main-owned child relationships and read/clear access
to the private action history. Sidebar children keep their checkout identity,
independent lights and keyboard row access in their own worktrees, with a child
glyph and parent tooltip. Hovering, focusing or selecting a parent highlights its
children; hovering or focusing a child highlights its parent. Running, exited and
revoked parents retain this context; the compact rail shows each session once.
Filters retain parent context; orphans remain visible in their checkout.
An exited parent remains until its children are closed. No relationship highlight
changes xterm ownership, attachment ordering, hidden execution or activity delivery.

Action log in the app menu exposes search, action/outcome filters, pagination,
actor/parent and target/result identities, fixed reasons and redacted reply
proposals. Pending confirmations, refusals, indeterminate delivery and human
Make/Revoke/Transfer orchestrator and Take over actions are visible. Audit intent
precedes authority changes; failure refuses that command. Serialized private
reads, writes and clearing enforce five 10 MiB files and 30 days. Clearing retains
live deduplication. Only allowlisted redacted fields leave main; raw prompts,
tails, request payloads, credentials and fingerprints are excluded. Tests cover
filters, orphan/exited/revoked context, keyboard access, storage failure and
permissions, retention/clearing, IPC payload/sender boundaries and real-app axe.

### Agent previews (#297)

Every Foom-launched agent, including an orchestrator, can show Markdown or HTML
files from its own launch-bound worktree. These tools are listed from startup,
including across #303 role changes, and callable by both agent roles. Paired human
CLI grants cannot use them. They never take focus or need a trusted dialog.

| Tool | Parameters | Result |
|---|---|---|
| `open_preview` | `path` (≤1024 UTF-8 bytes; relative, or absolute inside own worktree) | `{ previewId, path, kind, placement, reused }` |
| `list_previews` | none | `{ previews: [{ previewId, path, kind, visible }] }`, owned generation only |
| `close_preview` | `previewId` | `{ previewId, closed: true }`; foreign and unknown IDs both `not_found` |

Console equivalents are `foom open-preview PATH [--json]`, `foom previews
[--json]`, and `foom close-preview PREVIEW_ID [--json]`, with existing exit codes
(0 success, 2 schema/usage, 3 authentication/scope, 4 capacity/not found/unavailable).
Antigravity's process-local guidance names `open-preview`. Server instructions
name `open_preview` so clients can discover the view action.

Canonical-path reuse returns the same ID with `placement: "existing"` and never
moves it. No idempotency key is needed. New previews fill the landing spot, then
first empty tile, otherwise wait in the sidebar without a native view. Nothing
is split, added or replaced. Limits are four previews per agent, twelve per
instance, and six opens in a burst then one every ten seconds, including reuse.
Human close is sticky for that generation/path. Exit, takeover and revocation
return ownership to the human; later grants inherit nothing. Worktree removal
closes previews. Fixed audit metadata precedes results; audit failure refuses.
`list_previews` is read-only; open/close change presentation. All three have
non-destructive, idempotent and closed-world MCP annotations.
