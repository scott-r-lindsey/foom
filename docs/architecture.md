# Architecture

This describes the target design. Where the code differs today, the section says so. A PR that changes a decision here updates this file in the same PR.

## Application profiles

Before readiness or any profile store opens, unpackaged launches without
`--user-data-dir` select `Foom Dev` beneath Electron's platform `appData` directory.
This profile persists between launches. Packaged builds retain Electron's default
profile; an explicit `--user-data-dir` always wins, including tests and `start:fresh`.
There is no automatic migration or copying between profiles.

Main acquires Electron's single-instance lock after selecting the profile. A losing
launch exits before opening stores, sessions, IPC or shutdown writers. A second
launch restores, shows and focuses the existing window; distinct profiles can run
side by side. Unpackaged windows use the title **Foom Dev** and a neutral **Dev**
sidebar marker, including explicit test/fresh profiles. Main passes only a boolean
identity through the sandboxed preload; profile paths remain in main.

At startup, main removes inherited `FOOM_*` environment variables and `CLAUDECODE`
(the Claude nesting guard) before spawning child processes. Foom's per-launch
hook URL, token and session therefore cannot leak from the parent terminal into
the child app's sessions. Bash lifecycle integration uses an invocation-private
startup file and non-exported shell callbacks, not environment credentials.
Per-launch agent settings remain scoped to command arguments; user configuration
and unrelated environment variables are unchanged.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | Terminal capabilities and IPC broker, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Terminal host (`utilityProcess`) | PTYs, headless screens and parser/view backpressure | Trust messages without validation or depend on an attached view to consume output |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Source layout

Directories expose the process boundaries above, with features grouped within main and renderer:

```text
src/
  main/
    main.ts           # application composition and lifecycle
    window/           # appearance and window scaling
    terminals/        # terminal IPC capabilities and utility-process client
    workspace/        # workspace coordination, worktree service and IPC
    agents/           # CLI discovery, launch and invocation-scoped hooks
    evaluator/        # rules, model transport/probe, redaction, keys and verdict log
    setup/            # settings, repository discovery and setup IPC
  terminal-host/      # utility-process entry, PTYs, headless screens and activity
  preload/            # sandboxed window.desktop bridge
  shared/             # declaration contracts and platform-neutral runtime helpers
  renderer/
    renderer.tsx      # browser entry
    app.tsx           # preflight/board composition
    board/            # board view, live/sample sources and worktree dialog
    terminal/         # imperative xterm controller and reply suppression
    preflight/        # setup source, steps and controls
    ui/               # reusable UI controls
    styles/           # token and application CSS
    fonts/
tests/
  unit/               # process/feature layout mirrors src; tooling tests also live here
  electron/           # real-app and packaged tests, with their PTY probes
  fixtures/           # shared unit-test data
```

`src/main/terminals/terminal-ipc.ts` grants renderer capabilities; it does not own PTYs.
`live-board-source.ts` adapts the real bridge, while `sample-board-source.ts` serves explicit development builds and tests.
The browser-safe `shared/terminal-colors.ts` runs in both the host and renderer;
`shared/terminal-host-protocol.ts` validates messages between main and host.

Within those features:

- `preflight-view.tsx` coordinates navigation, scans, persistence, errors, heading focus and launch. Welcome, agents, repositories, worktrees and readiness render in their own `*-step.tsx` modules; they receive state and actions from the coordinator. The welcome step shows instead of tells: `welcome-noise.tsx` tiles ten made-up terminals like a window manager, then folds them into ten lights, one of which needs you. `welcome-noise-output.ts` generates their output: colored, bursty, with streamed prose and per-agent status lines, and each light follows its own terminal's output rate. It is decorative (`aria-hidden`) and shows its final frame under reduced motion. Evaluator controls remain in `preflight-evaluator.tsx`.
- `inference-probe.ts` orchestrates Run check and model discovery. `probe-stream.ts` decodes bounded streamed events, `probe-errors.ts` maps transport/provider failures to Foom's messages, and `probe-response.ts` reads bounded response bodies. Shared probe types live in `probe.d.ts`.
- `board.ts` contains production board helpers. `sample-rows.ts` holds development fixture rows and is imported only by the sample source and tests.
- `styles/styles.css` is an ordered import manifest for base, board/terminal, preflight, inference check, appearance, welcome, welcome animation, repository picker, layout overrides, tooltips, agent cards and worktree dialog styles. The build bundles it into the existing `styles.css` asset; there are no runtime imports or new asset permissions. Keep the import order: the later preflight/layout/card rules intentionally follow the base feature rules.

The `foom/process-boundaries` ESLint rule checks static imports, re-exports, literal dynamic imports and `require` calls. Process-owned code may depend on its own process and shared modules. Shared modules cannot depend on process-owned code. Renderer and shared modules cannot import Node, Electron, node-pty or headless xterm. The sandboxed preload may import Electron at runtime and shared declarations as types; adding another runtime dependency requires an explicit boundary and loader design change.

Tests live outside `src/`; production compilation excludes them. Coverage still includes every executable source file regardless of its directory. The build emits main at `build/main/main.js`, preload at `build/preload/preload.js`, and the host at `build/terminal-host/terminal-host.js`. Renderer TypeScript is type-checked without emitting; esbuild produces the browser bundle. This prevents the renderer compiler from overwriting main’s CommonJS shared modules with unbundled ES modules. Renderer asset URLs remain unchanged.

## Board

**Today:** The board is the home screen, with live shell and agent rows grouped by repository. The source loads `workspace:snapshot`, refreshes on `workspace:changed` (including repository additions and preflight repository changes), and overlays `terminal:state`, `terminal:exit`, and activity events received while a snapshot is pending. Rows keep their positions when verdicts change. The persistent sidebar remains beside the terminal tile area. Arrow keys move row focus; focus or hover peeks at the real tail without changing attachment; Enter or click selects and focuses the terminal. Main intercepts ⌘/Ctrl+Shift+B to focus the sidebar and ⌘/Ctrl+Shift+N to select the oldest waiting verdict. Esc reaches the PTY. Below 720 CSS pixels, the sidebar collapses to accessible lights rather than disappearing. Registered repositories remain in the sidebar even without terminals. Wait time begins at the verdict's main-process timestamp and survives repeated attention classifications. Opening does not clear Needs you; Done/Failed dim once seen. Typing replies through terminal input; **Not attention** records dismissal feedback through IPC and waits for main's state update. Failed feedback remains visible and can be retried.

Each leaf of the split tree owns one persistent xterm controller. Sidebar selection
is independent of presentation. `tiles.ts` implements immutable split, close,
placement, drop-to-split, whole-leaf swap/move, preset, geometry and restore operations. `tile-area.tsx` renders the
leaves as a flat, keyed sibling list positioned by tree rectangles, rather than
nesting React components under splits. Changing parent splits therefore never
remounts surviving leaves. Presets retain the focused session first, then occupied
leaves and empty leaves in tree order; maximize changes rectangles and opacity
without changing attachments. Each attached terminal retains its own PTY size.
Drag origins come only from local sidebar/title-bar gestures; external drag payloads
are never interpreted. Drop-time inventory and tree lookups reject stale origins
and targets. Edge drops obey the same depth and leaf limits as ordinary splits;
refusal leaves the original tree intact. Whole-leaf swaps and moves preserve the
keyed controllers and their terminal attachments.

`terminal-view-source.ts` creates passive controllers (no process launch) through
the board source. Workspace subscriptions belong to `BoardSource.connect`, not an
individual tile. View operations share a serialized queue and a terminal ownership
map: transferring an already-visible session hides its old controller before its
new one opens it. Disposing a detached controller cannot detach another tile's
current attachment. Within each controller, switching still serializes detach,
drain, reset, fit and attach. Settings detaches views without destroying their
controllers. Hidden terminals keep consuming output in the host.

Versioned `foom.tiles.v1` localStorage metadata stores the tree, ratios, leaf IDs,
focus and terminal assignments. Restore validates untrusted JSON with size, depth,
node-count and uniqueness bounds; ratios clamp to 15–85%. Split construction
shares the restore limits of 256 leaves and 64 levels, so every constructed tree
can be restored. Missing sessions are
pruned only after the source's first inventory completes, so an asynchronous load
cannot erase valid assignments. This data grants no process capabilities. Maximize
is not persisted. All terminal IPC remains ID-scoped and main-validated.

The board starts empty. Shells and agents launch from a repository or checkout’s menu; **New worktree** is a repository action. `npm run start:samples` explicitly builds the development sample board. Normal builds omit its data, and Forge rebuilds without the sample flag before packaging, including when invoked directly. The renderer `<dialog>` New worktree form selects a repository, branch and detected agent or shell, and shows versions and hook availability. Repository paths come from main’s registry or native directory picker; main chooses worktree destinations and executables.

Main's inventory watcher derives the common Git directory with `rev-parse`, validates
its canonical path, and watches metadata directories for `HEAD`, `packed-refs`,
`refs/heads` (including nested branch names) and linked `worktrees` metadata.
Directory watches survive Git's atomic file replacements. Events debounce for
300 ms with a one-second maximum wait, rebuild the directory subscriptions and
reuse `workspace:changed`. The maximum wait prevents continuous rename events
from deleted Windows directories from starving refresh. Rebuilds close old
handles before discovery to stop that event stream.
Repository removal and workspace shutdown close subscriptions and timers. Watch
errors close only the affected subscription and schedule a debounced refresh,
preserving healthy parent/sibling watches and pending rebuilds (Windows reports
an error when a watched directory is deleted). Errors alone do not retry watches.
Discovery/setup failures close the repository's subscriptions; window focus
refresh remains the fallback. Sidebar commands still re-read Git inventory and validate identity.
The live board source marks sessions whose checkout is absent or prunable without
changing their terminal state, capabilities or attachment.

## Renderer

**Today:** The board uses React 19 with TSX and reads one typed source through `useSyncExternalStore`. Each stable tile mounts one imperative terminal controller through the source adapter and disposes xterm and subscriptions on unmount. Terminal attachment and measurement remain in the controller to preserve attachment ordering. Board focus and pane selection are independent view state; hovering or focusing a row previews its tail without selecting it. The source also supplies path-identified repositories and their complete Git worktree inventory, including empty worktrees and the main checkout, plus validated main-process navigation commands. `sidebar-model.ts` computes stable pin/active/idle sections, filtering, hidden attention counts and roll-ups. `sidebar-view.tsx` renders the tree (or flattened session column below 720px). Sidebar focus and location selection do not attach a terminal; only the board's presentation callback requests that from the tile controller. `row-menu.tsx` portals menus to the document body, positions them from the action button's viewport rectangle, and owns keyboard navigation and dismissal. `sidebar-preferences.ts` validates versioned localStorage metadata for pins, expansion and terminal-ID names; this metadata grants no process or filesystem capabilities. Session metadata restores as exited rows across application exit; PTYs and screens are not restored. Activity batches write brightness directly to each light; a separate clock updates wait labels without React commits. Activity goes directly from IPC to light styles without changing the React row snapshot.

- **React 19 with TSX**, bundled by esbuild as a production build (`process.env.NODE_ENV` defined). No other UI framework, component kit, or CSS-in-JS. Styles are plain CSS using the tokens in `tokens.css`.
- **The renderer holds view state only.** Terminal, verdict, and worktree truth lives in main and arrives through `window.desktop`. Components don't call the bridge directly; they read from one board data-source interface shaped like the IPC contract. A sample source serves explicit development builds and tests; the app uses the live source.
- **High-frequency data bypasses React.** Activity arrives about 10 times a second for up to 10 terminals. A small subscriber writes each light's brightness to a CSS custom property on the light element; React re-renders only when structure or verdicts change. Terminal output never goes into React state.
- **xterm.js stays imperative.** One component owns the `Terminal` through a ref, creates it once, and keeps the attach, drain, reset, fit, snapshot, acknowledgement, and reply-suppression order described under Terminals.
- **Keyboard first.** Every board action works without a mouse. The Electron suite runs axe; serious or critical violations fail.
- **Linting:** `eslint-plugin-react-hooks` and `@eslint-react/eslint-plugin` on top of the existing type-aware rules. `eslint-plugin-react` and `eslint-plugin-jsx-a11y` don't support ESLint 10 and are not used.
- **Coverage and lint globs include `.tsx`.** A component outside them would silently skip the per-file thresholds or the renderer import restrictions.
- The CSP doesn't change. React needs no `eval`.

## Terminals

**Today:** `src/terminal-host/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/main/terminals/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/main/terminals/terminal-ipc.ts` grants the app window access only to the terminals it created. The renderer starts on an empty board, with no PTY until a launch is requested. Selecting a row places its session in an available tile or focuses its existing tile; Esc remains terminal input. Hiding or closing a tile, removing it through a preset, or entering Settings detaches the stream without stopping the shell. Placing another terminal in an empty tile or returning from Settings drains pending renderer writes, resets the display, fits the visible grid, and restores a fresh host snapshot before continuing the live stream. Input and resize events are suppressed while hidden or changing attachment. The manager and ID-scoped bridge support multiple concurrent sessions; the board consumes live worktree and verdict data. Closing the window requests application quit on every platform. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals; once a termination request succeeds, shutdown and retries only drain its native exit callback, because closing a ConPTY handle twice can crash the host. A throwing termination request remains retryable. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their process handles and exit subscriptions even after a terminal is removed from the board. Confirmed quit applies the same graceful termination and force-kill deadlines to these removed processes and waits for their pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Color state also belongs to the host: OSC 4 (palette) and 10/11/12 (foreground/background/cursor) queries, sets, and 104/110/111/112 resets use shared public-parser handlers. Only the host handler writes replies; the renderer handler applies colors without answering queries, including mixed set/query commands. Colors accept xterm-compatible hex and `rgb:` forms; unsupported names and malformed entries are ignored. The palette starts with xterm's 256 defaults, and foreground/background/cursor use the brand ink/bg/accent tokens. Main sends the resolved terminal palette on creation and validated, terminal-ID-scoped updates on changes. A terminal palette replacement resets application-set color overrides to the new defaults, as the existing browser theme replacement did. Parser barriers order these updates with output, and attachment snapshots include all color state, so changes while hidden appear on reattachment. Keyboard, paste, and mouse input are not filtered.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. The host supplements serialization with scrolling margins for both buffers and restores origin mode before positioning the active cursor. A pending right-edge wrap is recreated by replaying the cursor row with the pinned serializer after restoring margins, preserving cell styles and the current pen. Normal-buffer margins are restored before entering the alternate buffer, so leaving fullscreen mode retains normal scrolling. xterm 6 does not expose margins publicly; the snapshot helper checks its pinned internal buffer representation and rejects attachment if incompatible; pending-wrap restoration also checks the pinned addon’s internal row serializer. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The activity meter and last-lines buffer read from the same stream in the host. One 100 ms timer batches changed UTF-8 bytes-per-second rates for all terminals, exponentially smoothed with a 500 ms time constant. Rates decay to zero; the timer sleeps once all meters are quiet and zero. Quiet fires once per output burst after 500 ms for a trailing question, y/n, password, or Enter prompt, otherwise after 2 seconds. New output restarts the debounce; pending parser writes prevent quiet classification. A terminal silent from launch gets its first quiet event after 2 seconds. Exit and removal cancel the meter. These are timing hints, not attention verdicts. Main exposes quiet callbacks for the evaluator and forwards activity only for live owned terminals; view attachment does not affect measurement. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

The host uses Electron's `utilityProcess.fork`, not a Node child-process fork, so RunAsNode stays disabled. The native node-pty module remains unpacked from ASAR; Windows continues using the ConPTY DLL to avoid its Node helper path. After the native rebuild, packaging restores `conpty.dll` and `OpenConsole.exe` beside the rebuilt addon from node-pty’s matching architecture prebuild; node-gyp clears these postinstall files during rebuild. The three-platform CI matrix runs the packaged executable and tests its PTYs and detached snapshots with the disabled fuse verified.

Host requests and responses are validated at runtime and carry terminal IDs; request/reply pairs also carry a monotonic request number. Each attach has a main-generated view generation so late output from a previous view is ignored. Creation IDs are allocated in main. Unknown and duplicate IDs are rejected by the host. Renderer payloads cannot choose executables or working directories. A host exit or 10-second request timeout rejects pending operations, marks live terminals failed (`terminal:exit` code -1), and removes views. Exited terminals are not reclassified. A later create starts a fresh host; old IDs cannot address new sessions. The board displays terminal failures and offers Restart shell for its local shell. Confirmed quit requests native PTY shutdown in the host and reports failures without closing the window, allowing a retry. Shutdown RPC has a 15-second deadline to accommodate the native exit barriers. Final disposal waits for the utility process to exit, with a 12-second fallback for an unresponsive host.

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

Wheel input in an alternate buffer without mouse tracking is translated to Up/Down by the
renderer using xterm's public custom wheel handler. Application cursor mode selects SS3
(`ESC O A/B`); otherwise it uses CSI (`ESC [ A/B`). Pixel deltas accumulate into line steps;
line/page deltas are normalized, direction changes and attachment changes reset the remainder,
and one event sends at most 100 arrows. Normal-buffer scrolling, mouse reporting and Ctrl-wheel
retain xterm's handling. Input still passes through the selected terminal's ID-scoped bridge.

## IPC contract

Every channel checks the sender (the owning window, the main frame, `app://bundle/index.html`) and validates every payload at runtime. Every terminal-scoped message carries a terminal ID. Creation returns the new ID; it accepts only dimensions, with shell and working directory selected in main. The future worktree launch specification above remains a main-only capability.

| Channel | Direction | Payload |
|---|---|---|
| `board:command` | main → renderer | registry board actions (including tile presets and new worktree); preload rejects unknown commands, covered boards and modal launchers ignore them |
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
| `terminal:state` | main → renderer | `{ id, verdictId, state, reason, signal, confidence, timestamp }`; `verdictId` is null for user actions and unstored verdicts |
| `terminal:feedback` | renderer → main (invoke) | `id`, `verdictId` (null only for the current unstored verdict), `replied` / `dismissed` / `ignored` |
| `workspace:sidebar` | renderer → main (invoke) | → repositories with complete worktree inventories and the main-selected shell name |
| `workspace:sidebar-command` | renderer → main (invoke) | validated discriminated command: launch by registered repository/worktree and agent ID, stop/close/restart by owned terminal ID, remove linked worktree by validated path, or forget repository; main owns confirmations |
| `workspace:snapshot` | renderer → main (invoke) | → `{ repositories, terminals }`, each launched terminal with its agent, repository, worktree, branch, and latest state |
| `workspace:add-repository` | renderer → main (invoke) | none; main shows the directory picker → repository or null |
| `workspace:changed` | main → renderer | invalidates the workspace snapshot after launch or removal; no payload |
| `workspace:worktrees` | renderer → main (invoke) | added repository path → worktrees |
| `workspace:create-worktree` | renderer → main (invoke) | repository path, branch, `root` / `adjacent` → worktree |
| `workspace:start` | renderer → main (invoke) | `{ repository, branch, run, acknowledgeCodexNotifierReplacement }` → terminal ID or null on cancellation |
| `workspace:remove` | renderer → main (invoke) | terminal ID → boolean; main owns confirmation and dirty-file inspection |
| `agents:scan` | renderer → main (invoke) | `refresh` → `{ warning, agents }` (no PATH) |
| `agents:launch` | renderer → main (invoke) | `{ agent, repository, worktree, cols, rows, acknowledgeCodexNotifierReplacement? }` → `{ id, attention }` or null on cancellation |
| `setup:state` | renderer → main (invoke) | → `{ settings, keys, secureStorage, worktreeRoot }`; `keys` says only which providers have a stored key |
| `setup:save` | renderer → main (invoke) | settings patch (known fields only) → state; a model source must have passed `setup:check` |
| `setup:set-key` / `setup:remove-key` | renderer → main (invoke) | provider, key / provider → state; keys are never returned |
| `setup:check` | renderer → main (invoke) | check ID, inference source, time limit → `{ ok, failure?, message, verdict?, timings, request, reply, thinking }` |
| `setup:check-progress` | main → renderer | check ID, `{ kind: "step", event }` or `{ kind: "stream", thinking, reply }`; the preload validates the shape |
| `setup:check-cancel` | renderer → main (invoke) | check ID |
| `setup:models` | renderer → main (invoke) | local endpoint → `{ ok, models, server }` or `{ ok: false, failure, message }` |
| `setup:changed` | main → renderer | setup state after a successful settings save or zoom shortcut |

The renderer names repositories and worktrees only by paths main returned, and agents by ID. Main copies the known launch fields, checks the repository is registered and the checkout is authorized for that launch, and resolves the executable itself. A launched terminal belongs to the window like one it created.

## Confirmations

`main/confirmations/arming.ts` owns the click-again capability. A validated workspace
command begins one generation and retains its action/target in main while its
confirmation callback waits. Main emits `confirmation:armed` with a random UUID,
the canonical target and a consequence label. `confirmation:confirm` must carry
that exact nonce and target, arrive at least 300 ms after arming and no more than
three seconds later, and come from the board's top frame. A monotonic clock checks
the deadline independently of the expiry timer. Acceptance consumes the nonce
before resuming the operation; forged, mismatched, early and replayed answers do
not approve anything. `confirmation:cancel`, expiry, replacement, navigation and
renderer loss revoke pending arming. Generation checks reject delayed preparation
after cancellation. Existing workspace locks, identity/status rechecks and launch
validation remain in force while an operation awaits confirmation.

Workspace callbacks pass a typed confirmation kind, with an exhaustive label map;
labels never depend on matching user-facing prose. Click-again only prevents
misclicks: the board receives its nonce, so a compromised board can confirm after
300 ms. It is not a trusted user-consent boundary. Data-discard and permission-widening
actions must use the trusted window. Saving bypass defaults (#164/#167) uses this
main-only `TrustedDialog` API, preserves the full disclosure text and focuses
Cancel by default; it never uses click-again.

The board receives arm/end events through its source's `ConfirmationClient`.
Menus and launch buttons keep only view state; pointer exit, focus movement and
unmount disarm main. A trusted-dialog notification closes a menu and restores its
anchor before the separate window takes focus. Main-originated end events reset
armed labels without closing a menu on expiry. The legacy launch and removal IPC
entry points use the same gate; a renderer-supplied force or shared-checkout flag
cannot answer a confirmation.

`main/confirmations/trusted-dialog.ts` deliberately preloads one hidden, frameless
child window at startup. The extra renderer process lives for the app's lifetime:
this trades memory for immediate confirmation even when the board has crashed or
hung. Do not move its initialization into the board or lazy-load it on quit.
A separate in-memory session and `app://confirmation/confirmation.html` origin
isolate its renderer process from the board. The window covers the parent's bounds;
its page centers a raised card over an opaque theme-derived backdrop. It covers
rather than composites the board, avoiding black transparent windows on Linux
without a compositor. Native `modal` is false to avoid macOS sheet presentation;
main disables parent input, redirects parent focus to the child, follows parent
move/resize events while pending, then removes listeners and restores input and
focus on dismissal. Positioning remains subject to window-manager restrictions
(for example native Wayland). Quit approval does not need the board to render.
Main serializes requests, supplies the current
resolved theme and content, and gives each request a new ID. Its sandboxed preload
exposes only request rendering and answering; it buffers the request until the page
subscribes. `confirmation:answer` validates the exact window, top frame, URL,
request ID and boolean. Board frames, stale IDs and malformed answers are ignored.
Closing, renderer failure and disposal cancel. A failed window is recreated for
the next request. This main-only content API also serves merged-worktree cleanup and can later serve #119.

The trusted session denies permissions and navigation, blocks new windows and
webviews, and serves only its page, script, styles and bundled fonts. Context
isolation and sandboxing stay enabled; Node integration stays disabled. Its CSP
matches the board's restrictions. React renders titles, filenames and session
metadata as text. The page traps focus between Cancel and the confirming button,
handles Escape, focuses Cancel for every request, and respects reduced motion.
Quit inventories live terminals in main, including shells outside the workspace
snapshot; it does not query the board. Renderer loss immediately releases a pending terminal view flush; a crashed board
is not asked to flush again until it loads. The existing deadline still allows
shutdown when a live board is unresponsive.

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom creates worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added. Listing includes all Git worktrees, including external ones; confirmed removal supports linked worktrees created by any tool.

**Today:** `src/main/workspace/worktrees.ts` provides the main-process `WorktreeService`, independently of the UI and IPC. Add a repository before listing or modifying its worktrees. It canonicalizes repository paths, lists NUL-delimited Git records, checks out existing branches or creates new ones, and delegates dirty/locked removal checks to Git. Force allows dirty removal but does not override locks or target validation. Direct service removal still requires ownership unless main supplies a worktree identity captured for explicit confirmation. Adjacent trees use `<repo>-<branch>` (branch slashes create subdirectories). Creation checks resolved parent directories against the allowed root and rejects existing destinations. Ownership records the device, inode, and birth time of the worktree directory, its `.git` file, and its resolved Git metadata directory. Listing and removal revalidate that identity; missing or replaced entries permanently invalidate ownership, including for forced removal. Removal rejects redirected paths. `removeRepository` forgets a repository, but refuses while Foom owns worktrees in it, so their ownership records aren't dropped. These checks do not provide isolation against another local process concurrently replacing filesystem entries.

At startup, main opens the service with `WorktreeService.open(app.getPath("userData"))`. Repository registration and ownership are stored in versioned `worktrees.json` using a private temporary file and atomic rename; writes are serialized within the service. Startup validates the untrusted state, rechecks repository paths, allowed roots, Git membership, and filesystem identity, and drops stale or redirected entries. Corrupt or unsupported state grants no ownership and does not block startup. Registration, creation, removal, and ownership invalidation await persistence; write failures are reported to the caller. The synchronous constructor remains available for an explicitly in-memory service. The renderer reaches it through the `workspace:*` channels. `workspace:start` validates the branch in main and creates or reuses an owned worktree at the configured location. A failed launch leaves the owned worktree available for retry with the same branch. `workspace:remove` takes a terminal ID; sidebar removal takes a registered repository and worktree path. Main validates Git membership, canonical paths and locks, excludes the main checkout (including when a linked checkout is registered as the repository), captures filesystem identity, and requests click-again for a clean checkout or a trusted dialog naming uncommitted changes from NUL-delimited Git status. Cancellation preserves the terminal and files. Main rechecks identity and status after confirmation, stops the worktree’s terminals and waits for native exit, then rechecks identity and status again before removing the directory; the branch is kept. Changed files require a fresh review. A refusal retains the exited terminal screen and capability for inspection, restart, or another removal attempt. Capabilities are revoked only after successful removal. Dirty removal is authorized only by that confirmation, never by a renderer force flag. Failed removal leaves the row available for retry. Operations on the same repository/branch are serialized. State assumes a single application service writer; it is not a security boundary against a local process able to forge the entire state file. External removal does not adopt the worktree. Worktrees are never adopted just because they appear under the configured root. Repositories sharing a basename share a destination namespace; a collision fails without overwriting the existing directory.

Sidebar inventory never awaits remote merge checks. Main caches eligibility for
one minute, starts a background scan for a new local worktree/session inventory
or an expired result, and emits a workspace change when it finishes. Matching
in-flight scans are shared; superseded scans, removed repositories and disposed
workspaces cannot publish late results. Git status reads use `--no-optional-locks`
so index refreshes cannot race deletion of per-worktree metadata. Cleanup still
fetches afresh.

Merged cleanup uses the same removal sequence with an additional main-owned
revalidation callback. Candidate path, filesystem identity, branch and commit
are captured before the trusted dialog. Both revalidation passes check ownership,
session eligibility, clean status and `merge-tree` containment against a freshly
fetched default commit. A failed post-confirmation fetch prevents every removal.
Local branch removal uses `update-ref --no-deref -d <ref> <expected-commit>` for atomic
compare-and-delete, providing forced deletion for squash merges without the
check/delete race of `branch -D`. It refuses branches checked out elsewhere.
As with ordinary removal, this does not isolate concurrent filesystem mutations
by external local processes. Fetches disable interactive credential prompts and
Git commands have a 30-second process deadline.

## Agent discovery and launch

**Today:** `src/main/agents/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Stable Claude Code releases at or above 2.1.284 and Codex releases at or above 0.155.1 enable hooks only when help includes the complete `--settings` or `-c` flag respectively. There is no maximum version. Unparseable versions, prerelease/custom suffixes, missing flags, failed probes, Antigravity, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Codex receives `--no-alt-screen` only when its help lists the complete flag, independently of hook support or the hooks setting. Inline output stays in normal scrollback for wheel scrolling, peek and evaluator tails; a failed or unsupported probe leaves launch arguments unchanged. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. Legacy agent launch requires ownership. Sidebar launch authorizes any selected checkout in the registered repository, including external and detached worktrees, without adopting it. Main captures the canonical checkout identity before confirmations or agent scanning; the agent service revalidates it after hook preparation, immediately before spawning. Shells revalidate immediately before spawning too. Validation checks current Git membership and common Git directory, rejects redirected, bare, locked and prunable worktrees, and detects replacement during confirmation. The identity is a main-only launch capability; IPC never copies it from renderer requests. All checkouts permit multiple sessions. Sidebar, New worktree and legacy agent launch paths use a main-owned confirmation before launching an agent alongside any running agent in that checkout. Shells and exited agents do not trigger the warning. Cancellation creates no session. Main grants the shared-launch capability only after checking for active agents under the launch lock; renderer-supplied flags cannot bypass confirmation. Launch and removal locks cover confirmation and spawning. Repository registration is reserved before any asynchronous launch or worktree creation, including legacy launch IPC. Repository removal in both the sidebar and Settings refuses pending operations and tracked sessions; its exclusive guard spans confirmation and deregistration and blocks new launches until it settles. Each session retains independent hooks and verdicts. Read-only review remains in #114.

`setHooksEnabled(false)` disables hook attachment for subsequent launches. A main-process integration supplies a fresh `AgentHooks` binding per launch, with a Claude stdin adapter command, a Codex argv adapter command, session credentials, and a cleanup callback. Claude settings attach prompt, tool, Stop, PermissionRequest, and Notification observer hooks as inline JSON in `--settings`; Codex 0.161+ receives stable lifecycle definitions and keeps `-c notify=[...]` until completion hooks are observed working. Older supported Codex versions receive notify only. No settings files are created in the user's HOME or workspace. Codex notifier fallback requires `acknowledgeCodexNotifierReplacement` after the UI discloses that the user's notifier is replaced for this invocation. Confirmed lifecycle hooks remove that override and disclosure on later launches. `release(terminalId)` must be called on exit/kill to revoke credentials and free the worktree; `dispose()` releases all bindings during shutdown after terminals are stopped. Spawn failures clean up immediately.

`src/main/workspace/workspace.ts` connects these services in main. It scans once and reuses the result until a refresh, starts the hook receiver on the first launch that attaches hooks, and closes it after terminals stop on quit. `src/main/agents/hook-launch.ts` writes each launch's adapter script to its own `mkdtemp` directory (mode 0700), registers receiver credentials under a random key, and maps that key to the terminal ID once it exists (`AgentHooks.bind`). Exit, kill, and shutdown release the launch: credentials are revoked, the directory is deleted, and the worktree is free again. Antigravity launches without hooks. Preflight's settings reach the workspace through `configure`: the hooks setting calls `setHooksEnabled`, and launching an agent that preflight turned off is refused. Launched agents and worktree shells appear immediately in stable repository groups on the board. The New worktree form discloses Codex notifier replacement before the first hooked Codex launch; main persists `codexNotifierAcknowledged` in settings and reuses it for later launches.

## Control plane

**Foundation implemented in #152.** `main/control/` owns the service, launch grants,
versioned HTTP adapter, private discovery, operation records and audit storage.
The workspace starts it lazily on the first agent launch, even when hooks are off.
All current launches receive the immutable `agent` role. The exposed methods
are `whoami`, `sessions`, `session_state` and actor-scoped `operation_status`
(the latter requires a main-issued orchestrator grant, which has no user launch path yet). Unknown methods, role/force
flags and unknown fields fail closed. No orchestration mutations are exposed.

`POST /control/v1` requires `Authorization: Bearer <token>` and a JSON envelope
`{ version: 1, instanceId, method, params }`. Identity takes empty params; operation
lookup takes exactly one of `operationId` or `idempotencyKey`. Every request checks
the live grant and app-instance ID, including after receiving its bounded body.
Responses contain `{ result }` or a fixed `{ error }` code. The adapter enforces
8 KiB headers, 64 KiB bodies, 32 connections and four outstanding requests per
grant, with five-second transport deadlines. Policy and role checks stay in the service.

Launch environments carry `FOOM_CONTROL_URL`, `FOOM_CONTROL_TOKEN` and
`FOOM_CONTROL_INSTANCE`; `FOOM_SESSION` correlates with hooks when attached.
Control tokens remain unavailable until main binds the terminal ID. The host
scrubs inherited `FOOM_*` and `CLAUDECODE` on every spawn before adding main's
fresh launch environment. Early exit before launch completion also revokes grants.

The profile's `control/` directory is private (0700/0600 on Unix; current-user
DACL on Windows). Discovery contains only version, endpoint and instance ID;
clients validate ownership, permissions, file type and the literal loopback endpoint.
Clean shutdown removes discovery; the instance check rejects stale metadata.
Windows ACL setup/verification uses a fixed PowerShell program calling .NET ACL
APIs directly, with paths passed as environment data. It does not autoload modules
from an inherited PowerShell 7 `PSModulePath`; failure refuses control initialization.

Operation intent and the hashed actor-scoped idempotency mapping are synced before
returning a new reservation. Only `created: true` authorizes a future handler to
start work; duplicates return the existing record with `created: false`. This is
a main-only distinction, omitted from public operation lookup. At 4096 records,
new reservations refuse rather than evicting deduplication state. Canonical action
input is hashed, never stored as prompt or reply text. A main-only confirmation
closure binds actor, operation and a caller-rechecked target/dirty-state identity;
it cannot be approved by a transport flag. Revocation cancels pending confirmations
and marks running operations indeterminate. Audit failure refuses the reservation.

Separate audit files rotate before 10 MiB, retain at most five files and prune
files older than 30 days on startup and writes; clearing them preserves live operation records.
Recovery preserves known outcomes and records interrupted operations as
indeterminate, then retires old-generation deduplication files. It never restores
authority or replays actions. Mutation handlers, trusted dialog wiring, visibility
and takeover must ship together in later issues.

**Read-only MCP implemented in #153.** `POST /mcp` uses the same authentication,
body/header/connection limits and service authorization as the versioned endpoint.
It negotiates MCP 2025-03-26, 2025-06-18 or 2025-11-25, returns JSON responses and
binds one random protocol session to each live principal. Reinitializing replaces
that principal's old protocol session; DELETE terminates it. GET authenticates and
validates the session before returning 405 (no SSE stream). Revocation is rechecked
at dispatch. Only `whoami`, `sessions` and `session_state` are listed or callable
through MCP; hidden orchestration methods are refused even by direct invocation.

The service reads a main-owned workspace snapshot, never a terminal tail. Sessions
are repository-scoped, paginated by the preceding terminal ID and limited to 100
rows. Foreign/missing IDs and cursors return the same not-found response. Names are
redacted before a 160-character bound; oversized names are suppressed. Locations
are opaque path hashes rather than raw paths. Results carry fixed state reasons,
opaque revisions derived from launch, execution and verdict state, and conservative
`unknown` attention provenance for Needs you. Current execution overrides stale
evaluator verdicts, as on the board. Display names are branch/worktree labels, not
renderer-only custom names.
Whoami returns the same opaque location identities and bounded worktree label.

Agent discovery reports MCP support independently of hooks. Verified exact CLI
releases receive a random server name: Claude gets a private temporary MCP JSON file
with environment expansion, Codex gets an additive `-c` server table referencing the
bearer environment variable. Tokens never enter argv or files. Exit, early exit,
spawn/attachment failure and shutdown dispose attachments and revoke credentials.
Managed policy may refuse attachment in the client; no settings are weakened.
See the [real-client probe record](orchestration.md#read-only-mcp-implementation-verification-153).

**Remaining target from #119.** See [orchestration research](orchestration.md) for
per-agent evidence and follow-ups #154–#157. The packaged console helper, pairing
and orchestration remain future work. Existing terminal ownership, utility-host
parsing and renderer boundaries remain in force.

Main owns one control service over the workspace, agent, evaluator and terminal-host
services. A loopback Streamable HTTP MCP adapter and a versioned HTTP CLI adapter
call it; neither adapter owns policy. A separate console executable built from
TypeScript provides `foom`, without enabling Electron's RunAsNode fuse or requiring
system Node. Per-launch Claude MCP config and Codex `-c` overrides attach the server;
Antigravity receives CLI guidance and a process-local PATH addition until per-launch
MCP support is verified. No global agent or repository configuration is written.

A separate 256-bit control token shares the hook launch's lifecycle but never its
secret or authority. Main stores a digest mapped to role, canonical repository,
terminal, parent and generation. Caller-supplied roles and MCP session IDs grant
nothing. Authenticate initialization and every subsequent request, bind protocol
sessions to principals, validate every payload and target at runtime, and recheck
revocation before effects. Reject browser origins and unexpected Host values; bind
only `127.0.0.1` on an ephemeral port. Never expose tokens through renderer IPC,
logs, argv or tool results. Child launches scrub inherited credentials and receive
fresh read-only tokens. Exit, failed launch and shutdown revoke grants.

Ordinary agents see `sessions`, `session_state` and `whoami` for their repository,
without terminal contents. Only a main-created orchestrator principal sees
`create_worktree`, `launch`, `tail`, `reply`, `stop`, `remove_worktree`, `wait_for`
and `operation_status`.
Enforce authorization again in the service even for hidden tools. The repository
menu reserves one orchestrator slot atomically; reserve at most four child slots,
including starting/stopping children. Children run only in new worktrees created by
that orchestrator. No child can gain orchestration through the API. #84 config-only
roles and #67 remote access are separate capabilities, not implicit extensions.

Existing main-owned git validation, argument-array execution, launch/removal locks
and confirmations are reused. Removal always asks the human, including clean
worktrees; no API force flag bypasses identity or dirty-state checks. Mutations use
idempotency keys and bounded operation records. MCP `operation_status` and CLI
`foom operation-status` query by operation ID or idempotency key within the same
actor generation and repository, including when the original response was lost.
Records distinguish pending confirmation, running, succeeded, failed, declined,
cancelled and indeterminate outcomes; lookup never replays a mutation. Retain
records and deduplication mappings for the grant's lifetime, refusing new mutations
at the storage limit. Parent exit cancels pending actions
but leaves children visible and running for human control. A replacement parent
does not inherit them. Metadata-only `wait_for` is bounded to 30 seconds. CLI access
outside Foom-launched agents requires explicit, expiring in-app pairing; private
discovery files contain endpoint metadata, never a reusable human credential.
Same-OS-user processes are not isolated by these bearer capabilities or worktrees.

Agent output, hooks, model verdicts and names are untrusted data. `tail` authorizes
only an orchestrator's children, reads the host screen, applies evaluator redaction,
and returns at most 40 lines and 16 KiB with revision and untrusted-data metadata.
No files, diffs, transcripts, keystrokes or raw hook payloads are read for the API.
Printed content may include them; the product privacy wording describes the new
path to the orchestrator's model provider and redaction's limits.

The reply gate adds question/permission/credential/unknown attention provenance;
`needs_input` or confidence alone is insufficient. Current PTY adapters only permit
human-reviewed proposals for question verdicts. Permission, credential and unknown
states reject proposals. Automatic delivery remains disabled until an adapter can
prove question-specific routing; no combination of absent hooks, text patterns and
a main-process write lock proves that a PTY is not displaying a new approval prompt.
Proposals bind to actor generation, child, verdict and output/input revisions;
output, input, permission signals, exit and takeover invalidate them. Delivery is
single-use, bounded and rate-limited, never automatically retried after ambiguity.
The human can suspend replies immediately. Agent approval policies stay intact.

A separate bounded private action log records actor, target, operation and outcome,
with redacted reply proposals but no tails, credentials or initial prompts. Persist
intent before automated mutations; audit failure refuses automation while human
terminal control remains available. Ship basic action visibility and takeover with
mutations, then nest children under their orchestrator in the board source and add
the full log view. Components retain view state only; hidden PTYs keep running.

## Settings and setup

**Today:** First run is the preflight countdown from [product](product.md#first-run). `src/main/setup/settings.ts` stores versioned `settings.json` in user data: whether setup is complete, the hooks setting, which agents are turned on, the default worktree location, and the inference source. Writes are atomic (private temporary file, then rename) and serialized; a failed write leaves the settings unchanged. Missing, corrupt or unsupported files start from defaults, so preflight runs again. Every patch, from IPC or disk, is validated field by field and unknown fields are rejected.

`src/main/setup/setup.ts` applies the settings to the running app at startup and on each save, owns the key store and the app's model evaluator, and runs Run check. A model source can be saved only if it is already saved or passed a check in this session; storing or removing a provider's key invalidates that provider's checks. A cloud check without a stored key fails at its first step. The Evaluator step asks a local endpoint for its models as the URL is typed, offers them as suggestions for the model field, and says when the named model isn't among them.

Appearance lives in Settings and the preflight rail through the same `AppearanceControls` component and applies at once. `colorMode` (system, light or dark) sets `nativeTheme.themeSource` for Eclipse; fixed interface themes supply their own base. Main applies the source before the window is created at startup, so the CSS (`prefers-color-scheme`), the window background and terminals using Follow interface all follow it; changing the resolved terminal palette resets colors a program set in the terminal; fixed terminal themes ignore interface changes. `interfaceScale` (80–150% in steps of 10) is Chromium zoom: the window starts with it as `zoomFactor` and later changes use `setZoomFactor`. The window resizes with it in both directions (`src/main/window/window-scale.ts`): main remembers the window's size at 100% and sets the window to that size times the scale, capped to the display's usable area and moved back on screen if needed, so zooming in and back out restores the same size. A resize by the user sets a new size at 100%. On first launch, the window uses 60% of the primary display’s usable width and height. After a successful quit, main saves the normal window dimensions in `window-size.json` in user data and restores them on the next launch, clamped to the current display and minimum. Maximized or full-screen exits save the normal dimensions. Missing or invalid saved dimensions use the first-launch size. The minimum size (900 × 640 at 100%) scales too. Maximized and full-screen windows keep their size. Tiling window managers may ignore the resize; zoom still applies. Main handles the zoom keys before the terminal sees them: ⌘ =, − and 0 on macOS, and Ctrl+Shift+= / Ctrl+Shift+− and Ctrl+0 elsewhere, because plain Ctrl+− is readline's undo. A shortcut saves the new scale and sends `setup:changed` so preflight's controls follow. `terminalFontSize` is a separate validated integer setting (10–32 CSS pixels, default 14). Each mounted terminal controller reads it before its initial attachment, subscribes to `setup:changed`, and updates xterm options. Visible attachments refit and send an ID-scoped resize; hidden views use the new size on their next attachment. Disposal removes the subscription.

Interface colors are independently stored as `interfaceTheme`: `follow` (default),
a built-in ID, or a version 1 portable object with `name`, `base` and `colors`.
Follow retains existing `colorMode` preferences and uses Eclipse Light/Dark; the
Themes picker’s System choice sets both Follow and System. A `colorMode`-only save
returns to Follow, while changing zoom or terminal settings retains the theme.
Fixed themes override `colorMode` with their declared light/dark base for
`nativeTheme.themeSource`. Main uses the palette's exact background both at startup
and after saves, including switches between themes with the same base.

`shared/interface-themes.ts` validates exact keys, six-digit opaque hex colors,
brand hue and color-distance rules, contrast and the declared base. Built-in palettes
pass the same gate used for user data. The object covers every color token in
`styles/tokens.css`; fonts stay fixed and bundled. There are no CSS filenames,
imports, URLs or arbitrary CSS values in theme data. See [brand](brand.md#interface-themes)
for the numerical invariants. A future Foom-config loader can supply the same
object through the existing settings validation; this change does not load files.

`renderer/ui/interface-theme.ts` subscribes to the setup source and system media
changes, sets color tokens on the root element and removes its listeners on unmount.
It ignores stale initial reads after a newer save or disposal. CSS keeps the original
Eclipse tokens as a startup/failure fallback. Settings → Themes uses token-scoped
previews of every board status, including the halo, square failure light and labels.
It neither renders terminal output nor subscribes to activity. The CSP and preload
surface are unchanged.

Terminal colors are independently stored as `terminalTheme`: `follow` (default), a built-in ID (`foom-light`, `foom-dark`, `solarized-light`, `solarized-dark`, `dracula`), or a portable palette object for future user configuration files. The object has exactly foreground, background, cursor, selectionBackground and the 16 named ANSI colors (black through brightWhite), each a six-digit `#RRGGBB` color. Main validates every key and value; the host protocol validates palettes again. Both processes and the renderer share the same resolver. Palette replacement resets OSC overrides; OSC 104 restores the active theme's ANSI defaults. Settings previews all 16 colors, bold, dim and selection; board peek uses the resolved foreground/background. Third-party palette licenses are bundled in the packaged notices.

The renderer shows preflight until setup is complete; subsequent configuration lives in Settings. The default worktree location applies to the New worktree flow.

Settings opens beside the persistent sidebar with the board button or ⌘/Ctrl+,.
Main reserves the shortcut through the existing validated `board:command` channel.
There is still one window and one trusted IPC sender. The board keeps its terminal
controllers mounted but detaches and hides their views while Settings is open. Esc
restores sidebar row focus after the terminal has reattached; selecting a sidebar
terminal closes Settings. The shared setup coordinator renders the same Agents,
Repositories, Worktrees, Evaluator and Appearance controls in both paths, with guided
navigation only in preflight. Settings adds Terminal font size, interface Themes and
Sound controls. Successful `setup:save` calls publish `setup:changed` to keep live
consumers synchronized. Repository selection changes save immediately in Settings,
with controls disabled during the write and refused selections restored to the
registered repositories. Scans in Settings start from existing registrations;
preflight continues to suggest recent repositories and save when leaving the step.

Repositories come from the user's code folder (one, saved as `codeFolder`). Main offers common folders under home (`~/code`, `~/src`, `~/projects` and similar) that hold repositories, each with a count from a quick scan (the same walk, stopped at 5,000 folders), or shows the native picker; then `src/main/setup/code-scan.ts` walks the folder breadth first with live progress: at most three levels and 20,000 folders (reporting when it stopped early), never following symbolic links, skipping hidden folders, `node_modules`, `Library`, `AppData`, `Applications` and Foom's worktree folder, stopping at each repository, and skipping `.git` files (linked worktrees and submodules). Last activity comes from the modification times of `.git/logs/HEAD`, `.git/index` and `.git/HEAD`, without running git; activity in the last 30 days preselects a repository, as does already being added. The renderer may add or remove only paths from main's latest scan; leaving the step applies the selection, and a refusal (for example a repository with Foom-made worktrees) keeps the user on the step with the reason. `npm run start:fresh` runs the app with a throwaway profile to test first run.

## Agent signals

Foom attaches its hooks per launch and never edits the user's own config:

- Claude Code: `claude --settings <inline-json>` with Stop, PermissionRequest, and Notification hooks; JSON arrives on stdin. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
- Codex: `codex -c notify=[...]`; JSON arrives as an argument. The external callback reports turn completion, not approval requests, and replaces the effective notify command for that launch.
- Antigravity: output evaluator only for now. Hooks and headless mode exist, but an invocation-scoped hook attachment was not verified.

See [agent research](agents.md) for versions, payloads, local probes, sources, and remaining verification. Completion events trigger classification; they do not unconditionally set Done. Echo-off alone is not a password signal: all three tested CLIs disabled echo at startup.

**Today:** `src/main/agents/hook-receiver.ts` provides an independently usable main-process service. `HookReceiver.listen(onSignal)` binds only `127.0.0.1` on an OS-assigned port. `register(terminalId, agent)` returns fresh `FOOM_SESSION`, `FOOM_TOKEN`, and `FOOM_HOOK_URL` environment additions and an idempotent `revoke()` capability. The launcher must revoke on launch failure, terminal exit, or removal; application shutdown must call `close()`. The workspace maps receiver keys back to terminal IDs before signals reach the evaluator. The app doesn't start a listener until a launch needs one.

Requests POST JSON to `/hooks`, with `X-Foom-Session` and `Authorization` containing the launch session and raw token. Tokens contain 256 random bits; comparison uses constant-time equality of fixed-length SHA-256 digests, including for unknown sessions. The listener rejects browser origins and nonliteral Host headers, limits headers to 8 KiB and bodies to 64 KiB (including chunked requests), caps connections, and times out stalled requests. It checks revocation again before delivery. Unknown/revoked sessions and incorrect tokens all receive 401. Unsupported events are acknowledged without changing state; malformed events receive 400.

The first supported event pins the agent session/thread ID for that launch. Subsequent events must match; Codex also requires a turn ID. Only `{ terminalId, action, signal, conversationId }` escapes the receiver. The validated conversation ID is saved locally by Workspace and is not forwarded into evaluation. PermissionRequest and `permission_prompt` produce `needs_input`; Stop, `idle_prompt`, and Codex `agent-turn-complete` produce `classify`. No event directly sets Done. Agent text, paths, tool inputs, and Codex `input-messages` are discarded, never logged, executed, or forwarded to the evaluator. Classification still uses only the redacted terminal tail.

The hook command cannot run Node from the packaged app because the RunAsNode fuse is disabled. `src/main/agents/hook-adapters.ts` supplies distinct observer scripts for Claude stdin and Codex's final JSON argument: POSIX `sh` plus `curl`, and Windows PowerShell plus `Invoke-WebRequest`. The launcher writes the returned source to a private launch directory, invokes POSIX files with `sh` or Windows files with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, supplies the launch environment, and removes the files afterward. On Windows it first runs the generated script in probe mode; a missing interpreter or enforced policy that blocks the script rejects launch with an error and cleans up the script. The execution policy applies only to that PowerShell invocation; user and machine settings are unchanged. Codex's configured notify argument array must end at the script's configured arguments so the CLI can append its JSON argument. Payloads remain data throughout; scripts emit no output or approval decisions, have a three-second HTTP timeout, and exit successfully even when the receiver is unavailable. Per-launch settings and notify attachment, tool availability checks, and notifier-replacement disclosure belong to #12.

## Saved conversations

Main writes ordered, atomic replacements of private `sessions.json` in the active
profile. It stores terminal ID, agent, registered repository, worktree, branch and
validated conversation ID only. Loading validates bounded records and rejects
malformed IDs, paths, agents and duplicate terminal IDs. Unregistered repositories
are omitted. Restored records grant sidebar actions only, never a host capability;
views do not attach or request tails until a successful explicit relaunch.

Resume and New conversation retain the terminal ID. Main drains the previous
terminal's evaluation queue, removes its exited host screen and launches a fresh
PTY under that ID after the usual worktree/confirmation checks. An existing live
host ID cannot be reused. The renderer hides/releases the old view before the
command; the ID-scoped availability event carries an optional reset marker on
creation so controllers discard old exit state. A launch version in the board
snapshot reattaches surviving tile controllers without remounting xterm. Failed launches leave the saved
record dormant and retryable. Close deletes the record, without touching Git.
All terminal-ID sidebar commands validate the sender and ownership in either the
host or main's restored inventory. Copy uses main's clipboard capability and the
stored ID, never caller-provided clipboard text. Shutdown drains pending writes.

## Evaluator pipeline

`quiet` or parsed metadata event → process exit → permission hook → per-agent title/progress/screen rules → shell facts and generic text patterns → model (if configured) → verdict `{ state, reason, signal, confidence }` → `terminal:state` and the verdict log.

States: `needs_input`, `done`, `failed`, `quiet_ok`, `working`.

**Today:** `src/main/evaluator/evaluator.ts` supplies the pure main-process `evaluateRules` classifier,
and `src/main/evaluator/verdict-log.ts` supplies `VerdictLog`. `Workspace` runs them for every terminal
the window owns, including the shell: on quiet, on a hook signal, and on exit. Each
evaluation reads the last 40 host lines and runs in order per terminal, so a slow one
can't overwrite a newer verdict; a failure is logged and the next one still runs. The
result goes out on `terminal:state` and into the verdict log. The verdict log classifies
through `Setup`, which holds the app's one `ModelEvaluator` for the saved source (rules
only by default) and replaces it when preflight saves a new source. Results from a
replaced evaluator still in flight are published, not discarded. See
[inference service usage and benchmarking](inference.md).

A permission hook (`needs_input`) stays in force across later quiet evaluations.
For agents, typing records reply feedback but does not establish resumed execution;
neither typing nor dismissal overrides lifecycle evidence. Dismissal still clears the
attention indicator and reminders; it does not start Working audio. A later working hook
releases an explicit permission blocker. Opening a terminal is not a reply.
Shell reply/dismissal behavior remains separate: replies mark Working and dismissal
marks Quiet. Terminal-generated reports are filtered by `terminal-reports.ts`.
New lifecycle transitions invalidate asynchronous classifications. Host output
invalidates pending screen classifications but never establishes agent execution.

A verdict is published even if the log can't store it. It then has a null
`verdictId`: a reply still clears it without recording anything, and
`terminal:feedback` accepts null only for the terminal's current unstored verdict.

A known exit is final, including when an older permission hook arrives afterward.
For a live terminal, a matching permission hook takes precedence over an observed
shell-prompt return and text patterns. Completion hooks only request classification.
Prompt return must be supplied as a process fact, never inferred from `$` or `>` in
output. Echo-off is not an independent input. Text rules inspect only the last
nonblank line of the last 40 host-provided plain-text lines, recognize explicit
confirmation/password/Enter prompts, test-runner failure summaries, and listening
server URLs. Other quiet tails remain `working` with low confidence. Historical
prompts followed by more output do not request attention.

`VerdictLog.evaluate` (or `classify` then `commit`) appends a timestamped verdict with a unique ID and terminal ID
to `verdicts.jsonl` in the supplied user-data directory. `recordAction` records the
next explicit `replied`, `dismissed`, or `ignored` action against that verdict ID;
dismissal includes `not_attention` feedback. Opening a view is not an action.
Writes are serialized and synced before resolving, and new files have mode 0600.
Failures reject and can be retried. The log contains fixed rule reasons and metadata,
never tails, agent payloads, or keystrokes. The integration must handle write errors
without blocking terminal operation. One service instance owns the file; feedback
can address only verdicts issued by that instance, and historical records remain
available on disk across restart. Only the latest committed verdict per terminal
accepts feedback; superseded and removed terminals’ entries are released. Workspace
keeps the current verdict and ID when classification repeats its state and signal,
including across transient Checking, while failed writes remain retryable. No automatic
inference of ignored actions or log retention policy is implemented yet. The reusable fixture suite in
`tests/fixtures/evaluator.ts` contains sanitized, representative terminal tails.

Model calls get the last 40 lines, redacted, with a timeout. One-shot agent evaluators must not load repository instructions or use file, command, MCP, or other external tools to expand that input; a read-only sandbox alone does not enforce this boundary. Use another inference source or rules only when isolation cannot be enforced. A failure falls back to rules-only and never blocks the light.

The model service has a time limit set in preflight (1–30 seconds, five by default)
and two concurrent calls by default (hard maximum four). Saturated calls use rules
immediately; there is no waiting queue or retry. A timed-out transport keeps its slot
until it settles so even a transport that ignores cancellation cannot exceed the limit.

Run check (`src/main/evaluator/inference-probe.ts`) is separate from classification and shows its
work. It runs one stage at a time and reports each stage to the renderer as it starts
and ends: reading the key (cloud), a TCP connection to the endpoint, then for local
endpoints identifying the server (`/api/version` for Ollama), finding the model in
`/models`, and whether Ollama already has it in memory (`/api/ps`). It then sends the
fixed sample with streaming on, reports thinking chunks and reply text as they arrive
(at most ten updates a second), and parses the verdict. It has the same time limit,
and a timeout names the stage that was running. Starting a new check or editing the
source cancels the one in progress. Leaving the Evaluator step also cancels its check
and ignores any late result, so it cannot replace a source chosen afterward.

Failures are reported in Foom's own words from a fixed set: connection refused,
unreachable, DNS, TLS, connect timeout, missing key, rejected key (401/403), model not
found (404, or absent from the model list, with `ollama pull` for Ollama), no quota
left, rate limit (429), server error (5xx), other HTTP status, timeout, truncated or
refused reply, and a reply that isn't the requested JSON. Node error codes and HTTP
status numbers may be shown. From a provider's error body, Run check reads only the
machine-readable code (`error.code`, `error.type` or `error.status`) and uses it only
if it is on a fixed list, such as OpenAI's `insufficient_quota`, which shares 429
with rate limits. The code picks a message Foom wrote; the body's text is never shown
or logged. Because the check sends only
the fixed sample, its Details may show the exact request (URL, parameters and prompt,
never credentials) and the model's raw reply as inert text, capped at 4,096
characters. Classification of real terminals shows neither.
Model JSON must contain exactly a known state and finite confidence in [0, 1]. It may
arrive wrapped in one Markdown code fence, as chat models often send it; nothing else
may surround it.
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
key-read API; preflight can save, replace or remove a key through `setup:set-key` and
`setup:remove-key`, and learns only whether one is stored. Redaction removes likely labelled
credentials, bearer/API tokens, JWTs, URL credentials, and private-key blocks before
selecting the last 40 physical lines. Already-truncated host tails with an unmatched private-key END marker lose the entire preceding fragment; leading PEM-sized base64 lines are also redacted when both markers are absent. Line boundaries are preserved. Oversized input fails back to rules. Redaction
is heuristic and cannot identify every unlabelled secret.

### Shell lifecycle status

Explicit shell launches opt into invocation-scoped integration. Bash 4.4+ starts with
an isolated startup file that loads `/etc/profile` and the first readable user login
profile, then installs PS0 and prepends a status-preserving PROMPT_COMMAND callback
(the user's existing callbacks and PS0 are retained). This is an interactive shell;
Bash's `login_shell` option is not set. No user configuration files are modified.
The utility host removes the private startup directory on spawn failure or PTY exit.
Older Bash and other shells retain output, hook and process-exit detection.

The headless parser accepts OSC 633 lifecycle markers only with that launch's random
token. Terminal-ID-scoped, runtime-validated events report command start and prompt
return with a bounded exit status. Initial prompt means Ready (Quiet); a running
command means Working, and its next prompt means Done or Failed. Prompt editing,
empty commands and subsequent quiet evaluation preserve the last result. These are
status hints only, never capabilities or instructions. A permission hook and a real
process exit retain precedence. Lifecycle transitions invalidate pending inference.
Slow classification displays transient Checking after 150 ms; new output, user input,
removal and command lifecycle changes invalidate the old result. Checking is a UI
state, not a model verdict or a verdict-log entry. Ambiguous rules-only results say
“No completion or input request detected,” rather than implying a Quiet verdict.

## Tile renderer measurement

After `npm run make`, run
`xvfb-run -a node tests/electron/tiles-measurement.js` on Linux (omit Xvfb on
other platforms). It starts the packaged app with a private profile and temporary
repository, opens six real terminal tiles, and floods two of them for 12 seconds.
It records ten seconds of animation-frame intervals, browser long tasks, and ten
input-to-render probes on another terminal, plus final flood byte counts. The
fixture uses the DOM renderer and retains sandboxing. Measurements are machine-
and workload-specific; record the report and interpretation in the PR rather
than treating frame timings as portable pass/fail thresholds.
## Recorded sounds

`shared/sound.d.ts` defines four kinds and path-free `{source, file}` choices.
`shared/sounds.ts` validates exact keys, filename syntax, switches, finite volume
bounds and distinct Needs you choices. Only settings loaded from disk can migrate
the former `soundscape` property; IPC accepts the new format. Migration preserves
switches and volumes. The existing setup IPC and atomic store persist choices.

`main/sounds/library.ts` creates `~/.foom/config/sounds/{working,done,needs-you,refusal}`
and merges its catalogs with read-only `build/sounds/` inside the packaged resources.
The build copies the approved OGG/Opus recordings, manifest and notices; notices also
feed `build/THIRD_PARTY_NOTICES.txt`. Settings exposes sound credits until the About
screen (#96) consumes the shared notices. The manifest records original authors,
URLs, CC0 licenses, retrieval dates, source and derivative checksums, and edits.

`sound:list` and `sound:read` validate the main window's top-level sender and exact
argument counts. Read requests contain only kind/source/filename. Main accepts direct
regular files, rejects hidden/overlong/unsafe filenames and out-of-folder symlinks,
checks extension against header, and bounds each folder to 100 files. Working files
are capped at 8 MB; others at 2 MB. User reads use an inspected descriptor, bounded
allocation and directory/name rechecks. `sound:open-folder` calls `shell.openPath`
only on the fixed main-owned folder; `sound:notices` reads a fixed bundled file.
No arbitrary filesystem capability, URLs, Node APIs or CSP exceptions reach the renderer.

Opening Sound lists folders again and emits `sound:changed`, refreshing cached choices
so restored files take effect without a restart. The renderer decodes IPC bytes with
`decodeAudioData`, validates durations (Working 1–30 s, Done/Needs you ≤1.5 s, Refusal
≤0.3 s), and measures RMS and peak. Gain targets −25 dBFS RMS, capped at 4× and a
−6 dBFS peak; silence stays silent and nonfinite samples fail. Invalid selections
fall back to the default and report a reason, never rewriting saved choices.

The sound controller subscribes to board and setup sources. It reads main-owned
execution metadata, never output rates. One steady loop at the selected volume
plays while any agent is working; shells and exited sessions are excluded. Shell rows
are also excluded from verdict alerts, so command completion and shell prompts stay silent. A 100 ms clock settles verdicts for
one second, spaces alerts by two seconds, gives attention priority and repeats
outstanding attention every two minutes. State changes, removal and disposal cancel
reminders; repeated verdict IDs do not restart them. Attention is muted in the focused tile while the document has focus, excluding
Settings, preflight and location views. Completion remains audible when focused and
is deduplicated by launch and turn; initial readiness and restored verdicts are silent. Muted
completion is consumed. Settings must load before sound; later settings events take
precedence over a pending initial load. No terminal text enters audio.

`renderer/sound/web-audio.ts` owns one loop, one verdict voice and an independent
Refusal voice. A refused placement calls Refusal immediately, obeying Alerts and its
volume without verdict settling or debounce. Context resume, gain ramps, asynchronous
decode cancellation and cleanup are owned here. Audio failure leaves terminals and
visual status operational. Settings previews stop on replacement/unmount and after
five seconds for Working (two seconds for other kinds). No synthesis remains.

## Board shortcut definitions

`main/window/commands.ts` owns the command registry: IDs, labels, platform
bindings, enabled/checked state, native roles and actions. `app-menu.ts` projects
this registry to the macOS menu and the sandboxed renderer's menu data. Main owns
one `before-input-event` dispatcher; native accelerators are display-only
(`registerAccelerator: false`). Windows/Linux have no native application menu.
The existing two-second Ctrl+Shift+Space tile leader resolves from the registry;
blur, timeout and unmatched input cancel it. Alt alone and F10 open the wordmark
menu. Plain Ctrl letters and numbers reach the terminal.

The `app-menu:list`, `app-menu:execute` and `app-menu:view` invoke handlers accept
only the owning window's trusted top-level frame. Execute accepts an existing,
enabled command ID; it never accepts code, URLs, paths or arbitrary terminal IDs.
View accepts bounded tile counts and booleans solely for presentation availability
and the maximize checkmark. The board source exposes this small typed capability.
The renderer reuses RowMenu's keyboard navigation, portal and dismissal behavior.
Menu selection and native shortcuts dispatch identical main-owned actions.
Application-menu actions dismiss before dispatch, independently of row-action
confirmation cancellation. They restore the previous focus and selection first,
so native editing targets the original input; navigation commands then own their
destination focus. Escape continues to return focus to the wordmark.
Development commands are omitted when packaged; packaged webContents also set
`devTools: false`. Quit and Close Window go through the existing confirmed shutdown.

`attention-badge.ts` derives attention counts from main's workspace snapshot on
inventory and verdict changes. Windows overlays are generated BGRA bitmaps;
macOS gets a Dock badge and a menu whose waiting-session callbacks carry main-owned
terminal IDs. The validated preload notification selects an existing board row.
Linux uses `app.setBadgeCount`, which is a no-op on unsupported desktops. Renderer
activity rates never determine badge counts.

Terminal view operations recheck current inventory when queued work executes.
The validated `terminal:availability` notification carries terminal IDs in a batch.
It revokes each ID locally on removal, before asynchronous inventory refresh, and
suspends view work before shutdown. Preload acknowledges a subsequent ID-scoped
flush after the current renderer turn; main validates sender, IDs and token and
waits for that acknowledgement before revocation. A three-second fallback permits
cleanup when the renderer is crashed or unresponsive. A failed shutdown restores availability and
the previously selected view unless the user changed selection. Removing a terminal releases
its controller locally; known lifecycle actions hide
its view before revoking the capability. A hidden controller never detaches a
later owner's attachment. View queue failures become status text and cleanup
still disposes controllers. Main continues to reject unknown and foreign IDs.

### Agent title, progress and screen evidence

The evaluator order is **process exit → permission hook → per-agent rules → shell
facts/generic text rules → model**. Main chooses the agent from its launch record;
output cannot choose a rule manifest. Shell sessions never use agent rules.
`main/evaluator/agent-rules/*.json` ships one versioned manifest per agent, recording
minimum engine version, provenance, ordered priorities, region, matchers, exclusions
and the source rationale. Herdr-derived rules are a capture-backed subset; the
Apache-2.0 license and modification notice are included in generated third-party
notices. The future About screen (#96) can consume that same notice bundle.

The headless host listens to OSC 0/2 titles and parses OSC 9;4 progress without a
view. It retains only sanitized titles (512 code units, no control/format chars)
and bounded numeric progress. Changed metadata is emitted after queued parsing
finishes, with a terminal ID. Main validates it, checks live session ownership and
keeps it outside renderer IPC. Title changes request immediate evaluation only when
the detected rule or state changes. Spinner and blinking frames retain the latest
evidence without evaluating; progress-only or unknown changes wait for normal quiet
events, so they cannot trigger inference during streaming output. Existing generation/output guards discard stale results, exits stay
final. Permission hooks persist until a working hook, or a reply followed by fresh
working title evidence and no matching agent permission form; dismissal only hides attention.

Screen matching uses the existing 40-line host tail, capped to 500 characters per
line, and only the bottom nonempty lines or text after the last horizontal divider.
Titles and progress are separate local evidence. Pattern strings have a 128-character
limit; the regex subset forbids groups, repetition, alternation and backreferences.
Only fixed-width atoms, classes, anchors and approved escapes are accepted. A five
millisecond evaluation budget supplements those bounds; it is not presented as a
way to interrupt a running JavaScript regex. No matcher can type into a terminal.

Working and blocked rules produce fixed reasons and `rules:<agent>:<rule-id>` signals.
Idle evidence has low confidence and continues through generic rules and the model,
never directly to Done. Workspace execution promotes an ambiguous result to Done
only after a recorded working-to-idle transition; Claude with hooks additionally
requires Stop, so title-only interrupts stay neutral. Initial readiness stays neutral. Model requests still contain only the existing redacted 40-line tail; titles,
progress, files, diffs, keystrokes and manifest content are never added to that input.


## Agent execution

`main/agents/execution.ts` owns an independent machine per agent invocation:
`starting`, `idle`, `working`, `blocked`, `exited`. Shell command markers remain
separate. Output, keyboard input, focus and feedback never prove agent execution.
Main subscriptions and validated `agent:execution` IPC receive transitions only,
with terminal ID, launch identity, turn number, revision, from/to, source and time.
Workspace snapshots hydrate the current state; the renderer rejects older launch
or revision evidence. Resume creates a new invocation even when the terminal ID
is reused. Revoked hook capabilities cannot address that invocation.

| Agent | Working | Blocked | Idle |
| --- | --- | --- | --- |
| Claude | Per-launch UserPromptSubmit/PreToolUse observer hooks; half-circle title | PermissionRequest hook; live screen forms | Stop hook; star title |
| Codex | Trusted per-launch UserPromptSubmit/PreToolUse/PostToolUse hooks; braille spinner title | PermissionRequest hook; Action Required title | Stop hook; fallback turn-complete notify; plain title |
| Antigravity | No supported signal yet | Screen rules | No supported signal yet |

Evidence precedence is: process exit; lifecycle hooks (including Codex); active permission hooks; agent-specific
blocked forms/titles; agent working titles; generic shell patterns; model fallback.
A blocked agent form wins over a simultaneous working title, but generic password,
yes/no and Enter strings do not override supported agent working evidence.

Hooks are strongest evidence. An explicit permission hook survives spinner frames
until a working hook proves progress, or user input is followed by a fresh working
title and classification finds no agent-specific permission form. Input alone and
dismissal never resume execution. A new permission hook resets that reply evidence.
Screen blockers beat working titles during
classification; later positive progress supersedes stale screen evidence only after
classification verifies the current screen no longer requests attention. Repeated
spinner frames can trigger this recovery while blocked. Dismissal is tracked
separately from execution against a digest of the attention signal and screen;
unchanged evaluations stay quiet. Changed attention evidence, a new permission
hook, or a lifecycle transition invalidates that dismissal. Idle
titles may end a turn started by a hook (including Claude Esc, which lacks Stop).
With Claude hooks attached, a title-only turn end stays Quiet: Stop is required
before reporting Done, including when Stop arrives after the idle title. Without
hooks, title-only completion remains heuristic. Codex 0.161+ attaches stable
lifecycle observers with trust granted only in Codex. Once startup, prompt and Stop
are observed, later launches preserve the user's notifier. Codex idle titles without
Stop stay neutral after lifecycle hooks have been observed, including Esc interrupts.
Older/unreviewed installations keep the turn-complete notify fallback.
Antigravity lifecycle hooks remain deferred to #178; no global agent configuration
is changed. Observer hooks emit no permission decision.

Turn end stops Working immediately, independently of asynchronous classification.
Classification checks attention and failure evidence before announcing completion;
Needs input moves execution to blocked. A first idle is readiness, never completion.
Working-to-exited is failure even with exit code zero. A newer execution revision
invalidates in-flight classification. The board overlays execution on verdicts so
silent thinking remains Working and unsupported execution stays neutral.


### Stable Codex hook health

Codex 0.161+ receives six invocation-only `-c hooks.<event>=…` definitions. Commands
point at a versioned observer installed with Foom, outside ASAR, with no per-launch
data in the definition. Credentials remain environment-only. SessionStart is health
metadata, not a turn-ending signal; prompt/tool hooks mean Working, PermissionRequest
means Blocked, and Stop permits completion classification. The receiver validates and
pins the conversation ID across lifecycle and notify formats and retains no payload
text, tool inputs or transcript paths. Observers print nothing and exit successfully;
missing credentials make them immediately inert. Transport timeout is one second.

Main stores observed health in `codex-hook-health.json` in Foom's profile, never in
Codex state. A fingerprint of the six definitions invalidates cached health when the
installed observer path/version changes. Only observed startup + prompt + Stop
permits later launches to omit `notify` and its disclosure. A review screen or missing
prompt callbacks in the current execution turn restores the fallback for subsequent
launches. Prompt and Stop observations are scoped to execution turns: notify is
ignored only when Stop completed that same turn. An attached notify fallback can
complete later turns even when their lifecycle callbacks disappear; title-only ends
stay neutral after lifecycle hooks have been observed. Newer launches own health
updates so an older terminal cannot overwrite a newer result. Setup exposes these
observations and directs users to Codex's `/hooks`; no Foom control grants trust or
reopens review. The [probe and limitations](agents.md#stable-codex-lifecycle-observers-181)
record real Linux timing and the outstanding Windows real-CLI probe.
