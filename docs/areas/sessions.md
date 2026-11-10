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
restoring IDs, roles that could not be restored, the shared
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
validated conversation ID, last known running state and main-owned orchestration provenance (repository-root and parent-checkout identities, parent relationship, bounded action history, owned worktree paths/identities and unused/used state, plus the uncertain-creation budget). Private registered-host checkout locators (remote repository, worktree, branch and identity)
also survive exit/tombstone expiry, are validated on load and are never projected
to the renderer. They revalidate against the registered host/code folder and live
Git identity before granting worktree ownership or relaunching. Credentials and terminal contents are never stored. Loading validates bounded records and rejects
malformed IDs, paths, agents and duplicate terminal IDs. Unregistered repositories keep exited rows without launch authority. With restore enabled, eligible running records launch after all saved windows are shown, at most three at a time, with parents first and shared checkouts serialized. Local launches use the manual resume path and fresh credentials; remote sessions
reattach existing daemon PTYs through [profile-scoped recovery](hosts.md#persistent-remote-sessions-757-pr-2); views attach only once the new host exists. Orchestrator re-grants additionally require the saved repository-root and parent-checkout identities to match their respective paths, supported per-launch MCP and provider restore capability (bundled Claude Code/Codex, or a valid v2 config provider declaring it); see [provider loading](providers.md#agent-provider-registry-and-manifest-approval-407) and [orchestration](../contracts/control-identity.md#identity-and-capability-model). Restoring a parent validates every owned checkout against the live Git inventory: it must still be a Foom-managed linked worktree in the parent's repository, with matching checkout identity; main, missing, foreign and replaced checkouts grant no ownership. Restored children, including already exited children, recover owned worktrees as used; legacy records without an ownership list use the child path and the host's current branch and identity. Unused owned worktrees remain launchable after restart, within the four-worktree unused budget; used worktrees cannot be launched into again. In-flight launches are saved as used to prevent reuse after an ambiguous shutdown. Restored running children still count against the configured child limit. Shutdown freezes the running records before terminating PTYs, so shutdown exits cannot overwrite the saved state.

Resume and New conversation retain the terminal ID. Main drains the previous
terminal's evaluation queue, removes its exited host screen and launches a fresh
PTY under that ID after the usual worktree/confirmation checks. An existing live
host ID cannot be reused. The renderer hides/releases the old view before the
command; the ID-scoped availability event carries an optional reset marker on
creation so controllers discard old exit state. A launch version in the board
snapshot reattaches surviving tile controllers without remounting xterm. Every
launch that reuses an ID advances it, shells included, because the renderer
advances its row on reset and ignores snapshots older than that row. Failed launches leave the saved
record dormant and retryable. Close deletes the record after cleanup. Owned review worktrees retain their existing trusted removal policy.
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

## Exit observation and release (#767)

`session-lifecycle.ts` owns immutable exit facts per invocation. Host observation
synchronously releases config/probe/agent resources once and notifies orchestration
to revoke authority, before execution transitions or asynchronous evaluation.
Removal uses the same release path; duplicate exits retain the first exit code.
A removal tombstone rejects delayed exit notifications until an explicit invocation
reset. Config credentials bound after an early host exit are revoked at binding.

The terminal queue then publishes exit metadata (`inventory-settled`), persists the
row and runs final classification. Completion advances the internal fact to
`evaluation-settled`. Inventory retains its existing timing: host observation alone
does not mark the row exited; dormant saved/failed launches remain separate from
live host facts. Orchestration consumes the synchronous host observation while
snapshot projection consumes inventory-ready facts. Review stop acknowledgements
still distinguish signaled exits from natural exits and wait for inventory readiness.

Resume resets lifecycle facts with execution state after draining the old queue.
Queued exit work captures the execution invocation identity; reset or removal
invalidates it before it can set exit metadata or classify a replacement invocation.
Completion of old evaluation likewise cannot settle a replacement lifecycle fact.


Manual tile Resume and restart use the same provider capability gate, including
refusal of config-origin providers using built-in IDs. The new #1081 manual Resume
consent is app-lifetime state supplied only by the trusted human grant. Restart
restoration does not infer it from a saved role; after such a restored session exits,
its manual Resume is ordinary until the human explicitly re-grants with the current
disclosure. Re-grant ownership recovery promises are limited to retained records
before Foom restarts. See [orchestration](orchestration.md#same-session-resume-and-re-grant-1081).

## Background Close (#1048)

`WorkspaceContext.closeSession` publishes `closeState: "closing"` before awaiting
filesystem or SSH cleanup, then awaits session persistence before destructive work.
The launched record remains in main's inventory and retains its remote placement;
the board source alone omits it. Terminal input and attachment are blocked through
the main-only `setClosing` capability. Busy-session and checkout reservations
prevent duplicate actions and launch/removal races. The original Close promise
settles only after cleanup; failures restore a `closeState: "failed"` row.

SessionStore persists the close marker. Quit freezes it with the existing session
records before terminal shutdown, without adding a cleanup wait to the shutdown
budget. On restart either saved marker becomes a visible failed, dormant row; it
never automatically relaunches or repeats deletion. Remote discovery cannot
replace that recovery record. This retains the remote locator for explicit retry
when its host is reachable. A cleanup that completes after the quit freeze may
leave a conservative recovery row; retry still uses the original live membership,
identity and deletion checks.


## Forgotten hosts (#1152)

Before importing saved rows, SessionOwner prunes remote placements whose host is
no longer registered and awaits the repaired sessions.json write. This also cleans
profiles left stale by older builds, with Restore sessions disabled as well as
enabled. Host removal awaits the same inventory/persistence repair. Late remote
discovery cannot import rows while their host is unregistered. Live attached tiles
remain usable until exit or Close; all saves in that app run, including quit,
exclude them, and exit removes their rows. The in-memory removal mark still excludes
those specific tiles if the host is re-enrolled before they exit, so their old
authority cannot be re-persisted in that run.

There is no durable suppression of daemon discovery. After re-enrolling the same
host and restarting Foom, any of this profile's sessions still live on its daemon
but absent from saved records are recovered under [profile-scoped recovery](hosts.md#persistent-remote-sessions-757-pr-2).
These are human-owned tiles with no prior parent/child links, control grant,
orchestrator role or owned worktrees. Forgotten exited sessions are absent from
both saved records and live discovery and do not return. Retained Close recovery
rows keep the exception below.

Runtime exit pruning requires the explicit in-memory removal mark: developer-spike
sessions whose host was never registered retain their ordinary exit/resume behavior in this
app lifetime. A host named by a currently validated, explicit developer spike
override also retains its saved metadata for manual Close recovery; this does not
register it or grant saved restore/fleet authority. Other unregistered placements
are still pruned at startup.
No pruning step sends remote stop, kill or session-close or closes a live connection.

Dropped parents confer no saved authority: surviving records lose their parentId.
Runtime row removal uses normal orchestration retirement and child removal. Owned
worktree provenance and used state on surviving parents remain intact, including
archived reviewer reports: forgetting a session is not permission to delete or reuse
its checkout. Independent worktree-removal retry records are untouched.

Exception: pending/failed Close records retain their row, remote locator and cleanup
marker even if the host is missing. They protect unfinished destructive cleanup
under Background Close; dropping them would silently lose the explicit retry.
Startup presents them as failed/dormant and never retries automatically. Re-enroll
the same host before explicitly retrying Close, with the existing membership and
identity checks. This exception also covers Close racing registration removal.
