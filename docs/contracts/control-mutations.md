# Control Mutations

### Orchestrators and children (#155)

**Launch.** Only the human elevates a running agent through its session menu; see [elevation](control-elevation.md#elevation-303). Every agent, including children, gets the console directory on its
process-local PATH, and the CLI works when MCP attachment is unavailable or denied
by client policy. Antigravity uses only the CLI, without any MCP configuration.

**Tools.** Every mutation takes an `idempotencyKey` (`[a-zA-Z0-9_-]{1,200}`) and
returns the operation record. Limits and foreign targets are recorded as
`failed`/`refused` and then rejected (`capacity`, `conflict` or `not_found`), so a
retry with the same key returns that record.

| Tool | Parameters | Result |
|---|---|---|
| `create_worktree` | Exactly one of `branch` or `pullRequest` | New local branch, or continue an open same-repository PR; `resultId` is the opaque worktree ID |
| `launch` | `worktreeId`, `agent` (a loaded provider ID), optional `model`, `effort`, `prompt` ≤16 KiB (including the fixed author brief when `review` is enabled) and `review` | `resultId` is the child session ID |
| `prompt` | `id`, `text` ≤16 KiB | Text plus submit, honoring bracketed paste, without review |
| `send_keys` | `id`, `keys` (1–64) | Validated logical keys, without review |
| `stop` | `id` | Existing graceful stop; an already exited child succeeds; a stop error is `indeterminate` |
| `remove_worktree` | `worktreeId` | Returns an operation (`pending_confirmation` when review is needed); poll `operation_status` |
| `handoff` (child only) | `status`, `summary`, optional `links` and `review`, `idempotencyKey` | `{ seq, status, timestamp }` |
| `read_handoff` (orchestrator only) | `id`, optional `seq` | Bounded report with `untrusted: true` |
| `tail` | `id`, optional `lines` 1–40 | `{ id, revision, timestamp, lines, truncated, untrusted: true, notice }` |
| `wait_for` | `ids` (1–configured child limit), optional `after` map of ID → revision, `timeoutMs` 0–30000 | `{ sessions, changed, timedOut }` |

Initial launch prompts and branch names reject control characters other than newline and tab,
Unicode format characters, and a leading `-`, so they cannot become options.
Children receive the user's Settings default arguments for their agent, with only
explicit model/effort selections replacing the corresponding declared selectors, never share a checkout, and get a read-only
grant naming their parent. If those defaults bypass permissions, `launch` is refused
with `forbidden` before spawning and the worktree stays unused. The prompt follows a fixed line naming the orchestrator
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
the socket deadline to 65 seconds after a request body arrives, allowing the CLI's
60-second mutation deadline and bounded `wait_for` calls.

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
providers. Only orchestrator-created, unused worktrees remain eligible for the
initial launch. The loop's internal review/resume steps reuse that checkout with
ordinary owned-child grants and the existing per-parent capacity reservations.
No child receives launch/prompt authority and parentless agents cannot opt in.
See [the loop rules](../areas/orchestration.md#optional-child-buildreview-loop-690).

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
