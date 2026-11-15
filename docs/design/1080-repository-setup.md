# Repository setup on hosts (#1080)

**Approved design.** Phase 1 was approved by the user and merged in #1192.
Phase 2 implements the runtime and fixture acceptance below. The user merges the
implementation because this extends host execution and trusted human approvals.

## Current behavior and scope

[#1080](https://github.com/scott-r-lindsey/foom/issues/1080) has no comments at the
phase-one read. Its dependencies #1061 (scoped rechecks) and #1062 (embedded
terminals) are closed and present on this branch's base. Today
[Hosts](../areas/hosts.md#host-card-readiness-and-repository-fixes-1026) checks
Foom's own language-neutral requirements. It neither determines build dependencies
nor runs checkout code. First-use checkout preparation already belongs to launch
(#1074); setup must not bring clone controls back to Settings.

Proposed addition: an optional, approved setup list for each registered repository,
kept exclusively in Foom's private profile. It describes host OS packages and
versioned toolchains needed to work on that repository. It does not install the
repository's application dependencies, run builds, execute package scripts or
certify that a build will pass. Those remain ordinary unprivileged repository work.

Host **Ready** retains its current meaning. Below it, a **Repository setup** group
shows one row per registered repository, independently of Git access and checkout
presence. A host can be Ready while `foom · Needs setup` is visible. The repository
row names missing requirements, its own observation time, the approved revision,
**Review list**, **Set up**, and its accessibly named reload control. Existing
Check capabilities also includes these rows when the capability is available;
opening Settings reads saved observations only.

## Create a list without trusting checkout instructions

Settings → Repositories adds **Setup list** on the selected registered repository.
Hosts → Repository setup → **Create list** opens the same editor, preserving the
originating host for the return action. No list means **No setup list** (neutral,
not Met); existing launch behavior continues until a list is approved. An empty
approved list explicitly records **No host requirements**.

The editor offers two paths:

1. **Write list**: choose packages for each supported distribution and toolchains
   from Foom's catalog. Require a short purpose for each requirement and source
   paths where available. A distribution can be explicitly unsupported; an absent
   mapping never means an empty requirement set.
2. **Draft with agent**: copy a fixed brief, then open an ordinary human-owned
   repository agent using existing launch behavior. The brief asks it to read
   build docs/manifests as text and return a structured proposal with requirements,
   evidence paths and uncertainties. It forbids running installers or requesting
   sudo for this task. The user pastes its JSON result into **Import draft**.
   This is an ordinary agent with its existing permissions, not a new read-only
   sandbox; the brief cannot enforce its behavior. Foom performs no model request
   or autonomous agent launch. The disclosure says repository material may reach
   the chosen agent's provider under that agent's settings. The user may instead
   use an existing agent. Setup-list editing remains available when an approved
   list would block a new repository launch.

The JSON is untrusted suggestion data. Import parses and validates it; it never
imports an executable, shell program, URL, environment assignment or approval.
No checkout file is watched as a setup list, and no agent/control API can approve,
change the active list or run setup. Paste avoids adding a general agent-to-profile
writer. Unsupported requirements stay visibly unresolved in the draft; the user
must resolve or explicitly remove them before approval, with removal shown in the
review. Manual fixes remain possible in the user's own terminal.

## Review and approve

The review page names the repository and shows all distro mappings (Debian/Ubuntu,
RHEL-family, Arch, macOS), package names, toolchain version constraints, purposes,
evidence and any gaps. A distribution picker changes the displayed command preview;
it does not hide other mappings from approval. Each mapping shows its exact argv
steps and whether sudo is required. Package names are literal, narrowly validated
operands; they cannot begin with a dash or contain whitespace, paths or expansion.
Version constraints use a closed supported form (exact version or major range),
not arbitrary expressions passed to a shell. Limits: 64 KiB input, 128 requirements,
64 source paths, 160 characters per path and 500 characters per explanation.
Unknown fields, duplicates, invalid UTF-8/NUL and oversize input refuse import.

Approval is distinct from execution. **Approve list** saves a new immutable active
revision atomically in main. It installs nothing. **Cancel** leaves the previous
active revision intact; drafts never replace it. Updating shows added, removed and
changed requirements against the active revision. Approval can replace the whole
list only from the registered board main frame using a main-held review token
bound to repository identity, draft digest and expected active revision. Main
revalidates the evidence snapshot and catalog revision before saving; a change
requires review again. A concurrent window's approval makes an older review refuse.
Failed persistence retains the active revision and the editable draft.

A saved approval records the canonical structured list digest, catalog revision,
source fingerprint, source checkout identity/HEAD for attribution, approval time
and monotonic list revision. Source text and explanatory prose confer no authority.
Profile writes use the current serialized JSON store; this work must not migrate
production state to SQLite or enable #1153 phase-D guards incidentally. Main owns
records; renderer/preload receive bounded validated projections. Future migration
follows [data ownership](../areas/data.md).

Removing a list requires an explicit **Remove setup list** confirmation explaining
that this removes the repository launch prerequisite. It uninstalls nothing.
Repository removal deletes its lists and observations; host removal deletes that
host's observations, retaining the repository list. Re-registration never revives
old authority by matching an origin string alone.

## Keep the list fresh

Approval also approves evidence paths, not commands found in those files. Foom
fingerprints bounded regular-file bytes as data inside the selected checkout.
Reject absolute paths, `..`, symlinks, escapes and special files; never source a
file, run its interpreter or load a plugin. A fixed built-in set includes root and
nested language manifests/lockfiles, toolchain version files, build definitions,
CI workflows and contributor instructions. The approved list may add documentation
paths. Compare the sorted membership of the fixed patterns as well as file bytes,
so adding a new workspace manifest or removing a version file invalidates review.
Include dirty and untracked matching files; do not assume HEAD alone is current.
Implementation must publish the exact pattern set in the owning area docs and
cover monorepos. Bound inspection to 64 matching/evidence files, 1 MiB each and
4 MiB total; exceeding a bound reports **Unable to verify sources**, never Met.

Inspect on explicit **Review list**, a repository-row reload, Check capabilities,
**Set up**, and before a repository agent/child launch. No idle filesystem watcher,
background model call or periodic host poll is added. A host without a checkout
can check installed requirements against the approved list; its row additionally
says **Sources checked at first launch**. First launch validates the actual
prepared checkout before spawning. This may require the existing clone preparation,
but never creates a child or consumes a child slot on a prerequisite refusal.

| Change | Result and user action |
| --- | --- |
| Same evidence bytes on another commit | Keep the approval; a commit hash alone does not make it stale. |
| Relevant bytes or membership differ, including branch switch/dirty edits | **Review needed** with paths and changes; block setup and new repository agent launches for that source fingerprint. |
| Requirements unchanged after review | **Keep list** approves a new evidence baseline explicitly; it does not run setup. |
| Requirements changed | Edit or import another draft, review the diff, then **Approve list**. |
| Active list or recipe catalog changes | Invalidate all corresponding host observations and pending setup/review tokens. Recheck under the new digest. |
| Source cannot be read or host is unreachable | **Unable to check**; retain dimmed last observations and refuse launch without fabricating missing packages. |

A changed branch does not rewrite the shared approved baseline automatically.
Older branches whose requirements differ need explicit review against the current
list; per-branch lists are outside this first version. One active baseline may be
restrictive when several branches need different toolchains; show that reason
rather than silently install a different version. Approving unrelated source
changes with Keep list is intentionally an explicit human decision.

Fingerprints catch changes in the declared evidence set, not every semantic build
change. A dependency introduced only in another source file can escape detection.
**Review list** is always available; repository maintainers must update the list
when requirements change. UI says **Requirements met**, not “Build guaranteed.”

## Check, set up, then recheck only that row

Read-only checks are new, closed host operations. Package presence uses fixed
package-database queries for the selected distro and toolchain probes use bundled
version parsers and fixed `--version` arguments. They run outside the checkout,
with normalized host environment and a safe PATH excluding checkout/current-directory
entries. They never call a checkout's package manager, config, script or plugin.
Version mismatch is **Needs setup**; a failed/timed-out probe is **Unable to check**.
Saved results are presentation only, never launch authorization.

**Set up** is the single execution click after an active list has been approved.
Its adjacent summary discloses the host, repository, missing items, exact steps,
network downloads and sudo. Main refreshes platform/package facts and sources,
then selects steps for only unmet requirements. A changed plan refuses and returns
to review instead of executing steps the user did not see. Met rows offer only
Reload/Review. Unsupported distro, missing recipe, unavailable capability or
unresolved version shows **Manual setup required** with a fixed reason, no Set up.

The run opens the human-owned embedded terminal in that host card (#1062), keeps
Settings open and follows Stop / Keep open on exit. Input/passwords go directly
to its ID-scoped terminal IPC. Children get no sudo, no install capability, no
setup terminal ID and no ability to type into this terminal. Recipe processes get
no orchestration grant, hub credentials or Foom-added secret environment layers.

Each step has fixed executable/argument arrays from a bundled recipe template plus
validated literal package operands; no shell source, interpolation, `eval`, typed
commands, checkout paths or arbitrary executable/URL fields. Main binds the canonical
ordered steps, list revision/digest, catalog revision, distro/architecture, host
registration and repository identity to the run. The host independently validates
and reconstructs the steps and checks their SHA-256 digest before starting. A
capability version advertises this extension; incompatible older daemons refuse
before dispatch without falling back to generic execution. Exact recipe-catalog
identity is required even for protocol-compatible peers. Registration, repository,
approval and cancellation are rechecked after awaits and immediately before dispatch.

OS packages retain existing recipe policy: Debian update then install, DNF install,
Arch install without `-Sy`, and Homebrew via the validated login PATH. Prompts and
sudo stay in the visible terminal; Foom cannot supply an answer. No silent fallback,
removal, distribution upgrade, arbitrary package repository or repository script.

Toolchains are catalog capabilities, not arbitrary agent-provided installers. The
initial implementation must support Node 24 on supported Linux/macOS architectures:
resolve `24.x` to an exact bundled release with fixed official HTTPS archive URL
and checked-in SHA-256 per architecture. A bundled helper downloads, bounds and
verifies the archive, rejects traversal/links outside its private staging root,
then atomically publishes to a Foom-owned account-private toolchain prefix. An
approved exact pnpm version uses a catalog-pinned package artifact and integrity
check, with lifecycle scripts disabled. Neither path edits shell startup files or
agent configuration. Repository launches/checks prepend only that validated
profile-selected toolchain bin directory; human machine shells retain their normal
PATH. Show versions and this repository-scoped PATH effect in review. A requested
version outside the catalog is Manual setup required, never “latest.” New releases
change the catalog digest and require review before installation; existing matching
system tools may satisfy a list without installation. Node's minimum host ABI must
be checked separately from the daemon's minimum; incompatibility is manual setup,
not an inferred successful install. Other toolchains require a separately reviewed
catalog entry; there is no generic script escape hatch.

Runs serialize with the existing host mutation reservation. A second window sees
**Setup already running**; reconnect never replays it. Removing/changing approval
while a run is live stops future steps, cannot undo a step already dispatched, and
marks its result superseded. Stop/failure starts no later step. There is no rollback
or automatic uninstall. On exit (success, failure or Stop), recheck only this
host/repository row (#1061), including on failure after partial installation.
Recheck/persistence failure reports **Unable to check/save**; exit zero alone cannot
mark requirements met. Other rows and full-check Last checked stay unchanged.
Terminal chrome retains **Done** or **Failed · step N · exit code** separately from
requirements status. Retry is another explicit Set up click, with a fresh plan
that skips requirements now met; terminal restart never replays setup.

## Launch admission

Before every new repository agent or child launch, including restart/resume that
spawns a process, main checks the active list revision, actual checkout fingerprint
and current host facts. Reattachment of an existing process is unaffected. Check
freshness at admission and revalidate digest/identity immediately before spawn;
remote spawn must bind the same validated prerequisite result. Checks are observations,
not atomic protection against host software changing after them.

Missing requirements refuse before agent spawn with a closed reason and bounded
item IDs/required versions. Human UI offers **Open setup** targeting this exact
Hosts row; it never sets up or retries the launch automatically. Orchestrator tools
return the fixed reason and missing items; the human must click Set up. Failed,
unknown, stale and unsupported checks have separate refusal reasons. Human machine
shells and manual repair terminals remain available. The guard applies to Local
repository agent launches too, with the same list/probe policy; Local appears as
**This computer** in the setup section. Unsupported native Windows setup has a
manual path, and must not acquire a POSIX recipe by guessing.

## Implementation acceptance after approval

No runtime acceptance is claimed by this phase. The implementation PR must update
Hosts/Settings/launch/privacy contracts and the file map, with:

- Pure fixture tests for valid/invalid draft input, approval races and failed saves,
  unsupported mappings, bounded reads, source add/remove/dirty changes, unchanged
  commit transitions and changed catalog/digest refusals.
- Fixture host checks for met, unmet, wrong version, unknown/timed-out probe,
  failed step, Stop, partial success and row-only recheck/persistence retry. Assert
  exact argv, safe environment, no interpolation and no unapproved dispatch.
- Toolchain archive integrity/path traversal/ABI checks, fresh-login/system-tool
  selection, private prefix publication and repository PATH propagation fixtures.
- Launch tests across local/remote human/child/restart routes proving no child
  starts or budget is consumed on prerequisite refusal, and identity/revision
  changes before spawn refuse. No installation from agents or control tools.
- Focused real Electron boundary tests under Xvfb for approve versus run, embedded
  terminal ownership, failure/recheck, launch refusal and multi-window stale actions.
  Every process is a fixture CLI; no real package manager, agent, SSH or network.
- The contributor validation suite and runtime packaging/coverage gates. Keep all
  deadlines, security boundaries and coverage thresholds intact.
