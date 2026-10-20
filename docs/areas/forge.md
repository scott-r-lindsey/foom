# Forge

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/worktrees.md).

## Forge

### Forge observations

[Forge manifests](../forge-plugins.md) are approved as a second plugin kind. The first
#521 stage adds the shared `(kind, version)` dispatch path, strict offline forge
validation, a build-locked GitHub manifest and a transport-injected interpreter.
The current GitHub provider remains active while side-by-side fixture tests prove
parity. The new interpreter receives argv-array transport from main; it cannot
resolve or spawn a CLI itself. Fork/same-repository decisions and trusted
default-branch refusal remain TypeScript policy. Settings now exposes forge cards
through the main-owned config status catalog, including fixed rejection reasons.
Profile-only `forges` and `forgeHosts` maps use the settings store atomic writes
and runtime parser. New host assignments require an enabled catalog entry; stale
assignments remain unavailable without fallback. Setup IPC checks the owning app
top frame, and host syntax is validated only in main. These preferences do not
change active polling. The inactive `ForgeLifecycle`
service now supplies native executable resolution, disposable neutral working
directories, bounded execution and process-tree cancellation, auth gating, narrowed
result caching and explicit invalidation. It revalidates registry membership, exact
manifest bytes, executable identity and the main-owned worktree context before
execution and publication, including cached reads. CLI diagnostics never escape
this boundary; consumers receive only fixed execution states and mapped metadata.
`ForgeRuntime` now wires the config scanner’s registry callback and profile
settings invalidation to tracking and adoption, with discovered login PATH supplied
by main. Its internal constructor selection defaults to the old provider; there
is no user-visible switch. Only parity tests select manifests. Host routing uses
only enabled entries in the user’s `forgeHosts` assignments, never manifest host
claims or inferred fallback. Registry/settings changes cancel samples and retire
tracking observations and number bindings. Main-owned lazy context closures
revalidate registration, filesystem identity, branch and remote at the lifecycle
boundary; tracking additionally guards publication with a selection generation.
Legacy selection does not discover executables or evaluate manifest contexts.
Large-request scheduling within manifest bounds (including slowdown-only minima),
optional display/checks-meaning metadata, versioned persistence and production
activation/removal of the old provider remain integration work. The interpreter
supports declarative dynamic batch AST composition and check-count reduction with old/new offline parity tests;
activation remains gated on the remaining scheduling, metadata and persistence work.
#516's adaptive cadence and dynamic check-count batches are unchanged.

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
