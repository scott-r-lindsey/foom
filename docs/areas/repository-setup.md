# Repository setup (#1080)

The [approved design](../design/1080-repository-setup.md) owns behavior. This
feature retains serialized JSON persistence, without SQLite or phase-D guards.
`main/setup/repository-setup.ts` owns immutable active approvals, board-scoped
review/run tokens and row observations. Registration incarnation IDs belong to
`worktrees.json`; legacy incarnations are durably flushed before saving setup
approval, and removal/re-registration cannot resurrect an earlier approval.
The private `repository-setup/state.json` holds canonical list digests, catalog
identity, source fingerprints, attribution and monotonic revisions. Saving fails
closed and retains the prior approval and editable draft. Stored observations
never authorize a launch.

## Evidence membership

Inspection reads dirty and untracked regular files without running Git, scripts,
interpreters or plugins. It compares sorted path membership and SHA-256 bytes;
HEAD is attribution only. Approved evidence paths add documentation to this set.
Root and nested names are exactly:

```text
package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml
pnpm-workspace.yaml yarn.lock bun.lock bun.lockb Cargo.toml Cargo.lock
rust-toolchain rust-toolchain.toml go.mod go.sum go.work go.work.sum
pyproject.toml requirements.txt Pipfile Pipfile.lock poetry.lock uv.lock
.python-version Gemfile Gemfile.lock .ruby-version pom.xml build.gradle
build.gradle.kts gradle.properties global.json Directory.Build.props
Directory.Packages.props composer.json composer.lock .nvmrc .node-version
.tool-versions mise.toml .mise.toml Makefile CMakeLists.txt CMakePresets.json
meson.build meson_options.txt Dockerfile Containerfile AGENTS.md CLAUDE.md
CONTRIBUTING.md
```

Also includes root `.github/workflows/*.yml` / `*.yaml`, and nested `*.csproj`,
`*.fsproj`, `*.vcxproj`. Directory exclusions are `.git`, `node_modules`, `.venv`,
`vendor`, `target`, `dist`, `build`, `out`, `coverage`, `test-results`, `inspiration`
and root `docs/mockups`. Explicit evidence can name regular files in excluded
non-Git directories; it cannot traverse links or `.git`.

Limits are 64 evidence/matching files, 1 MiB each, 4 MiB aggregate, 64 directory
levels and 20,000 entries visited. Absolute paths, parent traversal, links, special
files, redirected reads and exceeded limits report Unable to verify sources.
This is bounded filesystem observation, not atomic isolation from another local
process replacing entries. No watcher or periodic inspection is added.

## Checks and catalog

Package probes are fixed `dpkg-query --show --showformat=${db:Status-Status} --`,
`rpm --query --`, `pacman -Q --`, or validated-login-PATH `brew list --versions`,
followed by narrowly validated literal package operands. Toolchain probes use only
`--version` and exact/major-range parsing. Probes run outside checkouts with a
normalized discovery PATH excluding relative/current/checkout entries, and a small
complete environment without Foom-added secrets or control grants. Discovery is
not the executable probe PATH. Before any ABI probe, the shared checker resolves
all supported tools (Node, pnpm, Homebrew) to canonical targets outside both the
registered code/repository root and selected checkout. It pins those targets in
a fresh Foom-owned 0700 temporary directory. Every probe gets only that directory
plus canonical fixed system directories verified root-owned and not group/world
writable. Missing supported tool names have private exit-127 blockers, so an
`env node` shebang cannot fall through to another Node. Arbitrary login directories
never enter the probe PATH. Before probing, the checker reads bounded shebangs
and recursively canonicalizes static interpreter chains (at most four scripts),
including simple `/usr/bin/env NAME` lookup through these pins and verified system
directories. Relative interpreters, repository/checkout targets, cycles, deeper
chains and unsupported env flags/assignments are blockers (Unable to check).
Only an argument-free absolute interpreter or the single NAME operand of
`/usr/bin/env NAME` (including a canonical alias of env) is accepted. Every other
interpreter argument is refused, even apparently benign options; there is no
safe-option allowlist. This blocks preload flags and script operands that could
execute repository content without the interpreter itself residing in R/W.
Accepted scripts run as `<canonical interpreter> <canonical script> --version`,
with only the canonical nested script paths prepended; their private PATH entries
use the same canonical invocation. Native binaries execute directly. An absolute alias
or PATH alias is never handed to the kernel as an unchecked script interpreter.

`withSetupProbeDependencies` owns this scope in local human/child/resume admission,
remote admission and management, and setup helpers. It removes the directory in
`finally`, including on failed checks, cancellation and partial construction.
Helpers retain the pinned environment through recipe execution. Ordinary agent
work resumes its normal filtered login environment after admission; the temporary
probe directory is never returned as a durable agent PATH. Native Windows setup
remains manual and creates no Unix probe scope.

Failed/timed-out probes remain Unable to check, distinct from missing packages
and wrong versions. Read-only probes disable [Corepack network access](https://github.com/nodejs/corepack#environment-variables)
and [Homebrew auto-update/analytics](https://docs.brew.sh/Manpage#environment).
Explicit setup retains the disclosed installer network behavior. Local source
observations retain the registered repository root when inspecting a linked
worktree. Remote checks retain the entire registered code root and selected
checkout. Selecting a worktree never narrows the exclusion scope. These are
bounded filesystem observations. The threat boundary is untrusted repository
content under the registered root R and selected checkout W, including static
interpreter chains that lead into either root. A same-user process retargeting or
replacing files outside R/W during a check can already execute as that user and
is explicitly outside this boundary; these checks do not attempt to isolate it.

Package grammars are manager-specific allowlists. All reject leading `-`, trailing
`-`/`+`, `=`, paths, globs and whitespace; Debian also rejects dots (apt regex
fallback), while Homebrew permits only an optional numeric `@version` suffix.
The recipe sink validates operands again. Apt installation uses `--no-remove --`
to refuse explicit and solver removals. Homebrew uses `--formula --`, with
`HOMEBREW_NO_INSTALL_CLEANUP=1` and `HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1`
([documented behavior](https://docs.brew.sh/Manpage#environment)). Unmet OS packages
on RHEL/Arch are manual until an atomic no-removal transaction is supported;
checks, already-met packages and private toolchains remain available. Catalog
revision 6 invalidates prior approvals and mismatched helpers. Exact catalog-v1
profiles retain their original lists and digests through a bounded historical
reader. They remain Review needed and block launch/setup; obsolete package names
are visible in review and editable, but cannot be approved under the current
schema. Replacements use the trusted confirmation and the next list revision.
Other malformed lists or invalid list/source digests still refuse startup.
Unused setup storage is not created at startup; existing state and every write
still receive private-directory/file verification.

The initial catalog pins Node 24.17.0 for Linux/macOS x64/arm64 to official
`nodejs.org` archive SHA-256 values and pnpm 10.34.7 to its fixed npm artifact and
SHA-512 integrity. No latest resolution, checkout installer, arbitrary address,
package removal or distribution upgrade is exposed. Native Windows setup is
manual. Node checks its own minimum ABI separately from daemon readiness: Linux kernel
4.18, glibc 2.28 and the bounded system libstdc++ `GLIBCXX_3.4.25` symbol; macOS
13.5. The [pinned Node platform contract](https://github.com/nodejs/node/blob/v24.17.0/BUILDING.md#platform-list)
is the source. Library reads are fixed-path regular files bounded to 16 MiB each.

Downloads refuse redirects, exceed neither 128 MiB compressed nor 512 MiB
uncompressed, and verify integrity before parsing tar members. Member count,
header checksums, traversal, links and special file types are checked before
private staging. Bounded GNU long-name records receive the same path checks as
ordinary names; dangling or duplicate metadata refuses the archive. Node publishes only its executable; pnpm extracts package bytes
without lifecycle scripts. Atomic private publication never edits shell startup
files. Only catalog-selected private bins affect repository launch PATH.

## Approval, execution and launch

Only registered board main-frame `setup:repository-setup` IPC exposes the closed
list, copy-brief, review, cancel-review, approve, remove, check and run actions. No agent/control operation
approves or runs setup. Initial approval and every replacement request use the
main-owned trusted dialog; a review token only requests it. Cancel leaves the
active list intact; empty replacements explicitly disclose removal of all launch
prerequisites. Main revalidates review authority and evidence after the trusted
answer. Removal asks through the trusted dialog and explains
that the launch prerequisite is removed without uninstalling anything.

Review tokens bind board, repository incarnation, expected revision, canonical
list, evidence and catalog. Back, Cancel and Edit revoke the review token, including
reviews awaiting a source read. Unsupported toolchains remain unresolved data;
approval requires resolution or explicit removal, with removed IDs shown in review.
Setup tokens bind the exact displayed plan and host
registration, source fingerprint and actual root/checkout presence. Set up refreshes
sources/platform/facts and refuses changed plans. Main re-reads the source snapshot
after local shell/remote connection preparation immediately before dispatch. The
helper checks the bound source snapshot before probes and each recipe step; edits
during awaits refuse all subsequent steps. This is bounded revalidation, not an
atomic filesystem snapshot.
Concurrent exit/renderer rechecks reuse a scoped token only when its immutable
plan digest and registration binding still match; row object replacement cannot
discard a valid retry. The terminal is human-owned and embeds in Settings with the existing Stop / Keep
open behavior. Run cancellation/revocation stops future steps, without rollback.
Exit triggers only the affected host/repository row check; terminal exit zero
alone never marks requirements met.

Remote protocol capability `repositorySetup` carries the exact catalog digest.
Older/mismatched daemons refuse before dispatch. Remote child specs retain the
existing 64 KiB agent-field budget; the independently validated setup admission
carries its own 64 KiB canonical list bound. Helpers reconstruct fixed argv
and verify the run digest. Host mutation reservations serialize setup with
existing mutations; the app-wide local reservation also excludes vendor installers; reconnect never replays it. Remote repository launches bind
list revision and source fingerprint and recheck requirements on the host before
spawn. Local and remote main checks retain final identity/revision validation.
