# Forge manifests — proposed specification (#520)

**Proposed, not decided. User approval is required before #521 starts.** This PR
adds a design and evidence fixtures, not runtime support. #521 would implement the
shared engine and convert GitHub; #522 would ship GitLab after its evidence gates.
There are no new permissions for agents, no forge writes, and no merge automation.

A forge is a second manifest **kind** in the [existing plugin system](agent-plugins.md),
not another plugin architecture. Built-ins are bundled JSON. An approved duplicate
can express every built-in behavior, including fallback queries. Main owns process
execution, ownership decisions and polling; manifests describe CLI syntax and data.

## Review artifacts and compatibility

The complete, standalone worked manifests are [GitHub](../spikes/forge-manifests/github.json)
and [GitLab](../spikes/forge-manifests/gitlab.json). The executable
[JSON Schema draft](../spikes/forge-manifests/forge.schema.json) uses draft 2020-12.
The tables and semantic constraints below are part of the proposal; JSON Schema
alone cannot validate query safety, placeholder scope or exact-byte approval.
[Spike evidence](../spikes/forge-manifests/README.md) separates recorded output from
constructed fixtures, and describes validation without live CLIs.

Dependency status: #520 has no listed prerequisite. #521 also depends on #516
being merged; this spec does not authorize starting either follow-up early.

Versioning is per kind: `kind: "forge", version: 1`; existing `agent` v1 and v2
bytes, directories, IDs, approvals and semantics remain unchanged. The shared
loader dispatches on `(kind, version)` before kind-specific validation. Unknown
kinds/versions are invalid, never interpreted as agents. No automatic rewriting.

Proposed config location: `forges/<id>.json`, using the same contained-directory,
64 KiB descriptor-bounded reads, file watcher, Recent changes, config git, Revert,
Keep and profile-only SHA-256 approval machinery as `agents/`. Each kind has a
50-file catalog cap and its own ID namespace; registry keys include kind. Bundled
IDs are reserved within their kind. No second trust store or consent IPC.

Settings uses the existing card component in a **Forges** group: name, badge,
source, approval, detected executable/version, host assignments, available status,
on/off and **Duplicate as plugin**. Duplication changes only ID/name, creates an
exclusive `forges/<id>-custom[-N].json`, and copies no approval, enablement, host
assignments or cached observations. It remains pending until exact bytes are
approved. The shared duplicate operation receives kind plus a build-owned ID.
Disabling a card preserves settings but stops probes and polls. This is a behavior
specification, not approval of a new visual layout.

No executable resolution/probing/auth check occurs for pending, disabled, invalid
or changed manifests. Approval shows every command, environment override, query,
output mapping, exit rule, host declaration, check meaning and minimum cadence,
with before/after changes. The trusted dialog names that the CLI runs as the user;
approval of JSON is not executable attestation or an OS sandbox. Main rechecks the
digest, selected host, enabled state and registry revision before each spawn and
before publishing results. Changes revoke future work and discard in-flight samples.
A duplicate receives exactly the same capabilities through the same engine.

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
The user can choose one approved enabled forge per host in Settings, including
explicit self-hosted entries such as `git.example.org → gitlab-custom`. An explicit
assignment may extend that manifest's declared hosts using its same grammar. A
manifest edit cannot add assignments. Duplicates never steal a host; conflicts or
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
and guard arrays default to empty, minimum interval defaults to 30 seconds, and
absent operations/fallbacks disable those features. Explicit null is not omission.

| Root field | Required content |
| --- | --- |
| `kind`, `version`, `id`, `name`, `badge`, `executables` | Identity and resolved CLI; `forge`, `1` |
| `remote` | Host declarations and namespace/comparison grammar |
| `auth` | `argv`, `successExitCodes: [0]`, optional `failureContains` |
| `environment?` | Fixed nonsecret prompt/pager overrides only; absent means none |
| `minimumIntervalSeconds?` | 30–86400; may slow Foom's cadence, never accelerate it |
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
| `query` | That plan's fixed GraphQL text, <=16384 bytes, total query text <=32768 bytes; no string substitutions in it |
| `branches` | Batch only; 1–50 distinct validated branch strings, JSON encoding only |

`literal` does no escaping; `percent-component` UTF-8 percent-encodes the entire
project (including slashes) once and is allowed only for project endpoint segments;
`json` serializes branches only. No arbitrary output-to-argv bindings. Node ID is
the only intermediate identifier. Reject out-of-scope slots, dangling query/node
bindings, nested parts and incompatible encodings before approval. Manifest values
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

Read-only is a reviewed contract, not a claim that arbitrary approved binaries are
sandboxed. The parser rejects GraphQL mutation/subscription operations using a real
GraphQL grammar (including fragments), permits one query, and forbids endpoint
substitution from output. API commands must declare GET explicitly, except GraphQL
query transport. Known mutation commands, auth/config changes, aliases/extensions,
file inputs and shell entry points are invalid. New CLI syntax requires a reviewed
read-only grammar in the generic command validator before shipping; it must apply
equally to bundled/config manifests, never grant a built-in-only escape hatch.
This enforcement design is an explicit implementation gate, not solved by the JSON
Schema. Approval still cannot prove an installed executable behaves honestly.

## Operations and observation lifecycle

Main invokes a fixed workflow; manifests cannot supply a general program or loops.

1. Revalidate worktree identity, branch, host assignment and approval. With no bound
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

`batchStatus` is optional acceleration: one command, fixed optional GraphQL query,
`rows` path, `pageComplete` path and `maxBranches` <=50. It consumes a validated
JSON branches slot and returns records using the same mapping. Each row must carry
its own branch/number/head/project evidence. Partition by host, project, manifest
digest and executable; never batch across repos/accounts. Require explicit
`pageComplete === false` (the path selects a has-next-page flag), a bounded array
<=1000, no unknown requested-branch substitutions, and one unambiguous row per
branch. Missing rows have no match only on a complete page. Duplicates invalidate
that branch; malformed envelope/partial page invalidates the batch. The v1 batch
operation supplies candidates only: checks and final rechecks still run per
candidate under the same budgets. It cannot turn one branch's success into another's.
A failed/absent batch falls back to per-branch sampling at the slower cadence below.
Neither worked manifest declares a batch: no unmeasured bulk result is presented as
production-ready. Rich atomic bulk checks would require a later format extension.

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
manifest-supplied policy result. Approval still reviews whether selectors describe
the CLI correctly; this is not cryptographic attestation of an arbitrary CLI response.

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

Keep `requiredChecks` for existing MCP compatibility, add a validated `checksMeaning`
discriminator to new metadata/UI in #521, and label it “Required checks”, “Head
pipeline” or “Commit status”. Persist it with observations. No check meaning or
conclusion grants merge authority. `none` means a verified empty relevant set,
never that the user may merge; unknown is never success.

GitHub maps failed/cancelled to failure, unfinished to pending, neutral/skipped to
success; GraphQL errors, different head, missing data and partial context pages are
unknown. The fallback query is byte-for-byte the one in `forge.ts`. A null rollup
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

Foom owns #516 scheduling and the existing `ForgeTracking` limits. Success baseline
is 30 seconds, unavailable/no match backs off 60/120/240/480/600 seconds; check-only
unknown remains a valid observation. Effective delay is the maximum of that delay,
manifest minimum and the scheduler's fleet load. The requested slower non-batch baseline conflicts with preserving today's GitHub
30-second polling. This remains an approval gate: choose a uniform 60-second
non-batch baseline (30 seconds for successful batch sampling), or preserve 30 seconds
for all providers in #521 and defer that cadence change to #516. Do not implement
a privileged provider-ID exception: bundled and duplicate manifests have identical
scheduling semantics. The worked manifests declare only their minimum interval,
not a faster polling entitlement. No manifest can raise request concurrency or reset
backoff. One serial worker, >=1 second between samples, <=1000 tracked worktrees,
no catch-up bursts; backoff and manifest minima can exceed ten minutes.

Cache keys include host, project, selected manifest/digest, executable identity,
worktree identity, branch and bound number. Reinspect identity/branch before network
work and before publish. Removal/replacement retires observations. Saved narrowed
metadata remains private/atomic in `control/forge.json`; add a versioned envelope
when new fields land, reading legacy records as GitHub observations only after
remote/ownership revalidation. Unknown versions/corrupt data grant no authority and
no visible cached success. Revocation/offline failures hide stale PR metadata as
today; they never reuse a previously green check result. Stop all work on shutdown.

Proposed shared disclosure (replaces GitHub-specific wording when implemented):

> Foom uses your selected forge CLI and its existing login to read PR or merge
> request and CI metadata. It sends repository/project, branch and PR/MR identifiers
> in read-only status requests. Foom does not send terminal content, store forge
> tokens, change CLI login/configuration, or write to the forge.

Queries and validated remote IDs/SHA may also be sent as read-only request data;
no local worktree paths, prompts, model output, diffs, titles or terminal bytes are
sent as inputs. Raw stdout/stderr and auth identity do not enter renderer, MCP,
logs, persistence or trusted diagnostics. Retain only narrowed metadata and fixed
failure categories. Shell-free execution prevents shell injection, not dishonest
plugin behavior; exact-byte review remains necessary.

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

- Disabled/unapproved/changed bytes, duplicate cards, conflicting host settings,
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

## Open questions — approval gates

1. **Command safety grammar:** settle how the shared validator proves a new CLI's
   accepted command forms are read-only without a per-provider execution adapter.
   Fixed argv + approval is not proof. #521 must not quietly reduce this to a
   manifest `readOnly: true` flag or ship a privileged GitHub exception.
2. **Auth preflight parity:** retain mandatory exit-0 gating, or make it advisory
   for public anonymous reads? This proposal gates. `gh auth status` can fail for
   another account on the same host even when a selected account can read; measure
   supported versions before deciding. The proposed fixed negative-marker scan
   handles the observed glab exit-0 failure but needs healthy/failed-version
   coverage before shipping. No credential extraction or config changes.
3. **Non-batch cadence:** choose uniform 60 seconds or preserve the 30-second
   baseline for all providers during migration. The issue requests a slower fallback and exact current GitHub
   behavior; both cannot change the same interval simultaneously. Recommendation:
   keep 30 for #521 parity, decide the uniform policy alongside #516 before release.
   This is intentionally unresolved; no per-provider compatibility privilege.
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

User approval of this specification and resolution of the #521 gates must be
recorded on #520 before implementation starts. A green spec PR is not that approval.
