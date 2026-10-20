# Control

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Control plane

**Foundation implemented in #152.** `main/control/` owns the service, launch grants,
versioned HTTP adapter, private discovery, operation records and audit storage.
The workspace starts it when the window is composed so human pairing is available before an agent launches. A failed startup leaves the window usable and can retry on agent launch.
Launches receive the `agent` role; only main changes it, when the human makes a
running session the orchestrator or revokes it (#303), or when restore re-grants an
orchestrator (#155). The read methods are `whoami`, `sessions`,
`session_state` and actor-scoped `operation_status` (orchestrators only). Unknown
methods, role/force flags and unknown fields fail closed. Orchestration methods are
described in the [orchestration contract](../contracts/control-mutations.md).

`POST /control/v1` requires `Authorization: Bearer <token>` and a JSON envelope
`{ version: 1, instanceId, method, params }`. Identity takes empty params; operation
lookup takes exactly one of `operationId` or `idempotencyKey`. Every request checks
the live grant and app-instance ID, including after receiving its bounded body.
Responses contain `{ result }` or a fixed `{ error }` code. The adapter enforces
8 KiB headers, 64 KiB bodies, 32 connections and four outstanding requests per
grant, with five-second transport deadlines. Policy and role checks stay in the service.

Launch environments carry `FOOM_CONTROL_URL`, `FOOM_CONTROL_TOKEN` and
`FOOM_CONTROL_INSTANCE`; `FOOM_SESSION` correlates with hooks when attached.
Control tokens remain unavailable until main binds the terminal ID. The host
scrubs inherited `FOOM_*` and `CLAUDECODE` on every spawn before adding main's
fresh launch environment. Early exit before launch completion also revokes grants.

The profile's `control/` directory is private (0700/0600 on Unix; current-user
DACL on Windows). Discovery contains only version, endpoint and instance ID;
clients validate ownership, permissions, file type and the literal loopback endpoint.
Clean shutdown removes discovery; the instance check rejects stale metadata.
Windows ACL setup/verification uses a fixed PowerShell program calling .NET ACL
APIs directly, with paths passed as environment data. It does not autoload modules
from an inherited PowerShell 7 `PSModulePath`; failure refuses control initialization.

Operation intent and the hashed actor-scoped idempotency mapping are synced before
returning a new reservation. Only `created: true` authorizes a future handler to
start work; duplicates return the existing record with `created: false`. This is
a main-only distinction, omitted from public operation lookup. At 4096 records,
new reservations refuse rather than evicting deduplication state. Canonical action
input is hashed, never stored as prompt or reply text. A main-only confirmation
closure binds actor, operation and a caller-rechecked target/dirty-state identity;
it cannot be approved by a transport flag. Revocation cancels pending confirmations
and marks running operations indeterminate. Audit failure refuses the reservation.

Separate audit files rotate before 10 MiB, retain at most five files and prune
files older than 30 days on startup and writes; clearing them preserves live operation records.
Terminal operation snapshots are removed after their outcome audit entry is synced;
in-memory deduplication remains until quit. Before publishing the listener or granting
fresh credentials, recovery validates all snapshots, silently removes settled snapshots,
and records only pending-confirmation and running operations as indeterminate. Recovery
appends share one write and sync (split only at the 10 MiB rotation boundary), then
all snapshots are removed. Invalid or unreadable snapshots and audit failures refuse
startup and retain snapshots for reconciliation. It never restores
authority or replays actions. Mutation handlers retain trusted dialog wiring, action visibility and takeover together.
