# Architecture

This describes the target design. Where the code differs today, the section says so. A PR that changes a decision here updates this file in the same PR.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | Terminal capabilities and IPC broker, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Terminal host (`utilityProcess`) | PTYs, headless screens and parser/view backpressure | Trust messages without validation or depend on an attached view to consume output |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Board

**Today:** The board is the home screen, with a live shell row and ten explicitly labeled, read-only sample sessions grouped by repository. Arrow keys select rows, P or hover peeks without moving focus, Enter opens, Escape hides and restores row focus, and N opens the oldest waiting sample. Rows keep their positions when verdicts change. Opening does not clear Needs you; Done/Failed dim once seen. The open terminal occupies a panel beside the board (the board is covered on narrow windows); inactive rows leave the tab cycle. Sample IDs and input never reach the terminal bridge. The real shell starts detached, can be opened, hidden and restarted, and retains its output in the host. A source adapter exposes row/verdict snapshots, activity batches and async tails; live worktree/verdict integration remains #57.

## Renderer

**Today:** The board uses React 19 with TSX and reads one typed source through `useSyncExternalStore`. A persistent shell panel mounts one imperative terminal controller through the source adapter and disposes xterm and subscriptions on unmount. Terminal visibility and measurement remain in the controller to preserve attachment ordering. Activity batches write brightness directly to each light; a separate clock updates wait labels without React commits. The temporary source simulates activity at 10 Hz for ten sample rows. Live board data remains #57.

- **React 19 with TSX**, bundled by esbuild as a production build (`process.env.NODE_ENV` defined). No other UI framework, component kit, or CSS-in-JS. Styles are plain CSS using the tokens in `tokens.css`.
- **The renderer holds view state only.** Terminal, verdict, and worktree truth lives in main and arrives through `window.desktop`. Components don't call the bridge directly; they read from one board data-source interface shaped like the IPC contract. A sample source serves development and tests, and a live source (#57) replaces it in the app.
- **High-frequency data bypasses React.** Activity arrives about 10 times a second for up to 10 terminals. A small subscriber writes each light's brightness to a CSS custom property on the light element; React re-renders only when structure or verdicts change. Terminal output never goes into React state.
- **xterm.js stays imperative.** One component owns the `Terminal` through a ref, creates it once, and keeps the attach, drain, reset, fit, snapshot, acknowledgement, and reply-suppression order described under Terminals.
- **Keyboard first.** Every board action works without a mouse. The Electron suite runs axe; serious or critical violations fail.
- **Linting:** `eslint-plugin-react-hooks` and `@eslint-react/eslint-plugin` on top of the existing type-aware rules. `eslint-plugin-react` and `eslint-plugin-jsx-a11y` don't support ESLint 10 and are not used.
- **Coverage and lint globs include `.tsx`.** A component outside them would silently skip the per-file thresholds or the renderer import restrictions.
- The CSP doesn't change. React needs no `eval`.

## Terminals

**Today:** `src/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/terminal.ts` grants the app window access only to the terminals it created. The renderer starts on the board with its shell detached. Opening the shell row reveals xterm; Esc hides the view and returns focus to that row. Hiding detaches the stream without stopping the shell. Reopening drains pending renderer writes, resets the display, fits the visible grid, and restores a fresh host snapshot before continuing the live stream. Input and resize events are suppressed while hidden or changing attachment. The manager and ID-scoped bridge support multiple concurrent sessions; live worktree/verdict integration awaits #57. Closing the window requests application quit on every platform. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals; once a termination request succeeds, shutdown and retries only drain its native exit callback, because closing a ConPTY handle twice can crash the host. A throwing termination request remains retryable. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their process handles and exit subscriptions even after a terminal is removed from the board. Confirmed quit applies the same graceful termination and force-kill deadlines to these removed processes and waits for their pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Color state also belongs to the host: OSC 4 (palette) and 10/11/12 (foreground/background/cursor) queries, sets, and 104/110/111/112 resets use shared public-parser handlers. Only the host handler writes replies; the renderer handler applies colors without answering queries, including mixed set/query commands. Colors accept xterm-compatible hex and `rgb:` forms; unsupported names and malformed entries are ignored. The palette starts with xterm's 256 defaults, and foreground/background/cursor use the brand ink/bg/accent tokens. Main sends the native system theme on creation and validated, terminal-ID-scoped updates on changes. A system theme replacement resets application-set color overrides to the new defaults, as the existing browser theme replacement did. Parser barriers order these updates with output, and attachment snapshots include all color state, so changes while hidden appear on reattachment. Keyboard, paste, and mouse input are not filtered.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. The host supplements serialization with scrolling margins for both buffers and restores origin mode before positioning the active cursor. A pending right-edge wrap is recreated by replaying the cursor row with the pinned serializer after restoring margins, preserving cell styles and the current pen. Normal-buffer margins are restored before entering the alternate buffer, so leaving fullscreen mode retains normal scrolling. xterm 6 does not expose margins publicly; the snapshot helper checks its pinned internal buffer representation and rejects attachment if incompatible; pending-wrap restoration also checks the pinned addon’s internal row serializer. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The activity meter and last-lines buffer read from the same stream in the host. One 100 ms timer batches changed UTF-8 bytes-per-second rates for all terminals, exponentially smoothed with a 500 ms time constant. Rates decay to zero; the timer sleeps once all meters are quiet and zero. Quiet fires once per output burst after 500 ms for a trailing question, y/n, password, or Enter prompt, otherwise after 2 seconds. New output restarts the debounce; pending parser writes prevent quiet classification. A terminal silent from launch gets its first quiet event after 2 seconds. Exit and removal cancel the meter. These are timing hints, not attention verdicts. Main exposes quiet callbacks for the evaluator and forwards activity only for live owned terminals; view attachment does not affect measurement. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

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
| `terminal:tail` | renderer → main (invoke) | `id`, line count (1–10000) → plain text lines from the headless screen |
| `terminal:activity` | main → renderer | batched `[{ id, rate }]`, about 10 per second at most |
| `terminal:state` | main → renderer | `id`, state, reason, signal, timestamp |

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom creates worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added. Listing includes all Git worktrees, including external ones; removal is restricted to worktrees the service created.

**Today:** `src/worktrees.ts` provides the main-process `WorktreeService`, independently of the UI and IPC. Add a repository before listing or modifying its worktrees. It canonicalizes repository paths, lists NUL-delimited Git records, checks out existing branches or creates new ones, and delegates dirty/locked removal checks to Git. Force allows dirty removal but does not override ownership or locks. Adjacent trees use `<repo>-<branch>` (branch slashes create subdirectories). Creation checks resolved parent directories against the allowed root and rejects existing destinations. Ownership records the device, inode, and birth time of the worktree directory, its `.git` file, and its resolved Git metadata directory. Listing and removal revalidate that identity; missing or replaced entries permanently invalidate ownership, including for forced removal. Removal rejects redirected paths. These checks do not provide isolation against another local process concurrently replacing filesystem entries.

At startup, main opens the service with `WorktreeService.open(app.getPath("userData"))`. Repository registration and ownership are stored in versioned `worktrees.json` using a private temporary file and atomic rename; writes are serialized within the service. Startup validates the untrusted state, rechecks repository paths, allowed roots, Git membership, and filesystem identity, and drops stale or redirected entries. Corrupt or unsupported state grants no ownership and does not block startup. Registration, creation, removal, and ownership invalidation await persistence; write failures are reported to the caller. The synchronous constructor remains available for an explicitly in-memory service. UI/IPC integration remains future work. State assumes a single application service writer; it is not a security boundary against a local process able to forge the entire state file. Worktrees are never adopted just because they appear under the configured root. Repositories sharing a basename share a destination namespace; a collision fails without overwriting the existing directory.

## Agent discovery and launch

**Today:** `src/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Stable Claude Code releases at or above 2.1.284 and Codex releases at or above 0.155.1 enable hooks only when help includes the complete `--settings` or `-c` flag respectively. There is no maximum version. Unparseable versions, prerelease/custom suffixes, missing flags, failed probes, Antigravity, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. The selected worktree must still be owned by `WorktreeService`; one agent launch at a time may occupy each worktree.

`setHooksEnabled(false)` disables hook attachment for subsequent launches. A main-process integration supplies a fresh `AgentHooks` binding per launch, with a Claude stdin adapter command, a Codex argv adapter command, session credentials, and a cleanup callback. Claude settings attach Stop, PermissionRequest, and Notification observer hooks as inline JSON in `--settings`; Codex receives `-c notify=[...]`. No settings files are created in the user's HOME or workspace. Codex attachment requires `acknowledgeCodexNotifierReplacement` after the UI discloses that the user's notifier is replaced for this invocation. `release(terminalId)` must be called on exit/kill to revoke credentials and free the worktree; `dispose()` releases all bindings during shutdown after terminals are stopped. Spawn failures clean up immediately.

The receiver and adapters from #13 are available as independent services; connecting them to the launcher, persisted settings/setup (#17), board/IPC integration (#9), and actual output evaluation (#14/#15) remain integration work. Until integrated, the existing renderer continues launching its shell, and `attention: "evaluator"` describes the required fallback rather than an already-running evaluator.

## Agent signals

Foom attaches its hooks per launch and never edits the user's own config:

- Claude Code: `claude --settings <inline-json>` with Stop, PermissionRequest, and Notification hooks; JSON arrives on stdin. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
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

**Today:** `src/evaluator.ts` supplies the pure main-process `evaluateRules` classifier,
and `src/verdict-log.ts` supplies `VerdictLog`. Application wiring, terminal state IPC,
and feedback controls belong to #50 and the board integration; these services do not
start an evaluator in the running app yet. `src/model-evaluator.ts` adds the model
tier for ambiguous rule results. Setup controls remain #17; see
[inference service usage and benchmarking](inference.md).

A known exit is final, including when an older permission hook arrives afterward.
For a live terminal, a matching permission hook takes precedence over an observed
shell-prompt return and text patterns. Completion hooks only request classification.
Prompt return must be supplied as a process fact, never inferred from `$` or `>` in
output. Echo-off is not an independent input. Text rules inspect only the last
nonblank line of the last 40 host-provided plain-text lines, recognize explicit
confirmation/password/Enter prompts, test-runner failure summaries, and listening
server URLs. Other quiet tails remain `working` with low confidence. Historical
prompts followed by more output do not request attention.

`VerdictLog.evaluate` appends a timestamped verdict with a unique ID and terminal ID
to `verdicts.jsonl` in the supplied user-data directory. `recordAction` records the
next explicit `replied`, `dismissed`, or `ignored` action against that verdict ID;
dismissal includes `not_attention` feedback. Opening a view is not an action.
Writes are serialized and synced before resolving, and new files have mode 0600.
Failures reject and can be retried. The log contains fixed rule reasons and metadata,
never tails, agent payloads, or keystrokes. The integration must handle write errors
without blocking terminal operation. One service instance owns the file; feedback
can address only verdicts issued by that instance, and historical records remain
available on disk across restart. No automatic inference of ignored actions or log
retention policy is implemented yet. The reusable fixture suite in
`tests/fixtures/evaluator.ts` contains sanitized, representative terminal tails.

Model calls get the last 40 lines, redacted, with a timeout. One-shot agent evaluators must not load repository instructions or use file, command, MCP, or other external tools to expand that input; a read-only sandbox alone does not enforce this boundary. Use another inference source or rules only when isolation cannot be enforced. A failure falls back to rules-only and never blocks the light.

The model service has a five-second deadline and two concurrent calls by default
(hard maximums: 30 seconds and four). Saturated calls use rules immediately; there
is no waiting queue or retry. A timed-out transport keeps its slot until it settles
so even a transport that ignores cancellation cannot exceed the limit. Run check
uses the same limits and reports status and elapsed time without provider errors.
Model JSON must contain exactly a known state and finite confidence in [0, 1].
Reasons and signal names are generated locally, never copied from model output.
HTTP responses are bounded to 64 KiB and truncated/tool/refusal responses fail closed.

Cloud transports use fixed Anthropic, OpenAI, and Google HTTPS origins. Local
OpenAI-compatible endpoints require a loopback IP literal (127.0.0.1 or [::1]);
redirects, URL credentials, queries, and fragments are rejected. No transport
supplies tools, file attachments, terminal IDs, hooks, or process metadata.
CLI inference is currently unavailable: neither tested CLI has a verified complete
no-files/no-instructions/no-integrations isolation profile. This intentionally
follows the fail-closed decision above; interactive agent launch is unaffected.

## Secrets

- API keys go through Electron `safeStorage` and are never written in plain text.
- Keys never cross into the renderer after they're entered.
- The redaction pass runs before any text leaves the machine.

`InferenceKeys` is a main-only key store using Electron `safeStorage`. It rejects
unavailable encryption and Linux `basic_text`, writes only ciphertext to private
0600 files through atomic replacement, and supports removal. There is no renderer
key-read API. Source/model selection is supplied by main; setup persistence and
sender-validated entry controls belong to #17/#50. Redaction removes likely labelled
credentials, bearer/API tokens, JWTs, URL credentials, and private-key blocks before
selecting the last 40 physical lines. Oversized input fails back to rules. Redaction
is heuristic and cannot identify every unlabelled secret.
