# Control

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Control plane

This area owns authentication, transport limits, credential lifecycle and durable
operation/audit storage. [Child authority](child-authority.md) owns repository and
child authorization, input, tails and waits; [orchestration](orchestration.md) owns
feature composition, role transitions and child/review lifecycle.

**Foundation implemented in #152.** `main/control/` owns the service, launch grants,
versioned HTTP adapter, private discovery, operation records and audit storage.
The workspace starts it when the window is composed so human pairing is available before an agent launches. A failed startup leaves the window usable and can retry on agent launch.
Agent grants support `manual`, which serves only fixed bundled reference
documentation without workspace or session data; paired CLI grants omit it. Unknown
methods, role/force flags and unknown fields fail closed. Orchestration methods are
described in the [orchestration contract](../contracts/control-mutations.md).

`POST /control/v1` requires `Authorization: Bearer <token>` and a JSON envelope
`{ version: 1, instanceId, method, params }`. Identity takes empty params; operation
lookup takes exactly one of `operationId` or `idempotencyKey`. Every request checks
the live grant and app-instance ID, including after receiving its bounded body.
Responses contain `{ result }` or a fixed `{ error }` code. The adapter enforces
8 KiB headers, 64 KiB bodies, 32 connections and four outstanding requests per
grant, with five-second transport deadlines. Policy and role checks stay in the service.

A separate 256-bit control token shares the hook launch's lifecycle but never its
secret or authority. Main stores a digest mapped to role, canonical repository,
terminal, parent and generation. Caller-supplied roles and MCP session IDs grant
nothing. Authenticate initialization and every subsequent request, bind protocol
sessions to grant generations, validate every payload and target at runtime, and
recheck revocation before effects. Reject browser origins and unexpected Host
values; bind only `127.0.0.1` on an ephemeral port. Never expose tokens through
renderer IPC, logs, argv or tool results. Child launches receive fresh read-only
tokens. Exit, failed launch and shutdown revoke grants.

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
new reservations refuse rather than evicting deduplication state. MCP
`operation_status` and CLI `foom operation-status` look up an operation ID or
idempotency key within the same actor generation and repository, including after
a lost response; lookup never replays a mutation. Records distinguish pending
confirmation, running, succeeded, failed, declined, cancelled and indeterminate
outcomes. Deduplication mappings remain for the grant's lifetime. Canonical action
input is hashed, never stored as prompt or reply text. A main-only confirmation
closure binds actor, operation and a caller-rechecked target/dirty-state identity;
it cannot be approved by a transport flag. Revocation cancels pending confirmations
and marks running operations indeterminate. Audit failure refuses the reservation.

The separate private action log records actor, target, operation and outcome,
with hashes of child input but no input text, keys, tails, credentials or initial
prompts. Persist intent before automated mutations; audit failure refuses automation
while human terminal control remains available.
Audit files rotate before 10 MiB, retain at most five files and prune
files older than 30 days on startup and writes; clearing them preserves live operation records.
Terminal operation snapshots are removed after their outcome audit entry is synced;
in-memory deduplication remains until quit. Before publishing the listener or granting
fresh credentials, recovery validates all snapshots, silently removes settled snapshots,
and records only pending-confirmation and running operations as indeterminate. Recovery
appends share one write and sync (split only at the 10 MiB rotation boundary), then
all snapshots are removed. Invalid or unreadable snapshots and audit failures refuse
startup and retain snapshots for reconciliation. It never restores
authority or replays actions. Mutation handlers retain trusted dialog wiring, action visibility and takeover together.

## Config-session manual boundary (#704)

Config agents receive no `ControlService` grant or principal. A separate per-launch
`ManualMcp` loopback listener registers only `manual` and directly calls the
same authority-independent bundled reader. Every other tool name is unknown,
including explicitly named control, preview, handoff and orchestration tools.
The listener has no workspace, repository or session dependencies and cannot
serve `/control/v1`. The existing provider ABI uses `FOOM_CONTROL_URL` and
`FOOM_CONTROL_TOKEN` to attach it; those credentials authenticate only that
isolated listener, with no instance ID, CLI directory or control grant. Exit,
early exit, failed preparation/spawn and shutdown close it and remove private
attachment files. Ordinary and orchestrator grants are unchanged.
The manual listener shares the control endpoint's authority-free transport
helpers: 8 KiB headers, 32 connections, five-second header/body deadlines checked
every second, and four outstanding authenticated requests reserved before body
reads. Excess requests receive 429; close or upload error releases the slot.

## Restricted remote child relay (#755)

The phase-2 remote adapter retains the real launch grant in main and calls the
existing service with that bound principal. It exposes only `handoff`, `manual`
and sanitized `whoami`; it never forwards a caller-selected grant, hub URL or
credential. Identity is a separate random launch alias with child role and the
three allowed capabilities. Neither terminal nor parent IDs occur in remote
results. The adapter validates exact finite result shapes and refuses results
containing either protected hub identity; local identity responses are unchanged.
Every other method gets the fixed `phase_2_restricted` code and a fixed reason
naming #756. Revocation is checked before and after asynchronous service work.
Parent-facing operations continue to use hub terminal IDs. This limitation is
lifted by the host-aware control work in #756, not by a flag or remote payload.
