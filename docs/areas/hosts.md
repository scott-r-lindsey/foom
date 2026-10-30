# Registered SSH hosts (#757 PR 1)

Settings → Hosts is the only enrollment surface. Registrations are profile-only
`registeredHosts` records, validated on load, with an SSH alias/account selector
and approved absolute code folder. The agent-editable config excludes them;
`setup:save` cannot write them. Developer spike mappings register nothing and
confer no later fleet authority. Host-aware orchestration (#756) uses the same registration and management service.

`setup:hosts` accepts one closed action from the registered board main frame:
list, test, add, refresh, remove, locations or clone. Main selects enabled agent
executables from its validated manifest catalog. Renderer inputs cannot choose
remote commands, probe arguments, origins or checkout destinations. Replies are
validated in preload and rebuilt from declared fields. All failures are fixed
states/reasons, with no raw SSH, Git or agent output.

Test and add use the existing exact-build artifact selection, SHA-256 bootstrap
and SSH stdio protocol. SSH retains BatchMode, disabled agent/X11 forwarding,
ClearAllForwardings, ConnectTimeout and its environment allowlist. There is no TCP
listener. A management request has no terminal ID and creates no PTY. Existing
SSH host-key trust applies; Foom never accepts a key or prompts for credentials.
Removing a registration only forgets it: it sends no stop, kill or session-close
operation, including when the last observation reports live sessions.

The default code folder is `~/foom`. The remote expands it against its own home,
creates missing components with mode 0700 and checks canonical containment,
symlinks, ownership of the code folder and group/world write permissions. Ancestors
must not be group/world writable, except a root-owned sticky ancestor such as
`/tmp`. Checks repeat before repository mutation. These are filesystem observations,
not atomic traversal or protection from a compromised account/root.

Host rows expose daemon version, live session count, CPU cores and three load
averages, memory total/available and fixed agent states with Refresh. Linux uses
`MemAvailable` from `/proc/meminfo`. macOS available is the sum of free, inactive
and speculative page counts from fixed `/usr/bin/vm_stat`, multiplied by its page
size; wired/compressed pages are excluded. [Apple’s vm_stat snapshot](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c#L122-L141) prints free pages with speculative pages removed, so this adds speculative pages once. This measures reclaimable memory and
is not a promise that an allocation will succeed. There are no busy warnings or
idle resource polling timers.

Ready means installed and probeable, using only the existing `--version` and
`--help` probes over the account's login PATH. Missing executables show Not found;
failed probes show Unable to check. No sign-in probes or credential reads are
added. Manifest probe output stays on the host and is reduced to fixed states. Main projects the inventory onto its selected manifest IDs: unexpected host IDs are discarded and omitted entries become Unable to check.

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
sockets are copied/forwarded. Clone failures use a fixed reason. The host cannot
select a local executable or write location. Git output never reaches the UI.
Clone, fetch and default-branch network queries each have an explicit five-minute
subprocess deadline; discovery and Git inspection probes retain five seconds.
The daemon's ten-second deadline covers negotiation and idle clients only.
Each management request gets a separate seven-minute budget after negotiation;
SSH bootstrap has its own two-minute hub budget. Agent preparation and final
spawn authorization share a separate two-minute daemon budget.

Disconnect, operation expiry and daemon shutdown cancel the operation's subprocess
group, including descendants. Later Git commands and clone publication check
cancellation first; an already-issued rename/mutation can still finish and must
be reconciled by reading state.
The daemon retains at most four in-flight management/preparation operations even
when their clients disconnect, until their subprocesses and cleanup settle.
Repository mutations run one at a time per daemon; overlapping mutations refuse
with the fixed checkout-refused reason, including retries during cancellation.
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

Persistent sessions, hub-restart reattachment and daemon upgrade negotiation are
PR 2 of #757 and are not implemented by this settings surface.

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
work. A failed inventory connection reports `remote_host_unreachable`. No sign-in
probe or new inventory UI is added here; Settings → Hosts owns that presentation.

Orchestrator session reads expose a bounded host list with fixed agent states and
CPU/memory observations, including Local. Paths, raw probe output and credentials
are omitted. Linux available memory uses MemAvailable; macOS uses the same
free + inactive + speculative page definition locally and remotely. No polling,
busy warning or Foom-enforced heavy-validation lock is added.

Remote management Git reads disable replacement refs and legacy grafts, including
checkout validation and identity rechecks. Detached worktree removal requires HEAD
to be reachable from a retained branch, remote-tracking ref or tag using stored
commit history with commit-graph reads disabled, matching the local removal guard.
