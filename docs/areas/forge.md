# Forge

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/worktrees.md).

## Forge

### Forge observations

[Forge manifests](../forge-plugins.md) are a second plugin kind, loaded through the
shared `(kind, version)` dispatcher and contained config scanner. Production uses
the build-locked GitHub JSON and the same interpreter for config copies. The old
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
worktrees through a main-owned forge provider. GitHub is supported through your
own `gh` CLI and existing login; Foom stores no tokens, makes no forge writes and
sends no terminal content. The CLI contacts GitHub with repository and branch/PR
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
