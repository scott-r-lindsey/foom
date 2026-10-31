# Orchestration

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Orchestration

This area owns feature composition, role transitions, child worktree/launch/close
lifecycle and review automation. [Control](control.md#control-plane) owns service
authentication and durable operation/audit storage; [child authority](child-authority.md)
owns authorization and the input, tail and wait capabilities.

**Orchestrators and children implemented in #155.**
`main/control/orchestration-authority.ts` owns slots, limits, ownership checks,
lifecycle and the action history. `orchestration-mutations.ts` implements worktree
creation/removal and child launch/stop/close; `orchestration.ts` dispatches calls
and implements child input, handoff reads, tails and waits. The classes share
the authority module through inheritance, keeping all parent/generation and child
ownership checks in one place. `orchestration.d.ts` holds their host and state
contracts. The main-only leaf modules `workspace/worktree-outcome.ts` and
`control/orchestration-limits.ts` own the shared uncertain-creation error and unused
worktree bound, so Git helpers and session persistence do not load orchestration
implementations for these primitives.

`review-effects.ts` owns review snapshot reads and durable stop/launch/resume effects;
`ReviewLoops` retains phase and evidence ownership. Effects receive captured child
capabilities that revalidate exact live parent/child identities after durable
intent and in the host's pre-spawn callback. Authority alone reserves capacity
and updates child membership/exit state. `finished-child-closer.ts` owns close
eligibility, settled exit-observation interests and one-shot durable automatic
closes, using owned-child capabilities and the loop's retention query. It retains
the last participant and does not retry failed closes. `orchestration-automation.ts`
only composes the child-event subscription and disposal for unread events, loops
and the closer; it holds no authority state. `WorkspaceContext` wires main's
worktree creation, agent launch,
stop, close, host tail and removal effects. Role changes and child worktree/agent
launches live in `orchestration-commands.ts`. Service calls enter this composition
through asynchronous `call` dispatch;
adapter/tool exposure follows [MCP](mcp.md), and capability authorization follows
[child authority](child-authority.md). See [the mutation contract](../contracts/control-mutations.md#orchestrators-and-children-155).

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
are refused. With `pullRequest` and `review: true` (#843), main instead creates
a detached checkout at the fetched PR head without any branch, including when
the author has the branch checked out. Closing its reviewer uses the
[narrow review removal exception](../contracts/control-mutations.md#orchestrators-and-children-155),
with trusted confirmation when the proof fails. All creation paths share the unused budget, branch locks and forge tracking. Children launch with
the user's default arguments, with optional manifest-validated model/effort
replacement (#853; refused, never stripped, when defaults bypass permissions), `sharedCheckout` off, a read-only grant
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
branch and review state remain for ordinary worktrees. Foom-created detached
review checkouts instead use the narrow #843 removal exception above.

## Optional child build/review loop (#690)

Only an orchestrator's `launch` accepts `review: {rounds?, agent?, model?, effort?, postFindings?, parentWaitMinutes?}`.
It is off by default; opting in defaults to three rounds (maximum five), Claude,
and no posting. Both author and reviewer providers must support resume. Review-enabled task prompts
reserve the fixed author brief within the combined 16 KiB UTF-8 launch limit;
oversized requests refuse before creating a launch operation. Main runs
fixed sequential steps; agents receive no orchestration authority. The human
New-worktree flow has no review option. This is the final scope decision recorded
on #690; there is no parentless-agent handoff capability.

The author keeps one PR, waits for green required checks, and hands off `done`.
Main verifies an open PR and a successful (or empty) required-check set
whose head matches the checkout HEAD before stopping the author through the normal host
session stop path (signal the process group, wait briefly, then force). Main waits
for the observed exit before launching a reviewer in the same checkout. Invalid
handoffs escalate without stopping the process.
It rechecks the observed PR/check facts after capacity waits and immediately before
spawning, so a newly red or changed head cannot pass on an earlier green result.
Missing, pending, red, unknown or mismatched-head checks escalate without review.
The reviewer gets a fixed brief: reproduced correctness/security bugs only, no
style nits or edits, then a structured verdict handoff. Main validates the verdict
and unchanged
worktree before stopping the reviewer through the same host path and waiting for
exit. Signal exit codes from these requested stops do not fail the loop; unexpected
nonzero exits still escalate. Each automated stop records durable action intent
and rechecks live authority, the latest handoff sequence/status, HEAD, worktree
snapshot and green required checks after that write and immediately before
signaling. Changed evidence cancels that stop and re-evaluates the same loop.
Only a host acknowledgement that it signaled a running process grants the expected
stop-exit exemption; a natural nonzero exit still fails even when it races a
snapshot or stop intent. A host-observed exit awaiting main inventory settles
without polling or repeated stops. Main compares HEAD, index entry modes/object IDs/stages and semantic flags
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
a running PTY. The next review waits for another validated author handoff and
host-observed exit. A clean
verdict, round cap, failed author report, blocked/failed reviewer report, missing report/verdict, unavailable
conversation, non-green checks, changed worktree or launch failure ends the loop
and raises a readable event for the parent. Clean still requires the orchestrator's
final verification and merge decision. Foom never merges or makes forge writes.

Reviewers are ordinary owned children and consume the existing per-parent budget.
New reviewer placement follows the same General → Show new children on the board
preference as initial children, without taking focus; author resumes retain their tile.
Each transition reserves a slot before asynchronous work, waits when full, and
rechecks ownership and cancellation immediately before spawning. Handoffs remain
readable under each participant's ID. State is exposed in session metadata and
shown in words in sidebar rows and tile titles. Human or parent stopping,
takeover, parent exit or revocation ends automation. Saved loop participants remain dormant and show
`Escalated: restored`; restoration never silently launches a loop step.

An author's `blocked` handoff enters `waiting-on-parent`, shown as **Waiting on
parent**, without stopping its process or spending a review round. The owning
orchestrator's explicit `prompt` resumes the preceding Building or Fixing phase only after input delivery
succeeds and live ownership is rechecked. `send_keys`, human terminal input,
foreign parents and failed/ambiguous prompt deliveries cannot resume it. A prompt
must target the live author process; Foom never injects input or relaunches an
exited blocked author on its own. The next fresh `done` handoff and exit use the
usual green-check and worktree validation before review. A fresh `failed` report
still escalates. Waiting uses one deadline timer per loop, with no polling;
`review.parentWaitMinutes` configures 1–1440 minutes, default 180 (three hours).
The console flag is `--review-parent-wait-minutes`. Expiry escalates with
`author blocked`; prompting, cancellation and removal release the timer.

Review invalidations coalesce separately for each loop. A change arriving during
an asynchronous step requests at most one follow-up check of that same loop;
completing a check never invalidates sibling loops. Unchanged running children
settle without polling or a self-sustaining Promise microtask cycle, leaving main
able to service control and UI requests. Clean and escalated loops, including
restored participants, do not advance on later invalidations.

`postFindings: true` explicitly asks the reviewer to post its verdict and findings
as a PR review comment using its own `gh` login. It is off by default. Main stores
no forge tokens and performs no write; posting is the agent's own CLI action.

Settings → General **Close finished agents** defaults to on. Existing child-event
invalidations check exited owned agents: reviewers become eligible only after the
loop accepts their verdict and observes their exit; authors and ordinary children
need a MERGED or CLOSED PR. Active loop authors (including waiting on parent) stay
open until the loop is clean or ended. Needs-you/unread attention, blocked sessions,
takeover, starting or running sessions and children without a PR stay open (accepted
reviewers need no PR). The normal sidebar close path discards the final screen and
removes the tile and row, keeping the checkout, branch and remaining loop state.
Closing an accepted reviewer must not cancel its author's loop. Automatic closes
persist normal close intent and recheck the live parent, ownership, setting and
eligibility after that write; audit failure leaves the session visible. Disabling
the switch retains finished sessions. No polling, new timer, Git command or forge request is
added; unchanged metadata settles, and failed close attempts retain the session
without automatic retries.

Loop attention is projected onto the parent: an author with unread review attention
is ineligible even when its own row is quiet. Automatic close always leaves at least
one loop participant on the board, retaining the review record and its persistence;
the final participant requires explicit close, including after acknowledgment.
PR-based closure uses only a successful observation after the exit-triggered
recheck has settled. A response from an older in-flight read cannot qualify. The
existing forge completion invalidation wakes closure even for unchanged PR metadata;
the settled read is checked synchronously again immediately before close.

## Registered-host placement (#756)

`create_worktree` accepts an optional registered SSH `host`. Omission keeps local
creation; specifying one creates in that host's already approved repository
checkout, branching from its fetched default (or its validated PR branch). The
returned worktree ID is host-bound and opaque, even when two hosts use identical
paths. `launch.host`, when supplied, must match that worktree. Omission retains the
created worktree's host; it never moves work or chooses a host. Remote inventory is
checked before launch preparation, using [the shared host service](hosts.md).

The hub owns child grants, limits, operation IDs and launch reservations across
hosts. Remote children retain exactly handoff, manual and sanitized whoami.
A captured remote checkout identity is checked through management and in agent
preparation; the daemon checks it again immediately before PTY creation. The host
also refuses removal during prepared/running launches. Main holds its operation
reservation through launch/removal and rechecks parent authority before spawning.

Remote removal retains trusted confirmation and compares the exact identity and
changes again on the host before deletion, keeping the branch. Unavailable remote
merged-clean proof falls back to review; local auto-removal policy is unchanged.
A lost removal result is indeterminate. Sidebar checkout labels include the SSH
host in text. Session metadata retains actual placement and adds `host` (null for
Local); orchestrator reads also include host resource/agent observations. Host
filters affect rows, not authority. Remote ownership/reattachment after hub restart
follows #757 PR 2. Detached remote review checkouts and developer spike mappings
retain `remote_review_unsupported`.

Registered remote children support the same optional sequential loop (#942).
A read-only `snapshot-worktree` management operation validates registration,
approved folder, canonical checkout membership, creation identity and origin,
then returns only HEAD and a SHA-256 digest. The digest pins branch/origin,
index semantics, exclusion rules and tracked/untracked bytes under the local
snapshot's 10,000-file / 32 MiB limits; bytes never leave the host. Cancellation,
disconnect, unavailable evidence and identity changes refuse advancement.
Main pins each round's evidence, retains the shared forge/capacity/ownership
checks, and sends the pinned snapshot only in the private typed launch protocol.
The daemon recomputes it after preparation and immediately before starting either
the reviewer or resumed author. The captured author conversation and terminal ID
stay in main; only the conversation needed by the provider reaches its resume argv.
Reviewers receive fresh ordinary restricted child grants with exactly handoff,
manual and sanitized whoami, never hub terminal IDs or control credentials.
This adds no remote previews, merge authority or detached-review cleanup exception.

### Retained review evidence (#972)

The author’s review state includes `lastVerdict`, the latest accepted verdict and
its bounded findings as untrusted child-authored data, including at the round cap.
Closing a reviewer discards its screen but retains its handoffs with the owning
parent’s worktree record until that checkout is removed. Reads revalidate checkout
identity and live parent authority; takeover and revocation do not grant access.

### PR continuation and standalone review (#972)

The owning parent's `launch` may reuse its worktree after every prior session
there exited and closed, rechecking the empty checkout at the spawn boundary.
PR numbers and review options persist with owned-worktree metadata and are
inherited on continuation. Failed launches preserve the previous budget state.
Explicit `launch.pullRequest` resolves before spawn; `pr_binding_unresolved`
is a specific refusal, never a delayed “checks not green” escalation. Forge
tracking retains actual checkout identity/branch separately from the validated
PR head branch. Existing head, check, capacity and cancellation gates remain.
New tasks may launch before creating their first PR and bind on first completion.

The orchestrator's `review` mutation composes detached PR creation and one ordinary
Claude launch under a durable outer launch operation. Its key reconciles the
entire action; internal operations have derived keys. It supplies the standard
read-only verdict brief, optional full-SHA `since` and quoted `focus`. It validates
that the detached checkout head matches the resolved PR before launch and checks
cached head evidence again before spawn. It does not attach to any author's loop
or resume an author. The parent reads the handoff and stops/closes the reviewer;
posting requires explicit `postFindings`. See the [mutation contract](../contracts/control-mutations.md#review-continuation-and-explicit-binding-972).
