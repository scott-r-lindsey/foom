# Registered SSH hosts (#757)

Settings → Hosts is the only enrollment surface. Registrations are profile-only
`registeredHosts` records, validated on load, with an SSH alias/account selector
and an approved code folder. An incomplete registration may retain `~/...` until
the host expands it; canonical absolute observations are required before checkout use. The agent-editable config excludes them;
`setup:save` cannot write them. Developer spike mappings register nothing and
confer no later fleet authority. Host-aware orchestration (#756) uses the same registration and management service.

Each registration may have a profile-only nickname (#1027). Click its title in
Settings → Hosts to edit; expanded editable titles show a pencil, while collapsed
titles expand the row. Renaming remains available during remote checks; Save name or Enter commits, Cancel or Escape discards,
and an empty name restores the default unless another host has claimed it as a
nickname. A refused reset preserves the saved name and profile. Nicknames use 1–40 Unicode letters,
numbers, spaces, dots, hyphens or underscores, without surrounding whitespace.
A nickname must differ from every other registered host's display name ignoring
case. Legacy registrations without nicknames remain valid, including duplicate
short names. The default is the SSH hostname's first component, without the
account or domain; IPv4 addresses retain all components. The full SSH selector
remains visible and copyable on the card.

`hostDisplayName` projects the label for Settings, machine rows, remote checkout
chips and tile title bars; board launch options also expose registered host labels. Labels never
replace registration keys or enter remote requests, SSH, environment, argv or
agent projections. Rename only updates the local profile and performs no remote
inspection. Check replies preserve a name saved while the check was running.
Add host accepts an optional nickname with the same validation and inline errors;
main validates it again and saves it only together with a successful enrollment. Folder changes and canonical expansion preserve nicknames.

`setup:hosts` accepts one closed action from the registered board main frame:
list, progress, dismiss-output, test, add, rename, preflight, draft-preflight, create-folder, change-folder, refresh, remove, locations, clone, trust-origin, trust-host-key, cancel-trust, end, recipe or reload. Main selects enabled agent
executables from its validated manifest catalog. Renderer inputs cannot choose
remote commands, probe arguments, origins or checkout destinations. Replies are
validated in preload and rebuilt from declared fields. Failures retain fixed states/reasons. Explicit Add and check actions additionally
expose bounded, display-only SSH output as described below; Git and agent probe
output remain private. Artifact absence, version/handshake
mismatch, provider validation, changed agent configuration, invalid replies and
cancellation have distinct reasons; only connection failures report unreachable.
The local `progress` read bypasses the action queue and returns only the current
preflight's inspect/origin/checkout phase, repository paths and completed typed
observations. It runs no SSH or Git commands. Settings reads it only while its
preflight is pending, at most one read at a time, and stops on completion or
unmount. Progress reads publish no workspace changes or background inventory
refreshes. No remote management protocol or host polling is added.
Inspection retries once when provider revision or enabled agents change, then
reports configuration changed. Repository mutations are never replayed.
Each refused management request logs one fixed reason and step in main, without hostnames,
paths or remote output.

Test and add use the existing exact-build artifact selection, SHA-256 bootstrap
and SSH stdio protocol. SSH retains BatchMode, disabled agent/X11 forwarding,
ClearAllForwardings, ConnectTimeout and its environment allowlist. There is no TCP
listener. Bootstrap captures the account's SSH login umask before tightening it
for its private cache work. The daemon retains that mask before applying 077 to
its own files. Every new remote shell or agent PTY, on a machine or in a repository,
starts with the captured mask; login shell startup may then override it. Foom's
cache, sockets, control files and other private artifacts remain 0700/0600.
Reattachment retains the existing PTY and its current mask (#1047). A management request has no terminal ID and creates no PTY. OpenSSH owns host-key trust. Foom relays only the user’s explicit answer to its unknown-host question and never reads or writes known_hosts itself; credential prompts are refused.
Removing a registration forgets its saved session rows and host caches in the same
operation, without sending stop, kill or session-close, including when the last
observation reports live sessions. Open attached tiles keep their connections until
exit or Close and are excluded from saved rows for the rest of that app run.
While the host is unregistered, its ordinary saved sessions are not restored.
Re-enrolling the same host later allows startup discovery to recover any of this
profile's sessions still live on its daemon as human-owned tiles, without their
prior parent, grant or orchestrator authority. Forgotten exited sessions do not
return. Failed/pending Close recovery rows are retained under the
[session recovery rule](sessions.md#forgotten-hosts-1152).

The default code folder is `~/foom`. The remote expands it against its own home,
creates missing components with mode 0700 only for the explicit `create-folder`
action, and checks canonical containment,
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

Host facts exposes daemon version, live session count, CPU cores and three load
averages, memory total/available with Refresh facts. Checklist agent states use
Check capabilities or their own row reload. Linux uses
`MemAvailable` from `/proc/meminfo`. macOS available is the sum of free, inactive
and speculative page counts from fixed `/usr/bin/vm_stat`, multiplied by its page
size; wired/compressed pages are excluded. [Apple’s vm_stat snapshot](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c#L122-L141) prints free pages with speculative pages removed, so this adds speculative pages once. This measures reclaimable memory and
is not a promise that an allocation will succeed. There are no human busy warnings or idle resource polling timers. Automated
child starts use fresh launch-time pressure admission; see [child pressure](../contracts/control-mutations.md#child-host-pressure-1046).

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
and Git top level. Settings shows only read-only lists of existing checkouts, without clone controls, absent rows or per-repository clone status. A checkout must have
a valid HEAD commit; an initialized repository with an unborn HEAD is refused.

First-use repository launch and worktree creation prepare a missing checkout automatically. Main shares concurrent preparation for the same registered host, folder and origin; existing valid checkouts are reused. Clone authorization rechecks the current host, approved folder and repository membership after origin reads and provider preparation, synchronously immediately before remote dispatch. A changed registration refuses without a remote mutation. Preparation runs Git with an argument array on the host, with the host's own login
PATH and Git configuration/access. No local files, credentials, SSH keys or agent
sockets are copied/forwarded. Clone, fetch and ls-remote disable terminal prompts and both Git/SSH askpass.
They run in a detached process group with ignored stdin and no controlling terminal.
Git resolves its own SSH command and variant, including conditional configuration
in the clone target context, `ssh.variant`, `GIT_SSH_VARIANT` and auto-detection.
Foom does not add variant-specific SSH options;
SSH configuration and keys remain owned by Git's transport. Each missing checkout gets one clone attempt using the registered origin exactly as the host's Git resolves it, including host rewrites and conditional configuration. There is no automatic HTTPS or authentication fallback: Foom adds no URL rewrite or credential helper, performs no alternate-URL probe and does not retry the clone. An `origin-auth` failure shows fixed hints for HTTPS through gh, a deploy key or ssh-agent on the host wherever work started; the user configures access and Foom does not act on those hints. Terminal/askpass and
GCM interaction are disabled for every variant. Diagnostics
are bounded and classified on the host, under the C locale, into `origin-auth`,
`origin-host-key`, `origin-unreachable`, `timed-out` or `checkout-invalid`. A refused
public key, including a passphrase-protected key unavailable from the host agent,
is `origin-auth`. Successful clones that fail checkout validation report
`checkout-invalid`; cancellation reports `cancelled` and still removes staging.
Only the closed reason crosses management, main and preload; raw output is never
attached to an exception or reply. Older daemons' `clone-failed` remains accepted.
The host cannot
select a local executable or write location. Git output never reaches the UI.
Clone, fresh-clone validation, fetch and default-branch network queries each have an explicit five-minute
subprocess deadline; discovery and other Git inspection probes retain five seconds. Unknown Git diagnostics, including disk/write failures, report `checkout-invalid`, not an inferred connectivity failure. Each first-use preparation logs only its closed result, without paths or Git output.
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
slot, so PR polling can overlap launch inspections. Explicit `create-folder` requests
share the mutation slot. Inspection and enrollment never create folders. Repository
mutations and confirmed End run one at a time per daemon; overlapping mutations refuse
with the fixed checkout-refused reason, including retries during cancellation.
Cancelled End stops no later session after an already-issued stop settles.
Once cancellation settles, a clone retry inspects an existing published checkout
instead of cloning again. Worktree creation remains charged/indeterminate if its
reply is lost, and an existing branch refuses a duplicate creation as before.
Repositories → Locations offers **Refresh locations** for reconciliation, including a clone published before its reply was lost. Refresh reads state and never retries a mutation.
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
Removing a host also prunes its saved rows under the
[forgotten-host rule](sessions.md#forgotten-hosts-1152), retaining cleanup recovery
and live connections. After re-enrollment and restart, this profile's daemon-live
sessions missing from saved records are recovered as human-owned tiles with no
prior authority; forgotten exited sessions are not rediscovered. A daemon-live
invocation saved as exited is likewise recovered for the human, without inheriting
its stale parent grant.
Profile tags classify ownership; they are not credentials or isolation from other
processes running as the account.

Live sessions never expire automatically. Only bounded exit-code tombstones expire
(after 24 hours from exit disposal, without renewal on reads); no live-detach timer
or inventory polling loop runs. The daemon has no log files and is launched with
stdio ignored. SSH stderr is drained and never logged. Explicit Settings checks may retain
its bounded in-memory display described under [embedded terminals](#embedded-host-terminals-1062).

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
Absent checkouts are cloned automatically before worktree dispatch or repository launch (#1074). Clone failures preserve `origin-auth`, `origin-host-key`, `origin-unreachable`, `timed-out` or `checkout-invalid` in operation results and human action dialogs. A pre-creation clone failure consumes no unused-worktree budget. New branch worktrees live directly
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
them in Repositories. Copies resolve only
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
results invalidate them. Explicit Settings checks/Refresh and lost create replies force a
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
Downloads. Failed sleep observations conservatively warn. Raw OS/status-probe output
stays on the host; explicitly requested bounded agent version/path display facts
follow the Settings agent-scopes contract below. Burstable cloud instances can show low load while CPU credits
or other quotas throttle them; the resource numbers are not a readiness guarantee.

`gh auth status` and optional bundled manifest `hostSetup.status` probes use ignored
stdin, bounded time/output and process-group cleanup. Output is discarded; exit 0
means signed-in, 1 signed-out, all other outcomes unknown. Foom never reads token
files or Keychain entries. A status is an observation, not a guarantee of later
access; Check capabilities or sign-in row reload repeats the non-interactive call, including after signing in on a
Mac whose login Keychain may be locked over SSH.

Settings → Hosts uses the Add → Check → Fix checklist described below.
Main selects checked-in recipes from the observed closed distro and the enabled
bundled catalog. Install opens the human-owned terminal inside its host card in
Settings and the preflight rail. Sign in retains its foreground human-owned tile;
foreground placement waits for the refreshed row before closing Settings. The remote executable verifies a main-supplied SHA-256 digest of the fixed argv sequence before running it, without shell
source or typing into an existing tile. Multi-step package repository preparation
stops on the first failure. Every Debian install starts with fixed
`/usr/bin/sudo /usr/bin/apt-get update`, including manifest-provided package
installs. gh refreshes again after enabling its repository. Arch recipes retain
`pacman -S --noconfirm PACKAGE` and do not refresh package databases. `-Sy` alone
would create an unsupported partial upgrade
([Arch guidance](https://wiki.archlinux.org/title/System_maintenance#Partial_upgrades_are_unsupported)),
so a new image with missing or stale databases may fail until the user updates it.
DNF install already synchronizes missing or expired metadata
([DNF metadata synchronization](https://dnf.readthedocs.io/en/stable/command_ref.html#metadata-synchronization)),
so it needs no separate refresh step. Prompts and sudo remain in the terminal. Recipe processes
receive no terminal ID, orchestration authority or hub credentials. Restarting an exited recipe tile opens an ordinary shell on the same registered host, without replaying the install/sign-in. Recipe sessions
reserve the daemon mutation slot until exit or completed session removal;
disconnect does not release it. Removal releases the reservation even when stop
times out or native disposal fails and no exit callback reaches the daemon.

### Vendor agent installers (#1071)

An explicit Install click in Settings → Agents or first-run local cards can run
one of the six bundled manifests' `hostSetup.script` installers on Linux/macOS,
including registered hosts. A working package-manager recipe takes priority
(Codex's macOS Homebrew cask); otherwise the bundled vendor script is used.
Git and gh retain their package-manager recipes. Unknown remote distros and
unsupported libc still refuse recipes; a missing package manager alone does not
prevent a vendor script. Native Windows script recipes are unavailable.

The Settings recipe launcher supplies an internal `FOOM_SETTINGS_INSTALL=1`
marker as an accidental-invocation guard only. It is not authorization: any
same-user process can set it, and it is removed from the vendor environment.
Foom enforces its click requirement through the trusted Settings renderer action
and main-owned recipe launch. No agent, child, control API or remote management
operation exposes an install capability. This does not prevent a same-user
process from independently downloading or executing vendor code.
The recipe process prints the fixed HTTPS address, downloads at most 2 MiB with
a 60-second deadline into a private temporary directory (0700) and file (0600),
then invokes `/bin/sh` or `/bin/bash` with that file and manifest arguments.
A fixed `/bin/sh` supervisor starts an independent watcher in its own POSIX
session/process group before running the interpreter. Terminal stdin/stdout/stderr
are inherited; ordinary terminal input is covered by the PTY fixture. The new
session has no controlling `/dev/tty`; vendor dependence on that device remains
part of live qualification.
Foom's downloader follows at most five redirects, checking HTTPS and refusing
URL credentials at every hop. It needs no curl or system Node. The script itself
may require curl/wget or other tools for later downloads. Failure stops the
recipe; a package-manager failure does not fall back silently.

Foom does not support installers leaving background processes running. The
watcher blocks on a helper-owned lifetime pipe (fd4) while the interpreter runs.
On success, failure, interruption or unexpected supervisor exit, the helper closes
that pipe. Helper death also closes it in the kernel. EOF makes the watcher issue
`kill -KILL 0` from inside the installer's group: the watcher itself anchors the
target, even when the supervisor has died. The helper never signals a numeric
PGID that might have been reused. The supervisor and interpreter close fd4; no
vendor descendant can inherit it and postpone EOF. The watcher ignores catchable
HUP/INT/TERM/QUIT, and its identity is not passed to the interpreter. This is
lifecycle cleanup, not containment of malicious same-user vendor code, which can
already enumerate and kill arbitrary same-user processes or create other sessions.

After reporting normal completion, the supervisor also issues `kill -KILL 0`
itself. This independent fallback prevents a lost watcher from allowing workers
to survive a completed install. The helper also signals its own still-live ChildProcess handle with TERM on
cleanup. The supervisor runs the interpreter as a background job with explicit
terminal stdin, then waits with job control disabled; TERM interrupts that wait
and its trap kills its own group. This independent Stop path works when the
watcher is lost while an installer hangs. An exited child is never signalled.
All group cleanup signals originate from live members of their own group, never
from a remembered numeric PGID.

The supervisor receives interpreter, private script path and manifest arguments
as positional argv, never generated shell source. It reports the interpreter's
exit status over fd3; the interpreter cannot inherit that pipe. The watcher holds
fd3 open without writing it, so the helper waits for watcher termination before
removing private files. An unexpected supervisor `exit` releases fd4 immediately,
rather than waiting for `close` (which may be waiting on that watcher). Normal
interpreter status is preserved; handled HUP/INT/TERM/QUIT returns 128 plus the
original signal number after closing the lifetime pipe and cleaning up.

The private file and directory are removed after success, download/spawn/script
failure, handled interruption and supervisor-only SIGKILL. If the helper itself
receives uncatchable SIGKILL, the watcher still terminates the installer group,
but the helper cannot run its file cleanup: the private temporary directory may
remain. Machine failure or simultaneous loss of multiple cleanup components likewise
cannot guarantee cleanup. Fixtures cover both local and host paths, including
supervisor/helper SIGKILL while the interpreter waits for `/bin/sleep`.

The existing SHA-256 recipe-step digest binds the address, interpreter and
arguments and declared installer environment on hosts. The vendor's unversioned
script content is **not** bound;
this is the security tradeoff explicitly accepted in #1071. The HTTPS rule applies
to Foom's download, not to arbitrary subsequent network operations performed by
vendor code. Recipes still receive no terminal ID, orchestration authority or
hub credentials. No probe, check, manifest load, agent or orchestrator capability
starts installation. Config manifests cannot declare script installers.

Local installs use the bundled console helper's internal Settings mode with a
complete installer environment and login PATH, no control grant and no shell
integration. The complete replacement environment carries HOME from the selected
account home, USER/LOGNAME from the OS account, SHELL (inherited or the account
login shell), PATH from the existing bounded login-shell query, TMPDIR and LANG.
Standard locale, XDG directory, ZDOTDIR, terminal and certificate-path variables
are preserved when present; unset XDG directories retain their standard HOME-based
defaults. Missing shell/temp/locale values have POSIX defaults. Arbitrary inherited
variables, agent API tokens, SSH credentials and FOOM_* are omitted. Foom-added
Environment layers, including stored secrets, are omitted. The local helper
normalizes the environment again before either vendor scripts or Homebrew.
Registered-host installs apply the same normalization to hostLoginEnvironment,
with the host account home, before vendor scripts or package-manager execution.
Bundled script `environment` pairs are applied after this normalization on both
paths (#1166). The parser refuses `FOOM_*`, `XDG_*` and the normalized account,
PATH, shell, temp and language names case-insensitively; fixed literal values
cannot reintroduce those names. Installer declarations also reuse the launch
manifest's reserved-name policy: loader/interpreter injection, shell startup and
parsing controls, proxies and credential-shaped names are refused, even for
bundled manifests. The shared policy includes `SHELLOPTS`, `BASHOPTS`, `CDPATH`,
`FPATH`, `ZDOTDIR`, `BASH_*` and names containing `CREDENTIAL`, in addition to the
existing launch restrictions. A BASH_ENV fixture verifies executable startup code
is rejected before installer download or spawn. Package managers keep the normalized environment.
Codex declares `CODEX_NON_INTERACTIVE=1`, which skips prompts by declining both
starting Codex and uninstalling another managed Codex installation.
Sign-in and lifecycle-plugin operations retain their existing environment policy.
They share the existing embedded terminal and Stop/Keep open lifetime rules.
Completion rechecks only the selected agent. Remote completion retains its scoped
tool/sign-in refresh. Settings chrome shows Done or Failed with the exit code.

Vendor documentation and fixed script source checked 2026-11-10:

| Agent | Fixed script | Vendor documentation |
| --- | --- | --- |
| Claude Code | `https://claude.ai/install.sh` | [Setup](https://code.claude.com/docs/en/setup) |
| Codex | `https://chatgpt.com/codex/install.sh` | [CLI](https://learn.chatgpt.com/docs/cli) |
| Copilot | `https://gh.io/copilot-install` | [Installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| OpenCode | `https://opencode.ai/v2/install` | [Current v2 installation](https://opencode.ai/docs/) |
| Pi | `https://pi.dev/install.sh` | [Quickstart](https://pi.dev/docs/latest/quickstart) |
| Antigravity | `https://antigravity.google/cli/install.sh` | [Getting started](https://antigravity.google/docs/cli-getting-started) |

Only Codex documents a non-interactive/no-launch switch in these scripts.
Claude Code, Antigravity, Copilot, OpenCode and Pi declare no such switch;
Foom adds none. Pi still offers installation choices, PATH changes and a launch
prompt; Copilot can prompt to update PATH. This change cannot suppress those
vendor prompts without a documented vendor option. OpenCode's `--no-modify-path`
controls shell-file edits, not prompts or launch, so it is not selected here.
Scripts were downloaded for source inspection only and never executed.

The issue's original OpenCode address installs v1; the v2 address matches Foom's
v2 adapter. Vendor scripts may modify shell startup files and install/update
agent-owned files; Foom's ban on direct global agent-config writes still applies
to Foom's own writes. Script output and prompts remain untrusted terminal content.
Live qualification on disposable human-owned hosts remains required per script:
record shell-file changes, discovery in a fresh login shell, sudo/prompts and
Node requirements. Documentation/source inspection and fixture tests do not prove
those real-host outcomes. No real installer or agent CLI runs in automated tests.

Codex retains its non-interactive status probe and device-code sign-in. Other
bundled agents keep unknown sign-in state until they declare a measured probe.

Protocol-3 hello advertises `hostFacts: 1`. A compatible older build without this
capability returns `facts-unavailable` for read-only facts, with a fixed needs-update
message. No management request is sent to its older, mutating inspect operation.
Existing PTYs still reattach; when the daemon becomes idle the normal upgrade
provides facts and recipes. Same-build peers are known to implement the capability.


## Partial onboarding preflight (#1005)

`draft-preflight` accepts an explicit Add host SSH selector and proposed folder before
enrollment, without granting registration. The disposable host-qualification hub
uses this action for its pre-enrollment checks too; only its later `add` enrolls the
host. Origin checks before `add` use the same draft action.
`preflight` is a registered-machine reload: main requires the current host and matching folder when the queued action
dispatches, before any remote inspection. A removed host refuses with `not_found`;
it never falls back to draft inspection.
It returns independent SSH, platform and bundled-artifact checks, the existing
requirements/tools/agents/sign-in facts, a folder check, and origin-access and
checkout observations for every registered repository. A row that cannot run is
`not-checked`; it never becomes a fabricated pass. Missing artifacts do not prevent
bounded SSH/OS/CPU/libc discovery. A refused folder does not suppress facts or origin
checks. Tool and agent discovery and recipes reuse #971/#988 capabilities.

`inspect` with `readOnly: true, partial: true` returns the expanded proposed path
and a fixed folder check (`folder-missing`, `folder-refused`, or `unsafe-folder`),
even when it cannot approve the directory. It grants no checkout authority. Origin
checks run `ls-remote -- ORIGIN HEAD` with the host's own login environment and the
existing no-prompt network Git helper. A valid canonical checkout supplies Git's
working directory so repository-local and conditional credential/SSH configuration
is preserved. Otherwise the approved folder, or the account home when that folder
is unavailable, supplies the context. Folder/checkout failures do not suppress the check.
Only fixed results cross the wire. Failed origin access does not hide checkout state.

Add can enroll an incomplete host, retaining its failed observation and proposed
folder. Invalid replies, cancellation and changed/invalid provider configuration
still refuse enrollment. A later successful refresh expands a pending home-relative
folder. `change-folder` explicitly selects a replacement without creating it;
`create-folder` alone creates the registered folder. Both invalidate checkout caches.
Missing folders expose Create and the Add host button permits incomplete enrollment.

Hello advertises `hostPreflight: 1`. Partial inspection, origin checks and explicit
folder creation are refused with `facts-unavailable` before dispatch to a compatible
older daemon without this capability. Existing host-facts, PTYs, sessions and idle
upgrade behavior remain compatible. Main validates every new request/reply and the
sandboxed preload validates and rebuilds all nested onboarding observations.


## Remote host onboarding UI (#963)

Add host takes the SSH selector and code folder in one form, enrolls the host,
and runs the full preflight. Ordinary opening of Hosts reads saved state only, without SSH,
including session and worktree inventory. Returning after an explicit foreground
recipe refreshes only its affected rows as described under [refresh scope](#checklist-refresh-scope-1061). Each host's Check capabilities runs the
full preflight, repositories and session/worktree inventory, saving a Last checked
timestamp and the closed observations in its profile registration. Never-checked
hosts say Not checked. Saved observations contain no secrets, terminal output,
session identities or worktree authority; removal deletes them. They remain
visible across restarts even when stale and never populate authorization caches.
Saved requirements also restore Install and Sign in availability for display; missing or
invalid requirements offer no recipes. Clicking an action selects its recipe from a
fresh inspection, never from saved observations. Host facts offers a separate
session/worktree inventory refresh.

Each host is a compact name, OS, status and chevron row, opening by default only
when it needs attention. Expanding exposes all controls and observations. Ready Git-access checks collapse to a count; failed origin checks remain visible. Checked-out repositories appear in a separate read-only list. Busy state belongs to each host; checking
one never disables another. Add host is enabled during loading and checks and is
disabled only while an add is running. An added host and its own check cannot be
replaced by an older check reply. The grouped checklist keeps
Host, Tools, Agents, each repository and macOS Power observations independent.
Unrun checks say Not checked, failed checks retain their fixed reason, and
unknown sign-in probes say Sign-in unknown. The UI never infers Remote Login or
Keychain state from a connection/authentication failure. Platform details are
limited to the existing closed observations; no OS version or CPU is invented.

Create explicitly creates the approved folder. Change folder edits its approved
path and rechecks without creating it. Install uses the existing main-selected
recipe in the host card; Settings stays open. Sign in retains foreground tile
placement and closes Settings once the tile is visible. No background install, recipe replay or terminal typing is added.
Missing recipes show no Install button. Git access to origin and explicit Trust host key… remain in each repository’s Git-access group. Origin-auth hints identify HTTPS through gh, a deploy key and ssh-agent as user-configured access options; Foom never applies them or instructs global URL rewrites. Host facts,
foreign session End and foreign worktree counts remain under Host facts.

Repositories → Locations groups existing checkouts beneath Local and each registered host,
with checkout path copy controls and no clone controls or clone status. Local selection
controls remain available under Choose repositories, opening for an empty list or
an active scan/selection. Its recent-days control stays available even when the
Recent group is empty or filtered out. The existing
projection supplies checkout paths rather than origin display strings and does
not report dirty or clone state; entries show the repository name and checkout path. The existing closed clone management request is reused by first-use preparation. Unreachable replies reconcile through read-only location/preflight checks.

## Human machine sessions (#1024)

The sidebar projects registration order, bounded agent facts and checked repository
locations. Location reads share a one-minute on-demand cache, invalidated by
explicit checks, host or repository registration changes and clone mutations; there is no timer.
Repository names and registration order do not affect the location cache key. Agent availability never comes from the
hub's installation when launching remotely. Host display labels are presentation
only and do not replace registration keys.

Human machine launches reuse profile-owned SSH terminal transport. A closed
`machine` open request names the approved code folder and optionally a bundled
agent ID with validated user defaults. Without a repository or checkout, shells
and agents start in the remote account's validated home directory; the approved
code folder still authorizes repository operations. The host rechecks the folder, resolves the
agent with its own login PATH, and starts an argument-array PTY. It adds no bypass
arguments, hook files or orchestration grant. A repository launch
additionally names the origin-derived clone directory, validated through the
existing read-only repository operation; worktree launches reuse profile provenance
and checkout identity checks. Hub environment values and credentials stay local.
Background inventory replies cannot replace a newer explicit host observation or
renew its freshness timestamp. Shared in-flight readers receive the current
observation, including missing-agent and unavailable results.
Completed Settings host checks invalidate the board inventory immediately,
including unreachable results. Machine sessions persist as human-owned session metadata; remote recovery only
reattaches the existing PTY. Local agent rows without a conversation ID remain
exited after restart, following ordinary session restoration eligibility.

Hello advertises `humanMachines: 1` for ordinary machine launches and
`machineHome` with the validated absolute home path for home-directory semantics.
Main uses that path for tile, sidebar and session facts; the daemon independently
selects its home as cwd and records it in session inventory. New home launches
require `machineHome`, including on same-build peers; older active daemons with
only `humanMachines: 1` refuse them. Repository/worktree launches retain their
existing capability and containment checks.
New machine launches refuse a compatible older
active daemon lacking this capability before sending open; they never fall back
to a code-folder shell. Existing PTYs still reattach. Machine launches use
the existing host-preparation budget, in addition to bootstrap.

## Host card readiness and repository fixes (#1026)

A host is Ready when SSH, platform, daemon, code folder and Git pass and at least
one enabled agent is installed and probeable. Optional missing agents, gh sign-in, absent checkouts and nonblocking macOS
folder/power warnings are neutral. Install and Sign in remain available. Repository access failures keep
their fixed failure rows without making an otherwise usable host unavailable.
Checkout creation belongs to first-use launch/worktree preparation (#1074), not Settings. The summary says Ready; existing checkouts are a read-only list.

An origin-host-key failure offers **Trust host key…**. Main re-reads the registered
repository's validated SSH origin and opens a human-owned tile on the registered
host. The fixed command is ssh -T with StrictHostKeyChecking=ask, forwarding
disabled, and the origin's account/host and optional port. HTTPS cannot select this
action. Compatible older daemons must advertise originTrust=1; otherwise the
launch refuses until the host daemon is updated. The user verifies the fingerprint and answers SSH; Foom never supplies an
answer or accepts a key. Check capabilities observes the result.

Codex's hook trust is not exposed by the existing version/help or exit-code sign-in
probes. Foom does not inspect or modify Codex's hook-trust store. On a new host,
the first Codex launch may show “Hooks need review”; review Foom's hooks in that
Codex tile. Installed and signed-in observations do not claim hook trust.

Host checks are language neutral and never execute anything from a checkout.
They do not inspect language or package manifests, infer build requirements, or
run repository scripts, plugins or package-manager probes. Preparing a host to
build a repository is left to an agent the user runs on that host
([#1024](https://github.com/scott-r-lindsey/foom/issues/1024)).

## Checklist refresh scope (#1061)

A full check runs only for **Check capabilities** and the first check on Add
(including a first-check retry after accepting a key). Only a full check changes
**Last checked**. Rename contacts nothing remote. Create/Change folder use their
own successful folder reply and invalidate affected repository rows to **Not checked**;
there is no hidden repository check. Clone and Trust origin update only that
repository. Install and Sign in automatically refresh only their affected tool/sign-in rows
on exit, including failures, without advancing the full-check timestamp. Hosts
reads the updated rows after an embedded install finishes; queued persistence
failures retain the existing retry behavior when Hosts is reopened. Queued rows that become stale (disabled tools
or removed repositories) are dropped independently; they never prevent the page or
other queued rows from loading. Queued failures never reject the list read: saved
hosts remain visible, and failed profile writes show Unable to save in the affected
row's existing failure state. Known row results are retained for persistence-only
retry without another remote inspection; one row's failure never blocks another.
An explicit row reload invalidates that target's older queued observation before
checking it. If saving the reload fails, reopening Hosts inspects that row again
rather than persisting the superseded result.
Recipes on the same host merge and deduplicate pending targets, including recipes
launched from already-open Hosts views in different windows.
A refused replacement folder leaves the registered
folder's saved and live observations intact and reports only the attempted change.
Action validation and launch inspection
still use the fresh inspections required above.

Every checklist row has an accessibly named reload icon, revealed on hover or
keyboard focus. Reload checks only that row, shows its own spinner and keeps
other results and controls available. If the existing observations cannot display
the selected row without a full check, that row shows Check capabilities required, without
helper copy or a synthetic full-check timestamp. Tool discovery does not run sign-in probes;
sign-in and origin checks can contact the network. Read-only partial inspection
accepts a closed `target` selector. Hello advertises `hostRowCheck: 1`; compatible
older daemons without it refuse scoped inspection and folder creation with `facts-unavailable`,
without falling back to a full check. Scoped results update saved presentation
without granting launch authority or advancing the full-check timestamp. Transient
checklists are replaced or cleared by each newer action reply; they never mask
newer live folder state.
Scoped reload replies do not publish a broad board inventory refresh. Folder and
clone replies may seed the sidebar's location view from the action's own observations
only when every registered host/repository pair is represented, including the acting
host's other repositories. Each location retains its own observation time; a seed
uses the oldest included time and never renews untouched data. Successful folder
actions contribute explicit Not checked locations without probing repositories.
Those invalidations have no read timestamp and cannot satisfy the sidebar cache;
the next sidebar read obtains actual checkout data.
A partial seed never stands in for the full location inventory. Scoped
observations may update only the corresponding fields of an existing live
inventory, without renewing its freshness; saved observations never populate it.
Resource refresh replies remain separate from the launch inventory when no live
inventory exists or a full read is pending. A failed resource refresh reports its
failure under Host facts while retaining the checklist observations.

## Settings agent scopes (#1070)

Hosts shows an enabled-agent readiness count and Open, which selects that host in
Settings → Agents → Machines, selecting the host in its picker. Agent controls and
recipes live below that picker; Global contains preferences only. Reading
the saved host list or selecting a scope starts no full check. The explicit machine
reload in Agents runs the full preflight and advances Last checked; individual
agent reloads use the existing scoped tool/sign-in requests. The selected machine
also reattaches its Settings-owned tool install terminal, sharing the same install
exit guard as Hosts. Global and machine changes hide the view without ending the
install; returning to that machine reattaches it. The separately confirmed plugin
installation and sign-in recipes retain their human-owned foreground tiles.

Protocol-3 hello advertises `agentSettings: 1`. Read-only inspect may request
`agentDetails: true`; only then does each agent include bounded display-only path,
version, closed capabilities and Antigravity plugin-inventory state. A compatible
older daemon lacking the capability refuses with facts-unavailable before dispatch.
These observations grant no launch authority and saved observations remain stale
until explicitly refreshed.

Antigravity's Install plugin is opt-in and separately confirmed in main, naming the
host, two fixed steps and global CLI effect. Its digest-bound recipe runs the
`foom-host --stage-plugin agy` handler, prints the staged directory, then runs
resolved `agy plugin install DIRECTORY` with an argument array in a human-owned
recipe tile. Both hub and daemon select only the bundled agy action; no supplied
path, shell source, other plugin or manifest can select it. The host rechecks CLI
inventory and refuses unless Foom is absent; present or unrecognized inventories
must be managed in agy. Staging alone does not install. No global configuration
file is written directly. Older daemons lacking agentSettings refuse this recipe.
Plugin installation additionally requires the daemon's exact build SHA-256 to
match the verified host artifact shipped by the approving desktop. Compatibility
flags alone never authorize staging another build's bundled assets. Main refuses
with the closed `remote_artifact_mismatch` launch reason (`version-mismatch` for
management) before sending the recipe or opening its PTY. The daemon runs the
recipe through its own `process.execPath`, so matching the artifact binds the
staged assets to this desktop build. A busy older daemon and its sessions remain
running; finish them and let the normal idle upgrade complete before retrying.
Read-only observations and other recipes retain their existing compatibility.

## Embedded host terminals (#1062)

Settings and preflight render in the registered board window. Install attaches
the existing human-owned recipe PTY through that window's ID-scoped terminal
capability and shared attachment queue. No cross-window attachment or remote
protocol change is needed. Output and scrollback retain the existing terminal
bounds; input goes directly through terminal IPC and is never copied into setup
state, diagnostics or persistence. Foom never types into the process.

Install sessions belong to the Settings window that starts them. Closing Settings
never transfers an install to the board or sidebar. With no live install process,
closing Settings immediately disposes its install sessions and views. While any
install process is running, every Settings exit (close button, Escape, Settings
shortcut, sidebar terminal selection or other navigation away) first shows the
in-app **Stop the install?** dialog, containing only **Stop** and **Keep open**.
Keep open has default focus; Escape chooses Keep open. It preserves Settings and
the PTY. Stop uses the existing ID-validated terminal kill/removal path, waits for
it to finish, then closes Settings and disposes the views. Failed termination
keeps Settings open. Installs still launching are included in the check. Section
changes retain window ownership and reattach the install when Hosts is reopened.
Closing the whole window or quitting uses the existing main-owned confirmation,
without this additional Settings dialog. Sign-in tiles are unchanged.
The panel retains its screen until dismissed or a
new install replaces it. Its own header states Installing, Done, or Failed with
the exit code; recipe tiles also state the final outcome in Foom chrome, never
by adding text to process output. The main exit subscription starts before
creation; exits received while launch settles pass through the existing workspace
exit lifecycle before the view is returned.

Add and explicit checks show a read-only output panel inside Add host or the
host card. Main retains the latest 65,536 UTF-16 units in memory, including
connection/platform steps, artifact verification, daemon upload/readiness and
OpenSSH stderr. Progress reads reuse the existing local progress channel during
an action; no idle polling or remote request is added. Raw text is inert display
content, never instructions, parsed facts, error diagnostics or a saved profile
field. Background inventory and repository/agent probe output are excluded.
Completion retains output until dismissed or the next check; failures retain
the fixed failure state alongside the output.

## Child pressure admission (#1046)

Main applies the same resource-derived budget locally that the SSH daemon applies
remotely. Running Foom agents (including human agents) and pending automated starts
share the machine budget. Fresh measurements and reservations are separate from
cached host checks and inventory. Humans remain unrestricted. Older daemons and
unreadable measurements allow unmeasured starts. See the [wire facts, thresholds
and retry rules](../contracts/control-mutations.md#child-host-pressure-1046).

## Accepting a new SSH host key (#1059)

Add and Check capabilities retain BatchMode=yes. The bounded platform probe uses
StrictHostKeyChecking=yes and the C locale so OpenSSH reports an unknown key
explicitly. OpenSSH's local diagnostics go through `-E` into a private per-run
0600 file beneath a 0700 temporary directory, removed on completion or failure.
The open file's size is checked every 10 ms while SSH runs and again on exit,
including successful exits. Exceeding 16 KiB kills the detached SSH process group
(Windows uses the fixed OS tree terminator) and permanently fails the probe;
overflowed text can never enable trust. Polling can allow a burst between checks,
but never waits for the connection deadline to enforce the limit. The monitor,
file handle and directory are removed on completion, failure or cancellation.
LogLevel=ERROR overrides user verbosity. Only exit status 255 and at most 16 KiB
from that client-owned channel can classify host-key-unknown, host-key-changed or
login-rejected. Remote command/login-shell stderr remains display-only, including
when the remote exits 255; it never offers trust. Generic verification failures
never offer trust. Daemon replies cannot supply local SSH classifications or
connection observations. Legacy saved unreachable observations still load.

Background inventory retains an unknown-key SSH observation without attempting
another inspection until an explicit trust/check clears it. A missing local
artifact cannot supersede this pending trust state or silently revoke the button.
A full check stops at any explicit failed SSH observation: no repository origin or
checkout requests run and no dependent failures are synthesized. An unavailable
local artifact catalog is reported only after SSH and platform checks succeed.
While SSH reports host-key-unknown, Settings hides every dependent section,
including stale repository failures, tools/agents, checkout rows, Last checked and
Host facts. Only the header, address/folder/Remove line, output and SSH trust row
remain. The full card returns when the accepted key's normal first check runs.
Changed-key and other SSH failures retain their current presentation, but likewise
skip dependent repository checks because no connection was established.

Only a registered host whose latest SSH observation is host-key-unknown can
request trust-host-key. Main checks OpenSSH >= 8.4 and the bundled console helper
using detached, bounded reads that share cancellation with the requesting run;
Windows and unsupported clients show a copyable `ssh HOST` fallback. No other
SSH call receives askpass variables or changes its environment allowlist.

Main resolves the host through bounded `ssh -G` output, including HostKeyAlias and
nonstandard ports. One detached SSH process runs a fixed `true` command with
BatchMode=no, StrictHostKeyChecking=ask, forced SSH_ASKPASS, password and
keyboard-interactive authentication disabled, no forwarding, no control-master
reuse, no local/remote configured command, no terminal and ignored stdio. Display
and terminal variables are absent. OpenSSH fetches the key and writes known_hosts.

The packaged Node SEA console dispatches ssh-askpass without Electron RunAsNode.
SSH invokes that verified binary directly; the per-run environment selects its
askpass adapter, without a temporary executable or shell launcher.
A 0700 mkdtemp directory holds a Unix socket, authenticated
by a random per-run credential. Both ends strictly parse the complete unknown-host
question; main also matches its host and port to the resolved registered target.
Nonstandard ports use OpenSSH's bracketed host and IP forms, including IPv6;
address fields must contain a valid IP and any port must be 1–65535 and match the
registered target. HostKeyAlias still retains the resolved port for this check. Only parsed
host, key type and SHA256 fingerprint reach the trusted main-owned confirmation.
Non-host-key, changed-key, secret, malformed and unmatched prompts fail closed.
OpenSSH 8.4's original question and 8.5+'s other-names notice are accepted,
including the historical `ommitted` spelling and newer `omitted`. Questions are
bounded to 4096 characters, 13 lines and 512 characters per line, with at most
eight file/line/name entries. Those entries are discarded, never rendered.
`get_hostfile_hostname_ipaddr` supplies HostKeyAlias verbatim when set, otherwise
the lowercased resolved HostName with the nondefault port; `ssh -G` supplies those
expected values. The typed command-line alias need not equal the displayed host.
See [8.4 source](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_4_P1/sshconnect.c)
and [8.5 source](https://raw.githubusercontent.com/openssh/openssh-portable/V_8_5_P1/sshconnect.c).
Unexpected OpenSSH question variants are refused rather than displayed verbatim.
An authenticated helper rejection reports only a fixed code, without forwarding
the rejected prompt. Non-decline failures publish fixed trust reason codes in the
check output panel; raw SSH prompts, host-file entries and exceptions are excluded.
Only one question can receive an answer per run. Cancel is focused by default;
Cancel, Escape and close decline. No renderer payload can provide the answer.

The run expires after two minutes. Cancellation, Settings section exit, board
navigation/loss, window disposal and quit abort the dialog and kill the detached
SSH group, revoke its credential and remove its directory. Accepted first-time
hosts rerun their first full check automatically, using the existing output panel.
An earlier successful observation (including retained lastAgents) prevents an
automatic full check; Check capabilities remains explicit for established hosts.
Declining preserves the failed observation. Changed keys require manual repair.
The human reviews light/dark row and dialog screenshots and merges; a real new
host must be verified manually before merge because automated tests use fixtures.
