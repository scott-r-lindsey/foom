# Forge Tracking

## Child PR and required checks (#340)

Forge tracking, adoption and merged-PR hints use the bundled GitHub and GitLab manifests through
the shared lifecycle. Recorded-fixture parity passed before the production legacy
provider was removed; its frozen test-only reference preserves comparisons.
Configured copies use the same interpreter. Main owns fork/same-repository and
default-branch refusals, exact enabled host assignments, auth/executable validation,
cancellation and publication checks. The batch plan composes GraphQL ASTs with
branch variables, numeric bindings and separate all/required check reductions.
Large requests run as bounded prefixes on successive serial ticks. A failed chunk
hides stale observations and backs off the whole repository, including its
unsampled suffix. Manifest minima
only slow regular polls; #516's discovery follow-up, adaptive cadence and budgets
are preserved. Optional display enrichment cannot change verified status; checks-meaning metadata
is published and persisted with observations. See [the forge contract](../forge-plugins.md).

Main tracks branches in every registered repository’s board checkouts and in orchestrator-owned worktrees, choosing a read-only
forge provider from the repository's origin URL (or its sole remote). GitHub on
`github.com` is supported first, through the user's existing `gh` login. Unknown
hosts, missing or logged-out CLIs and unavailable/malformed PR results omit PR
metadata; they do not fail a control request. Unavailable check results preserve
verified PR fields with an `unknown` conclusion. No additional opt-in is required by
the 2026-10-13 decision. GitLab now uses the bundled glab manifest; explicit host assignments support self-hosted instances. See [GitLab semantics](../areas/forge.md#gitlab-522).

The provider’s single-PR branch lookup is reusable by #337; repository polling uses the batched contract below. It runs only fixed `gh pr list`,
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
fixed state, optional validated `checksMeaning` and `requiredChecks` (`pending`, `success`, `failure`, `none`, `unknown`). Cancelled
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
with unknown checks refreshes at the active polling interval and changes session
revisions when its conclusion recovers. The single-PR lookup’s final head/state recheck is required
for every conclusion, including `unknown`; batched reads compare the head SHA with
the check commit inside the same GraphQL response. Newer gh versions keep the existing
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

Board and child observations share one tracker. Repository polls use one bounded
`gh api graphql` command with branch variables and validated numeric PR aliases.
Discovery requires one open same-repository head and excludes the repository’s
reported default branch. Bound PRs retain CLOSED/MERGED observations. The query
returns title (plain text), head, state and at most 100 check contexts per head;
partial pages or invalid head/check data yield unknown checks. Board counts include
all checks; orchestration conclusions include only required checks. Newly discovered
numbers bind on the following scheduler tick; until then required checks are unknown.
This avoids guessing required status from optional checks. Existing single-PR lookup
and its compatibility fallback remain available for adoption.

Polls run every 20 seconds while checks run or are unknown, every two minutes when
settled, and every ten minutes when no PR matches. Failed repository reads retain
60, 120, 240, 480 and 600-second backoff. Polling is serial, with one repository
per scheduler tick and no overlapping processes. Sleep and screen lock pause it;
both must clear before resuming. Agent idle and exit transitions request an immediate
read. Main validates checkout identity and branch before polling; removal or
replacement retires observations. Shutdown stops polling. Tracking remains bounded
to 1,000 checkouts and command output to 256 KiB.

Settings → General → Show pull requests and checks defaults from the first
selected enabled forge CLI auth preflight (`gh auth status --hostname github.com`
for the default assignment). Its shared disclosure names the selected CLI, existing
login and read-only repository/project, branch and PR/MR metadata requests, with no
terminal content. Disabling it hides board observations and
stops non-orchestrator polling; orchestrator metadata and `wait_for` remain active.

A private, atomically written version-1 `control/forge.json` envelope stores checkout identity, branch,
remote, manifest provenance and the narrowed PR mapping separately from launch grants. It survives app
restart, parent exit and a new orchestrator generation; saved data grants no
capabilities and remains absent from public metadata until ownership and the forge
result have been checked again. Local worktree paths and identities never enter
MCP results. The CLI contacts GitHub using its own authentication and sends only
repository, branch/PR identifiers and read-only status requests. Foom stores no
tokens, makes no forge writes and sends no terminal content. No terminal/model
output is used to discover PRs.

Automatic session close reads a main-only settled observation: `recheck` invalidates
this evidence synchronously, while cached display metadata remains available.
Single and batched completions carry the request generation. Older responses do
not settle a newer request; only the latest successful sample can authorize close.
Completion invalidates child metadata even if PR fields are unchanged, without new
polling or requests. Missing, unavailable or pending evidence refuses auto-close.

Each exit records the tracker's main-only request clock. Close evidence must come
from a request started after that marker as well as settling the latest recheck.
This also refuses cached data when exit publication precedes the queued refresh
callback, and refuses an older request that completes after exit. Markers are
reset for resumed launches and never persisted or exposed through IPC.

An eligible exited child awaiting fresh evidence registers cancellable local interest
in its exit marker. A successful single or batched read that settles that marker
consumes the interest and invalidates child metadata once, even when PR fields and
the recheck generation are unchanged. This includes already-exited children restored
after a cached read. Eligibility changes cancel stale interest. Unchanged periodic
reads without waiting children publish nothing; registering interest adds no timer,
poll or forge request.

## Registered remote checkouts (#940)

Remote child observations bind the registered SSH alias, approved code folder,
canonical clone and worktree paths, creation identity, actual branch and the local
repository's origin. Host decoration is display text only. The typed management
inspection checks membership, identity and origin on the host and returns bounded
branch/HEAD evidence. The hub rechecks registration and its own origin before and
after inspection. Forge requests still use the hub's selected local CLI and its
existing login; credentials and local checkouts are never copied to the host.

The shared tracker publishes remote PR/check changes through board, session and
child-event metadata. Equal branches on different hosts retain separate checkout
bindings, even when their remote paths match. Remote HEAD and binding evidence are
revalidated before publication; a push racing a query suppresses that sample.
Disconnect, revoked registration or changed identity/origin hide facts and back
off. Retained private bindings permit a later valid observation and restart
revalidation, but never restore grants or authorize a host. Missing remote HEAD
or origin evidence fails closed. Local sidebar scans never inspect opaque remote
checkout IDs as local paths. No merge authority, remote review snapshots or
automatic remote worktree removal is added.
