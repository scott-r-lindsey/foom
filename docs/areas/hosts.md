# Registered SSH hosts (#757)

Settings → Hosts is the only enrollment surface. Registrations are profile-only
`registeredHosts` records, validated on load, with an SSH alias/account selector
and approved absolute code folder. The agent-editable config excludes them;
`setup:save` cannot write them. Developer spike mappings register nothing and
confer no later fleet authority. Host-aware orchestration (#756) uses the same registration and management service.

`setup:hosts` accepts one closed action from the registered board main frame:
list, test, add, refresh, remove, locations, clone, end or recipe. Main selects enabled agent
executables from its validated manifest catalog. Renderer inputs cannot choose
remote commands, probe arguments, origins or checkout destinations. Replies are
validated in preload and rebuilt from declared fields. All failures are fixed
states/reasons, with no raw SSH, Git or agent output. Artifact absence, version/handshake
mismatch, provider validation, changed agent configuration, invalid replies and
cancellation have distinct reasons; only connection failures report unreachable.
Inspection retries once when provider revision or enabled agents change, then
reports configuration changed. Repository mutations are never replayed.
Each failed check logs one fixed reason and step in main, without hostnames,
paths or remote output.

Test and add use the existing exact-build artifact selection, SHA-256 bootstrap
and SSH stdio protocol. SSH retains BatchMode, disabled agent/X11 forwarding,
ClearAllForwardings, ConnectTimeout and its environment allowlist. There is no TCP
listener. A management request has no terminal ID and creates no PTY. Existing
SSH host-key trust applies; Foom never accepts a key or prompts for credentials.
Removing a registration only forgets it: it sends no stop, kill or session-close
operation, including when the last observation reports live sessions.

The default code folder is `~/foom`. The remote expands it against its own home,
creates missing components with mode 0700 only for explicit enrollment/inventory
(`inspect` without readOnly) and clone requests, and checks canonical containment,
symlinks, ownership of the code folder and group/world write permissions. Ancestors
must not be group/world writable, except a root-owned sticky ancestor such as
`/tmp`. Checks repeat before repository mutation. These are filesystem observations,
not atomic traversal or protection from a compromised account/root. Repository and
worktree inspection and readOnly host fact requests never create missing components: a missing approved folder or
ancestor refuses the read. Rechecks before mutation also validate without creation.

The daemon selects its HostPlatform once at startup. Linux reads bounded procfs
files directly for memory and legacy process identity; it needs no `ps`/procps
installation. macOS uses the built-in `/bin/ps` and `/usr/bin/vm_stat`. Bootstrap
remains POSIX `sh`, before the daemon exists. Raw observations stay on the host.

Host rows expose daemon version, live session count, CPU cores and three load
averages, memory total/available and fixed agent states with Refresh. Linux uses
`MemAvailable` from `/proc/meminfo`. macOS available is the sum of free, inactive
and speculative page counts from fixed `/usr/bin/vm_stat`, multiplied by its page
size; wired/compressed pages are excluded. [Apple’s vm_stat snapshot](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c#L122-L141) prints free pages with speculative pages removed, so this adds speculative pages once. This measures reclaimable memory and
is not a promise that an allocation will succeed. There are no busy warnings or
idle resource polling timers.

Ready means installed and probeable, using only the existing `--version` and
`--help` probes over the account's login PATH. Missing executables show Not found;
failed probes show Unable to check. Pi and OpenCode also require their measured per-launch attachment gates to pass;
otherwise they show Unable to check. Config providers show Unable to check and
refuse remote launch with `remote_agent_unsupported` before launch SSH work.
Sign-in probes follow the closed exit-code-only #971 contract below; no credential reads are added. Manifest probe output stays on the host and is reduced to fixed states. Main projects the inventory onto its selected manifest IDs: unexpected host IDs are discarded and omitted entries become Unable to check.

Settings → Repositories shows Local and each registered host. Main reads only
the registered repository's own origin. Only credential-free HTTPS and SSH Git
origins are accepted; local paths, command protocols and URL passwords are refused.
The checkout directory is `repository-` plus 24 hex characters of the origin's
SHA-256, directly beneath the approved folder. Existing destinations must be
owned, non-writable by other users, canonical directories with matching origin
and Git top level. State is Clean, Changes or absent (Clone here).
Absent checkouts show an explicit “Not checked out” label. A checkout must have
a valid HEAD commit; an initialized repository with an unborn HEAD is refused.

Clone here runs Git with an argument array on the host, with the host's own login
PATH and Git configuration/access. No local files, credentials, SSH keys or agent
sockets are copied/forwarded. Clone, fetch and ls-remote disable terminal prompts and both Git/SSH askpass.
They run in a detached process group with no controlling terminal. The host keeps
its configured `core.sshCommand` (or SSH's normal configuration when absent) and
adds `-o BatchMode=yes`; no SSH configuration or keys are read by Foom. Diagnostics
are bounded and classified on the host, under the C locale, into `origin-auth`,
`origin-host-key`, `origin-unreachable`, `timed-out` or `checkout-invalid`. A refused
public key, including a passphrase-protected key unavailable from the host agent,
is `origin-auth`. Successful clones that fail checkout validation report
`checkout-invalid`; cancellation reports `cancelled` and still removes staging.
Only the closed reason crosses management, main and preload; raw output is never
attached to an exception or reply. Older daemons' `clone-failed` remains accepted.
The host cannot
select a local executable or write location. Git output never reaches the UI.
Clone, fetch and default-branch network queries each have an explicit five-minute
subprocess deadline; discovery and Git inspection probes retain five seconds.
The daemon's ten-second deadline covers negotiation and idle clients only.
Each management request, including session inventory and confirmed End, gets a
separate seven-minute budget after negotiation;
SSH bootstrap has its own two-minute hub budget. Agent preparation and final
spawn authorization share a separate two-minute daemon budget.

Disconnect, operation expiry and daemon shutdown cancel the operation's subprocess
group, including descendants. Later Git commands and clone publication check
cancellation first; an already-issued rename/mutation can still finish and must
be reconciled by reading state.
The daemon retains at most four in-flight management/preparation operations even
when their clients disconnect, until their subprocesses and cleanup settle.
Read-only worktree inspections share this bounded reserve without taking the mutation
slot, so PR polling can overlap launch inspections. Enrollment (`inspect`) requests
share the mutation slot because they may create the approved folder. Repository
mutations and confirmed End run one at a time per daemon; overlapping mutations refuse
with the fixed checkout-refused reason, including retries during cancellation.
Cancelled End stops no later session after an already-issued stop settles.
Once cancellation settles, a clone retry inspects an existing published checkout
instead of cloning again. Worktree creation remains charged/indeterminate if its
reply is lost, and an existing branch refuses a duplicate creation as before.
Settings automatically refreshes repository locations after an unreachable clone
reply and offers **Refresh locations** for later reconciliation, including a clone
published before its reply was lost. Refresh reads state and never retries a mutation.
Clones are prepared in a private temporary sibling inside the approved folder,
validated, then published
by rename. Failure removes the temporary directory and leaves the destination
available for retry; an existing destination is never used as clone staging.

## Persistent remote sessions (#757 PR 2)

A private random owning-profile tag is saved beside the profile settings, outside
the settings/config schema and renderer projection. Every new remote session carries
it in daemon metadata only; it never reaches a PTY, agent environment, argv or files.
On startup the hub asks every registered host for this profile's live sessions.
Saved live rows reattach their existing terminal IDs, with complete screen replay;
reattachment never spawns a replacement. Already exited rows remain sidebar-only
under #732. With session restore disabled, rows remain dormant.

This profile's sessions absent from saved records become human-owned tiles. Their
inventory cannot restore a parent, grant or orchestrator role. Other-profile and
untagged sessions remain untouched. Settings → Hosts reports their live count and
**End…** opens a trusted confirmation. Main retains the confirmed IDs and random
session incarnation tags; the daemon refuses a changed incarnation or a session
owned by this profile. Before each awaited stop it checks the confirmed session
object again; replacements arriving while an earlier stop settles are skipped and
reported in the returned inventory for a new confirmation. Sessions arriving during
confirmation are not ended. Legacy End likewise retains its confirmed daemon
incarnation and never clears a replacement observed while its stop settles.
Removing a host still only forgets it. A daemon-live invocation saved as exited is
likewise recovered for the human, without inheriting its stale parent grant.
Profile tags classify ownership; they are not credentials or isolation from other
processes running as the account.

Live sessions never expire automatically. Only bounded exit-code tombstones expire
(after 24 hours from exit disposal, without renewal on reads); no live-detach timer
or inventory polling loop runs. The daemon has no log files and is launched with
stdio ignored. SSH stderr is drained, never retained or logged.

The protocol-2 negotiation advertises compatibility independently of build identity.
A newer hub can use a compatible old daemon while it has sessions, without killing
or replacing it. An idle daemon with no sessions, outstanding operations (including
cancelled work still settling), or other connected clients closes its listener under a synchronous shutdown gate; the new hub retries
bootstrap and starts its own verified build. Upgrade retries are bounded. Protocol-2 sessions use `host-v2.sock`, leaving a pre-feature daemon's `host.sock`
and PTYs untouched. On-demand legacy inspection tries at most 32 owner-checked
cached build identities against the old management API; it creates no PTY and
runs no cached executable. Legacy sessions appear as one untagged count. End
explicitly confirms all sessions in that legacy daemon, including sessions started
during confirmation. It matches a single process's exact cached executable,
`--daemon` argv, PID and start time (Linux procfs start ticks and owner uid, or macOS fixed
`/bin/ps` output), rechecks before
SIGTERM, and never unlinks the old socket. Process observation and signaling are
separate OS operations, with the same-user PID-reuse race; this is not isolation
from another process running as the account. Unverifiable or unsupported legacy
peers fail closed. Legacy binaries retain their original lifecycle until ended;
Foom cannot remove a timer inside an already running old binary. New daemons have
no live-session reaper. No legacy process is signaled as part of an upgrade.

## Host-aware orchestration (#756)

Only profile registrations authorize fleet operations. The management protocol adds
closed create/inspect/remove-worktree operations; no terminal ID, executable,
arbitrary destination or credential enters these requests. Main derives the remote
checkout from the registered repository's own origin and approved code folder.
Absent checkouts refuse: only Settings can clone. New branch worktrees live directly
inside the code folder and start from the freshly fetched origin default branch,
without tracking that default. Open same-repository PR adoption fetches and tracks
its validated origin branch. Existing branches refuse rather than overwrite work.

Registration, origin and repository preflight refusals fail without charging the
orchestrator's unused-worktree budget. Once creation may have been dispatched,
an unsuccessful or invalid result remains indeterminate and charged: partial
creation or a failed final identity check may have left a checkout behind. A
refusal during post-creation authority/capacity revalidation or registration
bookkeeping also remains indeterminate and charged, even after a successful
creation reply.

The shared inventory has a 60-second on-demand freshness budget, also invalidated
by provider or enablement changes. Concurrent reads share one probe. Missing,
stale or failed observations are probed over management; missing/uncheckable agents
are never inferred from the hub. A current non-ready observation refuses launch
with `remote_agent_unavailable` before launch inspection/preparation or SSH launch
work. A failed inventory connection reports `remote_host_unreachable`. The #971 sign-in observation is separate from discovery readiness; Settings → Hosts owns that presentation.

Orchestrator session reads expose a bounded host list with fixed agent states and
CPU/memory observations, including Local. Paths, raw probe output and credentials
are omitted. Linux available memory uses MemAvailable; macOS uses the same
free + inactive + speculative page definition locally and remotely. No polling,
busy warning or Foom-enforced heavy-validation lock is added.

Remote management Git reads disable replacement refs and legacy grafts, including
checkout validation and identity rechecks. Detached worktree removal requires HEAD
to be reachable from a retained branch, remote-tracking ref or tag using stored
commit history with commit-graph reads disabled, matching the local removal guard.

Remote child PR/check tracking uses the same management identity checks, with
validated branch, HEAD and origin evidence. Observations retain the registered
host and approved folder, canonical paths, creation identity and original local
origin. The hub's existing forge CLI performs read-only queries with its own login;
no forge credential enters SSH. See [remote tracking](../contracts/forge-tracking.md#registered-remote-checkouts-940).

Host aliases and code folders have copy controls in Hosts; checkout paths have
them in Repositories → Locations (their existing location). Copies resolve only
registered objects and cached validated checkout observations in main; they
never initiate SSH. Removed hosts discard cached locations. See the
[copy IPC contract](ipc.md#visible-fact-copy-controls-960).

## Remote review evidence (#942)

Registered-host review loops use the read-only `snapshot-worktree` management
operation and the existing bounded operation reserve. It returns only a validated
HEAD and SHA-256 digest after canonical membership, creation identity, origin,
approved-folder and owning-profile provenance checks. No terminal ID, file bytes
or credential enters management requests or snapshot responses. The host revalidates
pinned evidence before each reviewer/author PTY start. The hub retains loop policy, limits and grants; see
[review loops](orchestration.md#optional-child-buildreview-loop-690).
Snapshot Git index/path inventories have a separate 16 MiB stdout budget, matching
local Git, in addition to the 10,000-file / 32 MiB content bounds. Other probe
stdout and every stderr stream retain their 256 KiB limits.
Compatible older daemons that cannot supply this evidence refuse remote review;
ordinary sessions and reattachment remain usable.
Inspection, snapshots and confirmed removal validate the canonical clone and worktree in
one management request. The hub derives the clone path from the registered origin;
it does not open a separate repository-preflight SSH connection for these operations.
The daemon still checks clone origin, HEAD, membership, provenance and identity.
Removal still compares the confirmed changes and identity again before deletion.
Creation retains its repository preflight and indeterminate-result handling.


## Worktrees without sessions (#941)

Remote creation records durable profile provenance beside the checkout, inside
its serialized daemon mutation, before Git can add the checkout. The private
record binds the profile, origin, repository and checkout directory identities.
It contains no terminal ID, parent, grant, operation or credential. The tag is
profile metadata, not isolation from another process running as the account.

On-demand inventory reads never create folders or replay mutations. Pending reads
are shared, observations have a 60-second freshness budget, and create/remove
results invalidate them. Settings list/Refresh and lost create replies force a
fresh read. No inventory timer runs. These reads return
only this profile's worktrees after checking the approved folder, original
directory identities, canonical clone/origin and live Git membership. These
worktrees appear in the sidebar even without a session and after the last session
closes. Restart or re-registering the same host/folder rediscovers them. Replaced,
redirected, foreign-repository and unavailable checkouts do not become launch or
removal targets. Human launches recheck identity; deletion requires review and
fresh ownership, identity, changes and active-session checks under the ordinary
remote removal reservation. No automatic cleanup applies to recovered worktrees.

Other-profile and untagged worktrees are counted only in Settings → Hosts as
**other worktrees**. They are never listed, adopted, modified or deleted. There is
no untagged migration. This applies the profile ownership decision from #757 to
worktrees as well as sessions.

After an unsuccessful create reply, main reconciles using tagged inventory;
a matching branch/provenance can be recovered for the human as an unused checkout.
The original operation remains indeterminate and charged. Recovery grants no
orchestrator ownership, refunds no budget and resumes no work. Existing branches
still refuse duplicate creation, including another idempotency key. If Git did
not finish a valid checkout, provenance alone creates no launch target.

## Host requirements and recipes (#971)

| Requirement | Debian / Ubuntu | RHEL / Rocky / Alma / Fedora / Amazon | Arch | macOS |
| --- | --- | --- | --- | --- |
| Daemon | linux-x64 or linux-arm64; glibc ≥ 2.28 | Same; RHEL 7 is too old | Same | darwin-x64 or darwin-arm64 |
| Bootstrap tools | POSIX sh, coreutils, gzip, SHA-256 | Same; no procps needed | Same | Built-in sh, core tools, gzip, shasum; ps and vm_stat |
| Package manager | /usr/bin/apt-get | /usr/bin/dnf | /usr/bin/pacman | Homebrew through the login PATH only |
| git | Required for repository operations | Required | Required | Required; Command Line Tools presence is checked without an install dialog |
| gh | Optional; needed for children to open PRs | Same | Same | Same |
| Agents | Install the enabled CLIs on this host | Same | Same | Same |
| Git origin access | Host's own credentials and host-key trust | Same | Same | Same; a locked login Keychain can prevent SSH sign-in reuse |

Alpine/musl and glibc below 2.28 are unsupported. Distro, libc and package-manager
observations are closed values. Linux parses bounded `/etc/os-release` as data
(ID first, then ID_LIKE), never sources it. macOS reports only booleans for Command
Line Tools (missing CLT suppresses the system git shim probe and git installation actions), disabled idle sleep and code folders under Documents, Desktop or
Downloads. Failed sleep observations conservatively warn. Raw OS/probe output
stays on the host. Burstable cloud instances can show low load while CPU credits
or other quotas throttle them; the resource numbers are not a readiness guarantee.

`gh auth status` and optional bundled manifest `hostSetup.status` probes use ignored
stdin, bounded time/output and process-group cleanup. Output is discarded; exit 0
means signed-in, 1 signed-out, all other outcomes unknown. Foom never reads token
files or Keychain entries. A status is an observation, not a guarantee of later
access; Refresh repeats the non-interactive call, including after signing in on a
Mac whose login Keychain may be locked over SSH.

Settings Hosts keeps its existing layout; #963's onboarding redesign is deferred.
Main selects checked-in recipes from the observed closed distro and the enabled
bundled catalog. A user Install or Sign in click opens a human-owned visible tile
on that host. Foreground tile placement waits for the refreshed row before closing Settings. The remote executable verifies a main-supplied SHA-256 digest of the fixed argv sequence before running it, without shell
source or typing into an existing tile. Multi-step package repository preparation
stops on the first failure. Prompts and sudo remain in the tile. Recipe processes
receive no terminal ID, orchestration authority or hub credentials. Restarting an exited recipe tile opens an ordinary shell on the same registered host, without replaying the install/sign-in. Recipe sessions
reserve the daemon mutation slot until exit or completed session removal;
disconnect does not release it. Removal releases the reservation even when stop
times out or native disposal fails and no exit callback reaches the daemon.

The interim #971 decision ships package-manager installs only: apt, dnf, pacman
and brew. Vendor script installers (including pinned/checksummed scripts) are
**deferred for a later user decision**. Missing manifests/platform recipes, unknown
distros and absent package managers have no Install action and return the fixed
`recipe-unavailable` reason. Sign-in commands may still be offered for an installed
CLI. gh uses the repositories documented by GitHub: Debian's extrepo github-cli
entry and the official RPM repository, plus Arch github-cli and Homebrew gh.
See [GitHub's installation instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md).

Codex declares a non-interactive login-status probe, device-code sign-in and the
[Homebrew cask](https://formulae.brew.sh/cask/codex) install recipe. Other bundled
agents retain unknown sign-in state until they declare a measured status probe;
missing install/sign-in declarations remain unavailable.

Protocol-3 hello advertises `hostFacts: 1`. A compatible older build without this
capability returns `facts-unavailable` for read-only facts, with a fixed needs-update
message. No management request is sent to its older, mutating inspect operation.
Existing PTYs still reattach; when the daemon becomes idle the normal upgrade
provides facts and recipes. Same-build peers are known to implement the capability.
