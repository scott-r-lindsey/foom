# Control Mutations

### Orchestrators and children (#155)

**Launch.** Only the human elevates a running agent through its session menu; see [elevation](control-elevation.md#elevation-303). Every agent, including children, gets the console directory on its
process-local PATH, and the CLI works when MCP attachment is unavailable or denied
by client policy. Antigravity's current opt-in Foom plugin supplies MCP using
only inherited launch credentials; other installations retain the CLI fallback.

**Tools.** Every mutation takes an `idempotencyKey` (`[a-zA-Z0-9_-]{1,200}`) and
returns the operation record. Limits and foreign targets are recorded as
`failed`/`refused` and then rejected (`capacity`, `conflict` or `not_found`), so a
retry with the same key returns that record.

| Tool | Parameters | Result |
|---|---|---|
| `create_worktree` | Exactly one of `branch` or `pullRequest`; optional `review` boolean with `pullRequest`, optional registered `host` | New local branch, or continue an open same-repository PR; `resultId` is the opaque worktree ID |
| `launch` | `worktreeId`, `agent` (a loaded provider ID), optional matching `host`, `model`, `effort`, `prompt` ≤16 KiB (including the fixed author brief when `review` is enabled) and `review` | `resultId` is the child session ID |
| `prompt` | `id`, `text` ≤16 KiB | Text plus submit, honoring bracketed paste, without review |
| `send_keys` | `id`, `keys` (1–64) | Validated logical keys, without review |
| `stop` | `id` | Existing graceful stop; an already exited child succeeds; a stop error is `indeterminate` |
| `remove_worktree` | `worktreeId` | Returns an operation (`pending_confirmation` when review is needed); poll `operation_status` |
| `handoff` (child only) | `status`, `summary`, optional `links` and `review`, `idempotencyKey` | `{ seq, status, timestamp }` |
| `read_handoff` (orchestrator only) | `id`, optional `seq` | Bounded report with `untrusted: true` |
| `tail` | `id`, optional `lines` 1–40 | `{ id, revision, timestamp, lines, truncated, untrusted: true, notice }` |
| `wait_for` | `ids` (0–configured child limit with the board), optional `after` map of ID → revision, `boardAfter`, `timeoutMs` 0–30000 | `{ sessions, changed, timedOut, board }`; see the [board cursor](#local-message-board-973) |

Initial launch prompts and branch names reject control characters other than newline and tab,
Unicode format characters, and a leading `-`, so they cannot become options.
Children receive the user's Settings default arguments for their agent, with only
explicit model/effort selections replacing the corresponding declared selectors, never share a checkout, and get a read-only
grant naming their parent. If those defaults bypass permissions, `launch` is refused
with `forbidden` before spawning and the worktree stays unused. The prompt follows a fixed line naming the orchestrator
as its author, so the argv entry can never equal a subcommand such as `logout`.
Claude Code and Codex take it as the final positional argument; Antigravity composes
it through `--prompt-interactive`, adding CLI guidance only without the current
MCP plugin, and refuses a prompt on
releases without that option.

**Limits.** The configured number of children that have not confirmed exit, including starting ones and
any the human took over, and four created worktrees that no child has used,
including creations in progress, launches still starting, and creations that ended
`indeterminate` because Git may have added the checkout before a later step failed.
A worktree may serve a new launch only after all prior sessions there have exited
and closed; a failed spawn preserves its previous used/unused state. Each
worktree ID is bound to the checkout identity captured at creation; launch and
removal recheck it, so a replacement at the same path is refused. A human Resume or
New conversation on a child's row ends the orchestrator's ownership of that ID. Tails are rate-limited to one per child per second,
read 80 host lines, redact with `prepareTail` (which fails closed above 128 KiB),
then keep the requested lines and trim whole lines from the start to 16 KiB (a
single oversized line keeps its end on a UTF-8 boundary). The HTTP adapter extends
the socket deadline to 65 seconds after a request body arrives, allowing the CLI's
60-second mutation deadline and bounded `wait_for` calls.

**Removal.** Review checkouts have one narrowly scoped exception (#843). Closing
a reviewer can remove its checkout without confirmation, regardless of the
**Auto-remove merged worktrees** setting or whether the PR is still open, only
when Foom created it for review, its identity still validates, it remains detached
at the exact fetched and recorded PR head, it has no tracked or untracked changes
and no local refs or commits beyond that head, and no other session or operation
is using it. Main checks local refs against the creation baseline and inspects
worktree reflogs, including commits later reset away. Ignored content and unavailable
evidence also refuse automatic deletion. The closing exited session is released
by the removal sequence. The proof is repeated under the removal lock and next to
Git deletion; failure falls back to trusted confirmation. Existing identity,
membership, active-session and operation guards still apply after approval.
Ordinary worktrees keep the policy below.

Settings → General offers one **Auto-remove merged worktrees** checkbox
for all repositories, off by default, stored in the profile rather than agent-editable
config. Saved per-repository lists migrate to on when non-empty and off when empty;
new settings accept only a boolean. With it on, an orchestrator can remove only its own created worktree without
review when no session (including a starting child) runs there, there are no
uncommitted, untracked or unpushed changes, and its current branch tip is an
ancestor of the freshly fetched default branch (`git merge-base --is-ancestor`).
Main checks under the removal lock and rechecks immediately before deletion,
including actor authority, checkout identity and the current setting. Any failed
or indeterminate Git check, including fetch failure, falls back to the trusted
dialog. Main checkouts and another actor's worktrees remain forbidden. Automatic removal
also permits a same-repository MERGED PR whose reported head exactly matches the
local HEAD and whose validated merge commit is locally verified as an ancestor of
the freshly fetched default. This path permits squash and rewritten rebase merges
without head ancestry or a surviving upstream ref; clean status remains mandatory.
Forge data is only a hint, and the PR evidence is rechecked before deletion. Branches
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
child, and the child keeps counting toward the limit until it exits. See [hierarchy and searchable log](control-visibility.md#sidebar-nesting-and-action-log-157).

As of #217, Foom never emits `checking` in control API or MCP session states. Any existing client schema may retain it as deprecated for backward compatibility. Quiet debounce and classification do not introduce an intermediate state.

### Opt-in child review loop (#690)

`launch` additionally accepts optional `review: {rounds?, agent?, postFindings?, parentWaitMinutes?}`.
Defaults on opt-in are 3 rounds, Claude and no posting; rounds must be 1–5.
The optional `parentWaitMinutes` is an integer from 1–1440 (default 180).
Unknown fields fail closed. Main requires installed reviewer and resume-capable
providers. Only orchestrator-created worktrees with no remaining earlier sessions are
eligible for a new author launch. The loop's internal review/resume steps reuse that checkout with
ordinary owned-child grants and the existing per-parent capacity reservations.
No child receives launch/prompt authority and parentless agents cannot opt in.
See [the loop rules](../areas/orchestration.md#optional-child-buildreview-loop-690).

### Detached PR review worktrees (#843)

`create_worktree({pullRequest: N, review: true, idempotencyKey})` creates a
separate checkout detached at the fetched PR head without a local branch, even
when the author has that branch checked out elsewhere. `review` is an optional
boolean valid only with `pullRequest`; false preserves ordinary PR adoption.
The open, same-repository, non-default-branch validation and unused-worktree budget
remain unchanged. The console form is
`foom create-worktree --pull-request N --review --idempotency-key KEY`.
The reviewer reports findings by default; this is read-only intent rather than
filesystem enforcement. Deliberate edits and pushes remain possible.

### Per-child selections (#853)

MCP `launch` accepts `model?: string`, `effort?: string` and
`review: {rounds?, agent?, model?, effort?, postFindings?, parentWaitMinutes?}`.
Both selections are validated before launch reservation. Tokens match
`^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$`; absent manifest support returns
`unsupported`, malformed tokens or values outside a declared enum return
`invalid_request`. Effort requires a manifest enum. Model uses the manifest's list
when present, otherwise any well-formed token. Unknown fields, including free-form
`args`, remain refused. Omission preserves Settings defaults.

The reviewer selection applies only to reviewers. Fix steps retain the initial
author selection. Session metadata (`sessions`, `session_state`, including wait
results) carries `selection: {model?, effort?}` for the requested options, also
persisted with the session. It does not assert what model the CLI actually used.
The parent's handoff read remains paired with session metadata; children cannot
replace this main-owned record through handoff text.

See [manifest expansion and replacement](agent-launch.md#child-model-and-effort-853)
and [CLI flags](console.md).


### Launch failure reasons

`whoami.launchReasons` publishes these fixed codes and descriptions, alongside
`removalReasons`. Failed launch operations record one of the following; main logs
one bounded code-only line. No remote text, host output or stderr is returned or
logged. Ownership/grant refusals retain their existing control error semantics.

| Code | Meaning |
| --- | --- |
| `agent_disabled` | Local agent disabled in Settings |
| `agent_unavailable` | Local agent not installed or discoverable |
| `remote_agent_unsupported` | Agent has no supported remote launch attachments |
| `remote_agent_unavailable` | Remote agent not installed or discoverable |
| `remote_host_unreachable` | Remote host unreachable or BatchMode SSH authentication failed |
| `remote_host_facts_unavailable` | The compatible running daemon needs an update for read-only host facts |
| `remote_host_libc_too_old` | Remote Linux needs glibc 2.28 or newer |
| `remote_host_libc_unsupported` | Remote Linux does not provide supported glibc (musl is unsupported) |
| `remote_artifact_mismatch` | Remote platform, application or artifact mismatch |
| `remote_worktree_unavailable` | Remote checkout missing, changed or not a repository member |
| `remote_prepare_refused` | Remote host refused preparation |
| `remote_start_refused` | Remote host refused start |
| `launch_failed` | Other local launch failure |

Successful `launch` results include `placement: {kind: "local"}` or
`placement: {kind: "remote", host: SSH_ALIAS}`, also returned by `sessions` and
`session_state`. The value describes the actual launch and is saved with the row;
current developer mapping flags never relabel an existing session. Legacy remote
rows without a recorded alias cannot claim successful remote cleanup.

Closing a dormant remote row reconnects through the bounded agent cleanup protocol
and removes the remote process and private assets before deleting the local row.
A failed cleanup retains the row; the close operation and session reason report
`remote_host_unreachable`. Remote authority and routing remain phase-2 restricted.

### Host-aware placement (#756)

`host` is a Settings-registered SSH alias/account selector, never an arbitrary
command. `create_worktree` uses that host's approved existing checkout; it never
clones. Branch creation starts from the freshly fetched origin default. PR
adoption retains open/same-repository/default-branch checks and tracks origin.
`launch` uses the created worktree's host; an explicit different host refuses.
A host's current inventory can refuse an absent/uncheckable agent with
`remote_agent_unavailable` before launch preparation. Missing/stale inventories
are probed. Registered-host sequential review loops use pinned host snapshots
(#942); detached remote review checkouts and developer spike mappings remain
unsupported. Reviewer grants retain the three restricted child tools.

Worktrees discovered through profile-tagged remote inventory (#941) belong to the
human only. Discovery never creates a worktree ID or child grant, refunds an
indeterminate creation, or replays a mutation. A lost create reply remains charged;
the human can launch or review removal of a validated recovered checkout.

`sessions` and `session_state` accept optional `host` to filter for that remote
host. Every row includes `host: SSH_ALIAS | null` alongside actual `placement`.
Orchestrator calls also return `hosts`: observations with `host`, `resources`
(cores, three load averages, memoryTotal and memoryAvailable in bytes) and `agents`
(id and ready/missing/unable state). Null resources plus a fixed `reason` indicate
an unavailable host observation. Local uses null for its host. These observations
inform placement; there is no Foom validation lock or busy classification.

### Review continuation and explicit binding (#972)

`launch` accepts optional `pullRequest: N` (console `--pull-request N`). Main
resolves an open same-repository PR before spawning, independently of the actual
checkout branch, and requires the checkout commit to match the PR head both before and after resolution. Unresolvable bindings return `pr_binding_unresolved`; closed PRs
and forks return `pr_not_open` and `pr_from_fork`. Identity inspection still uses
the actual checkout branch. Review steps follow the bound number and require its
current head to match the checkout HEAD and green required checks at every existing gate.
New tasks without a PR can still launch; their first validated completion binds
the discovered PR. The loop cannot silently switch to another PR.

The same owning parent may launch a new author in its existing checkout once
every earlier session there has exited and closed. This includes human and
taken-over rows. The branch, PR number and review options remain attached to the
owned worktree; omission inherits them. Main rechecks identity, membership,
capacity, live authority and absence of prior rows before spawning. Starting
launches still reserve the checkout. Failed continuation preserves used state.
Restored metadata grants no authority and never starts automation.

`review({pullRequest: N, since?, focus?, postFindings?, idempotencyKey})` creates
one detached checkout at the fetched PR head and launches one ordinary Claude
reviewer with the standard read-only brief and structured verdict. `since` is a
full lowercase 40- or 64-digit commit SHA; the reviewer checks its ancestry before
scoping the diff. `focus` is quoted, bounded (4096 UTF-8 bytes) untrusted scope data.
The console is `foom review --pull-request N [--since SHA] [--focus TEXT]
[--post-findings true|false] --idempotency-key KEY`. No author's loop is changed;
the parent reads the verdict and stops/closes the reviewer normally. Pending or
red checks do not prevent a standalone review, but the fetched head must still
match the bound PR before launch. Posting defaults to false. Usual capacity,
takeover, identity, unused-worktree budget and cleanup rules apply. The composite
returns a launch operation whose `resultId` is the reviewer ID; query the caller's
key after a lost response. Closed reports survive only while their checkout does.

### Local message board (#973)

Only the current live repository orchestrator can call `board_threads`,
`board_read`, `board_post` and `board_resolve`. Children, ordinary agents,
paired human CLI grants, revoked and replaced orchestrators are refused.
Identity is derived from the grant, never a payload field. Unknown fields fail
closed. Threads are scoped to opening/addressed repositories.

| Method | Parameters | Result |
| --- | --- | --- |
| `board_threads` | optional `state`, `after` thread ID | `repositories`, up to 100 `threads`, `next`, `untrusted`, `notice` |
| `board_read` | `thread`, optional `after` post ID | `thread`, up to eight `posts`, `next`, `untrusted`, `notice` |
| `board_post` | `thread` OR `to` repository ID array and `title`; `kind`, `text`, optional `links`, `idempotencyKey` | operation; `resultId` is the thread ID |
| `board_resolve` | `thread`, `idempotencyKey` | operation; `resultId` is the thread ID |

Kinds are request, answer, decision-needed, fyi and link. Bounds, states and main's
append seam are defined in [message board ownership](../areas/message-board.md).
Every mutation uses the existing durable intent/audit and actor-scoped operation
lookup. Lost responses must be reconciled using `operation_status` with the same
key. Human replies and resolution also require idempotency keys, with receipts
persisted atomically with the accepted write. No author field is accepted.

```text
foom board threads [--category topics|children] [--state S] [--after THREAD]
foom board read THREAD [--after POST]
foom board post (--thread ID | --new --to REPO [--to REPO] --title T) --kind K --text-file FILE|- [--link URL] --idempotency-key KEY
foom board resolve THREAD --idempotency-key KEY
```

`wait_for` also accepts optional `boardAfter`, the `board.event` cursor from its
previous result. Results include `board: {event, changed}` when the board is
available. A new post by another author in a thread addressed to or opened by the
caller changes this cursor. Own posts, state changes and unrelated threads do not.
With no board cursor, capture the current one. Empty `ids` supports a board-only
wait. `foom wait-for --until-event` now works with no children and shares its
existing invalidation subscription and deadline scheduler; use `--board-after`
to retain the board cursor between calls. MCP remains bounded to 30 seconds and
rejects `untilEvent`; the CLI's blocking form is unchanged. Revocation/disconnect
releases the wait. Board event metadata contains no post text.


### Child thread events (#974)

`board_threads` accepts optional `category: "topics" | "children"`; omission lists
both. Child threads carry main-owned `child: {id, worktreeId, removedAt?}` metadata.
Current repository orchestrators can read these retained records, but `board_post`
and `board_resolve` refuse child threads. Human notes remain supported.

`prompt` additionally accepts optional boolean `sensitive` and `automatic`.
CLI flags are `--sensitive` and `--automatic` (no value). Use sensitive for credential
answers, or `send_keys`; the original prompt is delivered but omitted from persistent
board records. Existing credential/provider attention defaults to sensitive.
Automatic labels continuation nudges. Key values are never recorded.
See [main's recording rules](../areas/message-board.md#child-conversation-threads-974).
