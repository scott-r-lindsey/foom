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
contracts; `Workspace` supplies main's
existing effects (worktree creation, agent launch, stop, close, host tail, removal) and
the service delegates `create_worktree`, `launch`, `stop`, `close`, `remove_worktree`,
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
New child launches send a background placement event to the parent's board (or the
current board when hidden). The renderer queues it until inventory arrives, uses
sidebar placement without replacing the current tile, and preserves focus. Restore
sends no placement event. `close` accepts only owned, exited children and delegates
to the normal sidebar close path; the final screen is discarded while the checkout,
branch and review state remain.
