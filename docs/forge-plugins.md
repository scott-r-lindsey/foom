# Forge manifests — approved specification (#520)

The user approved the spec in [#520](https://github.com/scott-r-lindsey/foom/issues/520#issuecomment-6207655657),
with the later [#521 polling decision](https://github.com/scott-r-lindsey/foom/issues/521#issuecomment-6244997818)
superseding the original cadence proposal. There are no new permissions for agents,
no forge writes, and no merge automation.

The shared kind dispatcher, strict parser and build-locked GitHub manifest now
serve production tracking, adoption and merged-PR hints through the main-owned
lifecycle. Recorded-fixture parity passed before retiring the old provider from
application code; a frozen test-only reference keeps the comparisons reproducible.
Bundled and config manifests use the same interpreter, executable resolver, auth
preflight and bounded batch scheduler. GitHub's 20/120-second adaptive cadence,
one-second discovery follow-up and fleet budgets are preserved. GitLab #522 now uses recorded public-project evidence from glab 1.124.0.

Optional separate display reads now enrich single-PR samples only after the final
identity/ownership recheck. Board batches retain their existing query and counts,
with optional display fields isolated from status validation. Invalid display never
removes a verified PR or changes checks. Validated checks-meaning metadata is
published and persisted in the version-1 observation envelope, alongside bindings
to manifest digest and selected remote.

A forge is a second manifest **kind** in the [existing plugin system](agent-plugins.md),
not another plugin architecture. Built-ins are bundled JSON. A valid config copy
can express every built-in behavior, including fallback queries. Main owns process
execution, ownership decisions and polling; manifests describe CLI syntax and data.

## Review artifacts and compatibility

The complete, standalone worked manifests are [GitHub](../src/shared/bundled-forges/github.json)
and [GitLab](../src/shared/bundled-forges/gitlab.json). The executable
[JSON Schema draft](../spikes/forge-manifests/forge.schema.json) uses draft 2020-12.
The tables and semantic constraints below are part of the proposal; JSON Schema
alone cannot validate query safety or placeholder scope.
[Spike evidence](../spikes/forge-manifests/README.md) separates recorded output from
constructed fixtures, and describes validation without live CLIs.

Dependency status: #520 is approved and #516 is merged. Both prerequisites for
#521 are satisfied.

Versioning is per kind: `kind: "forge", version: 1`; `agent` accepts only version 2. Forge
bytes, directories, IDs and semantics remain unchanged. The shared
loader dispatches on `(kind, version)` before kind-specific validation. Unknown
kinds/versions are invalid, never interpreted as agents. No automatic rewriting.

Config location: `forges/<id>.json`, using the same contained-directory,
64 KiB descriptor-bounded reads, file watcher and validation as `agents/`; a valid
file loads with no approval step, like agents (#539). Each kind has a 50-file
catalog cap and its own ID namespace; registry keys include kind. Bundled IDs are
reserved within their kind. No trust store or consent IPC.

Settings uses the existing card component in a **Forges** group: name, badge,
source, detected executable/version, host assignments, available status,
and on/off. Settings now displays the validated catalog and saves profile-only
`forges` (ID → boolean) and `forgeHosts` (hostname → ID) maps. GitHub starts on with
`github.com → github`; config copies start off without hosts. New or changed host
assignments require a loaded, enabled forge. Disabling or losing a manifest preserves
its assignments for later restoration; it does not transfer them to another forge.
Hostnames must be exact lowercase ASCII DNS names, bounded to 253 characters; URL,
port, wildcard, IP, trailing-dot and unsafe-key spellings are rejected in main.
These preferences cannot be set in config `settings.json` or manifests. The
renderer only displays and submits them through sender-validated setup IPC.
Cards show declared executable names. First-run T-0 and Settings → Forges share
host readiness through the main-owned lifecycle, checking only hosts from selected
repositories’ local remotes and only enabled, explicitly assigned providers.
Readiness never runs PR queries or login commands and never publishes diagnostics.
There is no Duplicate action (removed for agents in #538); a hand-made
config copy of a built-in starts with no enablement, host assignments or
cached observations. Disabling a card preserves settings
but stops probes and polls. This is a behavior
specification, not approval of a new visual layout.

No executable resolution/probing/auth check occurs for disabled or invalid
manifests. A valid manifest loads without a trusted dialog. The CLI runs as the
user; JSON is not executable attestation or an OS sandbox, and the read-only command
grammar below, not human review, is the safety boundary. Main rechecks the bytes,
selected host, enabled state and registry revision before each spawn and before
publishing results. Edits reload the manifest and discard in-flight samples.
A config copy receives exactly the same capabilities through the same engine.

## Hosts, remotes and executable selection

Main selects origin, or the sole remote, as today. It parses these forms itself:
`https://host/namespace/project[.git]`, `ssh://git@host/namespace/project[.git]`,
and `git@host:namespace/project[.git]`, permitting one trailing slash. It strips one
terminal `.git`, not arbitrary suffixes. No local paths, custom schemes, credentials
in HTTPS, query/fragment, percent escapes, port overrides or alternate SSH users in
v1. A colon in a branch never becomes a URL. These restrictions preserve the
current GitHub remote surface; wider SSH/port support needs separate evidence.

| Field | Meaning |
| --- | --- |
| `remote.hosts` | Exact lowercase ASCII DNS host patterns only, no wildcard/regex/suffix match; <=8 entries |
| `namespace: pair` | Exactly two path components, owner and project |
| `namespace: nested` | 2–16 components; all but the last form the namespace |
| `case` | Path comparison only: ASCII case-insensitive or exact; DNS host comparison always lowercase |

Each component uses `[A-Za-z0-9_.-]+`, cannot start with `.` or `-`, and is <=255
characters; total project path <=1024. Hostnames use DNS labels, <=253 characters,
no userinfo, path, empty label, trailing dot, wildcard or IP literal. URL parsing
must not silently normalize dot segments. Missing/malformed/ambiguous remote means
unavailable, with no probe to an inferred host.

A declaration is compatibility data, **not host authority**. Main ships default
assignments `github.com → github` and, when #522 ships, `gitlab.com → gitlab`.
The user can choose one enabled forge per host in Settings, including
explicit self-hosted entries such as `git.example.org → gitlab-custom`. An explicit
assignment may extend that manifest's declared hosts using its same grammar. A
manifest edit cannot add assignments. Config copies never steal a host; conflicts or
missing selected providers are unavailable, with no priority or fallback guessing.
Host edits are main-validated user settings, not repository/plugin instructions;
they invalidate observations and require a fresh auth probe. No global CLI config,
login, logout, token refresh or credential migration is performed.

`executables` is an ordered list of basenames resolved with the agent PATH resolver:
login PATH on POSIX, inherited PATH on Windows, ignoring empty/relative entries,
no shell wrappers (`.cmd`, `.bat`, `.ps1`). Use the first resolved executable,
not one supplied by a caller, remote, CLI output or renderer. Fixed `--version`
and `--help` probes are display/evidence only; no minimum-version gate hides the
GitHub 2.45 fallback. No automatic installation. Run in a main-owned neutral working
directory, not the repository, with explicit host/project arguments and stdin closed.

`auth.argv` is fixed except for the validated host slot. Exit 0 with no declared
`failureContains` marker means available; all other exits, timeout or spawn failure
mean unavailable. Optional `failureContains` is <=8 literal case-sensitive strings
<=128 characters, tested against bounded stdout/stderr without regex or extraction.
Any match means unavailable. The glab example catches `api call failed:` and
`No token provided`: installed glab 1.36.0 reports those errors with exit 0. Discard stdout/stderr after marker testing; they can contain identity or credentials. Do not use `--show-token` or JSON auth
output. Cache success per host/executable/digest for at most five minutes; retry
failures on the normal backoff or explicit refresh. Auth does not confer ownership.
A CLI status failure leaves that host unavailable even if public anonymous reads
could work; this deliberate preflight addition is a review question below.

## Closed format and argv

All objects reject unknown keys and all JSON rejects duplicate/unsafe keys
(`__proto__`, `constructor`, `prototype`), invalid UTF-8, BOM, depth >24 or >8192
nodes. IDs/name/badge/executable limits match agent manifests. No modules, scripts,
shell strings, jq, Go templates, regex evaluation, external includes or downloads.
The schema URL is an identifier, never fetched at runtime. Optional environment
and guard arrays default to empty, minimum interval defaults to 20 seconds, and
absent operations/fallbacks disable those features. Explicit null is not omission.

| Root field | Required content |
| --- | --- |
| `kind`, `version`, `id`, `name`, `badge`, `executables` | Identity and resolved CLI; `forge`, `1` |
| `remote` | Host declarations and namespace/comparison grammar |
| `auth` | `argv`, `successExitCodes: [0]`, optional `failureContains` |
| `environment?` | Fixed nonsecret prompt/pager overrides only; absent means none |
| `minimumIntervalSeconds?` | 20–86400; may slow Foom's cadence, never accelerate it |
| `operations` | `lookupByBranch: {open, all}`, `resolveNumber`, `refresh`; optional `display`, `batchStatus` |
| `mapping` | Literal JSON paths, state table and project evidence |
| `checks` | `meaning`, `primary` plan, optional `fallback` plan |

An argv entry is either a literal string or `{ "parts": [literal-or-slot, ...] }`.
A slot is `{ "slot": "branch", "encoding": "literal" }`. This is the explicit
wire spelling of the shorthand `{branch}`, `{number}`, `{project}`, `{host}`:
strings containing braces are literal, never implicitly interpolated. Parts join
into exactly **one** argv entry, with no further expansion or splitting. Up to 16
parts, 64 entries and 65536 expanded bytes; each entry <=20480 bytes. Empty argv
entries and control characters are rejected. Query LF/tab is the sole exception.

| Slot | Validation and scope |
| --- | --- |
| `branch` | Existing `forgeBranch`: 1–200 characters; reject leading dash, whitespace/Cc/Cf, `~^:?*[\\`, `..`, `@{`, trailing dot, empty/dot-prefixed components and `.lock` suffixes; branch lookup only |
| `number` | Positive safe integer, decimal rendering; number operations/checks; candidate number must equal a requested number |
| `project` | Validated owner/namespace/project from selected remote, never caller-supplied URL |
| `host` | Validated selected host, explicit on every network command |
| `nodeId` | Check fallback only, bound by previous command; existing ASCII `[A-Za-z0-9][A-Za-z0-9_+/=-]{0,199}` rule |
| `query` | That plan's fixed or AST-composed GraphQL text, <=16384 expanded bytes, <=32768 total fixed text bytes; no string substitutions |
| `projectOwner`, `projectName` | Batch only; validated components of the selected pair-namespace project |

`literal` does no escaping; `percent-component` UTF-8 percent-encodes the entire
project (including slashes) once and is allowed only for project endpoint segments.
No arbitrary output-to-argv bindings. Node ID is
the only intermediate identifier. Reject out-of-scope slots, dangling query/node
bindings, nested parts and incompatible encodings at load. Manifest values
must use raw CLI string fields, never typed `--field` file-reading conversion for
untrusted identifiers. No arguments that load scripts/files or evaluate output.

Each command declares `jsonExitCodes` (<=4), optional `bindNodeId`, and optional
`emptyDiagnostics`. A JSON exit is useful only with valid bounded JSON stdout;
nonzero exit alone never means success. Nonzero JSON exits additionally require an
array root, preserving the existing runner contract. Diagnostic matching requires empty stdout,
the specified exit, exact prefix + one validated branch + suffix, optionally one
LF/CRLF. No substring match or arbitrary regex. It yields an empty check array
only in a check command. General command failures remain unavailable. The GitHub
example permits exits 1/8 for checks and list commands: today's runner accepts array
stdout at those exits, including lists. Object-returning operations require exit 0;
the old runner could only recover an array there, which cannot map a valid object.

Environment keys are restricted to nonsecret prompt/pager settings declared in
review (the examples use `GH_PROMPT_DISABLED`, `GH_PAGER`, `GITLAB_PAGER`). Values
are inert, and pager values must be `cat` or empty; no executable command values.
Do not permit credential, PATH, endpoint, proxy, loader or Foom capability overrides
from manifests. Foom retains CLI-owned authentication in the inherited environment,
scrubs Foom/session capabilities and closes stdin. Neither argv nor logs receive
tokens. Every process has a 10-second deadline and 256 KiB per-output-stream cap;
kill/reap on overflow/timeout. A sample has at most eight processes and 80 seconds,
including auth/display; no retries inside it. Shutdown/revocation cancels and reaps.

Read-only is a reviewed contract, not a claim that arbitrary configured binaries are
sandboxed. The parser rejects GraphQL mutation/subscription operations using a real
GraphQL grammar (including fragments), permits one query, and forbids endpoint
substitution from output. API commands must declare GET explicitly, except GraphQL
query transport. Known mutation commands, auth/config changes, aliases/extensions,
file inputs and shell entry points are invalid. New CLI syntax requires a reviewed
read-only grammar in the generic command validator before shipping; it must apply
equally to bundled/config manifests, never grant a built-in-only escape hatch.
This enforcement design is an explicit implementation gate, not solved by the JSON
Schema. Validation cannot prove an installed executable behaves honestly.

## Operations and observation lifecycle

Main invokes a fixed workflow; manifests cannot supply a general program or loops.

1. Revalidate worktree identity, branch, host assignment and loaded manifest bytes. With no bound
   number, run `lookupByBranch.open` (or `.all` for an explicit all-state request).
   Its JSON root must be an array with exactly one result. Zero is no match; two or
   more is ambiguous even if only one would pass ownership. Commands request two
   results so another page cannot hide ambiguity. Never take the first match.
2. Map and validate number, branch, state and source/target evidence. Compare branch
   literally to the requested branch; an initial open search must map to OPEN.
   Once bound, use `refresh` by number to follow OPEN/CLOSED/MERGED without binding
   another PR from later branch reuse. A list lacking head SHA gets one `refresh`
   before check evaluation; a missing/invalid head after refresh is unavailable.
3. Run primary checks. Fallback runs only on command failure/invalid JSON, preserving
   today's GitHub behavior: valid JSON with unmappable contents is `unknown` and
   does not trigger fallback. Intermediate fallback output can only bind `nodeId`.
   A failed/malformed check plan retains the valid PR with checks `unknown`.
4. Always rerun `refresh` after checks, including `none` and `unknown`. Compare
   number, branch, SHA, state and same-repository evidence to the candidate. A race,
   changed ownership, failed recheck or replaced checkout discards the sample.
5. Publish only narrowed metadata. Optional `display` enrichment must match that
   same identity/head/state and pass ownership again; failure omits title/URL only.
   It cannot change check status or replace the candidate. A later push is naturally
   observable next poll; this is a sampled observation, not an atomic merge grant.

`resolveNumber` returns the mapped branch, state and source/target evidence without
requiring a SHA, for adoption. Main requires OPEN, refuses forks/incomplete ownership,
validates the branch again and refuses the repository's default branch using the
existing trusted Git discovery. The manifest cannot claim `sameRepository`, supply
a default-branch bypass or authorize a checkout. #337's ownership, branch locks,
budget and identity rechecks are unchanged. Unsupported/default discovery failures
remain `forge_unavailable`; existing distinct adoption refusal codes remain intact.

Repository batching must preserve #516's dynamic queries, numeric PR bindings,
check counts, default-branch exclusion and verified head/check identity. Branch
values remain GraphQL variables; only validated numeric PR numbers enter query
syntax. Newly discovered PRs bind on the following scheduler tick, with required
checks unknown until then. Board counts include all checks, while orchestration
conclusions include only required checks. Main owns batching, budgets and policy.

The earlier candidate-only, fixed-query batch proposal is superseded by the user's
follow-main decision. The optional `batchStatus` representation below now expresses dynamic queries and
check counts. The main-owned lifecycle connects it to executable/auth validation, and
fixture tests prove parity with the retired provider. It must not replace batching with serial
candidate checks or change existing #337/#340/#516 tests. Bundled and config
manifests must use the same engine, with no provider-ID compatibility exception.

### Dynamic batch query representation

`operations.batchStatus` is an optional closed object. The bundled GitHub JSON
contains the complete data; a renamed config copy follows the identical engine.
There is no provider-ID exception. The pair-namespace GitHub form below is
extended by the [GitLab representation](#gitlab-batch-representation-522) for
nested paths, string IIDs and project IDs. It declares:

- `command`: the read-only GraphQL transport argv, with exit 0 only, explicit
  `{host}`, `{query}`, `{projectOwner}` and `{projectName}` slots. These last two
  slots are batch-only validated components of the selected pair-namespace project.
  The accepted grammar is `api graphql --hostname {host} -f query={query} -f
  owner={projectOwner} -f name={projectName}`. Main appends raw `-f bN=<branch>`
  variables in match order; no manifest can select a different dynamic flag.
- `query`: one GraphQL query with `$owner: String!`, `$name: String!` and exactly
  one `...FoomBatch` insertion marker at the repository selection.
- `discovery`: one query with `$branch: String!`, selecting a single unaliased
  connection field. `bound`: one query with `$number: Int!`, selecting a single
  unaliased PR field. No additional definitions, directives, default variables or
  fragment spreads are accepted. Inline type fragments are allowed.
- `repository`, `defaultBranch`, `nodes`, `pageComplete`: literal response paths.
  `defaultBranch` and generated `pN` aliases are relative to `repository`;
  `nodes` and `pageComplete` are relative to a discovery connection.
- `sourceProject`, `crossProject`: PR-relative project-path and cross-repository
  evidence. Main validates and compares the full source path to the selected
  project, requires a literal false cross-project flag, and independently refuses
  both the reported default branch and any main-supplied Git default branch.
- `webUrl`: one argv-style parts value with only host/project/number slots. Main
  requires HTTPS on the exact selected host, with no credentials or port override.
- `checks`: the existing check-result grammar, relative to each PR. Array shape and
  a required-flag path are mandatory. Main reduces required rows for orchestration,
  then all rows for board counts, checking the same head/commit guards in both.
  Missing, partial or unknown check data never produces green or partial counts.

The engine composes parsed GraphQL ASTs, assigning `pN` aliases and `$bN` branch
variables. Only positive safe integer PR bindings become numeric AST nodes, including
`isRequired` arguments; branch text never enters syntax. It rejects duplicate
branches and more than 1000 matches, ambiguous discovery, missing discovery aliases, partial
connections and GraphQL errors. Newly discovered PRs retain unknown required
checks until the next bound poll. Bound CLOSED/MERGED PRs remain observable.

The interpreter retains the existing manifest limits (16 KiB expanded query slot,
64 KiB total argv, 256 KiB stdout/stderr) and fails unavailable before spawning an
oversized request. The tracker sizes each request against the exact expanded query and argv, including
branch variables and the 64-entry argv cap. It submits one bounded prefix per
serial worker tick and leaves the remainder due for subsequent ticks. This
preserves #516's serial worker, fleet budgets, adaptive cadence and one-second
discovery binding follow-up; there are no per-PR fallback requests or catch-up loops. No executable or network calls occur in parity tests.
Recorded public identity/rollup fields are replayed in explicitly derived batch
envelopes; constructed contexts cover optional failures, unknowns and partial pages.

## Execution lifecycle

`ForgeLifecycle` accepts only main-selected `LoadedForgeManifest` entries from its
explicit registry. Config entries use the loader's exact-byte validation callback;
bundled entries use the build-locked manifest/digest. Registry replacement,
explicit refresh/invalidation and shutdown clear caches and abort pending samples.
The main-owned `ForgeRuntime` now connects the config scanner’s forge registry,
profile enablement/host assignments and discovered login PATH to this service.
It always selects manifests; there is no legacy production path, provider-mode
setting, environment flag or IPC switch.
Unknown, unassigned, disabled or missing selections return no provider, without
probing or falling back. Declared hosts never authorize routing.

Settings changes and registry replacements invalidate pending work and caches;
tracking immediately hides observations and clears number bindings. PATH changes
retire the old lifecycle, and executable identities are checked on every sample.
Tracking supplies a validation closure over registered checkout identities,
branches and remotes. Adoption and merged-PR hints supply a lazy main-owned
repository/worktree closure, used only by the manifest path. Each closure is
rechecked by the lifecycle before execution, cache reads and publication. Tracking
rechecks the sampled branches within each chunk, so a large fleet does not repeat
unrelated checkout validation for every command. Tracking
also rejects publication across selection generations. These context closures
are not IPC capabilities exposed to the renderer.

Executable discovery uses the agent policy: validated basenames, absolute PATH
components only, executable regular files, canonical paths, and native `.exe`/`.com`
files on Windows. No implicit cwd lookup or shell wrapper fallback. Main supplies
the discovered login PATH; this service never invokes a login shell. Each uncached
sample uses a fresh disposable temporary directory, execFile-style argument arrays
(`spawn` with `shell: false`), manifest allowlisted environment overrides, a maximum
10-second sample deadline and 256 KiB combined stdout/stderr cap. AbortSignal,
invalidation, shutdown, timeout and output overflow terminate the POSIX process
group or use fixed system `taskkill.exe /T /F` arguments on Windows. Completion
waits for process close and tree cleanup before removing the temporary directory.

Auth preflight is exit-0 gated per manifest digest, selected host and executable
identity, with the manifest's fixed negative markers scanned case-insensitively.
Nonzero auth, unauthenticated/forbidden diagnostics and transport failures expose
only fixed states (`unauthenticated`, `unavailable`, `cancelled`, `timeout`), never
raw stdout/stderr, Error causes or credentials. Raw output is transient input to
the interpreter, never logged, persisted or published. Successful status metadata
still passes the existing mapping and Foom-owned identity/ownership rules.

The lifecycle supports caching successful narrowed results for up to 120 seconds,
bounded to 1000 entries per operation. Production disables sample caching so
explicit idle/refresh reads remain fresh; the tracker owns the regular cadence. Cache keys include manifest
ID/digest, host/project, executable filesystem identity, main-owned worktree
identity, default branch and complete operation inputs including bound numbers.
Auth caching is independent of result caching. Cache reads and every command
revalidate registry membership, exact bytes and worktree context; executable
identity is reinspected before spawning and publication. The same checks run after
the interpreter finishes, so a mid-run byte edit, registry replacement, executable
replacement or revoked worktree cannot publish or cache its result. Failures clear
cached results/auth; invalidation retires the generation even if an operation has
already completed transport. This is filesystem revalidation, not protection
against a malicious local process racing individual filesystem operations.

Tracking and adoption entry-point parity tests replay recorded public fork evidence
and explicitly derived same-repository/batch envelopes through the manifest engine
and a frozen test-only legacy reference. Fixture CLI tests verify that a renamed,
hostile manifest cannot relax Foom's fork, same-repository or advertised
default-branch refusals. No real forge CLI or network is used.

The scheduler measures exact expanded requests, sends one bounded prefix per
serial tick and leaves unsampled work due. A failed chunk hides the repository’s
stale observations and applies shared repository backoff, so its unsampled suffix
cannot immediately retry the failed read. Minima only slow regular polling;
discovery binding still follows on the next tick. Single-PR display reads use the
manifest's optional separate command; identity, head, state and ownership must still
match. Display command failures, including timeout/auth failure, omit enrichment
without changing status. Registry, executable or checkout invalidation still retires
the whole sample. The display command has a separate ten-second deadline after the
status sample's ten-second budget; cancellation still kills and reaps its process tree.
Board batches keep one query and derive optional title/source/URL from that verified
response, without per-PR processes or changes to batch sizing/cadence.

## JSON mapping and check reduction

A path is an array of <=12 literal keys or integer indexes 0–999; `[]` is the root.
The larger path bound accommodates the existing GraphQL envelope without changing
the agent kind's eight-component selector grammar.
Resolve own properties only. Missing is distinct from JSON null. No wildcard,
recursive descent, filters, expressions, coercion or dynamic keys. The reducer is
the sole bounded array iteration. Mapping never retains arbitrary response fields.

| Output | Main-owned validation |
| --- | --- |
| `number` | Positive safe integer (GitLab `iid`, not global `id`) |
| `branch`, `headSha` | Existing branch validator; exactly 40 lowercase hex SHA characters |
| `mergeCommit?` | Optional literal selector; numeric-project-ID mappings retain exactly 40 lowercase hex characters; legacy owner/cross mappings retain 40–64. Final single-PR refresh must report the same raw value |
| `squashCommit?` | Optional literal selector for alternative integration evidence; exactly 40 lowercase hex characters; final single-PR refresh must report the same raw value |
| `state`, `states` | Exact, case-sensitive table lookup to OPEN/CLOSED/MERGED |
| `title?` | String <=1024 code units before sanitizing; strip Cc/Cf/Co/Cs and U+2028/U+2029; render inert text, no Markdown/HTML |
| `webUrl?` | <=4096; no hidden/control characters, credentials or port override; HTTPS and exact selected hostname only; revalidate in main at external-link open |
| `projects` | Tagged host-scoped evidence described below, never a manifest boolean decision |

Unknown states map conceptually to unknown, but cannot enter the existing fixed
PR state union: omit the PR sample. Unknown checks retain PR identity with `unknown`.
Invalid required identity fields are unavailable, not empty/success. Optional bad
display fields are omitted. Never strip controls from identity/URL fields into a
*different* valid identity; reject them. Unused fields are discarded immediately.

Project evidence has two initial representations, usable by any manifest:

- `owner-and-cross-flag`: map `owner` and boolean `crossProject`; selected endpoint
  supplies target project. Main reproduces today's rule: false plus ASCII-equal
  selected owner means same repository. True means fork and is refused. Optional
  `sourceName` with owner supplies a fully named fork source for display; absent
  names stay unknown. For false, source and target are the selected project without
  guessing a fork name. `resolveNumber` may return incomplete fork evidence, but it
  cannot be adopted. This preserves the old `gh` fields and ownership behavior.
- `numeric-project-ids`: source, target and endpoint-context project IDs must be
  positive safe integers. Main requires source == target == context for a same-repo
  candidate; the explicit selected-project endpoint binds context to the remote.
  Identities are `(host, numeric ID)`, not globally unique numbers. A fork's source
  ID is sufficient identity even without its path. Never guess from a web URL.

The parser rejects identical source/target selector paths in numeric-ID mappings
and requires all evidence selectors; no constant identity/decision fields exist.
Tests must reject missing, mistyped and contradictory evidence and cannot accept a
manifest-supplied policy result. Nothing verifies that selectors describe the CLI
correctly; this is not cryptographic attestation of an arbitrary CLI response.

Neither representation permits caller-provided truth values or relaxed fork/default
branch policy. Remote changes, provider changes and host reassignments clear number
bindings; project comparison never crosses hosts.

Check plans have 1–2 commands. Only the last JSON is reduced. `guards` run first:
absence, array length or strict equality to validated `headSha`/`number`. Failure
means unknown. Then an explicit null at `nullAt` means none; missing does not.
Otherwise select `rows`, require declared array/object shape and count <=`limit`.
For arrays, `pageComplete` when present must be false; missing/true is unknown.
Object shape is a single row (limit 1). Empty complete arrays yield none.

For each row, `required` when present must be boolean; false skips the row and true
includes it. Malformed flags fail the whole result. Run `rowGuards` on included
rows. Exactly one variant must match its optional `{path, equals}` discriminator;
missing/unknown/overlapping variants mean unknown. A variant with `status` must
also declare `completed` and `unfinished`: an unfinished status yields pending;
completed reads `value`; any other status yields unknown. Otherwise read `value`
directly. Table lookup is exact and never coerces types. Null/unknown value means
unknown. Tables must be closed, bounded, and cannot use unsafe keys.

Validate every included row before combining: any unknown makes the whole result
unknown; otherwise failure wins, then pending, then success. All-none or no included
rows means none. No invalid/partial result can become a green result.

| `checks.meaning` | What the fixed conclusion actually describes |
| --- | --- |
| `required` | GitHub's branch-protection-required contexts only, via `--required` or `isRequired`; optional failures do not contribute |
| `head-pipeline` | GitLab MR head pipeline at the sampled SHA; not approvals, external status checks, mergeability, merge trains or all branch protection |
| `commit-status` | Gitea/Forgejo aggregate commit statuses when no reliable required subset is exposed; never label it required |

Keep `requiredChecks` for existing MCP compatibility. The validated optional
`checksMeaning` discriminator accompanies it in session metadata (including MCP),
participates in revisions/event cursors and is persisted with observations. Legacy
records may omit it until refreshed. The checkout panel labels the relevant
conclusion “Required checks”, “Head pipeline” or “Commit status”, separately from
the existing all-check counts. PR marks include the inert title in their tooltip;
the existing main-owned link action revalidates HTTPS against the routed host saved
with the fresh observation. It never reparses the raw Git remote. This host stays
main-only, is not restored from disk, and applies equally to board and child rows.
No check meaning or conclusion grants merge authority. `none` means a verified empty relevant set,
never that the user may merge; unknown is never success.

GitHub maps failed/cancelled to failure, unfinished to pending, neutral/skipped to
success; GraphQL errors, different head, missing data and partial context pages are
unknown. The fallback query is byte-for-byte the one in the frozen legacy test reference. A null rollup
on the verified commit is none. The [current gh manual](https://cli.github.com/manual/gh_pr_checks)
documents JSON bucket values and pending exit 8; the installed 2.45 CLI instead
uses the existing fallback.

GitLab uses `head_pipeline`, matching its `sha` to the MR head. Success maps to
success; failed/canceled to failure; created/waiting/preparing/pending/running/manual/
scheduled to pending. Skipped and an explicit null head pipeline map to none;
missing or unmatched pipeline is unknown. This is a proposed conservative policy,
not a claim that GitLab's merge rules match those conclusions. See the
[MR API](https://docs.gitlab.com/api/merge_requests/) and
[pipeline statuses](https://docs.gitlab.com/api/pipelines/).

## Polling, persistence and privacy

Foom owns #516 scheduling and the existing `ForgeTracking` limits. Poll every
20 seconds while checks run or are unknown, 120 seconds once settled, and 600
seconds with no matching PRs. Failed repository reads back off for
60/120/240/480/600 seconds; check-only unknown remains a valid observation.
Effective delay is the maximum of the scheduler delay, manifest minimum and fleet
load. `minimumIntervalSeconds` may **only slow polling**, never accelerate it,
raise concurrency or reset backoff. A manifest minimum of 30 therefore slows an
active 20-second poll to 30 seconds but cannot shorten a settled 120-second poll.
The bundled GitHub minimum is 20 seconds to preserve main exactly. One serial
worker, >=1 second between samples, <=1000 tracked worktrees, no catch-up bursts;
backoff and manifest minima can exceed ten minutes. Sleep and screen lock pause
polling, idle/exit may request a fresh read, and shutdown stops it.

Cache keys include host, project, selected manifest/digest, executable identity,
worktree identity, branch and bound number. Reinspect identity/branch before network
work and before publish. Removal/replacement retires observations. Saved narrowed
metadata remains private/atomic in a version-1 `{version, entries}` envelope in
`control/forge.json`. Saved number bindings include manifest ID/digest and selected
host/project. A changed provider clears the binding before a new request. Legacy
array records may retain numbers only for the bundled GitHub manifest on
`github.com`, after remote/ownership revalidation; config copies start with a fresh
lookup. Loaded metadata stays hidden until a fresh successful sample. Unknown versions/corrupt data grant no authority and
no visible cached success. Revocation/offline failures hide stale PR metadata as
today; they never reuse a previously green check result. Stop all work on shutdown.

Shared disclosure:

> Foom uses your selected forge CLI and its existing login to read PR or merge
> request and CI metadata. It sends repository/project, branch and PR/MR identifiers
> in read-only status requests. Foom does not send terminal content, store forge
> tokens, change CLI login/configuration, or write to the forge.

Queries and validated remote IDs/SHA may also be sent as read-only request data;
no local worktree paths, prompts, model output, diffs, titles or terminal bytes are
sent as inputs. Raw stdout/stderr and auth identity do not enter renderer, MCP,
logs, persistence or trusted diagnostics. Retain only narrowed metadata and fixed
failure categories. Shell-free execution prevents shell injection, not dishonest
plugin behavior; a configured CLI still runs as the user.

## Worked examples and implementation acceptance

The linked manifests contain all argv, fields, tables and fallback query text; no
external includes, provider-ID switches or hidden built-in implementation. GitHub
preserves today's list limit 2, open/all semantics, bound lookup, number resolution,
owner/cross-repository checks, exit diagnostics, checks buckets, fallback and final
head/state recheck. Title/URL/source-name enrichment is a separate optional read so
unsupported fields cannot break existing status tracking. Exact equivalence means
the current accepted/rejected PR/check observations, not identical process counts:
auth preflight and optional display reads are explicit additions for review.

GitLab uses `glab api --method GET` with explicit host and percent-encoded project.
Its list sends `scope=all`, exact `source_branch`, state and two-result limit, then
refreshes details when needed. `--raw-field` avoids typed file expansion; explicit
GET avoids the API CLI's field-triggered POST default. See the
[glab API contract](https://docs.gitlab.com/cli/api/). No login was attempted.

#521 must replay current forge unit cases through the new engine and keep adoption,
tracking, renderer boundaries and Electron tests passing. Add fixture-only tests for:

- Disabled/invalid/changed bytes, config copies of built-ins, conflicting host settings,
  missing executable/auth, exact host and nested namespace parsing, unknown kinds.
- Invalid branches/numbers, option injection, field-file expansion, controls, URL
  credentials/foreign hosts, shell/GraphQL mutations and wrong placeholder scopes.
- Zero/one/two matches, wrong branch/number/project, fork/default-branch refusal,
  bound closed/merged PRs, concurrent push/state/ownership change and remote change.
- All check buckets, empty diagnostics, JSON on exits 1/8, fallback failure,
  unknown value, null vs missing, optional-only contexts, partial/oversized pages,
  wrong commit, pipeline mismatch/manual/skipped and unknown check meaning.
- Cancellation, per-host auth caching, output/deadline caps, shutdown/process cleanup,
  batch partial/duplicate/missing rows, slow fallback cadence and persistence migration.

Do not run real agent CLIs, live forge tests or require credentials in CI. Fixtures
are untrusted input, not instructions. No current coverage thresholds are weakened.

## Recorded decisions and remaining shipping gates

1. **Command safety:** the initial validator accepts a closed set of PR reads,
   fixed auth status, GraphQL query transport and explicit project-MR GET reads.
   It uses the GraphQL grammar to reject mutation/subscription operations. New CLI
   forms require reviewed grammar additions applying to both origins. Fixed argv
   alone, a `readOnly: true` claim or a privileged bundled exception is insufficient.
2. **Auth preflight:** mandatory exit-0 gating is approved, including public reads. `gh auth status` can fail for
   another account on the same host even when a selected account can read; measure
   supported versions before deciding. The proposed fixed negative-marker scan
   handles the observed glab exit-0 failure but needs healthy/failed-version
   coverage before shipping. No credential extraction or config changes.
3. **Polling resolved:** follow main, preserving #516's dynamic batches and
   check counts, 20-second active polls and 120-second settled polls. The previous
   30-second parity assumption was incorrect. Manifest minima can only slow this
   schedule; there is no special bundled-provider cadence.
4. **GitLab policy/evidence:** approve manual → pending and skipped → none labels;
   obtain public authenticated captures of MR detail/head pipelines and exit behavior
   before #522. Current glab is unauthenticated; constructed schemas are not that
   shipping evidence. Merged-result pipelines whose SHA differs remain unknown.
5. **Self-hosting:** host settings authorize routing only. GitHub Enterprise and
   self-managed GitLab versions, custom ports and certificate behaviors need public
   or synthetic evidence; do not promise parity merely from matching a hostname.
6. **Other CLIs:** `tea` (Gitea/Forgejo) still needs measured JSON fields, auth status,
   fork project identity, pagination and required-vs-all commit-status discovery.
   `az repos` needs organization/project/repository identity beyond a simple pair,
   Azure URL/SSH forms, extension discovery and policy-evaluation JSON. Neither has
   a worked/shipping manifest here. Native executable availability on Windows is
   also a gate; do not bypass wrapper restrictions for `az.cmd`. The
   [Azure command reference](https://learn.microsoft.com/en-us/cli/azure/repos/pr?view=azure-cli-latest)
   documents automatic extension installation on first use: future discovery must
   prevent that side effect, rather than silently installing it.

Approval is recorded on #520; the later polling decision on #521 takes precedence.
GitLab evidence and other CLI grammars remain separate shipping gates.


## GitLab batch representation (#522)

The same dynamic batch engine also accepts a base query with `$project: ID!`
and transport `api graphql --hostname {host} -f query={query} -f project={project}`.
The project slot remains the complete validated path, including nested groups.
A bound item query may declare `$number: String!`; main inserts only a validated
positive safe integer rendered as a GraphQL string literal. Discovery branches
still use raw `-f bN=` variables, with the existing output/query/argv caps.

Optional batch `mapping` has the same closed shape as the ordinary mapping and
selects the GraphQL fields independently of REST. `numberEncoding: decimal-string`
accepts only canonical positive decimal strings that fit safe integers.
`projectIdEncoding: global-project-id` accepts only `gid://gitlab/Project/N` with
canonical positive safe integer N. For numeric-project-ID mappings,
`projectContext` selects the queried repository/project ID from the batch repository
object; main requires source == target == context. No boolean can substitute for
these comparisons. The legacy sourceProject/crossProject selectors apply only to
owner-and-cross-flag mappings. The existing check-result object shape handles a
single head pipeline (without a required flag), while array results still require
the required-flag selector. Explicit null/skipped pipelines yield zero counts;
missing, malformed or stale pipelines yield unknown with no counts.

Optional root `requestLabel: "Merge request"` and `numberPrefix: "!"` provide
bounded inert board/panel/notification display metadata, defaulting to the existing
Pull request/# wording when absent. These fields grant no forge capability.
See [GitLab mappings and evidence limits](areas/forge.md#gitlab-522).

The added discovery/default-branch selections use the documented
[GitLab GraphQL Project and Repository fields](https://docs.gitlab.com/api/graphql/reference/objects/).
They are exercised in derived fixture envelopes, not claimed as new live captures.

GitLab REST maps `merge_commit_sha` and `squash_commit_sha` independently. There
is no manifest expression or ancestry-aware fallback selector: main retains both
validated hints, and cleanup tests the merge commit followed by the squash commit.
A candidate must be an ancestor of fetched default and locally integrate exactly
the sampled head. Head ancestry proves a merge; otherwise a candidate must be a
single-parent commit H with parent P whose conflict-free merge of P and the exact
head produces H's tree OID. Main runs `git merge-tree --write-tree P <head>` and
requires exit zero plus one canonical OID equal to `H^{tree}`. Missing/ambiguous
merge bases, conflicts, malformed output and Git errors fail closed. Patch IDs are
not proof because they ignore hunk positions, even with `--verbatim`.

Both containment and hint merges run in a disposable bare repository with a
read-only view of the source object store. Global/system config and system
attributes are disabled per subprocess. Main-owned info/attributes overrides
versioned attributes with a built-in merge driver and no content conversion;
fixed options disable renames and renormalization and retain built-in histogram diffing.
Repository merge-driver definitions are never executed. Exact tree comparison
preserves edit positions, binary data and line endings without decoding file bytes.
Only ancestry exit 1 means ordinary non-ancestry, permitting the alternative hint.
The head-equality, same-project, final-refresh, clean and identity guards remain.
See [Git merge-tree](https://git-scm.com/docs/git-merge-tree) and
[attribute precedence](https://git-scm.com/docs/gitattributes).
Missing/invalid hints are absent and cannot authorize cleanup. GraphQL
requests/maps `mergeCommitSha`; the documented MergeRequest schema has no
`squashCommitSha`. Cleanup's ordinary REST lookup supplies the squash alternative.
See [REST fields](https://docs.gitlab.com/api/merge_requests/) and
[GraphQL fields](https://docs.gitlab.com/api/graphql/reference/objects/#mergerequest).
The reduced #718 envelopes omit these SHA fields; tests add explicitly synthetic
merge/squash hints, with real local Git objects for the cleanup regression.
