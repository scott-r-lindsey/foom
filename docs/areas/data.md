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
