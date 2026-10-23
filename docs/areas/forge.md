# Forge

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/worktrees.md).

## Forge

### Forge observations

[Forge manifests](../forge-plugins.md) are a second plugin kind, loaded through the
shared `(kind, version)` dispatcher and contained config scanner. Production uses
the build-locked GitHub and GitLab JSON and the same interpreter for config copies. The old
provider survives only as a frozen test reference; recorded-fixture parity passed
before removal from application code. Fork/same-repository decisions and trusted
default-branch refusal remain TypeScript policy.

`ForgeRuntime` connects the catalog, profile settings and discovered login PATH to
tracking, adoption and merged-PR hints. Only enabled entries in the user's exact
`forgeHosts` assignments authorize routing; declarations cannot claim hosts or
trigger fallback. Settings cards show declared executables; the host status list uses the same
`ForgeRuntime.hostStatus` path as first-run T-0. Each bounded, host-only sample
uses `ForgeLifecycle` in a disposable neutral directory, with registry/settings
revalidation and no PR queries. Results contain only fixed readiness categories.
Only hosts from registered repositories’ local remotes are checked; disabled or
unassigned hosts perform no discovery or auth probes. Runtime requests perform
native resolution and mandatory auth preflight. Disabled
or unassigned manifests perform no discovery/probes. First-use board enablement
uses host-only auth preflight through this same lifecycle.

`ForgeLifecycle` supplies disposable neutral working directories, bounded argv
execution, process-tree cancellation and narrowed caching. It revalidates registry,
exact bytes, executable identity and main-owned checkout context before execution,
cached reads and publication. Settings/registry changes retire observations and
number bindings; PATH changes retire the lifecycle. CLI diagnostics never escape.
Batch sizing includes the 16 KiB query, 64 argv entries and 64 KiB total argv caps.
One bounded prefix runs per serial tick, leaving the remainder due. Manifest minima
only slow regular polling, preserving #516's adaptive cadence, one-second discovery
binding follow-up and fleet budgets. Version-1 observation persistence records
provider provenance; legacy numbers are reused only for bundled GitHub after
remote/ownership validation. Optional display enrichment is isolated from status; validated checks-meaning
metadata is published and persisted with observations.

Foom also reads PR and check status for board checkouts and orchestrator-owned child
worktrees through a main-owned forge provider. GitHub and GitLab are supported through your
own `gh` / `glab` CLIs and existing logins; Foom stores no tokens, makes no forge writes and
sends no terminal content. The CLI contacts the selected forge with repository and branch/PR/MR
identifiers to read PR and CI metadata. Unknown remotes and missing, logged-out or
unavailable CLIs leave these fields absent. Validated PR number, head SHA, state
and required-check conclusion appear in session metadata, and `wait_for` wakes on
conclusion changes. gh 2.45.0 uses a read-only GraphQL fallback when
`pr checks --json` fails. Unavailable, malformed or incomplete check results retain
verified PR fields with `requiredChecks: "unknown"`; this is never a successful
conclusion or evidence of an empty required set. Batched queries verify that the
check commit matches the PR head; single-PR adoption lookups retain the final
head/state recheck. The mapping survives restart and a new orchestrator generation,
without transferring authority over old children. Successful reads use the shared repository cadence; unavailable results back off from 60 seconds to at most 10 minutes.
Polling is serial by repository, pauses during sleep and screen lock, and stops on shutdown.
See [the data, persistence and polling contract](../contracts/forge-tracking.md#child-pr-and-required-checks-340).

### GitLab (#522)

The build-locked GitLab manifest uses the same interpreter and lifecycle as GitHub.
`gitlab.com → gitlab` is a default enabled assignment; explicit `forgeHosts`
assignments support self-hosted DNS hosts and nested namespaces. Recorded evidence
uses glab **1.124.0**; this is a tested version, not a minimum-version gate. Absent
executables and failed auth leave observations unavailable without a board error.
Fork adoption compares numeric REST source, target and endpoint project IDs in
Foom. The fork fixture remains synthetic; no real fork capture is claimed.

REST uses numeric IIDs, snake_case and lowercase statuses. GraphQL uses string
IIDs, camelCase, `gid://gitlab/Project/N` IDs and uppercase pipeline statuses.
The batch mapping declares those selectors/encodings; Foom validates canonical
positive safe integer IDs and requires source = target = queried project ID.
Discovery checks remain unknown until the next bound sample. GraphQL errors,
partial discovery connections and stale pipeline SHAs cannot produce success.
Batching retains one bounded prefix per serial tick with no per-MR fallback loop.
Ordinary REST lookup/resolve/refresh/checks remain available for single-MR callers;
check-plan fallback runs only on command failure or invalid JSON.

The conclusion means **head pipeline**, not GitHub branch-protection-required
contexts. A pipeline counts as one board check. Status mapping (GraphQL uses the
uppercase equivalent):

| Pipeline status | Conclusion |
| --- | --- |
| `created`, `waiting_for_resource`, `preparing`, `pending`, `running`, `manual`, `scheduled` | pending |
| `success` | success |
| `failed`, `canceled` | failure |
| `skipped`, explicit null head pipeline | none |
| missing pipeline, unknown status, mismatched SHA | unknown |

Recorded manual means a blocking manual job (`allow_failure: false`), hence
pending. Rules-omitted jobs do not imply a skipped pipeline; the recorded !5 is
success. !9 records a genuinely skipped pipeline. Additional statuses above are
constructed test cases. Single-MR checks always finish with an identity/head/state
refresh. MR titles are inert text; branch values stay argv/GraphQL variables.
Manifest display metadata supplies “Merge request”/`!`; GitHub retains “Pull
request”/`#` in board marks, panels and completion notifications.

Merged GitLab cleanup reads REST `merge_commit_sha` and `squash_commit_sha` as
separate optional hints, each exactly 40 lowercase hex characters. The manifest
language has literal selectors, not ancestry-aware fallback expressions. Main
tries both validated hints and requires local head-integration proof as well as
ancestry from the freshly fetched default: either the exact head is an ancestor
of the hint, or the conflict-free merge of a single-parent hint's parent with
the exact head must produce precisely the hint's tree OID. The latter uses
`git merge-tree --write-tree` in a disposable repository with fixed attributes
and config, not position-insensitive patch IDs. All ancestry/parent/tree proofs use
that same isolated repository; every workspace Git call disables replacement
objects and grafts, including source HEAD reads and final auto-removal rechecks.
Alternates share objects without importing local history overlays. Unrelated/stale hints, moved
repeated-block edits, unavailable/ambiguous merge bases, conflicts, malformed
output and Git errors cannot authorize cleanup. Exact-head, same-project, stable-refresh, clean-checkout
and identity guards remain required. This covers squash-only merges (null merge SHA), separate merge
and squash commits, and a non-ancestor merge SHA with a reachable squash SHA.
GraphQL maps `mergeCommitSha`; no unsupported `squashCommitSha` field is requested.
Cleanup uses the ordinary REST plan, where both fields are available. #718's
reduced envelopes omit merge/squash SHAs; these test additions are synthetic,
including the offline real-Git squash regression, not additional live captures.
