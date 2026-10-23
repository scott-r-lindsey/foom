# Agent Launch

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Agent discovery and launch

The [agent plugin format v2](../agent-plugins.md) parser (#430) supports offline
validation. #431 adds the generic launch
engine for v2 config plugins: fixed discovery, conditional ordered argv,
private MCP data files, prompts and preview grants, argument and environment
bypass, resume and attention rules. Hooks/health and setup are implemented by #432/#433. Claude (#434), Codex (#435) and Antigravity (#436) use the same v2 engine through bundled build-locked manifests.

**Today:** `src/main/agents/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Stable Claude Code releases at or above 2.1.284 and Codex releases at or above 0.155.1 enable hooks only when help includes the complete `--settings` or `-c` flag respectively. There is no maximum version. Unparseable versions, prerelease/custom suffixes, missing flags, failed probes, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Codex receives `--no-alt-screen` only when its help lists the complete flag, independently of hook support or the hooks setting. Inline output stays in normal scrollback for wheel scrolling and evaluator tails; a failed or unsupported probe leaves launch arguments unchanged. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. All launch paths authorize any valid selected checkout in the registered repository, including external and detached worktrees. Main captures the canonical checkout identity before confirmations or agent scanning; the agent service revalidates it after hook preparation, immediately before spawning. Shells revalidate immediately before spawning too. Validation checks current Git membership and common Git directory, rejects redirected, bare, locked and prunable worktrees, and detects replacement during confirmation. The identity is a main-only launch capability; IPC never copies it from renderer requests. All checkouts permit multiple sessions. Sidebar, New worktree and legacy agent launch paths use a main-owned confirmation before launching an agent alongside any running agent in that checkout. Shells and exited agents do not trigger the warning. Cancellation creates no session. Main grants the shared-launch capability only after checking for active agents under the launch lock; renderer-supplied flags cannot bypass confirmation. Launch and removal locks cover confirmation and spawning. Repository registration is reserved before any asynchronous launch or worktree creation, including legacy launch IPC. Repository removal in both the sidebar and Settings refuses pending operations and tracked sessions; its exclusive guard spans confirmation and deregistration and blocks new launches until it settles. Each session retains independent hooks and verdicts.

Login-shell reads share `src/main/login-shell.ts`: stdin is ignored and Unix
reads start in a detached session, without Foom's controlling terminal (#626).
Both PATH discovery and environment import retain their five-second deadline and
256 KiB limits per output stream. Timeout, excess output and shell exit kill the
Unix process group, including background descendants holding output pipes open.
Windows readers continue to use the inherited environment without a login shell.

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
in `feature-context.d.ts`; the coordinator retains shared locks and owner wiring.
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
