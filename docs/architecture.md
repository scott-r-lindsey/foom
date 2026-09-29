# Architecture

This describes the target design. Where the code differs today, the section says so. A PR that changes a decision here updates this file in the same PR.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | Terminal capabilities and IPC broker, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Terminal host (`utilityProcess`) | PTYs, headless screens and parser/view backpressure | Trust messages without validation or depend on an attached view to consume output |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Terminals

**Today:** `src/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/terminal.ts` grants the app window access only to the terminals it created. The renderer currently displays one shell; the manager supports multiple concurrent sessions. Closing the window requests application quit on every platform. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their exit subscriptions even after a terminal is removed from the board. Confirmed quit also waits for these pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The future activity meter and existing last-lines buffer read from the same stream in the host. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

The host uses Electron's `utilityProcess.fork`, not a Node child-process fork, so RunAsNode stays disabled. The native node-pty module remains unpacked from ASAR; Windows continues using the ConPTY DLL to avoid its Node helper path. After the native rebuild, packaging restores `conpty.dll` and `OpenConsole.exe` beside the rebuilt addon from node-pty’s matching architecture prebuild; node-gyp clears these postinstall files during rebuild. The three-platform CI matrix runs the packaged executable and tests its PTYs and detached snapshots with the disabled fuse verified.

Host requests and responses are validated at runtime and carry terminal IDs; request/reply pairs also carry a monotonic request number. Each attach has a main-generated view generation so late output from a previous view is ignored. Creation IDs are allocated in main. Unknown and duplicate IDs are rejected by the host. Renderer payloads cannot choose executables or working directories. A host exit or 10-second request timeout rejects pending operations, marks live terminals failed (`terminal:exit` code -1), and removes views. Exited terminals are not reclassified. A later create starts a fresh host; old IDs cannot address new sessions. The current single-shell UI displays the failure and offers Restart shell. Confirmed quit requests native PTY shutdown in the host and reports failures without closing the window, allowing a retry. Shutdown RPC has a 15-second deadline to accommodate the native exit barriers. Final disposal waits for the utility process to exit, with a 12-second fallback for an unresponsive host.

Target launch interface sketch (the current main-only `AgentService` uses `TerminalSpec.cwd` and optional environment additions):

```ts
type TerminalId = string;

interface TerminalSpec {
  worktree: string; // absolute path; must be a worktree Foom manages
  command: string; // resolved executable
  args: readonly string[];
  env: Readonly<Record<string, string>>; // explicit additions; the base env is scrubbed
  cols: number;
  rows: number;
  kind: "agent" | "server" | "shell";
}

interface TerminalManager {
  create(spec: TerminalSpec): TerminalId;
  write(id: TerminalId, data: string): void;
  resize(id: TerminalId, cols: number, rows: number): void;
  kill(id: TerminalId): void;
  attach(id: TerminalId): { snapshot: string }; // view opened
  detach(id: TerminalId): void; // view hidden; output keeps flowing into headless state
  tail(id: TerminalId, lines: number): string[];
  // Events: activity (rate), quiet (debounced), exit (code)
}
```

The base environment removes `npm_*` and `ELECTRON_*` variables. When launching an agent directly, Foom resolves the user's `PATH` from their login shell, because GUI apps on macOS start with a minimal `PATH`.

## IPC contract

Every channel checks the sender (the owning window, the main frame, `app://bundle/index.html`) and validates every payload at runtime. Every terminal-scoped message carries a terminal ID. Creation returns the new ID; it accepts only dimensions, with shell and working directory selected in main. The future worktree launch specification above remains a main-only capability.

| Channel | Direction | Payload |
|---|---|---|
| `terminal:create` | renderer → main (invoke) | `cols`, `rows` → `{ id, title }` |
| `terminal:attach` / `terminal:detach` | renderer → main | `id` → snapshot via `terminal:data` on attach |
| `terminal:kill` | renderer → main (invoke) | `id` |
| `terminal:input` | renderer → main | `id`, `data` (≤ 64 KB; chunked on code-point boundaries) |
| `terminal:resize` | renderer → main | `id`, `cols`, `rows` |
| `terminal:ack` | renderer → main | `id`, attachment token, `count` (attached terminals only) |
| `terminal:data` | main → renderer | `id`, attachment token, `data` (attached terminals only) |
| `terminal:exit` | main → renderer | `id`, exit code (final screen retained until killed) |
| `terminal:activity` | main → renderer | batched `[{ id, rate }]`, about 10 per second at most |
| `terminal:state` | main → renderer | `id`, state, reason, signal, timestamp |

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom creates worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added. Listing includes all Git worktrees, including external ones; removal is restricted to worktrees the service created.

**Today:** `src/worktrees.ts` provides the main-process `WorktreeService`, independently of the UI and IPC. Add a repository before listing or modifying its worktrees. It canonicalizes repository paths, lists NUL-delimited Git records, checks out existing branches or creates new ones, and delegates dirty/locked removal checks to Git. Force allows dirty removal but does not override ownership or locks. Adjacent trees use `<repo>-<branch>` (branch slashes create subdirectories). Creation checks resolved parent directories against the allowed root and rejects existing destinations. Ownership records the device, inode, and birth time of the worktree directory, its `.git` file, and its resolved Git metadata directory. Listing and removal revalidate that identity; missing or replaced entries permanently invalidate ownership, including for forced removal. Removal rejects redirected paths. These checks do not provide isolation against another local process concurrently replacing filesystem entries.

At startup, main opens the service with `WorktreeService.open(app.getPath("userData"))`. Repository registration and ownership are stored in versioned `worktrees.json` using a private temporary file and atomic rename; writes are serialized within the service. Startup validates the untrusted state, rechecks repository paths, allowed roots, Git membership, and filesystem identity, and drops stale or redirected entries. Corrupt or unsupported state grants no ownership and does not block startup. Registration, creation, removal, and ownership invalidation await persistence; write failures are reported to the caller. The synchronous constructor remains available for an explicitly in-memory service. UI/IPC integration remains future work. State assumes a single application service writer; it is not a security boundary against a local process able to forge the entire state file. Worktrees are never adopted just because they appear under the configured root. Repositories sharing a basename share a destination namespace; a collision fails without overwriting the existing directory.

## Agent discovery and launch

**Today:** `src/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Only the exact researched Claude Code and Codex version strings plus their required help flags enable hooks. Unknown versions, failed probes, Antigravity, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. The selected worktree must still be owned by `WorktreeService`; one agent launch at a time may occupy each worktree.

`setHooksEnabled(false)` disables hook attachment for subsequent launches. A main-process integration supplies a fresh `AgentHooks` binding per launch, with a Claude stdin adapter command, a Codex argv adapter command, session credentials, and a cleanup callback. Claude settings are inline JSON in `--settings`; Codex receives `-c notify=[...]`. No settings files are created in the user's HOME or workspace. Codex attachment requires `acknowledgeCodexNotifierReplacement` after the UI discloses that the user's notifier is replaced for this invocation. `release(terminalId)` must be called on exit/kill to revoke credentials and free the worktree; `dispose()` releases all bindings during shutdown after terminals are stopped. Spawn failures clean up immediately.

The receiver and adapters from #13 are available as independent services; connecting them to the launcher, persisted settings/setup (#17), board/IPC integration (#9), and actual output evaluation (#14/#15) remain integration work. Until integrated, the existing renderer continues launching its shell, and `attention: "evaluator"` describes the required fallback rather than an already-running evaluator.

## Agent signals

Foom attaches its hooks per launch and never edits the user's own config:

- Claude Code: `claude --settings <foom-settings.json>` with Stop, PermissionRequest, and Notification hooks; JSON arrives on stdin. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
- Codex: `codex -c notify=[...]`; JSON arrives as an argument. The external callback reports turn completion, not approval requests, and replaces the effective notify command for that launch.
- Antigravity: output evaluator only for now. Hooks and headless mode exist, but an invocation-scoped hook attachment was not verified.

See [agent research](agents.md) for versions, payloads, local probes, sources, and remaining verification. Completion events trigger classification; they do not unconditionally set Done. Echo-off alone is not a password signal: all three tested CLIs disabled echo at startup.

**Today:** `src/hook-receiver.ts` provides an independently usable main-process service. `HookReceiver.listen(onSignal)` binds only `127.0.0.1` on an OS-assigned port. `register(terminalId, agent)` returns fresh `FOOM_SESSION`, `FOOM_TOKEN`, and `FOOM_HOOK_URL` environment additions and an idempotent `revoke()` capability. The launcher must revoke on launch failure, terminal exit, or removal; application shutdown must call `close()`. The agent launcher is available as an independent service; connecting it to the receiver, evaluator, terminal state IPC, and UI remains integration work. The shell-only app does not start an unused listener.

Requests POST JSON to `/hooks`, with `X-Foom-Session` and `Authorization` containing the launch session and raw token. Tokens contain 256 random bits; comparison uses constant-time equality of fixed-length SHA-256 digests, including for unknown sessions. The listener rejects browser origins and nonliteral Host headers, limits headers to 8 KiB and bodies to 64 KiB (including chunked requests), caps connections, and times out stalled requests. It checks revocation again before delivery. Unknown/revoked sessions and incorrect tokens all receive 401. Unsupported events are acknowledged without changing state; malformed events receive 400.

The first supported event pins the agent session/thread ID for that launch. Subsequent events must match; Codex also requires a turn ID. Only `{ terminalId, action, signal }` escapes the receiver. PermissionRequest and `permission_prompt` produce `needs_input`; Stop, `idle_prompt`, and Codex `agent-turn-complete` produce `classify`. No event directly sets Done. Agent text, paths, tool inputs, and Codex `input-messages` are discarded, never logged, executed, or forwarded to the evaluator. Classification still uses only the redacted terminal tail.

The hook command cannot run Node from the packaged app because the RunAsNode fuse is disabled. `src/hook-adapters.ts` supplies distinct observer scripts for Claude stdin and Codex's final JSON argument: POSIX `sh` plus `curl`, and Windows PowerShell plus `Invoke-WebRequest`. The launcher writes the returned source to a private launch directory, invokes POSIX files with `sh` or Windows files with `powershell.exe -NoProfile -NonInteractive -File`, supplies the launch environment, and removes the files afterward. Codex's configured notify argument array must end at the script's configured arguments so the CLI can append its JSON argument. Payloads remain data throughout; scripts emit no output or approval decisions, have a three-second HTTP timeout, and exit successfully even when the receiver is unavailable. Per-launch settings and notify attachment, tool availability checks, and notifier-replacement disclosure belong to #12.

## Evaluator pipeline

`quiet` event → agent signal received? → process facts → text patterns → model (if configured) → verdict `{ state, reason, signal, confidence }` → `terminal:state` and the verdict log.

States: `needs_input`, `done`, `failed`, `quiet_ok`, `working`.

Model calls get the last 40 lines, redacted, with a timeout. One-shot agent evaluators must not load repository instructions or use file, command, MCP, or other external tools to expand that input; a read-only sandbox alone does not enforce this boundary. Use another inference source or rules only when isolation cannot be enforced. A failure falls back to rules-only and never blocks the light.

## Secrets

- API keys go through Electron `safeStorage` and are never written in plain text.
- Keys never cross into the renderer after they're entered.
- The redaction pass runs before any text leaves the machine.
