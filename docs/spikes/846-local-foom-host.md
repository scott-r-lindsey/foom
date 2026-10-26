# Local foom-host spike (#846)

**2026-10-25 · Proposed design, not current behavior.** Refs [#846](https://github.com/scott-r-lindsey/foom/issues/846).
No product code or architecture rule changes are included. Phase issues must be
filed only after user approval. The issue has no comments or listed dependencies
as of this investigation. Source baseline: `ba85e5769571b56e139bed7bcb43ae065c15dfc8`.

## Recommendation

Use a detached, profile-scoped Node 24 SEA host on macOS and Linux. Reuse
`TerminalManager` and the remote host's replay/retention machinery, with a new
local management protocol. Electron main becomes its authenticated client;
preload/renderer capabilities remain unchanged. Connect directly over a Unix
socket, without an SSH process or SEA relay per terminal.

Make the host the long-lived owner of invocation hooks and control endpoints.
Initially delegate policy/effects to the connected app and refuse unavailable
operations while detached. A later, separately approved phase moves orchestration
policy and required workspace services into the host so existing orchestrators
can keep working unattended. A socket-only PTY daemon must not be presented as
complete agent persistence: existing hook URLs, MCP grants and parent authority
otherwise disappear when Electron quits.

Default explicit Quit to **Stop everything and quit**, with a deliberate
**Keep running and quit** choice and a focused **Cancel**. Do not remember a
silent detach default in the initial release. A compatible desktop update can
leave the existing host running; replacing a host with live PTYs requires stopping
them with human approval. Do not attempt live PTY migration in this work.
Windows retains today's utility-process host until its separate transport and
native lifetime gates pass.

## Evidence and scope

Read the issue and comments through GitHub REST, the owning
[terminal rules](../areas/terminals.md), [shell rules](../areas/shells.md),
[boundaries](../areas/boundaries.md), [profiles and updates](../areas/application.md),
[sessions](../areas/sessions.md), [hooks](../areas/agent-hooks.md),
[control](../areas/control.md), [MCP](../areas/mcp.md),
[orchestration](../areas/orchestration.md), [child authority](../areas/child-authority.md),
[confirmations](../areas/confirmations.md), [privacy](../areas/privacy.md),
[execution](../areas/execution.md) and [evaluator](../areas/evaluator.md).
These remain authoritative for current behavior.

The [remote phase-1 report](../../spikes/remote-host/phase-1.md) already records a
real PTY retaining shell state across fixture transport loss and hub quit, with
screen replay. Its Linux SEA size/startup measurements are historical evidence,
not new local-host latency measurements or macOS verification.

The throwaway [lifecycle probe](../../spikes/local-host/lifecycle.mjs), run with
`node spikes/local-host/lifecycle.mjs`, creates only a temporary directory, fixture
Node processes and a Unix socket. On Linux x64 / Node 24.17.0 it verified:

- The detached fixture daemon remains reachable after its parent exits normally.
- It remains reachable after its parent receives SIGKILL.
- A separate same-UID client can connect through a 0700 directory and 0600 socket
  without any token. File permissions do not distinguish Foom from an agent.

Each probe terminates the daemon, removes its directory, and has a 15-second
fallback lifetime. It does not use a shell, PTY, product profile, agent CLI or
network. This is evidence for process independence and the permissions limitation
only. It does not establish Electron crash handling, node-pty lifetime, app-update
survival, authentication, macOS behavior, Windows behavior or performance. Those
are explicit implementation acceptance gates below; no new cross-platform
support is claimed by this spike.

## Ownership and quit choices (question 1)

| Owner | Proposed responsibility |
| --- | --- |
| Local host | PTYs, headless state, parser responses, activity, launch generation, session inventory, timers, hook/control listeners and live credentials |
| Electron main | Profile selection, app authentication, trusted dialogs, renderer authorization, safeStorage, OS notifications; initially workspace/control policy and evaluator |
| Later headless workspace service inside host | Validated launch/worktree effects, role/child authority, execution/evaluator, handoffs, operation/audit storage and optional review automation |
| Renderer/preload | Existing typed ID-scoped terminal capabilities and drawing; no socket, secret, executable or filesystem access |

A host is not an unrestricted new agent command server. Only the authenticated
app management channel can create local `TerminalSpec`s, enumerate all profile
sessions or attach arbitrary views. Agent control remains a separate limited
grant surface with the existing repository/parent/generation checks.

With live processes, Quit lists shells, agents and children from the host's
inventory, including hidden/unsaved sessions. **Stop everything and quit** closes
new-launch admission, cancels automation, uses the current graceful/force-stop
barriers, observes native exits, saves session metadata, revokes credentials and
then quits. A stop failure leaves the app open with retry; no false success.
“Everything” here means all local sessions in this profile, not other profiles;
remote shells retain their current explicit Stop versus disconnect behavior and
must be disclosed separately in the inventory.

**Keep running and quit** discloses the live count, that agents may keep spending
money, that human confirmations cannot be answered, and the 24-hour retention
limit. After a save-and-detach acknowledgement main closes views and releases its
lease without calling host shutdown. Cancellation or a failed barrier preserves
the app. With zero live sessions, quit can proceed without a spending dialog.
No settings toggle silently changes this initial default.

Closing a tile still detaches; explicit Stop/Close retains current semantics.
Last-window close on Linux uses the same Quit choices; macOS window close keeps
Electron alive as today. Renderer crash just detaches a view. App crash cannot
obtain quit consent: the host continues until reconnect, explicit stop or expiry.
The feature disclosure must say this; a stop-on-crash guarantee is incompatible
with this issue's goal. Logout, shutdown and reboot are outside survival scope.

On reopen, obtain a validated host inventory **before** normal session restore.
Join saved rows with `(hostEpoch, terminalId, launchGeneration)`. For live entries,
show **Running · reconnected**, attach the existing PTY, and refresh attention
without reporting a new launch or completion. Unknown status says Unknown.
Recover host-owned sessions missed by a crashed save into visible recovered rows;
never launch them again. Quarantine changed/missing repository identities from
control authority while preserving an authorized human stop path. Tombstones show
the true exit code. Missing entries show **Session lost** or **Retention expired**
when known, with explicit Resume/Restart, never an automatic duplicate agent.
`restoreSessions=false` may suppress new resume launches, but cannot hide processes
that are already running and potentially spending money.

## Lifecycle, identity and retention (question 5)

1. Select the actual profile and acquire Electron's single-instance lock before
   touching host state. Packaged Foom, Foom Dev, explicit `--user-data-dir` and
   `start:fresh` have distinct host namespaces. Canonicalize/validate the profile
   and bind a random profile identity to it; do not let a renderer choose it.
2. Store nonsecret discovery/version/epoch facts and encrypted credentials under
   the profile in a private `local-host/` directory (0700); socket is 0600 and
   created with umask 077. Validate ownership, type, ancestors and permissions.
   Never use the remote daemon's global `~/.foom-host` endpoint for local sessions.
3. Connect/authenticate to an existing host first. If absent, coordinate spawn
   with a per-profile exclusive startup lock and bounded readiness deadline.
   Spawn a verified, immutable versioned host copy, with an argument array,
   detached session, ignored inherited stdio, sanitized environment and `unref()`.
   Deliver its initial management secret through an inherited one-shot pipe,
   never argv or an environment variable visible to spawned terminals.
4. A held OS advisory lock, not merely a PID file or lockfile's existence, denotes
   endpoint ownership. Implementing this needs a reviewed native lock primitive
   (Node core has no portable flock API). Hold the lock for the host lifetime;
   serialize startup/recovery with the same lock. A losing spawn exits harmlessly.
   Timeout, permission failure or unknown identity never authorizes replacement.
5. If connect is refused, acquire the lifetime lock, recheck owner/type/inode and
   refuse recovery if a live owner or ambiguous state exists. Remove a stale
   socket only under that lock and only if it is still the inspected object.
   PID reuse must not trigger a kill. A listening but unresponsive host remains
   intact; offer a human recovery path rather than start competing PTYs.

The normal path is `<profile>/local-host/h.sock`. Unix socket pathname limits
make arbitrary long `--user-data-dir` paths impossible there (the remote code
already caps at 100 bytes). Fail with an actionable error in the first phase,
without silently falling back to in-process launch. A short private OS-runtime
socket directory keyed by profile identity is a possible later alternative;
using it instead of the issue's “under the profile” rule needs approval and
symlink/ownership/lifetime tests. Never truncate into a colliding path.

Keep one authenticated app-management lease per profile, with generations so a
stale disconnect cannot detach a replacement client. A missing UI view is not a
missing owner. For the initial retention policy the app lease is the owner:
host-owned MCP/hook traffic does **not** renew UI absence. Reuse remote rules:
24 hours from disconnect, reconnect cancels the timer, a later disconnect starts
a fresh interval, and hidden tiles do not start it. No activity polling is needed.
This also bounds unattended orchestration: a child launched while detached
inherits the original absence deadline, rather than opening a new 24-hour budget.

Reuse 32 full-session and 64 exit-tombstone limits initially, with explicit
capacity errors; later scaling must preserve child limits independently. An
exited detached session disposes PTY/screen and keeps only code and bounded
identity metadata until its original detach deadline. Reads do not renew expiry;
oldest tombstones are evicted first and consume no full-session slots. Preserve
the current limitation: final output not delivered before exit is lost once the
screen is disposed. Do not promise full historical logs. Stop, expiry and idle
shutdown cancel timers and native callbacks before disposal.

After no live sessions, clients or required tombstones remain, the daemon exits
and cleans up only its own endpoint. Explicit Stop everything can end it sooner
after the app has received exit facts. For disposable `start:fresh`, disable
Keep running and quit: destroy the host before the wrapper deletes its profile.
After a crash the same 24-hour safety bound applies; temp-directory cleanup alone
must never orphan an unbounded daemon. Tests always own and stop their fixture
hosts, including on failure.

## Socket authentication and same-UID boundary (question 6)

A 0600 socket is **same-user access control, not app authentication**. An agent
under that UID can ordinarily read private user files, inspect its environment,
connect to the socket, signal processes, and potentially invoke the same keychain
facilities. Root and a malicious same-UID process are outside the strong
isolation claim. Neither peer UID checks nor terminal-ID entropy fixes that.
The probe demonstrates the connection part of this limit.

Use a separate 256-bit management credential, held in host/app memory and stored
only as Electron safeStorage ciphertext for app reconnect. Host startup receives
the raw credential via its one-shot pipe; the host never needs to decrypt disk
secrets. Refuse persistence enrollment if encryption is unavailable or uses a
plaintext-equivalent backend; do not invent an unencrypted token file fallback.
This may limit Linux support until a supported secret-store backend is available.
Store no raw token, terminal screen or launch environment in discovery, logs or
session files. Host-held hook and control secrets live only in memory, independently
of the app-management credential, and never reach renderer IPC.

Specify a bounded mutually authenticated nonce handshake binding profile identity,
host epoch, client/server nonces and negotiated protocol to a MAC before accepting
management messages. Derive direction-specific session keys or use a reviewed
local authenticated channel; do not improvise ad hoc signing code during rollout.
Reject replay and negotiation downgrade. Set connection/handshake/body/queue limits
before authentication; reject invalid/foreign IDs and validate all messages after
it too. Peer-UID checks, if implemented natively on both Unix platforms, are an
additional cross-user check, not proof that the peer is Foom.

Terminal IDs are identifiers, **not bearer credentials**. Do not put them into
shell environment, argv, hook files, discovery or diagnostics as ambient attach
authority. Existing authorized MCP session results and private `sessions.json`
already contain IDs: the issue's literal “never exposed to other processes”
cannot hold for those existing interfaces or hostile same-UID readers. Preserve
those scoped contracts while requiring the separate management credential for
attach/inventory/create. An ordinary agent knowing its own or a guessed foreign
ID gains nothing; the remote `open(id)` takeover rule must not be copied locally.

Trusted confirmations remain in Electron's separate trusted window. Bind each
approval to the exact operation, actor generation, target identity and host epoch;
revalidate immediately before effects. UI detach cancels pending confirmations;
no approval replay after reconnect. Role elevation, pairing and cleanup requiring
human consent fail closed when the app is absent. An in-memory credential reduces
accidental capability leakage but is not an OS sandbox against another same-UID
agent. A stronger guarantee needs separate OS identities/sandboxing or a broker
with enforceable code identity, which is separate research.

## Hooks, MCP, children and attention without a UI (question 2)

Do not buffer raw HTTP requests and later execute them. Keep the launch's hook
receiver and control/MCP listener at stable host-owned loopback endpoints for the
whole PTY lifetime. Preserve the current origin/Host checks, token separation,
revocation, limits, generation checks and reduced hook payloads. The management
transport is Unix-only; the existing authenticated agent adapters remain loopback
HTTP for provider compatibility, never a network-facing listener. Keep invocation
observer/MCP files until host-observed exit; app quit must not delete files still
needed by running agents. Native helper extraction likewise outlives the app.

| Stage | While UI is closed | Failure/return behavior |
| --- | --- | --- |
| Initial persistence | Host authenticates and reduces hooks, stores bounded latest evidence; PTYs continue. Control calls needing app policy return explicit unavailable; no delayed mutations. | Reopen reconciles sequence/generation, obtains a fresh screen and marks gaps unknown. Orchestrators can keep coding but Foom-dependent child work pauses/fails. |
| Headless workspace phase | Host owns launch grants, repository/child authority, execution/evaluator, handoffs, waits, action/operation stores, launch preparations and reviewed workspace effects. Existing permitted child work continues. | Same checks and durable intent apply without UI. New human approval needs return UI unavailable/declined, never auto-approval. |

Bound evidence per launch (for example, 64 reduced events plus latest state),
sequence it, and surface overflow/gaps explicitly. No raw tool payloads, hook
transcripts or PTY text in the event log. Initial mode must retain conservative
working/needs-input/exit evidence without declaring Done from a lost Stop event.
Headless mode runs the existing local evaluator, not a model. Handoff bodies are
already an explicit bounded output capability; preserve their existing privacy,
parent checks, storage and pull-only behavior rather than treating them as hooks.

Moving an HTTP listener alone is insufficient for unattended children: current
policy/effects call main-owned workspace, Git, provider, audit and review services.
Move their narrow capabilities and locks as a coherent headless workspace owner;
do not create two independent session writers, role stores or launch queues.
The host becomes the authoritative writer while main projects snapshots and
issues authorized human commands. Changes to host-owned settings/config need
validated revisions; no restart-only stale security settings. Forge polling and
review transitions move only with their required validation and audit dependencies.
Until then, refuse them while detached instead of weakening checks.

Host keeps bounded unread attention facts and exit/handoff sequences. Initial
release promises no OS notifications while Electron is absent: the quit disclosure
says so, and reopen shows unread Needs you in words as well as amber. Agent
permission requests wait in their own CLI; Foom never approves them. A later
native notification helper needs permission, redacted content and click-to-open
routing tests; it must not send terminal text, paths or prompts to OS notification
services by default. No UI may mean no human answer, not automatic failure or
success. Provider-specific hooks may be best effort even when the host lives.

## Updates and protocol skew (question 3)

Separate artifact identity from wire compatibility. Today's remote handshake uses
the executable SHA-256 as `build`, requiring byte identity. Keep that remote rule
unchanged; local mode needs explicit protocol major/minor, required capabilities,
app/host versions, immutable build identity and host epoch. Authenticate before
inventory; incompatible major or missing required capability refuses attachment
without terminating the old host. Unknown optional fields may be ignored only
where the versioned validator explicitly allows them.

Commit to supporting the preceding shipped local protocol major for at least one
release, with fixture contracts for both directions and downgrade tests. App
release versions alone do not imply compatibility. A host with a disallowed
security version must not be used silently: offer to keep the old app/session
running or explicitly stop and replace; do not expose sensitive inventory before
identity verification. Provide bounded nonsecret compatibility diagnostics.

Copy the bundled, hash-verified matching-platform SEA and required resources into
an immutable versioned private profile directory before first launch. Validate
copies and native extraction; preserve executable/signing requirements on Darwin.
The running host must not lazy-load code, manuals, observers or addons from a
bundle that the macOS updater may replace. Retain files for a live host until it
exits, with locked cleanup preventing app/host races. Test the actual signed
package's relocation and launch behavior; bundle verification alone does not
prove a relocated SEA runs. No runtime download or auto-install of a service.

| Update situation | Proposed behavior |
| --- | --- |
| Compatible app, old host has live PTYs | Restart/detach UI; attach with negotiated capabilities; keep old host and mark host update pending. New sessions use its supported behavior. |
| Host idle | Stop idle host, verify/install bundled version, start new epoch; never revive old launch credentials. |
| Incompatible host with live PTYs | Refuse automatic replacement; disclose that updating the host stops processes. User can defer or Stop everything and update. No parallel host for the same profile. |
| App downgrade | Negotiate compatible protocol or show the same non-destructive incompatibility path; never write newer host state with an older app. |

Current stable macOS Squirrel installs on ordinary app exit. The implementation
must adjust the quit barrier to distinguish detach from stop and leave host-owned
files/credentials alone. Linux, Windows and nightly updates currently notify
rather than install. An incompatible new app must still present the compatibility
recovery screen; “defer” cannot assume the old bundle is still installed.

Reject initial fd-passing/re-exec upgrades: inheriting a PTY fd does not transfer
node-pty native watchers, parser queues, screen/mode/color state, subscriptions,
control grants, in-flight operations and platform cleanup semantics. A future
stable PTY keeper plus replaceable policy process could reduce host upgrades,
but adds a protocol and failure domain. No evidence here establishes transparent
PTY migration, particularly across ConPTY. Compatible app restarts are sufficient
for the initial goal; incompatible host replacement warns explicitly.

## Crash recovery

| Failure | Result and recovery |
| --- | --- |
| Renderer crash | Existing host/parser survives; retire the attachment token and restore through main. |
| Electron exit/crash/SIGKILL | App lease drops; PTYs and stable endpoints stay live; reconnect inventories before restore. Interrupted writes/Stop requests have unknown outcomes and are not replayed as input. |
| Host crash/SIGKILL | PTYs and in-memory screens/credentials are lost or no longer safely managed. Do not claim survival or blindly kill PIDs from disk. Revoke the epoch, show Session lost and reconcile before explicit resume. |
| Orphaned descendants after host loss | A process may escape the PTY group; inventory is not proof it died. Report possible unmanaged descendants, use owned process identities for diagnostics, and never signal a reused PID. Durable cgroup/job supervision would be separate scope. |
| Host alive but blocked | Bounded timeouts fail the client; do not unlink a live socket or create duplicate sessions. Human recovery may stop the host with a loss disclosure. |
| Restart after partial operation | Recover pending/running intents as indeterminate under current audit rules; no automatic mutation/input replay or credential resurrection from saved rows. |
| Logout/reboot | No live-state guarantee. Show lost sessions and use existing explicit conversation resume with fresh grants after revalidation. |

The initial PTY phase cannot restore a lost main-only policy decision or pending
confirmation. Detach cancels it, while already-started effects remain tracked as
indeterminate until reconciled. After policy moves into the surviving host, its
operation/grant state survives an app crash in memory; a host crash still follows
the existing conservative durable recovery rule. Do not restore stronger roles
from arbitrary inventory or disk facts alone.

## Platforms (question 4)

| Platform | Initial support and gates |
| --- | --- |
| macOS arm64/x64 | App-spawned detached SEA, no login item or LaunchAgent installed. Verify packaged quit, app crash, Squirrel replacement, signatures, native extraction and reconnect with fixture shells. No survival promise across logout. |
| Linux arm64/x64 | Same Unix design, verified private socket/lock and secret store. Verify GUI-launched and terminal-launched packages, SIGKILL and profile isolation. Detached sessions do not override system session/cgroup policy. |
| Windows | Keep utilityProcess/ConPTY and existing stop-on-quit confirmation. Disable detach choice and explain limitation. Later named-pipe implementation requires user/logon DACLs, rejection of remote clients and pipe squatting, authenticated handshake, independent process/job lifetime, ConPTY exit-barrier and packaged crash/update tests. |

Node documents independent detached process sessions on Unix, with unreferenced
children and non-parent stdio needed for background execution
([Node child processes](https://nodejs.org/api/child_process.html#optionsdetached)).
This supports the spawn choice, not a promise about desktop service managers.
Linux logind can kill processes in the login session scope
([logind policy](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html));
we will not enable lingering or change system configuration. Apple's user agents
are scoped to login and receive termination on logout
([Apple launchd guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)).
Consider opt-in OS-managed supervision later if measured requirements demand it;
it cannot recover PTY state after host failure merely by restarting the process.

Windows named pipes require explicit ACL design: Microsoft's documented default
includes broad read access, and logon SID restrictions help exclude other logon
sessions and remote users
([named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)).
A Unix `chmod` port is insufficient. No Windows host SEA currently exists in the
four-target remote catalog, so this is an additional build and lifecycle project.

## Reuse and local behavior changes (question 7)

| Existing implementation | Carry over / change |
| --- | --- |
| `src/terminal-host/terminal-manager.ts` and headless helpers | Reuse PTYs, snapshots, parser barriers, query/color response ownership, activity, foreground names, shell lifecycle and independent parser/view backpressure. Preserve pinned xterm guards. |
| `src/terminal-host/remote/daemon.ts` | Extract session ownership/expiry, exit tombstones, bounded queues, replay and stop/disposal paths. Add profile scope, epoch/generations and authenticated management; do not fork a second PTY implementation. |
| `src/terminal-host/remote/main.ts` and `private-path.ts` | Reuse detached SEA pattern and path checks conceptually. Replace HOME-global discovery, exact-build negotiation and manual-only stale-socket recovery. |
| `src/shared/remote-host-protocol.ts` | Reuse bounded framing/fragmentation validation. Add a distinct local protocol; remote `open` cannot create arbitrary local agents or preserve local capability checks. |
| `src/main/terminals/remote-transport.ts` | Reuse reconnect/retirement, replay/reset, restored dimensions/theme and token accounting. Use one multiplexed local management connection; avoid SSH and relay startup cost. |
| `src/main/terminals/terminal-host-client.ts` and terminal IPC | Preserve the client facade and sender/ID validation. Replace utility parent-port lifetime with socket operations; separate detach/dispose from host shutdown. |
| SEA builder/catalog/native extraction | Reuse Node 24, platform artifacts, manifest hashes and pinned node-pty loading. Add immutable local resources, signing/relocation tests and version retention. |
| Hook/control/workspace services | Extract Electron-free capabilities in phases. Do not import all of main into SEA or bypass renderer/process-boundary lint rules. |

Local mode gains survival, inventory and replay across app lifetime. It costs a
persistent Node runtime, framed serialization/queues, and version management.
There are no measured local echo/resize latency claims here. Compare same-machine
input-to-echo, launch readiness and resize/replay ordering against utilityProcess
without synthetic load; establish a budget before default rollout. Coalesce
resizes while disconnected but apply the final dimensions before snapshot/live
handoff. Never replay uncertain keyboard input or automatic child prompts.
Keep activity and ID-scoped shell events currently omitted by the remote shell
adapter; local agents must retain their existing evaluator evidence.

Process audit must distinguish an intentionally detached host from leaked test
processes. Fixture hosts carry explicit owned identities and are always stopped
by the harness, including on timeout/failure. Do not weaken the real-agent guard
or allow arbitrary leftover processes. Tests use only private temporary profiles,
controlled PATH, fixture shells/CLIs, no user rc files, no real SSH/network and no
user profile/config reads. Linux Electron and packaged verification use Xvfb.

## Rejected alternatives

- **Keep Electron hidden instead of quit:** does not survive main crash or update,
  and conflates a background app with a persistent terminal owner.
- **Copy remote mode unchanged:** HOME-global endpoint, exact-build match,
  shell-only spawn, ID-based takeover and lost hook/control policy do not meet
  local profiles, security or agent continuity requirements.
- **Buffer arbitrary MCP mutations for reconnect:** stale authority, repeated
  input/effects and unanswerable confirmations; return unavailable instead.
- **Move every app service into the first daemon change:** makes a large security
  and persistence migration inseparable from testing PTY lifetime.
- **tmux as a required backend:** extra dependency and another screen/PTY model;
  does not preserve Foom control grants or trusted confirmations on its own.
- **Always-on launchd/systemd installation or root service:** extra installation,
  policy and logout semantics unnecessary for app-quit survival. No silent login
  items or lingering changes.
- **Plaintext reconnect credential or IDs as passwords:** conflicts with secret
  storage policy and admits same-user callers too broadly.
- **Persist full terminal logs to recover a host crash:** changes privacy/storage
  semantics and still cannot restore running PTY/native process state.

## Proposed phase tickets and acceptance criteria

These are proposed titles, not newly filed issues. Each implementation PR must
update the owning area/behavior/contracts as well as tests. Phases depend on the
preceding phase unless noted; do not mark #846 closed through this spike PR.

### A. Local transport, host identity and lifecycle behind an opt-in flag

- Reuse the PTY manager in a detached host with isolated profile socket,
  authenticated app channel, generations, lock/recovery and immutable resources.
- Fixture app exits normally and by SIGKILL; the same shell PID/state and replay
  remain on reattach. Renderer IPC remains unchanged and validated. Hidden output
  continues; slow/stale clients cannot stall parsing or ACK another attachment.
- Concurrent startup, stale sockets, live-but-unresponsive hosts, symlink/wrong
  owner/type/mode, long paths, forged/replayed auth, guessed IDs and foreign
  profiles fail safely. An ordinary same-UID client without the app credential
  cannot list, create, stop or attach sessions; document hostile-UID limits.
- Foom/Foom Dev/two explicit profiles do not cross-attach. Fresh-profile teardown
  leaves no daemon. Expiry/tombstone/capacity behavior uses fake timers for 24h
  cases; native process shutdown gets real integration coverage.

### B. Persistent invocation endpoints and app reconciliation

- Host owns hooks/MCP endpoint lifetime, reduced sequenced hook evidence,
  live-grant authentication and private launch-file cleanup; main policy is an
  explicitly leased dependency. UI absence returns bounded unavailable errors
  for dependent calls; nothing is queued to execute after reconnect.
- App quit/reopen retains invocation credentials and endpoint addresses for live
  launches; foreign/revoked grants fail before effects. Gaps remain unknown,
  stale hook events cannot change another launch and no raw payload is retained.
- Inventory precedes restore; crash-before-save recovers visible rows with no
  duplicate agent spawn. True exits and gone sessions remain distinct. Lost or
  unknown launch outcomes require reconciliation and explicit retry.

### C. Quit/reopen behavior and compatible update support

- Trusted three-choice quit inventory discloses token spending, no offline OS
  notifications and the retention deadline. Default is stop; cancel/failure keeps
  the app open. Crash-survival disclosure and Windows limitation are visible.
- Version/capability fixtures cover old/new app-host combinations and downgrade.
  Compatible update retains live PTYs; incompatible update never kills without
  approval. Host update pending clears only after replacement is safe.
- Packaged macOS update/relocation test retains a live fixture PTY, hooks/MCP
  resources and native helpers after replacing the app bundle. Linux packaged
  exit/relaunch works from desktop and terminal launch. Run all required unit,
  coverage, full Electron, make and packaged checks on supported platforms.
- Add process diagnostics and audit ownership without blanket leak exclusions;
  measure utility versus local host latency/resize and record an approved budget.

### D. Headless orchestration and unattended status (separate approval gate)

- Move the narrow workspace authority/effect dependencies, stores, evaluator and
  review services into the host; only one owner writes sessions and operations.
  Audit failure refuses automation; takeover/revocation races remain enforced.
- With no Electron process, fixture parent can create/launch/stop its own children,
  read allowed tails/handoffs and wait, within repository/child/output limits;
  review automation advances only with its existing verified evidence.
- Trusted confirmations, pairing, elevation and UI previews refuse while absent;
  permission requests remain waiting. Reconnect cannot replay old approvals or
  lost input. Pending effects across crash are reconciled conservatively.
- Parent/child work shares the original UI-detach 24h deadline. Status/unread
  overflow is explicit, reopening shows authoritative attention, and no terminal
  data enters diagnostics or OS notifications.

### E. Windows parity and optional supervision (independent follow-up research)

- Windows opt-in only after local-only named pipe ACL/squatting/auth tests,
  independent process/job/ConPTY lifetime, concurrent exit and packaged quit,
  crash/update/reconnect checks pass. Until then keep current behavior.
- Evaluate launchd/systemd or native notifications only against an approved need;
  document opt-in installation/removal, no global setting changes, shutdown/logout
  limits and redacted notifications. Neither is required for Unix phase C.

## Open product decisions for approval

1. Approve Stop everything and quit as the default, with an explicit per-quit
   Keep running choice and no remembered silent detach preference?
2. Is an opt-in A–C milestone acceptable with Foom-dependent orchestration paused
   while Electron is closed, or must D land before any public detach release?
3. Should the UI-absence 24-hour deadline stop even active unattended children,
   as recommended, or should a later explicit unattended mode use a different
   retention/reconciliation policy? Who owns its spending limit?
4. Accept no OS notifications while the app is absent initially, and the loss of
   undelivered final screen content for detached exit tombstones?
5. Accept a compatibility window with host updates deferred until idle, explicit
   stop for incompatible/security-critical replacements, and no live migration?
6. Accept the documented same-UID threat limit and scoped ID disclosure, rather
   than promise isolation from arbitrary same-user agents? Is a stronger OS
   boundary a prerequisite?
7. Accept first-phase long-profile-path and unavailable-secret-store refusal,
   disposable-profile stop-only semantics, and Windows retaining stop-on-quit?
