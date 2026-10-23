# Worktrees

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/worktrees.md).

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom creates worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added. Listing includes all Git worktrees, including external ones; confirmed removal supports linked worktrees created by any tool.

**Today:** `src/main/workspace/worktrees.ts` provides the main-process `WorktreeService`, independently of the UI and IPC. Add a repository before listing or modifying its worktrees. It canonicalizes repository paths, lists NUL-delimited Git records, checks out existing branches or creates new ones, and delegates dirty/locked removal checks to Git. Force allows dirty removal but does not override locks or target validation. All Git-registered linked worktrees of an added repository can be managed, regardless of creator or location. Direct removal validates the same Git membership and filesystem identity as confirmed removal. Adjacent trees use `<repo>-<branch>` (branch slashes create subdirectories). Creation checks resolved parent directories against the allowed root and rejects existing destinations. Creation history records the device, inode, and birth time of the worktree directory, its `.git` file, and its resolved Git metadata directory. Listing revalidates creation history; missing or replaced entries invalidate that history. Removal captures a fresh identity and rejects replacement during confirmation or validation, including for forced removal. Removal rejects redirected paths. `removeRepository` forgets registration and creation history without deleting any checkouts. Workspace-level guards still refuse removal while sessions or operations are present. These checks do not provide isolation against another local process concurrently replacing filesystem entries.

At startup, main opens the service with `WorktreeService.open(app.getPath("userData"))`. Repository registration and historical creation records are stored in versioned `worktrees.json` using a private temporary file and atomic rename; writes are serialized within the service. Startup validates the untrusted state, rechecks repository paths, allowed roots, Git membership, and filesystem identity, and drops stale or redirected entries. Corrupt or unsupported state grants no repository registration and does not block startup. Registration, creation, removal, and history invalidation await persistence; write failures are reported to the caller. The synchronous constructor remains available for an explicitly in-memory service. The renderer reaches it through the `workspace:*` channels. `workspace:create-worktree` validates the branch in main; a branch already checked out is reported as `open` and not added again, an existing local branch is checked out, a branch only on the repository's remote (origin, or its only remote) is created with `--track -b <branch>` from its full `refs/remotes/<remote>/<branch>` ref, and anything else starts a new branch from HEAD. `workspace:start` validates the branch in main and creates a worktree at the configured location or reuses an existing Git checkout of that branch. A failed launch leaves the worktree available for retry with the same branch. `workspace:remove` takes a terminal ID; sidebar removal takes a registered repository and worktree path. Main validates Git membership, canonical paths and locks, excludes the main checkout (including when a linked checkout is registered as the repository), captures filesystem identity, and requests click-again for a clean checkout or a trusted dialog naming uncommitted changes from NUL-delimited Git status. Cancellation preserves the terminal and files. Main rechecks identity and status after confirmation, stops the worktree’s terminals and waits for native exit, then rechecks identity and status again before removing the directory; the branch is kept. Changed files require a fresh review. A refusal retains the exited terminal screen and capability for inspection, restart, or another removal attempt. Capabilities are revoked only after successful removal. Dirty removal is authorized only by that confirmation, never by a renderer force flag. Failed removal leaves the row available for retry. Operations on the same repository/branch are serialized. State assumes a single application service writer; it is not a security boundary against a local process able to forge the entire state file. The `managed` inventory field is historical creation metadata, not authorization. Git membership and canonical identity, rather than a directory location or creation record, determine eligible targets. Existing version-1 profiles remain readable. Repositories sharing a basename share a destination namespace; a collision fails without overwriting the existing directory.

Identity bookkeeping resolves the checkout's own `.git` directory or `gitdir: `
file in-process, then records the same canonical metadata path and fresh
`lstat` device/inode/birth-time tuple. Marker reads are limited to 64 KiB,
reject malformed files, and check marker type and size before opening. The opened
descriptor is checked again to catch replacements. Reads close descriptors on failure
and use nonblocking opens with `O_NOCTTY` on POSIX. Relative marker paths resolve from the checkout.
The service does not cache identity reads or worktree listings. Concurrent sidebar
requests share only a pending app-wide inventory read, including its Forge checkout
validation. Completion or failure discards it; workspace refresh and settings changes
invalidate it immediately for later callers. Each window still projects its own
preview registry after the shared read completes. Listing rechecks every
managed checkout without spawning Git for each history record. Launch and removal
still query Git for membership and canonical common-directory agreement, and
retain their redirected-path, locked/prunable, identity and confirmation checks.

`src/main/workspace/cleanup-owner.ts` owns merged-worktree eligibility scans,
cached plans, live cleanup runs and their inventory progress/tombstones behind
`CleanupOwner` and a narrow typed dependencies interface. It coordinates repository
forgetting, idle/owned worktree removal, automatic-removal policy and revalidation,
terminal stop/exit/removal callbacks and checkout-resource release. It receives
capabilities, never the facade or coordinator object. `WorkspaceContext` in `workspace-context.ts` keeps the shared repository
and branch launch/removal locks, terminal queues and cancellation; the cleanup owner
acquires those locks through callbacks that hand back an idempotent release
capability for that acquisition. Execution and verdict state live in
`ExecutionOwner`. Successful merged removals hold the shared branch locks until the checked-ref transaction finishes.
Session restoration and persistence remain in `SessionOwner`. The coordinator preserves
shutdown order: after PTYs stop, it marks itself closed and aborts launches, then
asks cleanup to stop scheduling and drain active runs before releasing watchers,
agent/control/hook services and session writes. Superseded background scans cannot
publish after repository removal or shutdown.

Sidebar inventory never awaits remote merge checks. Main caches eligibility for
one minute, starts a background scan for a new local worktree/session inventory
or an expired result, and emits a workspace change when it finishes. Matching
in-flight scans are shared; superseded scans, removed repositories and disposed
workspaces cannot publish late results. Git status reads use `--no-optional-locks`
so index refreshes cannot race deletion of per-worktree metadata. Cleanup reuses a completed plan younger than 60 seconds for presentation; otherwise
it opens checking before awaiting the fresh plan. Approval always fetches afresh.
Fetch operations are queued per repository, including background and explicit scans.
Each waits for both subprocesses to settle before releasing the queue on failure.
Default discovery runs `ls-remote --symref` alongside `fetch --prune`, then tests
the advertised commit with `cat-file -e`. Only an absent object needs the explicit
default-ref fetch. Either failed network operation refuses cleanup.

Merged cleanup uses the same removal sequence with an additional main-owned
revalidation callback. Candidate path, filesystem identity, branch and commit
are captured before the trusted dialog. Revalidation passes check Git membership and captured identity,
session eligibility, clean status and either `merge-tree` containment against a freshly
fetched default commit or a locally verified PR merge. The latter uses the existing
forge lookup for a same-repository MERGED PR, requires its head SHA to equal the
worktree HEAD exactly, validates the optional `PullRequest.mergeCommit` ID, and runs
`git merge-base --is-ancestor <mergeCommit> <fetched-default>`. Forge hints alone
never authorize removal; missing objects, mismatched heads and failed checks refuse.
Every removal rechecks this evidence. Automatic removal uses this verified PR path
alongside its existing ancestry/no-unpushed-commits path, preserving clean status,
identity, session and authority guards. A failed post-confirmation fetch prevents every removal.
Main owns one `CleanupRun` per repository. While it is pending, inventory does not
start background eligibility scans. Before deletion begins, cleanup drains all
existing scans, including superseded scans whose results will be discarded, so
Windows directory handles held by their Git processes cannot block removal.
Four workers run the existing removal
path, retaining its revalidation passes. Successful removals retain their branch
launch locks through the ref transaction so Foom cannot recreate those branches
while they are being deleted. Failed candidates release their locks immediately. Git removes
separate per-worktree admin directories and checkout indexes; these operations
need no shared main-index write. Status disables optional index locking; merge-tree
writes content-addressed objects. Persistence remains serialized by the service.
After all workers finish, a single `update-ref --no-deref --stdin` transaction
serializes shared ref/packed-refs mutation using Git's ref locks. It compares each
checked SHA, excludes moved and checked-out branches, and retains all transaction
refs if a concurrent change prevents commit.

The sidebar inventory carries main-owned total, done, phase, stopped and fixed
per-worktree states/reasons. Removed rows remain as presentation tombstones to
fold away. `CleanupFeed` is a main-only subscription capability, stripped before
sending any dialog request. The trusted window receives branch labels and opaque
row IDs, never cleanup paths. Its existing ID-scoped, exact-window/top-frame/URL
validated boolean answer approves only a ready plan, stops only an active run,
or closes the presentation. Checking cannot approve. Main publishes current state
on the existing render channel; stale IDs and non-boolean payloads are ignored.
Hide/close/Escape unsubscribe without stopping; reopening subscribes to the same
run. The repository reservation lasts until workers settle, including while hidden.
Shutdown stops scheduling new removals and waits for in-flight work.
As with ordinary removal, this does not isolate concurrent filesystem mutations
by external local processes. Fetches disable interactive credential prompts and
Git commands have a 30-second process deadline.

## Pruning stale worktrees

`prune-worktree` is a validated sidebar command naming a registered repository and
its recorded checkout path. Main refuses sessions in that checkout. WorktreeService
requires a current unlocked prunable Git entry, rejects the main checkout, and
checks the leftover folder before running fixed `git worktree prune` arguments
through `execFile` in that repository. It checks every path component with `lstat`,
canonical containment strictly under the managed root and absence of any `.git`
entry. It rechecks the folder's identity after Git returns before removing only
that folder. Missing folders need no deletion. Branches are never deleted. As
with normal removal, this does not isolate filesystem entries from another local
process replacing them concurrently.

## Additional group cleanup candidates (#729)

The existing explicit removal contract above is unchanged, including external
linked checkouts and trusted confirmation of tracked changes. Group cleanup also
accepts detached HEADs and untracked-only leftovers. These additional candidates
must resolve strictly inside Foom's configured worktree root, pass ordinary
membership/identity/lock checks, have no tracked changes and have zero commits
absent from local remote refs (`rev-list HEAD --not --remotes`). Git errors refuse
eligibility. The existing freshly fetched default and merge containment checks
still apply. Clean branch candidates keep their established policy.

The main-owned plan captures the complete NUL-delimited status. The trusted
cleanup dialog lists up to 50 untracked paths per checkout, truncates long paths,
and names the accept action Force delete when any candidate needs it. Revalidation
compares the entire status with the approved snapshot and repeats the additional
checks around terminal and preview shutdown. The service invokes a final approved
snapshot check after its asynchronous identity check, immediately before invoking
Git removal. Clean snapshots use ordinary Git removal without `--force`. Detached
candidates share the existing null-branch reservation, so a group serializes their
removals and releases that reservation
after each one; there is no branch ref to delete. The later ref transaction holds
only the release capabilities of retained branch reservations, so it cannot release
a newer detached removal reservation.

Known prunable inventory entries return unavailable panel facts without raising
`worktree-prunable`. Their sidebar rows say Broken checkout and offer only
Clean up, which reuses the guarded prune command above. Sessions must be closed
first. The coded-error Prune recovery remains available for a checkout that became
prunable after its row was rendered.
