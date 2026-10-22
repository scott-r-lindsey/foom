# Orchestration

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Orchestration

**Orchestrators and children implemented in #155.**
`main/control/orchestration-authority.ts` owns slots, limits, ownership checks,
lifecycle and the action history. `orchestration-mutations.ts` implements worktree
creation/removal and child launch/stop/close; `orchestration.ts` dispatches calls
and implements child input, handoff reads, tails and waits. The classes share
the authority module through inheritance, keeping all parent/generation and child
ownership checks in one place. `orchestration.d.ts` holds their host and state
contracts. `WorkspaceContext` wires main's worktree creation, agent launch,
stop, close, host tail and removal effects. Role changes and child worktree/agent
launches live in `orchestration-commands.ts`. The service delegates `create_worktree`, `launch`, `stop`, `close`, `remove_worktree`,
`tail` and `wait_for` to it through an asynchronous `call`. MCP lists these tools
and `operation_status` to every agent but runs them only for an orchestrator
principal. `prompt` and `send_keys` (#629) deliver bounded input to owned children
without per-message human review, replacing the reviewed `reply` flow (#156). See [the implementation record](../contracts/control-mutations.md#orchestrators-and-children-155).

A running agent session's menu offers **Make orchestrator…**, and **Revoke
orchestrator** on the active one (#303). There is no orchestrator launch. Main checks
the session is a running, non-config agent that is not an un-taken-over child, then
asks through the trusted dialog, which discloses the output path and names any
orchestrator it would replace. After the dialog it rechecks the session and the
current orchestrator, revokes the old one, reserves the repository's slot, swaps
the grant's principal (`ControlService.setRole`) and binds the slot. Every
orchestrator has the CLI fallback; Antigravity can be elevated without interactive
prompt support. Child worktree creation with `branch` requires a new local branch, refuses
checked-out branches, and starts from HEAD even when a same-named remote ref exists.
The narrow `pullRequest` path (#337) resolves an open PR through the #340 forge
provider, rejects forks and the default branch, validates its head, fetches from
main-selected origin and tracks origin's branch for plain push. An orchestrator's
own unused checkout may be reused after identity checks; other checked-out heads
are refused. Both paths share the unused budget, branch locks and forge tracking. Children launch with
the user's default arguments as written (refused, never stripped, when they bypass
permissions), `sharedCheckout` off, a read-only grant
naming their parent, and an optional prompt as one final argv entry. Claude Code
and Codex place `--` immediately before that prompt, after all launch options, so
variadic options cannot consume it. Launches without a prompt omit the terminator. Exit,
removal or revocation of the parent ends its authority, aborts pending removal
dialogs and frees the slot; children keep running. Snapshots carry a main-computed `orchestration`
view (role, children, last 20 actions); validated session metadata retains bounded history across restart. `take-over` is a sidebar
command that removes the orchestrator's stop, close, tail and wait access to that child.
With `showNewChildren` enabled (the default), new child launches send a background placement event to the parent's board (or the
current board when hidden). The renderer queues it until inventory arrives, uses
sidebar placement without replacing the current tile, and preserves focus. Restore
sends no placement event. `close` accepts only owned, exited children and delegates
to the normal sidebar close path; the final screen is discarded while the checkout,
branch and review state remain.

## Optional child build/review loop (#690)

Only an orchestrator's `launch` accepts `review: {rounds?, agent?, postFindings?}`.
It is off by default; opting in defaults to three rounds (maximum five), Claude,
and no posting. Both author and reviewer providers must support resume. Review-enabled task prompts
reserve the fixed author brief within the combined 16 KiB UTF-8 launch limit;
oversized requests refuse before creating a launch operation. Main runs
fixed sequential steps; agents receive no orchestration authority. The human
New-worktree flow has no review option. This is the final scope decision recorded
on #690; there is no parentless-agent handoff capability.

The author keeps one PR, waits for green required checks, hands off `done`, then
exits. Main verifies an open PR and a successful (or empty) required-check set
whose head matches local HEAD before launching a reviewer in the same checkout.
It rechecks the observed PR/check facts after capacity waits and immediately before
spawning, so a newly red or changed head cannot pass on an earlier green result.
Missing, pending, red, unknown or mismatched-head checks escalate without review.
The reviewer gets a fixed brief: reproduced correctness/security bugs only, no
style nits or edits, then a structured verdict handoff and process exit. Main
compares HEAD, index entry modes/object IDs/stages and semantic flags
(skip-worktree, assume-unchanged and intent-to-add), sparse-checkout and local
exclusion rules, and tracked/untracked non-ignored file bytes and modes
against the pre-review snapshot. Git stat-cache refreshes from read-only status/diff
commands do not change the snapshot. Unsupported index debug metadata fails closed.
Snapshot reads are bounded (10,000 files, 32 MiB
of file content); unavailable snapshots fail closed. Symlinks are hashed without
following their targets; redirected ancestors, special files and submodule
working directories refuse a snapshot.

Findings pass as quoted JSON data in a fixed author-resume template. Main resumes
the captured author conversation under the same terminal ID, using the provider's
existing resume argv and fresh credentials. It never writes prompts or Enter to
a running PTY. The next review waits for another author handoff and exit. A clean
verdict, round cap, blocked/failed report, missing report/verdict, unavailable
conversation, non-green checks, changed worktree or launch failure ends the loop
and raises a readable event for the parent. Clean still requires the orchestrator's
final verification and merge decision. Foom never merges or makes forge writes.

Reviewers are ordinary owned children and consume the existing per-parent budget.
New reviewer placement follows the same General → Show new children on the board
preference as initial children, without taking focus; author resumes retain their tile.
Each transition reserves a slot before asynchronous work, waits when full, and
rechecks ownership and cancellation immediately before spawning. Handoffs remain
readable under each participant's ID. State is exposed in session metadata and
shown in words in sidebar rows and tile titles. Stopping, takeover, parent exit
or revocation ends automation. Saved loop participants remain dormant and show
`Escalated: restored`; restoration never silently launches a loop step.

Review invalidations coalesce separately for each loop. A change arriving during
an asynchronous step requests at most one follow-up check of that same loop;
completing a check never invalidates sibling loops. Unchanged running children
settle without polling or a self-sustaining Promise microtask cycle, leaving main
able to service control and UI requests. Clean and escalated loops, including
restored participants, do not advance on later invalidations.

`postFindings: true` explicitly asks the reviewer to post its verdict and findings
as a PR review comment using its own `gh` login. It is off by default. Main stores
no forge tokens and performs no write; posting is the agent's own CLI action.
