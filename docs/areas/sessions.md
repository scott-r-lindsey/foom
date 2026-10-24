# Sessions

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/sidebar.md).

## Saved conversations

Checkout panels parse pasted resume lines locally; raw pasted text never crosses IPC.
`workspace:sidebar-command` accepts `{kind: "resume-id", checkout: {repository, worktree},
agent, id}`. Main validates the exact shape, agent, conversation ID, registered checkout
identity and current agent availability. The ID uses the shared `conversationId` validator;
`resumeArguments` and the reserved launch-default selector rules still own argv construction.
The conversation ID is not a terminal ID and grants no terminal ownership capability.
Per-conversation launch serialization prevents duplicate concurrent pastes across checkouts.
An existing live session is revealed through main's window-aware navigation. Otherwise the
usual manual launch path creates a row with the pasted ID, fresh hooks and credentials,
current defaults and shared-checkout confirmation. Hook events pin against that ID. CLI
rejection exits the row normally and keeps the ID; no agent transcript or runtime file is read.


`restoreSessions` defaults to `true`; disabling it keeps saved rows dormant for manual resume. Screens and scrollback are never persisted.

`src/main/workspace/session-owner.ts` owns session restoration and persistence behind
`SessionOwner` and its typed capability dependencies. It holds saved records,
restoring IDs, roles that could not be restored, repository identities, the shared
restart promise and the quit freeze. `WorkspaceContext` delegates loading, restart,
saves and quit preparation, and queries restore markers for inventory and launch/
removal guards. The owner restores handoff history, re-grants parent authority and
restores child relationships through the orchestration capabilities. Its launch
adapter calls the coordinator's bound home/checkout paths in `worktree-launch.ts`
and config path in `sidebar-commands.ts`; launch/removal locks, terminal queues
and cancellation remain in `workspace-context.ts`. Execution and
verdict state belong to `ExecutionOwner`. No owner receives the facade or coordinator object
or owns PTYs or terminal views.
Quit preparation waits for restoration, freezes and flushes the running records
before PTYs stop; failed preparation or cancelled quit re-enables persistence.
The coordinator still releases agents and control/hook services after terminals stop,
then asks the owner to drain session writes.

Main writes ordered, atomic replacements of private `sessions.json` in the active
profile through `SessionStore`. It stores terminal ID, agent, registered repository, worktree, branch and
validated conversation ID, last known running state and main-owned orchestration provenance (repository identity, parent relationship, bounded action history, owned worktree paths/identities and unused/used state, plus the uncertain-creation budget). Credentials and terminal contents are never stored. Loading validates bounded records and rejects
malformed IDs, paths, agents and duplicate terminal IDs. Unregistered repositories keep exited rows without launch authority. With restore enabled, eligible running records launch after all saved windows are shown, at most three at a time, with parents first and shared checkouts serialized. Every launch uses the manual resume path and fresh credentials; views attach only once the new host exists. Orchestrator re-grants additionally require the saved repository identity, supported per-launch MCP and provider restore capability (bundled Claude Code/Codex, or a valid v2 config provider declaring it); see [provider loading](providers.md#agent-provider-registry-and-manifest-approval-407) and [orchestration](../contracts/control-identity.md#identity-and-capability-model). Restoring a parent validates every owned checkout against the live Git inventory: it must still be a Foom-managed linked worktree in the parent's repository, with matching checkout identity; main, missing, foreign and replaced checkouts grant no ownership. Restored children, including already exited children, recover owned worktrees as used; legacy records without an ownership list use the child path and the host's current branch and identity. Unused owned worktrees remain launchable after restart, within the four-worktree unused budget; used worktrees cannot be launched into again. In-flight launches are saved as used to prevent reuse after an ambiguous shutdown. Restored running children still count against the configured child limit. Shutdown freezes the running records before terminating PTYs, so shutdown exits cannot overwrite the saved state.

Resume and New conversation retain the terminal ID. Main drains the previous
terminal's evaluation queue, removes its exited host screen and launches a fresh
PTY under that ID after the usual worktree/confirmation checks. An existing live
host ID cannot be reused. The renderer hides/releases the old view before the
command; the ID-scoped availability event carries an optional reset marker on
creation so controllers discard old exit state. A launch version in the board
snapshot reattaches surviving tile controllers without remounting xterm. Every
launch that reuses an ID advances it, shells included, because the renderer
advances its row on reset and ignores snapshots older than that row. Failed launches leave the saved
record dormant and retryable. Close deletes the record, without touching Git.
All terminal-ID sidebar commands validate the sender and ownership in either the
host or main's restored inventory. Copy uses main's clipboard capability and the
stored ID, never caller-provided clipboard text. Shutdown drains pending writes.

## Conversation signal validation

The authenticated receiver captures Claude `session_id`, Codex `thread-id` and
Antigravity `conversationId` from supported hook/notify events. IDs must be 1–200 ASCII letters, digits,
underscores or hyphens, starting with a letter or digit. Options, paths, whitespace,
control characters and shell syntax are rejected. Each launch pins its first ID;
mismatched subsequent events are rejected. IDs are local metadata, never model input.
No transcript or agent runtime file is read. Codex notifies at turn completion;
if it exits or updates before any notification, Foom cannot recover an unknown ID.
Hooks-disabled launches likewise cannot capture an ID.

## Antigravity resume

Resume supplies `--conversation` and the validated ID as separate arguments with current defaults and fresh credentials. Without plugin events, no new ID is captured. A normal manual launch pins the first observed ID: if the CLI starts a new conversation for an unknown ID, that new ID replaces the saved one. Pasted IDs retain their stricter requested-ID pin. The CLI warning stays visible. [Probe evidence: #249](https://github.com/scott-r-lindsey/foom/issues/249).

## Restored tile placement (#732)

Sessions that exited before quit keep their sidebar rows and Resume/New conversation
commands, but their saved board assignments become empty spaces: no screen or
scrollback exists to draw. Disabled or ineligible restores likewise stay in the
sidebar. Eligible running sessions keep their saved tile positions while queued
and relaunched. Restoration failures and roles that cannot be restored lose their
tile assignment and retain the existing sidebar error state. Manual resume uses normal
launch placement. [Board loading](board.md#restored-tile-placement-732) owns the
attachment readiness gate and loading presentation.
