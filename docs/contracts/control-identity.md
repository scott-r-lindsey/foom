# Control Identity

## Identity and capability model

Reuse the hook receiver's launch identity and lifecycle, **not `FOOM_TOKEN`**.
Mint a separate random 256-bit `FOOM_CONTROL_TOKEN`; hook credentials must never
authorize control operations. `FOOM_SESSION` is correlation only. Main maps token
digests to a principal with immutable role, repository identity, terminal ID,
parent ID and generation. Neither a tool argument nor an environment role flag can
promote it; only main changes a grant's role, when the human makes the session the
orchestrator or revokes it (see [elevation](control-elevation.md#elevation-303)). Compare fixed-length digests in constant time; unknown and revoked
tokens produce the same authentication error.

Bind credentials before exposing a session; revoke on spawn failure, exit, removal
and shutdown. No control registration depends on hooks being enabled. Scrub all
inherited Foom credentials before constructing each child's environment, then add
fresh child-scoped values. Never return tokens to the renderer, logs, MCP results
or error text. New Foom instances and resumed sessions receive fresh credentials;
automatic restore may re-grant orchestrator control only from Foom's main-owned session store, when restore is enabled, the orchestrator was active at quit, the same repository identity is still registered and the installed provider supports restore control and per-launch MCP. Bundled restore support is Claude Code/Codex; valid v2 config providers may declare the same capability, subject to these provenance checks (see [architecture](../areas/providers.md#agent-provider-registry-and-manifest-approval-407)). Hook data, conversation metadata, agent output and environment flags never grant roles. Otherwise the session resumes ordinarily and its panel says the role was not restored. Every re-grant has a new principal generation and token. The verified repository identity is carried into the launch and rechecked before spawning. Tokens, confirmations, replies, waits and in-flight mutations never survive; unresolved persisted operation intents still require human reconciliation.

Restored parents launch before their running, non-taken-over children. Those children keep child launch rules (user defaults with bypass refused and an orchestrator prompt prefix), count toward the configured child limit, and may be stopped, tailed and waited for by the new parent. Stop returns a conflict while a restored child is still starting; it cannot report success for a PTY that does not exist yet. Taken-over children and children without a re-granted parent resume ordinarily. The active panel and its action history continue without a restore badge.

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
`foom config validate PATH` performs offline validation without pairing or running config content. Config probe credentials are a separate capability; see [Config probes](../areas/probes.md#config-owned-probe-capability-591).

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
| `handoff` | Live owned child only | `status` done/blocked/failed, 1–8192 UTF-8 byte `summary`, up to ten HTTPS `links` of 2048 bytes each, `idempotencyKey`; no recipient argument |
| `read_handoff` | Orchestrator, own child only | Child `id`, optional positive `seq`; latest by default, bounded untrusted child-authored data |
| `prompt` | Orchestrator, own child only | ≤16 KiB UTF-8 text plus submit, honoring bracketed paste; no human review |
| `send_keys` | Orchestrator, own child only | 1–64 allowlisted logical keys, validated together before writing; no human review |
| `stop` | Orchestrator, own child only | Graceful stop with existing bounded termination fallback; retains worktree and final screen |
| `remove_worktree` | Orchestrator, own created worktree only | Requests an app confirmation unless Auto-remove merged worktrees is enabled in Settings → General; no force option or deleting branches |
| `wait_for` | Orchestrator, own children only | Up to the configured child limit of IDs, after-revision cursor, timeout 0–30 seconds; returns state/PR/handoff metadata or timeout |
| `operation_status` | Orchestrator or authorized human CLI grant, own operations only | Exactly one of operation ID or idempotency key; returns the operation record described below, never child output |

`create_worktree({ pullRequest: N, idempotencyKey })` (#337) uses the #340
selected forge manifest and the user's existing CLI login to resolve the PR head. Main
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

Existing orchestration tools are listed to every agent for clients that cache tools
(#303). The new `handoff` tool is listed only to live owned children, and
`read_handoff` only to orchestrators. Main also checks every direct call. A client
that cached tools before elevation can use `foom read-handoff` instead. Config-only tools for #84 are a separate
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
path, branch, clean/dirty state and changed files, plus cached PR number and
OPEN/CLOSED/MERGED state when forge tracking has an available observation. A single
pending removal keeps the ordinary worktree confirmation. Approve all or selected items;
when the action includes dirty items its button explicitly says **Discard changes
and remove all** or **Discard changes and remove selected**. Dirty rows carry an
amber warning icon and outline as well as the Dirty label. Decline has initial
focus, so Enter never discards changes by default.
Decline (or closing the dialog) declines the batch. Unselected items are declined.
Each operation independently rechecks and completes, so one stale checkout or
removal failure does not stop the others. Poll `operation_status` for each outcome.
New arrivals and per-item cancellation invalidate answers to the older displayed
list and reset selection. An aborted item is declined immediately and leaves the
review; other items remain pending. Aborting every item closes the dialog. Review uses existing forge observations only;
it performs no additional GitHub lookup and PR state grants no deletion authority. Pending confirmation
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
Provider attention permits `prompt` and `send_keys` from the owning orchestrator.
The existing Needs you light is amber and retains its label; short fixed reasons
identify Provider unavailable, Provider rate limit, Provider usage limit or Model switch requested.
Detection itself performs no automatic retry, model change or terminal input.

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
[`tests/fixtures/agent-detection/README.md`](../../tests/fixtures/agent-detection/README.md).
