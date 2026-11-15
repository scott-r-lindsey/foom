# Data ownership and synchronization (#1153)

Decided target architecture, approved in [#1153](https://github.com/scott-r-lindsey/foom/issues/1153).
Phase A ([#1160](https://github.com/scott-r-lindsey/foom/issues/1160)) records the design and
runs an isolated spike. **No production data moves to SQLite in phase A.** Existing
store documentation describes current behavior until its migration lands.

## Ownership and engine

Main owns one private profile database. Open every connection with WAL,
`synchronous=NORMAL` and `foreign_keys=ON`, then read back `foreign_keys` before
schema checks, migrations or writes. Failure to read back 1 refuses startup;
do not continue with an empty database or silently disable integrity. Other
processes never open it. SQLite files, WAL and SHM inherit private profile
permissions; none are renderer assets or telemetry.

Choose built-in `node:sqlite`, driven by Drizzle. `better-sqlite3` remains the
engine fallback if the spike exposes an incompatibility. Drizzle's native
`node:sqlite` adapter currently requires the pinned release candidate used by
the spike. Revalidate the adapter before phase C; do not substitute a different
ORM silently. Kysely is a fallback only if Drizzle cannot drive the chosen engine.
MikroORM is excluded from evaluation.

All Foom-owned durable state belongs here: profile settings/consents, registered
hosts and repositories, sessions, worktree history, environment overrides, board
metadata, forge observations, offers, control operations and redacted audit/history.
Secrets remain safeStorage-encrypted blobs, decrypted only in main. Terminal
screens, scrollback and agent transcripts remain out. Live host observations,
daemon sessions and PTY state stay in their process owners, projected through the
same view channel without persisting terminal content.

Human-editable configuration, themes and manifests remain external inputs under
their existing validation/approval rules. Their accepted owned projections can
be stored in SQLite; an importer must not turn unapproved disk edits into authority.
Remote `foom-host` state is out of scope for A–D; its SEA engine proof does not
authorize migrating that state. Physical Git/SSH effects still require existing
identity checks, confirmations and durable operation intent; database transactions
cannot make external side effects atomic.

## Schema, migration and removals

Drizzle TypeScript is the schema source, with reviewed, generated SQL migrations.
Every table is `STRICT`; closed values have `CHECK` constraints. The pinned
Drizzle version lacks a STRICT table option, so reviewed SQL explicitly adds it;
verify deployed tables with `PRAGMA table_list`. Do not rely on TypeScript enums
to validate stored data. Index foreign-key child columns and view predicates.

Every relationship has a foreign key with `ON DELETE RESTRICT`. No cascade is
approved by this design. A future cascade needs an explicitly documented owner,
scope and schema declaration. Domain removal functions delete the intended
children first and then the parent in one transaction. A referenced-host delete
must throw. Host forgetting retains the existing policy: saved local references
are removed without sending remote stop/kill. Live connections may outlive saved
registration; they do not reintroduce forgotten durable rows.

Phase C (#1162) owns the importer and quarantine: validate old JSON as untrusted
input, preserve recoverable originals, quarantine invalid relationships, and
commit accepted rows atomically. Never fabricate an FK parent or restore authority
from an invalid record to make import pass. Schema version mismatches, migration
failure and integrity failure must be actionable failures, not silent data loss.
Phase D (#1163) removes superseded JSON writers only after migration validation.

## Commit-driven changes

Each domain table has INSERT, UPDATE and DELETE triggers appending its table name
and an increasing revision to `_changes`. `_changes` itself is exempt to prevent
recursion; migration bookkeeping is internal. Trigger inserts share the writer's
transaction: rollback removes both data and notifications. Revisions are cursors,
not a promise of consecutive IDs or one revision per transaction.

One serialized main write boundary runs typed domain commands and migrations.
Only after COMMIT does it drain `_changes` beyond its last published cursor,
coalesce affected tables and recompute dependent subscribed views. Raw SQL and
data-changing migrations therefore enter the same publication path. Schema-only
migrations explicitly invalidate all views after commit. Never publish partial
transaction state. Draining/publication failure keeps the cursor pending for a
retry; restart starts fresh subscriptions from current snapshots. Prune old change
rows only below acknowledged publication cursors; a retained monotonic sequence
prevents revision reuse. The log stores no row contents or secrets.

## Views and typed commands over IPC

Target preload capability: `subscribe(view, params)` returns an unsubscribe
function and delivers a validated initial snapshot plus subsequent snapshots.
Views and params are a closed typed registry, never SQL, table selectors or paths
chosen to bypass existing authorization. Initial delivery and registration share
main's serialized snapshot/publication boundary so a commit cannot fall between
snapshot and subscription. Each subscription belongs to the requesting registered
board main frame; navigation, window destruction and unsubscribe release it.

Each push carries subscription ID, view, validated params, a generation, revision
and bounded data (or a fixed coded error). Main revisions order all publications,
including live caches; durable change cursors are separate internal values.
Preload validates responses and exposes small typed capabilities. Ignore stale
generations and non-increasing revisions. Reconnect installs a fresh generation
and full snapshot. Bounded per-window subscription counts and response sizes,
pagination for lists, coalescing/backpressure and explicit loading/error states
are mandatory implementation requirements. Phase B (#1161) defines concrete
view schemas and limits and implements this channel over today's stores first.

Writes are closed, typed commands such as host removal or repository registration,
runtime-validated and authorized in main. The renderer sends neither SQL nor
generic store actions. Write acknowledgement follows commit; it never replaces
subscription publication. Keep existing trusted confirmations and operation
idempotency rules. A failure does not optimistically grant a capability.

## Renderer and guards

TanStack Query owns every cache of main-owned views, keyed by view and normalized
params. Pushes set or refresh exactly affected query keys; structural sharing
preserves unchanged object identity. Query subscriptions own disposal, initial
loading and errors. Zustand or plain React state owns only local UI state such as
focus, selection and menus. `useState`/`useEffect` must not retain snapshots of
main-owned data. Structured PTY and daemon state follows the same view/query
contract; high-frequency consumers can update the DOM without React renders.
Terminal output keeps its imperative transport and never enters the query cache.

Phase B migrates Settings first and then other main-owned reads. Phase D enables
the lint guard allowing only the query layer to call the preload data API, after
legacy reads have migrated. Add a referenced-delete rejection test for every FK,
and a real Electron test for every view proving a write in one open surface
updates another without reopening. CI benchmarks cold-start load and write-to-push
latency; spike write-to-`_changes` timings are not end-to-end IPC measurements.

## Phase A proof

The isolated [spike](../../spikes/data/README.md) contains the Drizzle schema,
generated STRICT migration, triggers, enforcement assertions and reproducible
Node/SEA/Electron/packaged-ASAR measurements for both engines. Its dependencies
are isolated from Foom's production package and build graph. The
[measurement report](../research/data-spike.md) records versions, licences,
packaging/ABI/signing findings and CI evidence. No production API or guard is
claimed implemented by this document.

## Phase B channel over JSON (#1161)

Production persistence remains JSON. Store commits publish through
`main/data/view-changes.ts`; Settings publishes after successful replacement,
Environment after assigning its committed lists, WorktreeStore after its commit
callback, and SessionStore after rename. Settings reads expose committed values
while a profile replacement is pending. Accepted config, workspace inventory,
agent scans, registered-host actions/observations, fonts and sound catalogs also
publish. Explicit agent rescans publish completion even when facts are unchanged;
cached view reads stay quiet. Settings dependency comparisons avoid rechecking forge readiness for
unrelated preference edits. Legacy write capabilities and their confirmations
remain the closed typed commands; there is no generic mutation capability.

`data:subscribe` takes exactly `{id, view, params}`; `data:unsubscribe` takes the
owning ID; `data:ack` takes ID, generation and revision. Each window owns its
registry, with the same registered board/main-frame/URL checks as other IPC.
Main registers before starting an asynchronous snapshot; a concurrent change
invalidates that read and recomputes it before delivery. Navigation, renderer
loss, destruction, explicit disposal and unsubscribe release subscriptions.
At most 32 subscriptions belong to one board. Valid requests are capped at
32 KiB; IDs use 1–64 ASCII letters, digits or hyphens. Snapshot envelopes are
capped at 2 MiB UTF-8 in main; preload additionally bounds serialized input and
validates/projects every nested response using its existing inline validators.
Only fixed `unavailable` and `too-large` errors cross this channel.

| View | Params | Projection |
| --- | --- | --- |
| `settings` | `{}` | Existing validated SetupState (preferences, update status and theme catalogs) |
| `hosts` | `{}` | Registered hosts, saved/live observations and current locations/check display state |
| `agents` | Optional `machine`: `local` or `host:<registered alias>` | AgentReport; a remote machine additionally carries its one-host observation in `machine` and never runs a check on subscription |
| `repositories` | Optional `offset`, `limit` | Registered repository page |
| `worktrees` | Required registered `repository`; optional `offset`, `limit` | Authorized checkout page |
| `sessions` | Optional `offset`, `limit` | Existing WorkspaceTerminal projection; no terminal output |
| `environment` | `{}` | Existing masked EnvironmentState; secret values remain null |
| `config` | `{}` | Validated current ConfigStatus |
| `fonts` | `{}` | Bounded cached font catalog |
| `sounds` | `{}` | Validated catalog entries; audio bytes keep their separate capability |
| `readiness` | `{}` | Fixed Git/forge readiness; subscribed only on the owning readiness/Forges surface |

Settings host views keep the saved-observation projection of the former list
read; background board connection failures do not replace those observations.
Entering Hosts retains its explicit list command to resume owner-held row/save
retries; command replies cannot replace ordered snapshots.

The host view primes sealed-build and local SSH-client display capabilities
without retrying failed rows or connecting to a host. This preserves the opening
notice and saved host-key-trust affordance while keeping subscriptions read-only
with respect to remote machines.

Unknown views/fields, wrong param types and extra IPC arguments refuse. List
pages default to 100 entries, with limits 1–100 and offsets 0–1,000,000. A page
carries `nextOffset` when more entries exist. Settings subscribes repository
pages automatically, publishing the combined list only when all required pages
share `viewRevision` (the last invalidation of that view). Unrelated global
publications therefore cannot produce torn or indefinitely waiting page joins.
Exhausting the board's subscription cap surfaces an error, never a silently
truncated registration list. Other list hooks expose their bounded page; full
board/sidebar conversion remains deferred below.

Readiness views share a lazy main-owned probe result by view revision. Explicit
recheck commands force a fresh probe; publication of that result does not run the
probe again.

Global publication revisions include live caches. Each subscription also has a
fresh generation. Preload and the query adapter ignore stale generations and
non-increasing revisions. Main retains only one unacknowledged snapshot per
subscription; invalidations behind it coalesce into one latest read after its
acknowledgement. Reopening installs a fresh subscription and full snapshot.

Settings uses named query hooks, keyed by source identity, view and normalized
params; TanStack Query performs structural sharing. Multiple consumers share a
subscription, and the last consumer releases it. Explicit refetch reconnects a
live subscription instead of allowing an unordered legacy read into its cache.
Command acknowledgements cannot
overwrite ordered pushed data. Editable Environment rows, pending preference
commands and a pending Sound slider remain local drafts. Preference previews
release when their command group settles; they never populate the query cache. Sample/test sources retain their typed reader/event
adapters through the same query cache. The host picker consumes the hosts query
and no longer uses registeredHosts from a Settings snapshot.

Board/sidebar structural sources remain on their existing adapters: their
launch reservations, staged inventory/error ordering, cross-window ownership and
imperative terminal lifecycle make a partial replacement unsafe. Terminal output,
activity and DOM lights retain their existing transports. This is an explicit
phase-B deferral, not authorization to enable the phase-D preload-read lint guard.
The `sessions` and `worktrees` query hooks/channel are available for the later
consumer migration.
