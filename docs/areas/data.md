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

### Retired repository setup list (#1262)

[#1262](https://github.com/scott-r-lindsey/foom/issues/1262) retires
`repository-setup/state.json` as a profile data source. Foom ignores the legacy
file and any prior cleanup remnants. Existing files, including installed
toolchains, stay in place. Stored lists contribute no approvals or prerequisites
to a launch. The prepared control importer skips the obsolete store, and a
forward migration drops its approval and observation tables.

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

Settings host views keep saved full-check observations while overlaying explicit
Refresh facts results, including failures, and current inventory counts.
Background board connection failures do not replace those observations.
Legacy saved-only Hosts lists retain their saved inventory counts; the subscribed
Settings projection explicitly opts into current counts.
Entering Hosts retains its explicit list command to resume owner-held row/save
retries; saved row controls wait for that command to settle, and command replies
cannot replace ordered snapshots.

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

Readiness views across all windows share one lazy profile-owned probe result.
The cache depends on readiness and repository revisions; repository commits also
invalidate open readiness subscriptions. Worktree-only metadata commits retain
the repository revision. Explicit recheck commands replace the shared result;
publication lets every window reuse it without repeating auth probes.

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

## Phase C preparation: first related group (#1162)

`main/data/sqlite/` owns the prepared database, schema and migrations independently
of production startup. Temporary `main/data-import/` holds the legacy JSON importer,
its recovery/batch helpers and the prepared settings, environment, board, control,
window and command adapters that reuse feature parsers. The #1247 boundary-policy
amendment moves these modules mechanically: no production ownership or runtime
behavior changes. Only the temporary area gains the required feature imports;
`main/data` retains its sole `window: type` edge and never imports the temporary
area back. Wiring may compose the importer through its declared entry.
`shared/secret-cipher.d.ts` declares the encryption capability without a feature
or runtime dependency. Delete the temporary area and its policy entries at the
phase-D cutover (#1163); future domain placement requires its own reviewed policy.
`ProfileDatabase.open` must be explicitly supplied an app-owned profile; the
application does **not** call it. JSON readers and writers remain authoritative.
No phase-D guard is enabled. The pinned native `node:sqlite` Drizzle rc.5 adapter
is exercised again by unit and real Electron tests. ORM Apache-2.0 attribution
is included in bundled notices; Kit remains development tooling.

This first migration covers registered hosts, local repository registrations,
managed worktree claims, sessions and their saved placements/parent relationships,
owned-worktree provenance, pending removals and parent-directory history.
Remote repository inventories remain owned by `foom-host`; remote sessions refer
to the hub's registered host and retain validated remote checkout claims, without
inventing local repository/worktree parents. Home/config sessions and unmanaged
Git checkouts likewise do not fabricate owned worktree records. Saved metadata
remains a claim requiring all existing live Git/identity/authority checks.

Schema source is `schema.ts`. Generate with `pnpm exec drizzle-kit generate
--config drizzle.config.ts`; review the SQL, adding STRICT, explicit NOT NULL
text primary keys and all three change triggers before accepting a migration.
Generated snapshots describe Drizzle's model, not those reviewed SQL additions.
Build copies the reviewed SQL into main's private ASAR files. On Linux, macOS and
Windows, opening records the file's `lstat` device/inode before private-file
verification, then repeats private-file verification and compares device/inode
after `DatabaseSync` opens the pathname, before any PRAGMA or migration. Symlinks,
reparse redirection detected by the private-file checks and replaced identities
are refused and the connection is closed. POSIX ownership/mode/link checks and
Windows owner/ACL checks remain required. Because `node:sqlite` accepts only a
pathname, this is a post-open replacement check, not an atomic descriptor-bound
open; it cannot defend against a same-user adversary swapping a path away and
back between checks. The app-owned private directory remains the trust boundary.
Opening verifies migration version/checksum, STRICT table inventory, trigger
inventory and database integrity. It refuses incompatible or damaged state rather than starting empty.

Only main infrastructure uses `ProfileDatabase.write`; closed domain functions
use it for one synchronous transaction each. The boundary serializes writes,
asserts foreign keys before each transaction and drains triggers only after
commit through the phase-B publication clock. Failed publication returns a
committed result with `publicationPending`; retry publication rather than replaying
the command. The cursor advances only after success. Schema creation invalidates
all views. No log pruning is enabled in this preparation, so revisions cannot be
reused and unacknowledged entries cannot be lost. Forget-host removes its saved
sessions before the registration and performs no remote stop/kill effects.

The explicit first-group importer reads bounded, private legacy `settings.json`,
`worktrees.json` and `sessions.json` as untrusted input. Before its SQL transaction,
it atomically freezes their original text and source manifest in a private read-only
safeStorage-encrypted recovery envelope. Every group encrypts before creating a
file, including rejected rows and unknown fields that might contain credentials.
Unsupported/unavailable keychains (including Linux `basic_text`) and encryption
failures abort without plaintext fallback or completion. Old plaintext recovery
snapshots are refused; restore original sources rather than silently accepting them.
Production source files retain their current permissions and writers. Restart
reuses the frozen input; accepted rows, fixed quarantine positions/reasons and
completion marker commit together. Row savepoints isolate constraint failures;
missing/rejected parents never manufacture authority. Unsupported file versions
refuse the import. Reports contain counts and fixed source names, never rejected
payloads. Other settings and per-feature stores have separate explicit group importers
described below; all remain in production JSON through phase C.
The eventual cutover and retirement of JSON writers belong to phase D.

The phase-A report records observational timings for engine operations. The
[view measurements below](#view-measurements-and-approved-budgets-1246) time
the real Electron path through renderer delivery.

### Settings and consents preparation

The next reviewed migration adds `profile_settings`, `agent_consents` and
`profile_metadata`. The migration runner verifies every already-applied digest,
then applies pending scripts and version records atomically. Existing first-group
databases upgrade in place. All new domain tables are STRICT with change triggers;
settings keys, boolean preferences, closed choices and consent identities have
SQL checks as well as the existing runtime validators.

`importProfileSettings` has its own frozen recovery source and completion marker.
It reads only profile `settings.json`, never the external config folder. Version-2
config keys cannot become an accepted projection merely because they occur on
disk; only a validated `configText` with its matching recorded SHA-256 baseline is
retained. SQLite stores `configText` as a re-serialized closed projection from
`parseSettingsFile`, so retired/discarded fields and duplicate-key source text
cannot retain unknown content in plaintext. After verifying the source digest,
every re-serialized settings projection must round-trip through `parseSettingsFile`
to the same accepted values before storage, including its 64 KiB limit. If
normalization expands a valid source past that limit or otherwise fails the round
trip, the baseline pair is omitted and `settings.json#configBaseline` is quarantined
with fixed reason `invalid`; the group report records the rejection and the source
remains recoverable in the encrypted snapshot. For usable baselines, the importer
recomputes `configDigest` over the stored projection bytes. The matching pair
preserves the accepted values as the restart baseline when the external file is
a held proposal; normalization grants no approval to that proposal.
The original text remains only in encrypted recovery. Pending per-agent arguments keep their documented profile migration
status. Unknown or retired settings are quarantined, not written into SQLite.
Consent acknowledgements and disclosure identities are separate columns. ID-only
historical built-ins retain their historical identity; custom IDs do not gain a
current identity. Existing launch-time identity checks remain required. These
preparations add no production writer, approval, consent or read capability.

### Encrypted environment preparation

`environment_scopes` and `environment_entries` retain provider lists and variables.
The scope FK is RESTRICT and the composite primary index begins with its child
column. SQL enforces an exclusive choice: a nonsecret has a text value and no
ciphertext; a secret has a ciphertext BLOB and a NULL text value. The prepared
commands reuse the existing `safeStorageCipher` capability (including refusal of
Linux `basic_text`), force credential-bearing URLs to secrets and return only
masked snapshots. Ordinary reads use only the support flag, never the keychain.
Unrelated variable edits and unchanged retained secrets reuse existing ciphertext.
Environment row loading checks availability once, separately from recovery
envelope encryption/decryption, validates successful decryption in main and retains the original ciphertext bytes. A locked
keychain or any decrypt exception refuses the atomic import for retry, even after
a successful availability check. Backend exceptions cannot reliably identify
corrupt ciphertext versus transient keychain failure. Structurally invalid
ciphertext and successfully decrypted content that fails value validation are
quarantined; neither causes a recoverable backend failure to be marked complete.
No secret plaintext, cipher bytes or values enter change logs or reports. Domain
scope removal deletes intended variables before the scope. JSON remains the
production owner and all launch-time environment validation remains required.

### Board, forge, offers and history preparation

The control/history migration adds normalized threads, append-only posts,
recipients, idempotency receipts and explicit current-repository bindings. Receipt
post/thread identity is a composite RESTRICT FK. Historical repository, actor and
session IDs remain immutable snapshots rather than fabricated live parents;
current bindings reference only known saved registrations. The shared existing
Board parser validates imports and domain writes. Trusted author selection and
live role checks remain in the existing service. Child-history expiry deletes
intended receipts/posts/bindings before threads; it never deletes Git worktrees.

Forge observations retain validated checkout/provider claims with host, repository
and managed-worktree FKs. Forget-host removes its dependent observations without
remote effects. Generic offers, probe disclosures and fingerprinted hook-health
observations retain their existing meanings, never installation or launch authority.

Control intent is reserved and audited in one transaction, with hashed
idempotency keys and fingerprints. Duplicate reservations return `created: false`;
conflicting/recovered records cannot authorize effects. Imported interrupted
operations become indeterminate reconciliation history. No credentials, grants,
prompts, key values, screens or replay handlers are restored. The existing audit
whitelist/redactor is reused. Clearing audit removes links/history while retaining
operation state; retiring an operation removes its links first. Audit retention
keeps the existing 30-day/50-MiB bound. Verdict feedback has a RESTRICT verdict FK
and a unique next-action row. Historical verdicts never populate a live owner's
pending-feedback slot. Host diagnostic projections keep only fixed causes,
commands and numeric health fields, omitting raw stderr and terminal content.

The importer discovers only bounded, named profile files, excluding discovery
credentials and external agent/config directories. All import groups persist only
explicit field projections or values from closed validators/parsers that reject or drop unknown keys, including nested objects.
Pending removals project only path, repository, root and directory identity;
unrecognized token fields never enter SQLite or its journal. Hosts and managed
worktrees reject extra keys; sessions, board, settings, forge, setup, operation,
audit, verdict, health, diagnostic and window rows use their existing closed
validators or explicit projections.

Dynamic operation/health file manifests are frozen with their original text in
encrypted recovery envelopes before the atomic group import; crash retries load that frozen manifest before any mutable source discovery,
even if production files changed or discovery now fails. Completed
imports return without rescanning mutable sources. Restarted subscriptions begin
from current snapshots and the existing durable high-water cursor, so old change
rows are not replayed as new writes. All these paths remain explicit preparation:
JSON, existing service authorization and existing production readers/writers stay
in place. Current phase-B view dependencies are invalidated after commit; history
without a current phase-B view remains in the internal change log for its owner.

### Window and update preparation

The final store group keeps validated window geometry, the legacy size fallback,
anonymous update high-water dates and per-window preview metadata. Preview rows
have RESTRICT window and optional managed-worktree FKs; unmanaged checkout paths
remain snapshots. Removing a saved window set deletes its intended preview rows
first. Network permission is constrained to Off in SQLite and runtime validation;
restored metadata grants no file capability. The existing PreviewHost still
revalidates Git and contained file identity. Update reservations advance only to
newer UTC day/week/month dates in one transaction before the existing owner's
request; the prepared domain path sends no network request. Sources remain intact
and production window/update/preview owners continue to use their JSON files.

### View measurements and approved budgets (#1246)

The named `data SQLite: report cold process to first renderer view and write
to renderer view measurements` Electron case runs in CI on each desktop platform.
Repeat locally with `pnpm run test:electron --suite=data-sqlite.test.js
--test-name-pattern='^data SQLite: report'` (under `xvfb-run -a` on Linux).
Each of ten fresh fixture processes opens a separately seeded database with
1,000 saved repositories and subscribes to a 100-row page. The cold timer covers
process spawn, module loading, database open, creation of the sandboxed renderer
and receipt of its first view. OS page caches are retained. Seed work and fixture
file creation are outside the timers. Ten launches preserve cold-start sampling
within the existing case deadline. With ten samples, nearest-rank cold p95 is
the maximum.

Each process reuses its database and subscription for two discarded warm-up
registrations followed by five sequential timed registrations, yielding 50 write
samples. Each write timer covers command start through committed ViewRegistry
publication, renderer DOM update and receipt acknowledgement. Nearest-rank
write p95 is the 48th value in ascending order.

CI logs and `test-results/data-sqlite-measurements-<platform>.json` retain
nearest-rank p50/p95, individual samples, workload, platform and runtime versions.
All platform/metric pairs report the measured p95, budget and signed gap
(measured minus budget). The approved targets remain **p95 ≤ 500 ms** for cold
process to first renderer view on Linux and **p95 ≤ 25 ms** for write to renderer
view on Linux and macOS.

#1285 makes every budget report-only while the SQLite fixture is isolated.
Malformed budgets, incomplete or invalid measurements, and fixture process
failures still fail the test. When SQLite ships in phase B/C, set
`ENFORCE_SQLITE_VIEW_BUDGETS` in
[`sqlite-measurements.js`](../../tests/electron/sqlite-measurements.js) to
`true` to restore enforcement for the approved pairs with the larger write
sample count.

The historical CI run for PR #1236,
[44105455993](https://github.com/scott-r-lindsey/foom/actions/runs/44105455993)
(head `45b88a92b9fa1f6fdacdf22d5fee61cff1c1e01a`), uploaded these baseline
measurements in the `data-sqlite-measurements-<platform>.json` files inside its
`electron-results-*` artifacts. All used Electron 44.9.3, Node 24.22.0 and
SQLite 3.53.4. That workload used ten fresh processes with one timed write each.
Values below are rounded to two decimal places.

| CI platform | Cold p95 | Write p95 | Previously enforced |
| --- | ---: | ---: | --- |
| Linux x64 (`ubuntu-24.04`) | 361.78 ms | 6.96 ms | Both budgets |
| macOS arm64 (`macos-15`) | 660.86 ms | 7.95 ms | Write budget only |
| Windows x64 (`windows-2025`) | 1,293.08 ms | 72.47 ms | Reporting only |

Against those targets, macOS cold p95 was 160.86 ms higher, and Windows cold and
write p95 were 793.08 ms and 47.47 ms higher, respectively.
