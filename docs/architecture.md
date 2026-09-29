# Architecture

This describes the target design. Where the code differs today, the section says so. A PR that changes a decision here updates this file in the same PR.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | PTYs, terminal state, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Terminals

**Today:** `src/terminal-manager.ts` owns independent PTYs and headless screens by ID. `src/terminal.ts` grants the app window access only to the terminals it created. The renderer currently displays one shell; the manager supports multiple concurrent sessions. Closing the owning window disposes its sessions. PTY termination requests keep their exit subscriptions alive, including for terminals already removed from the board. A `will-quit` barrier waits for pending native exits before allowing Electron to tear down Node; a five-second timeout reports failure and cancels that quit attempt. This prevents native callbacks racing process teardown on Windows. Detached sessions continue running; navigation or a renderer crash automatically detaches views.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- Main forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Throttling (pause at a high-water mark, resume after the renderer confirms it drew the output) applies only while a view is attached.
- The activity meter and last-lines buffer read from the same stream. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

Target launch interface sketch (worktree and agent launch support is future roadmap work):

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

## Agent signals

Foom attaches its hooks per launch and never edits the user's own config:

- Claude Code: `claude --settings <foom-settings.json>` with Stop, PermissionRequest, and Notification hooks; JSON arrives on stdin. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
- Codex: `codex -c notify=[...]`; JSON arrives as an argument. The external callback reports turn completion, not approval requests, and replaces the effective notify command for that launch.
- Antigravity: output evaluator only for now. Hooks and headless mode exist, but an invocation-scoped hook attachment was not verified.

See [agent research](agents.md) for versions, payloads, local probes, sources, and remaining verification. Completion events trigger classification; they do not unconditionally set Done. Echo-off alone is not a password signal: all three tested CLIs disabled echo at startup.

**Today:** `src/hook-receiver.ts` provides an independently usable main-process service. `HookReceiver.listen(onSignal)` binds only `127.0.0.1` on an OS-assigned port. `register(terminalId, agent)` returns fresh `FOOM_SESSION`, `FOOM_TOKEN`, and `FOOM_HOOK_URL` environment additions and an idempotent `revoke()` capability. The launcher must revoke on launch failure, terminal exit, or removal; application shutdown must call `close()`. The launcher (#12), evaluator, terminal state IPC, and UI integration remain separate roadmap work. The shell-only app does not start an unused listener.

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
