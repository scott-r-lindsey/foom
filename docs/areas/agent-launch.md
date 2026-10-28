# Agent Launch

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Agent discovery and launch

The [agent plugin format v2](../agent-plugins.md) parser (#430) supports offline
validation. #431 adds the generic launch
engine for v2 config plugins: fixed discovery, conditional ordered argv,
private MCP data files, prompts and preview grants, argument and environment
bypass, resume and attention rules. Hooks/health and setup are implemented by #432/#433. Claude (#434), Codex (#435), Antigravity (#436) and Copilot (#410) use the same v2 engine through bundled build-locked manifests.

**Today:** `src/main/agents/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Stable Claude Code releases at or above 2.1.284 and Codex releases at or above 0.155.1 enable hooks only when help includes the complete `--settings` or `-c` flag respectively. There is no maximum version. Unparseable versions, prerelease/custom suffixes, missing flags, failed probes, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Codex receives `--no-alt-screen` only when its help lists the complete flag, independently of hook support or the hooks setting. Inline output stays in normal scrollback for wheel scrolling and evaluator tails; a failed or unsupported probe leaves launch arguments unchanged. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. All launch paths authorize any valid selected checkout in the registered repository, including external and detached worktrees. Main captures the canonical checkout identity before confirmations or agent scanning; the agent service revalidates it after hook preparation, immediately before spawning. Shells revalidate immediately before spawning too. Validation checks current Git membership and common Git directory, rejects redirected, bare, locked and prunable worktrees, and detects replacement during confirmation. The identity is a main-only launch capability; IPC never copies it from renderer requests. All checkouts permit multiple sessions. Sidebar, New worktree and legacy agent launch paths use a main-owned confirmation before launching an agent alongside any running agent in that checkout. Shells and exited agents do not trigger the warning. Cancellation creates no session. Main grants the shared-launch capability only after checking for active agents under the launch lock; renderer-supplied flags cannot bypass confirmation. Launch and removal locks cover confirmation and spawning. Repository registration is reserved before any asynchronous launch or worktree creation, including legacy launch IPC. Repository removal in both the sidebar and Settings refuses pending operations and tracked sessions; its exclusive guard spans confirmation and deregistration and blocks new launches until it settles. Each session retains independent hooks and verdicts.

Login-shell reads share `src/main/login-shell.ts`: stdin is ignored and Unix
reads start in a detached session, without Foom's controlling terminal (#626).
Both PATH discovery and environment import retain their five-second deadline and
256 KiB limits per output stream. Timeout, excess output and shell exit kill the
Unix process group, including background descendants holding output pipes open.
Windows readers continue to use the inherited environment without a login shell.

Normal agent `--version` and `--help` discovery uses this same bounded reader
(#898): ignored stdin, a detached Unix session, five seconds per call and 256 KiB
per output stream. Deadline, overflow and executable exit kill the Unix process
group with SIGKILL, including descendants that ignore SIGTERM or hold pipes open.
Failed reads retain the existing discovery fallback and do not strand the scan
of other providers.

### Launch environment (#215)

`src/main/setup/environment.ts` owns Environment settings. `environment.json` in user
data holds an All sessions list and one per agent; secret values are stored only as
`safeStorage` ciphertext, never in `settings.json`, and Linux's `basic_text` fallback
counts as unavailable, so secrets are refused there. Loading drops invalid rows and
secrets that cannot be decrypted. Replies carry names, plain values and null for saved
secrets; error messages name variables, never values. Environment status never
probes the keychain. Loading stored secrets checks availability once for the load;
saving new or changed secret values checks once for the write. Unchanged ciphertext
is reused on unrelated edits. See [keychain access](settings.md#environment-keychain-access-717).

Each launch is built in layers, each overriding the previous: the inherited
environment (scrubbed of `npm_*`, `ELECTRON_*`, `FOOM_*` and `CLAUDECODE`), All
sessions, the agent's own list, selected bounded manifest launch entries (#636),
then Foom's reserved variables (control, hook and session variables). Shells get All sessions only. Main validates every variable again
at launch. Names match `^[A-Za-z_][A-Za-z0-9_]*$` and compare case-insensitively on
Windows, where a layer reuses the inherited spelling. `FOOM_*`, `CLAUDECODE`, `TERM`,
`COLORTERM` and `TERM_PROGRAM` are reserved; `LD_PRELOAD`, `LD_LIBRARY_PATH`,
`DYLD_*`, `NODE_OPTIONS`, `ELECTRON_*`, `BASH_ENV`, `ENV` and `PROMPT_COMMAND` are
refused in any case. Values are literal (no expansion), at most 4096 characters, with
no NUL. `PATH` only prepends absolute directories: Foom's CLI directory, then the
agent's, then global, then the login PATH. Proxy variables must be `http://`,
`https://` or `socks5://` URLs; an empty value turns an inherited proxy off. A URL with
user information is always a secret. When any proxy is set, `NO_PROXY` and `no_proxy`
keep every existing entry and gain `localhost,127.0.0.1,::1`. Session snapshots list
the names Foom set, never values. Every secret value and URL credential (the password,
or a lone user name, which may be a token) is added to `prepareTail` redaction and kept
until quit, since running sessions keep replaced secrets. Import previews mask saved
secrets entirely. Import from login shell runs one fixed `-ilc` printf program
with NUL delimiters for the proxy and certificate names only (Windows reads the
inherited environment); values stay in main until the user picks names.

POSIX observers use `curl --noproxy '*'`. Windows observers pass `-NoProxy` on
PowerShell 6+ and set an empty default proxy on 5.1, so hooks reach the loopback
receiver behind any proxy. Current observer versions and lifecycle ownership are
defined in [Execution](execution.md#stable-codex-hook-health) and
[Antigravity plugin ownership](execution.md#antigravity-plugin-ownership).

`setHooksEnabled(false)` disables hook attachment for subsequent launches. A main-process integration supplies a fresh `AgentHooks` binding per launch, with a Claude stdin adapter command, a Codex argv adapter command, session credentials, and a cleanup callback. Claude settings attach prompt, tool, Stop, PermissionRequest, and Notification observer hooks as inline JSON in `--settings`; Codex 0.161+ receives stable lifecycle definitions and keeps `-c notify=[...]` until completion hooks are observed working. Older supported Codex versions receive notify only. No settings files are created in the user's HOME or workspace. Codex notifier fallback attaches per launch without a warning or confirmation. Confirmed lifecycle hooks remove that override on later launches. `release(terminalId)` must be called on exit/kill to revoke credentials and free the worktree; `dispose()` releases all bindings during shutdown after terminals are stopped. Spawn failures clean up immediately.

`src/main/workspace/workspace.ts` exposes the public API through the internal
`workspace-context.ts` coordinator, which connects these services in main.
Feature methods live in `worktree-launch.ts` (discovery, setup,
shells, agents and resumes), `sidebar-commands.ts` (inventory, sidebar commands,
checkout creation/removal, config sessions and probe credentials), and
`orchestration-commands.ts` (roles, child launches, terminal events and ordered
evaluation). Each module has a narrow capability type
in `workspace-capabilities.d.ts`; the coordinator retains shared locks and owner wiring.
`workspace-types.d.ts` declares dependencies and feature method signatures.
The coordinator scans once and reuses the result until a refresh, starts the hook receiver on the first launch that attaches hooks, and closes it after terminals stop on quit. `src/main/agents/providers/hook-launch.ts` writes each launch's adapter script to its own `mkdtemp` directory (mode 0700), registers receiver credentials under a random key, and maps that key to the terminal ID once it exists (`AgentHooks.bind`). Exit, kill, and shutdown release the launch: credentials are revoked, the directory is deleted, and the worktree is free again. Antigravity uses a separately installed opt-in observer plugin; only its Foom launches receive fresh hook credentials. Preflight's settings reach the workspace through `configure`: the hooks setting calls `setHooksEnabled`, and launching an agent that preflight turned off is refused. Launched agents and worktree shells appear immediately in stable repository groups on the board. Board, sidebar config and restored Codex sessions attach the notify fallback without notifier consent. Stored legacy `codexNotifierAcknowledged` values are ignored.

### Main-owned child review steps (#690)

Opt-in orchestrator-owned review loops use the same provider launch engine and
validated conversation IDs. The author retains its terminal ID; resumption drains
the old evaluation queue, removes the exited host screen, resets execution and
launches a fresh PTY with the captured conversation and fixed quoted review brief
in argv. Reviewer launches use the same checkout sequentially with fresh ordinary
child grants. Main rechecks cancellation and ownership immediately before spawn.
Main-owned loop presentation metadata is written with each row before its first
session save, so a crash during launch cannot restore a loop participant as an
ordinary running session. No global provider config or running-PTY input is used.

## Workspace feature capabilities (#768)

`workspace-capabilities.d.ts` declares independent feature contracts without importing
the coordinator. `workspace-feature-wiring.ts` builds each feature's dependency
slice and live views of coordinator-owned state; feature functions bind to these
capabilities rather than the coordinator. `workspace-orchestration-host.ts` adapts the
orchestration host, including PR adoption under the shared repository and branch
reservations. The context still owns those reservations, terminal queues, launch
cancellation, owner initialization and shutdown order behind the unchanged
`workspace.ts` facade.

OpenCode's bundled manifest (#824) uses `--standalone`, Foom-assigned `ses_` UUIDs,
and `--session` for resume. `OPENCODE_CONFIG` selects per-launch event observers;
`OPENCODE_CONFIG_CONTENT` merges per-launch MCP and exact Foom tool grants. Source
files contain only an environment token reference. All are revoked/removed on
release. Former same-ID config sessions remain dormant for explicit Resume; see
[provider compatibility](providers.md#bundled-opencode-824).

### Fixed per-launch extension attachment (#834)

The v2 engine may select `launch.extension` when a measured API is available and
its hook channel or MCP is attached. It writes only the selected application-owned
versioned module and nonsecret launch data in the private launch root, passing
`{extensionFile}` as a whole argv value at the MCP stage. The same file handles
hooks and tools without duplicate loading. Hook-only, MCP-only and combined
launches share cleanup and independent credentials; disabling hooks does not
remove authorized MCP. No extension file is written when neither is selected.
The existing private-file checks, revocation and disposal own these files too.
See [extension schema](../contracts/agent-launch.md#fixed-extension-attachment-834).

## Per-child model and effort (#853)

Orchestrator `launch` accepts optional `model` and `effort`; `review.model` and
`review.effort` select the sequential reviewers independently. Omission retains
Settings → Agents defaults (#535). Author fixes reuse the author's requested
selection. These fields never accept extra arguments or config expressions.

Main validates both author and reviewer selections before reserving a launch or
spawning discovery/agent processes. Values are 1–64 ASCII characters matching
`^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$`: no leading hyphen, whitespace or equals.
The loaded manifest must declare the corresponding selection template, otherwise
`unsupported`; a value outside its declared list returns `invalid_request`.
Effort always has a fixed manifest enum. Model values may be constrained by a
manifest list; otherwise any well-formed token is accepted. There is no additional
Settings model allowlist.

The main-only argument builder replaces all matching default selectors by the
manifest's flags (separate, equals and attached one-letter short forms). Config
selectors replace only the exact declared key, preserving other `-c` values.
Manifest `launch.valueFlags` declares other single-value options; selector flags
also own their following value. The replacement scan preserves those values even
when they look like selectors (for example a Claude system prompt containing only
`--model=opus`). Other defaults retain their order and bytes; Settings is never
rewritten.
Existing bypass-default refusal remains, and bypass inspection still checks the
final expanded argv and environment before spawning. Requests cannot supply flags,
templates or arbitrary extra argv. The provider may still reject a model/effort
combination it does not support.

Session metadata exposes `selection: {model?, effort?}` and persists it as the
requested values, not proof of the provider's actual model. `session_state` and
`sessions` let the parent verify the request alongside handoffs. Reviewer state
retains its own requested options; restored review participants remain dormant.
See the [manifest selection contract](../contracts/agent-launch.md#child-model-and-effort-853).

## Remote agent phase 2 (#755)

Phase 2 binds one locally authorized checkout to one pre-existing remote
repository/worktree using explicit main-only developer flags. The local
orchestrator owns remote children; the headless remote host owns their PTYs and
runs discovery against its own CLI installations and login environment. There is
no remote Foom UI, file synchronization or credential copying.

The remote child grant exposes only `handoff`, `manual` and a sanitized `whoami`.
Its identity is a fresh opaque per-launch alias, never a hub terminal ID or parent
ID. Local `whoami` and parent-facing terminal IDs are unchanged. Filesystem preview
and fleet/repository tools are refused with a fixed phase-2 restriction reason;
this limitation is deferred to the host-aware control surface in #756.
Review-enabled remote launches fail with `remote_review_unsupported`; local
HEAD/dirty snapshots and forge observations cannot attest to the remote checkout.
Host-aware review snapshots and forge evidence remain future work for #756/#757.

Remote hook and control endpoints terminate on private Unix sockets. A local
stdio MCP adapter talks to the remote endpoint; only bounded, versioned, validated
messages cross the SSH stream. A validated internal MCP handshake notification
updates the hub connection status without adding a child tool. Main keeps the actual child grant and dispatches
relayed calls through existing authorization and handoff validation. Remote
credentials are independent random per-launch capabilities, revoked on failed
launch, exit, removal and shutdown. Neither those endpoints nor remote processes
receive the daemon's terminal takeover ID or hub control credentials.

Use all five flags together:

```text
--remote-agent-spike=SSH_ALIAS
--remote-agent-artifact=/absolute/path/to/matching/foom-host
--remote-agent-local-checkout=/absolute/local/authorized/checkout
--remote-agent-repository=/absolute/remote/clone
--remote-agent-worktree=/absolute/remote/worktree
```

The local checkout remains the parent's authorization and forge coordination
record. The remote clone/worktree must already exist; Foom does not create,
synchronize or infer it. Only an owned child targeting that local checkout is
routed remotely. The parent itself and other checkouts stay local. Remote
processes inherit the host's environment and login PATH; hub Environment settings
and saved secrets are not copied. Both remote Git membership and local checkout
identity are revalidated around preparation. The host prepares without spawning,
then waits for main's final live-ownership/checkout authorization before starting
the PTY. Cross-host checks are not an atomic filesystem transaction or sandbox.

Resume uses a fresh remote launch and credential, with the captured conversation
ID. In this restricted phase, human Resume/New conversation for a remote row
retains its live local parent after rechecking ownership and child capacity;
local human relaunch behavior is unchanged. Taken-over/orphaned remote rows and
missing mappings cannot launch parentless or silently fall back to local. Remote
rows are marked in session storage; cross-hub persistence/reattach remains #757.

Antigravity needs the opt-in observer version 4 on that host for Unix-socket
hooks. In a remote shell, run the matching cached `foom-host --stage-plugin agy`
to stage reviewed assets, then explicitly run `agy plugin install PATH` with the
printed directory. Staging does not install or change global configuration.
Missing, older or disabled plugins retain screen evaluation. Claude and Codex
attach their manifest hooks and private stdio MCP config per launch. That config
forwards only the endpoint socket and control token by environment variable name
(Codex `env_vars`, Claude `env` references), never credential values in files or
arguments. Codex keeps
its notifier fallback; remote health observations are invocation-local and never
change hub/local CLI hook trust observations.

Remote model/effort selections use the same validated manifest argument replacement
before relay; effective launch flags and requested selections remain in local session
metadata. Pi extension and OpenCode context-event launches fail closed with
`remote_agent_unsupported` until their attachments support the private remote
transport. Remote Antigravity keeps Unix-socket hooks and CLI handoffs; its local
loopback MCP bridge stays inactive, with prompt guidance retained. No hub endpoint,
credential or identity is supplied to activate it.


Phase-2 launches record their actual `placement` at spawn: `{kind: "local"}` or
`{kind: "remote", host: SSH_ALIAS}`. Launch operation results and parent-facing
session state expose this value; session storage retains it across startup mapping
changes. A saved local session resumes locally even when its path now matches a
remote mapping. Remote rows remain dormant after hub restart until #757; closing
one still reconnects to clean up its remote process and launch assets.

Launch diagnostics use the fixed `launchReasons` codes in
[the control contract](../contracts/control-mutations.md#launch-failure-reasons).
Main logs one bounded code-only failure line. Remote output, stderr, paths and
provider text never select or enter a diagnostic message.
