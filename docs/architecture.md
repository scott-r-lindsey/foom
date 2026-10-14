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
    evaluator/        # local rules, tail redaction and verdict log
    setup/            # settings, repository discovery and setup IPC
    config/           # Foom config folder: hardened git, layout, approval, live reload
  terminal-host/      # utility-process entry, PTYs, headless screens and activity
  preload/            # sandboxed window.desktop bridge
  shared/             # declaration contracts and platform-neutral runtime helpers
  renderer/
    renderer.tsx      # browser entry
    app.tsx           # preflight/board composition
    board/            # board view, live/sample sources and the New worktree branch field
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

- `preflight-view.tsx` coordinates navigation, scans, persistence, errors, heading focus and launch. Welcome, agents, repositories, worktrees and readiness render in their own `*-step.tsx` modules; they receive state and actions from the coordinator. The welcome step shows instead of tells: `welcome-noise.tsx` tiles ten made-up terminals like a window manager, then folds them into ten lights, one of which needs you. `welcome-noise-output.ts` generates their output: colored, bursty, with streamed prose and per-agent status lines, and each light follows its own terminal's output rate. It is decorative (`aria-hidden`) and shows its final frame under reduced motion.
- `board.ts` contains production board helpers. `sample-rows.ts` holds development fixture rows and is imported only by the sample source and tests.
- `styles/styles.css` is an ordered import manifest for base, board/terminal, preflight, appearance, welcome, welcome animation, repository picker, layout overrides, tooltips, agent cards and branch field styles. The build bundles it into the existing `styles.css` asset; there are no runtime imports or new asset permissions. Keep the import order: the later preflight/layout/card rules intentionally follow the base feature rules.

The `foom/process-boundaries` ESLint rule checks static imports, re-exports, literal dynamic imports and `require` calls. Process-owned code may depend on its own process and shared modules. Shared modules cannot depend on process-owned code. Only main and the console may import `node-common` utilities; the console cannot import main, Electron or terminal-host policy. Renderer and shared modules cannot import Node, Electron, node-pty or headless xterm. The sandboxed preload may import Electron at runtime and shared declarations as types; adding another runtime dependency requires an explicit boundary and loader design change.

Tests live outside `src/`; production compilation excludes them. Coverage still includes every executable source file regardless of its directory. The build emits main at `build/main/main.js`, preload at `build/preload/preload.js`, and the host at `build/terminal-host/terminal-host.js`. Renderer TypeScript is type-checked without emitting; esbuild produces the browser bundle. This prevents the renderer compiler from overwriting main’s CommonJS shared modules with unbundled ES modules. Renderer asset URLs remain unchanged.

## Board

**Today:** The board is the home screen, with live shell and agent rows grouped by repository. The source loads `workspace:snapshot`, refreshes on `workspace:changed` (including repository additions and preflight repository changes), and overlays `terminal:state`, `terminal:exit`, and activity events received while a snapshot is pending. Rows keep their positions when verdicts change. The persistent sidebar remains beside the terminal tile area. Arrow keys move row focus; focus and hover leave terminal attachments unchanged and do not preview output; Enter or click selects and focuses the terminal. Main intercepts ⌘⇧B / Ctrl+Shift+Space, then B to focus the sidebar and ⌘B / Ctrl+Shift+B to collapse or expand it and ⌘/Ctrl+Shift+N to select the oldest waiting verdict. Esc reaches the PTY. Below 720 CSS pixels, the sidebar collapses to accessible lights rather than disappearing. Registered repositories remain in the sidebar even without terminals. Wait time begins at the verdict's main-process timestamp and survives repeated attention classifications. Opening does not clear Needs you; Done/Failed dim once seen. Typing replies through terminal input; **Not attention** records dismissal feedback through IPC and waits for main's state update. Failed feedback remains visible and can be retried.

Each leaf of the split tree owns one persistent xterm controller. Sidebar selection
is independent of presentation. `tiles.ts` implements immutable split, close,
placement, grow, space collapse, drop-to-split, whole-leaf swap/move, geometry and restore operations. `tile-area.tsx` renders the
leaves as a flat, keyed sibling list positioned by tree rectangles, rather than
nesting React components under splits. Changing parent splits therefore never
remounts surviving leaves. Maximize changes rectangles and opacity
without changing attachments. Empty leaves render as aria-hidden spaces without
chrome or DOM focus. Split preserves terminal focus and records the newest space's
ID as the landing spot; terminal-only tree order supplies numbers and navigation.
Grow walks to the nearest split on its axis and rejects any occupied sibling.
Gutters clamp occupied sides to 15–85%; empty sides can reach zero and collapse
on pointer release or keyboard commit past 8%/92%. Each attached terminal retains
its own PTY size. The controller publishes fitted columns/rows with its view
snapshot for tile panel facts; terminal output and activity stay outside React.
Tile panels reuse the sidebar panel's portal, keyboard navigation and styling.
Hide clears the leaf in place and records it as the landing spot without stopping
its session; exited-only Close uses the
existing validated sidebar command and retains the view if that command fails.
Placement fills space, then grows a rightmost column with proportional existing
column widths, or selects the least recently focused non-attention tile when
columns would fall below 60 terminal cells. The board measures the available area
at the current terminal font size and tracks focus recency outside persisted data.
All-attention boards may grow below that minimum. Blank single-leaf windows start
with 1–3 equal columns of about 100 cells; arranged trees retain their geometry.
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

Versioned `foom.tiles.v1.<window-id>` localStorage metadata stores the tree, ratios, leaf IDs,
focus, optional landing-space ID and terminal assignments. The version stays at 1;
existing empty tiles restore as spaces. Restore validates untrusted JSON with size, depth,
node-count and uniqueness bounds; finite ratios strictly between zero and one
persist unchanged (including automatically added columns); out-of-range ratios
clamp to 15–85%. Split construction
shares the restore limits of 256 leaves and 64 levels, so every constructed tree
can be restored. Missing sessions are
pruned only after the source's first inventory completes, so an asynchronous load
cannot erase valid assignments. This data grants no process capabilities. Maximize
is not persisted. All terminal IPC remains ID-scoped and main-validated.

The board starts empty. Shells and agents launch from checkout panels; home shells use the home row; **New worktree** is a repository action. `npm run start:samples` explicitly builds the development sample board. Normal builds omit its data, and Forge rebuilds without the sample flag before packaging, including when invoked directly. New worktree is a branch field inside the repository panel (`branch-field.ts` holds its pure completion, status and ref-rule logic; `branch-field-view.tsx` the field). It reads `workspace:branches` and creates through `workspace:create-worktree` without a location, so main applies the configured one; it never launches. Whether a panel shows the field is part of the panel intent target, so it closes with its panel. Repository paths come from main’s registry or native directory picker; main chooses worktree destinations and executables.

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

**Today:** The board uses React 19 with TSX and reads one typed source through `useSyncExternalStore`. Each stable tile mounts one imperative terminal controller through the source adapter and disposes xterm and subscriptions on unmount. Terminal attachment and measurement remain in the controller to preserve attachment ordering. Board focus and pane selection are independent view state; hovering or focusing a row does not fetch terminal output or select a terminal. The source also supplies path-identified repositories and their complete Git worktree inventory, including empty worktrees and the main checkout, plus validated main-process navigation commands. `sidebar-model.ts` computes stable pin/active/idle sections, filtering, hidden attention counts and roll-ups. `sidebar-view.tsx` renders the tree (or compact session rail by window choice, forced below 720px). Repository and checkout name clicks do not change the terminal pane. Sidebar focus does not attach a terminal; only the board's presentation callback requests that from the tile controller. Open row panels derive actions from current source data so delayed eligibility updates are visible without reopening. `row-menu.tsx` portals panels to the document body, positions them from the row’s viewport rectangle, and owns keyboard navigation and dismissal. `sidebar-preferences.ts` validates versioned localStorage metadata for pins, expansion and terminal-ID names; this metadata grants no process or filesystem capabilities. Session metadata restores as exited rows across application exit; PTYs and screens are not restored. Activity batches feed a disposable DOM-only light controller with logarithmic rate mapping, 120 ms attack and 700 ms release. It holds rate targets for at least one third of a second, writes brightness, scale and halo styles, and samples bounded eight-second SVG traces at 4 Hz in sidebar rows. Reduced motion renders four brightness steps and trace samples at 1 Hz without scaling. Latest activity rates are cached independently of mounted histories, including final zero batches while rows are hidden. New subscribers receive cached rates so remounting cannot revive stale snapshot activity. Closed, exited and nonmoving sessions discard history; unmount removes subscriptions and timers. A separate clock updates wait labels; a separate clock updates wait labels without React commits. Activity goes directly from IPC to light styles without changing the React row snapshot.

- **React 19 with TSX**, bundled by esbuild as a production build (`process.env.NODE_ENV` defined). No other UI framework, component kit, or CSS-in-JS. Styles are plain CSS using the tokens in `tokens.css`.
- **The renderer holds view state only.** Terminal, verdict, and worktree truth lives in main and arrives through `window.desktop`. Components don't call the bridge directly; they read from one board data-source interface shaped like the IPC contract. A sample source serves explicit development builds and tests; the app uses the live source.
- **High-frequency data bypasses React.** Activity arrives about 10 times a second for up to 10 terminals. A small subscriber writes each light's brightness to a CSS custom property on the light element; React re-renders only when structure or verdicts change. Terminal output never goes into React state.
- **xterm.js stays imperative.** One component owns the `Terminal` through a ref, creates it once, and keeps the attach, drain, reset, fit, snapshot, acknowledgement, and reply-suppression order described under Terminals.
- **Keyboard first.** Every board action works without a mouse. The Electron suite runs axe; serious or critical violations fail.
- **Linting:** `eslint-plugin-react-hooks` and `@eslint-react/eslint-plugin` on top of the existing type-aware rules. `eslint-plugin-react` and `eslint-plugin-jsx-a11y` don't support ESLint 10 and are not used.
- **Coverage and lint globs include `.tsx`.** A component outside them would silently skip the per-file thresholds or the renderer import restrictions.
- The CSP doesn't change. React needs no `eval`.

## Multiple windows

Main constructs one workspace, terminal host client, hook receiver, session store,
control runtime and evaluator route for the app. Window creation is serialized.
`window-ipc.ts` routes invoke channels by registered WebContents and validates the
top frame and exact app page before dispatch; each capability retains its payload
validation. Unknown windows and confirmation renderers cannot use board channels.
Closing a board unregisters only its own routes and disposes its trusted dialog,
setup IPC and menu listeners. It never disposes the workspace or terminal host.

`terminal-views.ts` holds app-wide view reservations. ID-only `windows:sync` reserves
up to 256 known sessions for one window and returns accepted IDs. Another window's
reservation cannot be replaced. Removing a reservation detaches that window's old
host stream before another window can attach. Settings may detach a stream while
retaining its reservation. `windows:select` focuses an existing foreign view;
`windows:popout` requires a reservation in the requesting window. Main transfers
that reservation and detaches the old stream before opening the new view. A failed
window load releases its reservations; the terminal remains available in sidebars.
Terminal input, resize, acknowledgements and detach cannot act on another window's
attached stream. Host generations continue to reject delayed output acknowledgements.

`window-placement.ts` validates and atomically persists the window set in private
`windows.json`. Each record has a stable random ID, display ID, normal bounds,
maximized flag and interface scale. Restore clamps geometry to a connected display,
falling back to the primary. The preload receives only its window ID and optional
pop-out terminal ID as main-generated arguments; it receives no profile paths.
Each window uses its ID to namespace validated localStorage tile metadata, including the sidebar collapse choice. New windows start expanded; the narrow rail override and temporary overlay do not change that choice. The
legacy size file remains a fallback for the first window. Global settings retain
one writer; window-specific wrappers keep interface scale separate. Setup scans and confirmations stay local to their requesting window. Classification uses the shared local rules.

`window-audio.ts` elects one board to play app sounds. Validated view IDs describe
focus; main combines them with native focus and publishes suppression to the audio
owner. Closing the owner elects another board. Refusal requests reach that owner.
Attention badges derive from the shared workspace once, including when macOS has
no board windows. Dock selection locates the existing view or opens a new window.

Tile layout records use `version: 2`. Each leaf is `{ kind: "tile", id,
content: null | { kind: "terminal", session } | { kind: "preview", preview } }`.
Restore accepts version 1 and converts its `session` field to terminal content;
saves write only version 2. The existing `foom.tiles.v1` storage key and its window
namespaces are retained for discovery of older layouts. IDs are bounded and unique
within each content kind; invalid preview content becomes empty space. IDs grant
no capability. After the first main inventory arrives, `pruneContent` removes
unknown terminal and preview IDs while retaining geometry. Every occupied tile is
numbered in tree order. Terminal attachment and window reservations only use
terminal content. Main's sidebar inventory supplies typed preview display facts
(ID, repository, worktree, relative path and Markdown/HTML kind); it is empty
until the preview host lands. Renderer components read these through the board
source and never resolve preview paths or own a preview registry.

Existing single-window tile layouts migrate once from `foom.tiles.v1` into the
first window’s namespace. Subsequent windows start with independent layouts.
With no macOS windows, an app-only native menu retains New Window and Quit
accelerators and has no callbacks into a destroyed board. Windows taskbar
overlays use the same app-level count on every live window so none retain stale
attention after focus changes.

Quit is app-scoped, inventories all running PTYs, and parents its trusted dialog
to the focused board. It flushes every live renderer, stops PTYs, drains workspace
persistence, and disposes the terminal host before exiting. Cancellation and failed
shutdown retain sessions and windows. macOS activation recreates a board after the
last one closes; Windows/Linux route the last close through confirmed quit.

## Terminals

**Today:** `src/terminal-host/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/main/terminals/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/main/terminals/terminal-ipc.ts` grants registered app windows access to app-owned terminals and enforces exclusive attachments. The renderer starts on an empty board, with no PTY until a launch is requested. Selecting a row places its session in an available tile or focuses its existing tile; Esc remains terminal input. Hiding a tile or entering Settings detaches the stream without stopping the shell. Placing another terminal in an empty tile or returning from Settings drains pending renderer writes, resets the display, fits the visible grid, and restores a fresh host snapshot before continuing the live stream. Input and resize events are suppressed while hidden or changing attachment. The manager and ID-scoped bridge support multiple concurrent sessions; the board consumes live worktree and verdict data. Closing a window detaches its views; the last window requests quit on Windows/Linux and keeps the app alive on macOS. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals; once a termination request succeeds, shutdown and retries only drain its native exit callback, because closing a ConPTY handle twice can crash the host. A throwing termination request remains retryable. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their process handles and exit subscriptions even after a terminal is removed from the board. Confirmed quit applies the same graceful termination and force-kill deadlines to these removed processes and waits for their pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Color state also belongs to the host: OSC 4 (palette) and 10/11/12 (foreground/background/cursor) queries, sets, and 104/110/111/112 resets use shared public-parser handlers. Only the host handler writes replies; the renderer handler applies colors without answering queries, including mixed set/query commands. Colors accept xterm-compatible hex and `rgb:` forms; unsupported names and malformed entries are ignored. The palette starts with xterm's 256 defaults, and foreground/background/cursor use the brand ink/bg/accent tokens. Main sends the resolved terminal palette on creation and validated, terminal-ID-scoped updates on changes. A terminal palette replacement resets application-set color overrides to the new defaults, as the existing browser theme replacement did. Parser barriers order these updates with output, and attachment snapshots include all color state, so changes while hidden appear on reattachment. Keyboard, paste, and mouse input are not filtered.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. The host and renderer both default to a blinking block cursor. The host supplements serialization with cursor blink options and DECSCUSR overrides, scrolling margins for both buffers, and restores origin mode before positioning the active cursor. Cursor overrides use a checked, pinned xterm internal representation because the public modes API and serializer omit them. Renderer control updates preserve application cursor choices; exited views hide the cursor and disable blinking. A pending right-edge wrap is recreated by replaying the cursor row with the pinned serializer after restoring margins, preserving cell styles and the current pen. Normal-buffer margins are restored before entering the alternate buffer, so leaving fullscreen mode retains normal scrolling. xterm 6 does not expose margins publicly; the snapshot helper checks its pinned internal buffer representation and rejects attachment if incompatible; pending-wrap restoration also checks the pinned addon’s internal row serializer. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The activity meter and last-lines buffer read from the same stream in the host. One 100 ms timer batches changed UTF-8 bytes-per-second rates for all terminals, exponentially smoothed with a 500 ms time constant. Rates decay to zero; the timer sleeps once all meters are quiet and zero. Quiet fires once per output burst after 500 ms for a trailing question, y/n, password, or Enter prompt, otherwise after 2 seconds. New output restarts the debounce; pending parser writes prevent quiet classification. A terminal silent from launch gets its first quiet event after 2 seconds. Exit and removal cancel the meter. These are timing hints, not attention verdicts. Main exposes quiet callbacks for the evaluator and forwards activity only for live owned terminals; view attachment does not affect measurement. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

`node-pty` is pinned to `1.2.0-beta.15` to include the upstream
[ConPTY handle-table synchronization fix](https://github.com/microsoft/node-pty/pull/922).
The stable 1.1.0 release can race native exit watchers against other exits, creation,
resize and termination, crashing the utility host during multi-terminal shutdown.
Replace this prerelease pin with the next stable release containing the fix when it ships.
The exact prerelease pin avoids a local native patch; Electron tests exercise
concurrent terminal exits and shutdown, and all three platforms validate packaging.

The host uses Electron's `utilityProcess.fork`, not a Node child-process fork, so RunAsNode stays disabled. The native node-pty module remains unpacked from ASAR; Windows continues using the ConPTY DLL to avoid its Node helper path. After the native rebuild, packaging restores `conpty.dll` and `OpenConsole.exe` beside the rebuilt addon from node-pty’s matching architecture prebuild; node-gyp clears these postinstall files during rebuild. The three-platform CI matrix runs the packaged executable and tests its PTYs and detached snapshots with the disabled fuse verified.

Host requests and responses are validated at runtime and carry terminal IDs; request/reply pairs also carry a monotonic request number. Each attach has a main-generated view generation so late output from a previous view is ignored. Creation IDs are allocated in main. Unknown and duplicate IDs are rejected by the host. Renderer payloads cannot choose executables or working directories. A host exit or 10-second request timeout rejects pending operations, marks live terminals failed (`terminal:exit` code -1), and removes views. Exited terminals are not reclassified. A later create starts a fresh host; old IDs cannot address new sessions. The board displays terminal failures and offers Restart shell for its local shell. Confirmed quit requests native PTY shutdown in the host and reports failures without closing the window, allowing a retry. Shutdown RPC has a 15-second deadline to accommodate the native exit barriers. Final disposal waits for the utility process to exit, with a 12-second fallback for an unresponsive host. Main records the utility exit code and PID plus Electron’s `child-process-gone` reason and native exit code, correlated by a unique service name per host. Host failures include the last 8 KiB of the utility process’s own stderr; PTY output, snapshots and tails are never included. Exit records also appear in Electron test diagnostics/JUnit, including crash details delivered after the utility exit event. App event listeners are released on host replacement or final disposal.

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

Every channel checks the sender (a registered app window, its main frame, `app://bundle/index.html`) and validates every payload at runtime. Every terminal-scoped message carries a terminal ID. Creation returns the new ID; it accepts only dimensions, with shell and working directory selected in main. The future worktree launch specification above remains a main-only capability.

| Channel | Direction | Payload |
|---|---|---|
| `board:command` | main → renderer | registry board actions (including Tidy tiles and new worktree); preload rejects unknown commands, covered boards ignore them |
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
| `workspace:sidebar-command` | renderer → main (invoke) | validated discriminated command: launch by registered repository/worktree and agent ID, stop/close/restart/take-over/make-orchestrator/revoke-orchestrator by owned terminal ID, remove linked worktree by validated path, or forget repository; main owns confirmations |
| `workspace:snapshot` | renderer → main (invoke) | → `{ repositories, terminals }`, each launched terminal with its agent, repository, worktree, branch, and latest state |
| `workspace:add-repository` | renderer → main (invoke) | none; main shows the directory picker → repository or null |
| `workspace:changed` | main → renderer | invalidates the workspace snapshot after launch or removal; no payload |
| `workspace:worktrees` | renderer → main (invoke) | added repository path → worktrees |
| `workspace:branches` | renderer → main (invoke) | repository path → `{ head, local: [{ name, worktree }], remote, remoteBranches }` from refs already present; never fetches |
| `workspace:create-worktree` | renderer → main (invoke) | repository path, branch, optional `root` / `adjacent` (default: configured) → worktree plus `outcome`: `new`, `existing`, `origin` or `open`; launches nothing |
| `workspace:start` | renderer → main (invoke) | `{ repository, branch, run, acknowledgeCodexNotifierReplacement }` → terminal ID or null on cancellation; the board no longer uses it |
| `confirmation:scrim` | main → requesting board | boolean visibility only; cosmetic dimming, no dialog content or approval capability |
| `confirmation:size` | trusted renderer → main | finite positive `{ width, height }` in CSS pixels; exact trusted main frame, URL and pending request required; zoomed and clamped to parent content and display work area |
| `confirmation:answer` | trusted renderer → main | request ID and boolean; exact trusted window, main frame, URL and pending ID required |
| `workspace:remove` | renderer → main (invoke) | terminal ID → boolean; main owns confirmation and dirty-file inspection |
| `agents:scan` | renderer → main (invoke) | `refresh` → `{ warning, agents }` (no PATH) |
| `agents:launch` | renderer → main (invoke) | `{ agent, repository, worktree, cols, rows, acknowledgeCodexNotifierReplacement? }` → `{ id, attention }` or null on cancellation |
| `setup:state` | renderer → main (invoke) | → `{ settings, themes?, worktreeRoot }` |
| `setup:save` | renderer → main (invoke) | settings patch (known fields only) → state |
| `setup:changed` | main → renderer | setup state after a successful settings save or zoom shortcut |
| `environment:state` | renderer → main (invoke) | → `{ lists, windows, secrets }`; saved secrets have a null value |
| `environment:save` | renderer → main (invoke) | exactly `{ scope, previous, name, value, secret }`; a null value keeps a saved secret → state |
| `environment:remove` | renderer → main (invoke) | scope, name → state |
| `environment:read-shell` | renderer → main (invoke) | → importable candidates with masked credentials; values stay in main |
| `environment:import` | renderer → main (invoke) | names from the last read → state |

The renderer names repositories and worktrees only by paths main returned, and agents by ID. Main copies the known launch fields, checks the repository is registered and the checkout is authorized for that launch, and resolves the executable itself. A launched terminal belongs to the app; only its view is window-scoped.

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
child window for each board at creation. Each extra renderer process lives until
its parent board closes: this trades memory for immediate confirmation even when
the board has crashed or hung. Do not move its initialization into the renderer or
lazy-load it on quit. Its background throttling is disabled so a reused request
can render and report dimensions while the child is still hidden. With no macOS boards, quit opens a board and its trusted
child before asking for confirmation.
A separate in-memory session and `app://confirmation/confirmation.html` origin
isolate its renderer process from the board. The opaque frameless window contains only
its raised card, with a native shadow and platform rounding where supported (square
corners on Linux). The board draws a cosmetic translucent scrim in the top layer, covering any open
board form, from the boolean-only
`confirmation:scrim` notification. Hiding or failing to draw it grants nothing.
Native `modal` is false to avoid macOS sheet presentation. On Windows and Linux,
main disables the parent. On macOS, Electron's `setEnabled(false)` attaches a
translucent sheet above even a focused child (#353), so main instead temporarily
makes the board nonfocusable and blocks its mouse and keyboard events before
renderer dispatch. The keyboard guard also prevents board shortcuts. Main
redirects parent focus to the child; each dismissal restores the original native
focusability or enabled state and removes the input guards. The page uses a ResizeObserver to report
natural card dimensions in CSS pixels via `confirmation:size`. Main accepts only
finite positive sizes from the trusted main frame at the exact confirmation URL,
while a request is pending. It multiplies by the board zoom, clamps to the parent's
content area less a 24-DIP margin and the display work area, and centers the card on
the content bounds. The card's content scrolls when constrained. Main shows the
window only after its first valid measurement, re-establishes the parent link,
reapplies positioning after show, and raises it with `moveTop()` before focusing.
A main-owned one-second guard cancels if the page never measures. A shown child
that cannot acquire native key focus gets one reorder attempt and a second
one-second check; failure cancels without approving, clears the scrim and releases
board input. Windows/Linux also require native visibility. On macOS, current key
focus takes precedence over occlusion reporting, which can disagree with the
visible child during reuse. Hiding, minimizing or destroying the child, or hiding/minimizing its
board, also cancels after checking current native visibility/minimization, so a
late Cocoa hide notification cannot dismiss a newly visible reused request.
Checks and listeners are removed on dismissal and disposal.
These focus checks are a recovery safety net; the Electron regression observes
composed desktop pixels, since macOS can report native focus through an overlay.
Theme and Interface scale updates reach the dialog while pending; parent move,
resize, maximize, unmaximize and restore events recenter it. Dismissal removes
listeners, clears the scrim, and restores input and focus. Positioning remains
subject to window-manager restrictions (for example native Wayland). Quit approval
does not need the board to render.
Main serializes requests, supplies the current
resolved theme and content, and gives each request a new ID. Content carries a glyph,
subject, labeled disclosure sections, facts, argument chips and the pairing code with
its main-owned expiry deadline. The sandboxed preload validates structured fields.
The shared anatomy uses 500 CSS pixels for prose and 540 for lists and disclosures;
main still applies zoom and the parent/work-area clamps. List names wrap in their own
grid column; state and retention labels never wrap. Pairing counts down to the actual
request deadline, including time spent waiting behind another dialog. Cleanup checking
counts come from the latest inventory; fetch ages use the successful main-owned fetch
timestamp, never a new timer started by opening the dialog. Its sandboxed preload
exposes only request rendering, sizing and answering; it buffers the request until the page
subscribes. `confirmation:answer` validates the exact window, top frame, URL,
request ID and boolean. Board frames, stale IDs and malformed answers are ignored.
Closing, renderer failure and disposal cancel. A failed window is recreated for
the next request. This main-only content API also serves merged-worktree cleanup and can later serve #119.

The trusted session denies permissions and navigation, blocks new windows and
webviews, and serves only its page, script, styles and bundled fonts. Context
isolation and sandboxing stay enabled; Node integration stays disabled. Its CSP
matches the board's restrictions. React renders titles, filenames and session
metadata as text. The page traps focus within Cancel, the confirming button and (when scrolling)
the content region,
handles Escape, focuses Cancel for every request, and respects reduced motion.
Quit inventories live terminals in main, including shells outside the workspace
snapshot; it does not query the board. Renderer loss immediately releases a pending terminal view flush; a crashed board
is not asked to flush again until it loads. The existing deadline still allows
shutdown when a live board is unresponsive.

## Worktrees

Git runs in main through `execFile` with argument arrays, never through a shell. Branch names are validated with `git check-ref-format --branch` and may not start with `-`. Foom creates worktrees under the configured root (default `~/.foom/worktrees/<repo>/<branch>`) or next to repos the user added. Listing includes all Git worktrees, including external ones; confirmed removal supports linked worktrees created by any tool.

**Today:** `src/main/workspace/worktrees.ts` provides the main-process `WorktreeService`, independently of the UI and IPC. Add a repository before listing or modifying its worktrees. It canonicalizes repository paths, lists NUL-delimited Git records, checks out existing branches or creates new ones, and delegates dirty/locked removal checks to Git. Force allows dirty removal but does not override locks or target validation. All Git-registered linked worktrees of an added repository can be managed, regardless of creator or location. Direct removal validates the same Git membership and filesystem identity as confirmed removal. Adjacent trees use `<repo>-<branch>` (branch slashes create subdirectories). Creation checks resolved parent directories against the allowed root and rejects existing destinations. Creation history records the device, inode, and birth time of the worktree directory, its `.git` file, and its resolved Git metadata directory. Listing revalidates creation history; missing or replaced entries invalidate that history. Removal captures a fresh identity and rejects replacement during confirmation or validation, including for forced removal. Removal rejects redirected paths. `removeRepository` forgets registration and creation history without deleting any checkouts. Workspace-level guards still refuse removal while sessions or operations are present. These checks do not provide isolation against another local process concurrently replacing filesystem entries.

At startup, main opens the service with `WorktreeService.open(app.getPath("userData"))`. Repository registration and historical creation records are stored in versioned `worktrees.json` using a private temporary file and atomic rename; writes are serialized within the service. Startup validates the untrusted state, rechecks repository paths, allowed roots, Git membership, and filesystem identity, and drops stale or redirected entries. Corrupt or unsupported state grants no repository registration and does not block startup. Registration, creation, removal, and history invalidation await persistence; write failures are reported to the caller. The synchronous constructor remains available for an explicitly in-memory service. The renderer reaches it through the `workspace:*` channels. `workspace:create-worktree` validates the branch in main; a branch already checked out is reported as `open` and not added again, an existing local branch is checked out, a branch only on the repository's remote (origin, or its only remote) is created with `--track -b <branch>` from its full `refs/remotes/<remote>/<branch>` ref, and anything else starts a new branch from HEAD. `workspace:start` validates the branch in main and creates a worktree at the configured location or reuses an existing Git checkout of that branch. A failed launch leaves the worktree available for retry with the same branch. `workspace:remove` takes a terminal ID; sidebar removal takes a registered repository and worktree path. Main validates Git membership, canonical paths and locks, excludes the main checkout (including when a linked checkout is registered as the repository), captures filesystem identity, and requests click-again for a clean checkout or a trusted dialog naming uncommitted changes from NUL-delimited Git status. Cancellation preserves the terminal and files. Main rechecks identity and status after confirmation, stops the worktree’s terminals and waits for native exit, then rechecks identity and status again before removing the directory; the branch is kept. Changed files require a fresh review. A refusal retains the exited terminal screen and capability for inspection, restart, or another removal attempt. Capabilities are revoked only after successful removal. Dirty removal is authorized only by that confirmation, never by a renderer force flag. Failed removal leaves the row available for retry. Operations on the same repository/branch are serialized. State assumes a single application service writer; it is not a security boundary against a local process able to forge the entire state file. The `managed` inventory field is historical creation metadata, not authorization. Git membership and canonical identity, rather than a directory location or creation record, determine eligible targets. Existing version-1 profiles remain readable. Repositories sharing a basename share a destination namespace; a collision fails without overwriting the existing directory.

Sidebar inventory never awaits remote merge checks. Main caches eligibility for
one minute, starts a background scan for a new local worktree/session inventory
or an expired result, and emits a workspace change when it finishes. Matching
in-flight scans are shared; superseded scans, removed repositories and disposed
workspaces cannot publish late results. Git status reads use `--no-optional-locks`
so index refreshes cannot race deletion of per-worktree metadata. Cleanup reuses a completed plan younger than 60 seconds for presentation; otherwise
it opens checking before awaiting the fresh plan. Approval always fetches afresh.
Fetch operations are queued per repository, including background and explicit scans.
Each waits for both subprocesses to settle before releasing the queue on failure.
Default discovery runs `ls-remote --symref` alongside `fetch --prune`, then tests
the advertised commit with `cat-file -e`. Only an absent object needs the explicit
default-ref fetch. Either failed network operation refuses cleanup.

Merged cleanup uses the same removal sequence with an additional main-owned
revalidation callback. Candidate path, filesystem identity, branch and commit
are captured before the trusted dialog. Both revalidation passes check Git membership and captured identity,
session eligibility, clean status and `merge-tree` containment against a freshly
fetched default commit. A failed post-confirmation fetch prevents every removal.
Main owns one `CleanupRun` per repository. While it is pending, inventory does not
start background eligibility scans. Before deletion begins, cleanup drains all
existing scans, including superseded scans whose results will be discarded, so
Windows directory handles held by their Git processes cannot block removal.
Four workers run the existing removal
path, retaining both revalidation passes. Successful removals retain their branch
launch locks through the ref transaction so Foom cannot recreate those branches
while they are being deleted. Failed candidates release their locks immediately. Git removes
separate per-worktree admin directories and checkout indexes; these operations
need no shared main-index write. Status disables optional index locking; merge-tree
writes content-addressed objects. Persistence remains serialized by the service.
After all workers finish, a single `update-ref --no-deref --stdin` transaction
serializes shared ref/packed-refs mutation using Git's ref locks. It compares each
checked SHA, excludes moved and checked-out branches, and retains all transaction
refs if a concurrent change prevents commit.

The sidebar inventory carries main-owned total, done, phase, stopped and fixed
per-worktree states/reasons. Removed rows remain as presentation tombstones to
fold away. `CleanupFeed` is a main-only subscription capability, stripped before
sending any dialog request. The trusted window receives branch labels and opaque
row IDs, never cleanup paths. Its existing ID-scoped, exact-window/top-frame/URL
validated boolean answer approves only a ready plan, stops only an active run,
or closes the presentation. Checking cannot approve. Main publishes current state
on the existing render channel; stale IDs and non-boolean payloads are ignored.
Hide/close/Escape unsubscribe without stopping; reopening subscribes to the same
run. The repository reservation lasts until workers settle, including while hidden.
Shutdown stops scheduling new removals and waits for in-flight work.
As with ordinary removal, this does not isolate concurrent filesystem mutations
by external local processes. Fetches disable interactive credential prompts and
Git commands have a 30-second process deadline.

## Agent discovery and launch

**Today:** `src/main/agents/agents.ts` provides a main-only `AgentService`, following the worktree service's integration boundary. `scan()` resolves PATH with the account's login shell (`-ilc`, a fixed printf program with NUL delimiters), then probes each resolved executable with bounded `--version` and `--help` calls. It retains full version strings. Shell failures report a warning and use inherited PATH; Windows uses inherited PATH and native executables. Relative and empty PATH components are ignored. Windows batch/PowerShell wrappers are not executed through a command shell; installations exposing only those wrappers currently need a native executable on PATH.

Stable Claude Code releases at or above 2.1.284 and Codex releases at or above 0.155.1 enable hooks only when help includes the complete `--settings` or `-c` flag respectively. There is no maximum version. Unparseable versions, prerelease/custom suffixes, missing flags, failed probes, disabled hooks, and an unavailable receiver use output evaluation. Calling `scan()` again replaces discovery results. Codex receives `--no-alt-screen` only when its help lists the complete flag, independently of hook support or the hooks setting. Inline output stays in normal scrollback for wheel scrolling and evaluator tails; a failed or unsupported probe leaves launch arguments unchanged. Launch uses a resolved executable and argument array through a terminal creation capability (including the asynchronous utility-host client), with the resolved PATH added to its scrubbed environment. All launch paths authorize any valid selected checkout in the registered repository, including external and detached worktrees. Main captures the canonical checkout identity before confirmations or agent scanning; the agent service revalidates it after hook preparation, immediately before spawning. Shells revalidate immediately before spawning too. Validation checks current Git membership and common Git directory, rejects redirected, bare, locked and prunable worktrees, and detects replacement during confirmation. The identity is a main-only launch capability; IPC never copies it from renderer requests. All checkouts permit multiple sessions. Sidebar, New worktree and legacy agent launch paths use a main-owned confirmation before launching an agent alongside any running agent in that checkout. Shells and exited agents do not trigger the warning. Cancellation creates no session. Main grants the shared-launch capability only after checking for active agents under the launch lock; renderer-supplied flags cannot bypass confirmation. Launch and removal locks cover confirmation and spawning. Repository registration is reserved before any asynchronous launch or worktree creation, including legacy launch IPC. Repository removal in both the sidebar and Settings refuses pending operations and tracked sessions; its exclusive guard spans confirmation and deregistration and blocks new launches until it settles. Each session retains independent hooks and verdicts.

### Launch environment (#215)

`src/main/setup/environment.ts` owns Environment settings. `environment.json` in user
data holds an All sessions list and one per agent; secret values are stored only as
`safeStorage` ciphertext, never in `settings.json`, and Linux's `basic_text` fallback
counts as unavailable, so secrets are refused there. Loading drops invalid rows and
secrets that cannot be decrypted. Replies carry names, plain values and null for saved
secrets; error messages name variables, never values.

Each launch is built in layers, each overriding the previous: the inherited
environment (scrubbed of `npm_*`, `ELECTRON_*`, `FOOM_*` and `CLAUDECODE`), All
sessions, the agent's own list, then Foom's reserved variables (control, hook and
session variables). Shells get All sessions only. Main validates every variable again
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
receiver behind any proxy. That change made the Windows Codex observer `codex-v2.ps1`
(POSIX stays v1) and the Antigravity plugin version 2.

`setHooksEnabled(false)` disables hook attachment for subsequent launches. A main-process integration supplies a fresh `AgentHooks` binding per launch, with a Claude stdin adapter command, a Codex argv adapter command, session credentials, and a cleanup callback. Claude settings attach prompt, tool, Stop, PermissionRequest, and Notification observer hooks as inline JSON in `--settings`; Codex 0.161+ receives stable lifecycle definitions and keeps `-c notify=[...]` until completion hooks are observed working. Older supported Codex versions receive notify only. No settings files are created in the user's HOME or workspace. Codex notifier fallback requires `acknowledgeCodexNotifierReplacement` after the UI discloses that the user's notifier is replaced for this invocation. Confirmed lifecycle hooks remove that override and disclosure on later launches. `release(terminalId)` must be called on exit/kill to revoke credentials and free the worktree; `dispose()` releases all bindings during shutdown after terminals are stopped. Spawn failures clean up immediately.

`src/main/workspace/workspace.ts` connects these services in main. It scans once and reuses the result until a refresh, starts the hook receiver on the first launch that attaches hooks, and closes it after terminals stop on quit. `src/main/agents/hook-launch.ts` writes each launch's adapter script to its own `mkdtemp` directory (mode 0700), registers receiver credentials under a random key, and maps that key to the terminal ID once it exists (`AgentHooks.bind`). Exit, kill, and shutdown release the launch: credentials are revoked, the directory is deleted, and the worktree is free again. Antigravity uses a separately installed opt-in observer plugin; only its Foom launches receive fresh hook credentials. Preflight's settings reach the workspace through `configure`: the hooks setting calls `setHooksEnabled`, and launching an agent that preflight turned off is refused. Launched agents and worktree shells appear immediately in stable repository groups on the board. Checkout launchers disclose Codex notifier replacement before the first hooked Codex launch; main persists `codexNotifierAcknowledged` in settings and reuses it for later launches.

## Control plane

**Foundation implemented in #152.** `main/control/` owns the service, launch grants,
versioned HTTP adapter, private discovery, operation records and audit storage.
The workspace starts it when the window is composed so human pairing is available before an agent launches. A failed startup leaves the window usable and can retry on agent launch.
Launches receive the `agent` role; only main changes it, when the human makes a
running session the orchestrator or revokes it (#303), or when restore re-grants an
orchestrator (#155). The read methods are `whoami`, `sessions`,
`session_state` and actor-scoped `operation_status` (orchestrators only). Unknown
methods, role/force flags and unknown fields fail closed. Orchestration methods are
described under **Orchestrators and children** below.

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
binds one random protocol session to each live grant generation, so it survives a
role change. Reinitializing replaces that grant's old protocol session; DELETE terminates it. GET authenticates and
validates the session before returning 405 (no SSE stream). Revocation is rechecked
at dispatch. Ordinary agents can call only `whoami`, `sessions` and `session_state`.
Because clients fetch tools once (#303), MCP lists the orchestration tools to every
agent; calls without the role are refused with a message naming `whoami`, here and
by direct invocation.

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

Agent discovery reports MCP support independently of hooks, using stable version
floors (Claude Code 2.1.293, Codex 0.161.0) and the corresponding help flag
(`--mcp-config` or `-c`). Supported releases receive a random server name: Claude gets a private temporary MCP JSON file
with environment expansion, Codex gets an additive `-c` server table referencing the
bearer environment variable. Tokens never enter argv or files. Exit, early exit,
spawn/attachment failure and shutdown dispose attachments and revoke credentials.
Managed policy may refuse attachment in the client; no settings are weakened. The control
service tracks attachment per principal after terminal binding: Connecting for up
to 30 seconds, Connected after a successful authenticated MCP request, or Not
connected at the deadline with recovery on later traffic. CLI and rejected MCP
requests do not count. Timers are cancelled on success, revocation and shutdown.
Main publishes the transient state through workspace snapshots; session panels
show it neutrally except for an orchestrator's magenta Not connected failure.
See the [real-client probe record](orchestration.md#read-only-mcp-implementation-verification-153).

**Console helper and pairing implemented in #154.** `src/cli/` bundles as a Node 24
console SEA; `src/node-common/` supplies bounded private discovery and validators
to both console and main, without exposing Node to renderer/shared browser code.
An exact protocol and instance envelope routes online commands to the same service.
A separate `/control/v1/pair` endpoint accepts no bearer credentials, rejects browser
origins and nonliteral hosts, bounds bodies to 4 KiB, and holds the response while
the trusted main-owned dialog reviews a matching code. Pairing chooses the focused
live board at request time, or the first board; with no macOS boards it opens one.
The app-owned service never retains a closed board's dialog. Cancellation is
rechecked after opening a board and before requesting approval. Reviews expire after 60
seconds and support cancellation while queued or visible. Repository membership is
checked before and after review. A `cli` principal has read-only metadata scope,
a ten-minute deadline checked on every call, memory-only token delivery, and an
explicit release operation unavailable to agents. Pairing is single-pending,
rate-limited to one request per ten seconds and bounded to four live grants.
See [console usage and PATH ownership](orchestration.md#console-helper-and-local-pairing-154).
`foom config validate <path> [--json]` (#206) is offline and read-only. It dispatches
before inherited control credentials or pairing; it never opens discovery, keys,
worktree state or userData. The standalone Node executable needs neither Foom nor
a display, and also works while Foom is running. There is no config mutation.

The path names one file, a config root, `themes`, `terminal-themes`, `sounds`, or
one sound-kind folder. JSON files select their parser with `kind`; folder validation
also checks placement (`settings.json`, `themes/*.json`, `terminal-themes/*.json`).
Only the documented config layout is walked. Unexpected entries, symlinks (including
in-folder links), nonregular files and redirected directories are rejected. Reads
use capped open descriptors, carry the validated parent identity through each read,
and check it again after opening and before/after reading. JSON is
limited to 64 KiB and theme folders to 50 entries; sound kind folders to 100 entries,
with 8 MiB Working files and 2 MiB other files. Invalid entries count toward these
offline traversal bounds so hostile directories cannot force unbounded work.

Each invalid file produces a filename, JSON path and a fixed reason from the theme
validation vocabulary. Text prints one problem per line; filenames are JSON-escaped
to keep control characters inert. `--json` prints the same problem records as an
array (empty for valid input). Exit status is 0 for valid, 1 for invalid and 2 for
usage or I/O errors; I/O errors take precedence in mixed results. No file contents
or parser exception messages appear in diagnostics. Offline sound checks use the
shared filename, header, size and duration rules; `music-metadata` reads duration
from bounded bytes through a tokenizer that checks token lengths before allocation.
FLAC block and comment counts are checked before the parser can allocate tag arrays,
with no file/network access. Missing duration is invalid.
This checks container metadata, not sample decoding; playback still verifies that
Chromium can decode the audio and checks its samples.

**Orchestrators and children implemented in #155.** `main/control/orchestration.ts`
owns slots, limits, ownership and the action history; `Workspace` supplies main's
existing effects (worktree creation, agent launch, stop, host tail, removal) and
the service delegates `create_worktree`, `launch`, `stop`, `remove_worktree`,
`tail` and `wait_for` to it through an asynchronous `call`. MCP lists these tools
and `operation_status` to every agent but runs them only for an orchestrator
principal. `reply` (#156) creates a single-use proposal for human review; it never
exposes general terminal input or unattended delivery. See [the implementation record](orchestration.md#orchestrators-and-children-155).

A running agent session's menu offers **Make orchestrator…**, and **Revoke
orchestrator** on the active one (#303). There is no orchestrator launch. Main checks
the session is a running, non-config agent that is not an un-taken-over child, then
asks through the trusted dialog, which discloses the output path and names any
orchestrator it would replace. After the dialog it rechecks the session and the
current orchestrator, revokes the old one, reserves the repository's slot, swaps
the grant's principal (`ControlService.setRole`) and binds the slot. Every
orchestrator has the CLI fallback; Antigravity can be elevated without interactive
prompt support. Child worktree creation requires a new local branch, refuses checked-out branches,
and starts from HEAD even when a same-named remote ref exists. Children launch with
no default arguments (so never bypass), `sharedCheckout` off, a read-only grant
naming their parent, and an optional prompt as one final argv entry. Claude Code
and Codex place `--` immediately before that prompt, after all launch options, so
variadic options cannot consume it. Launches without a prompt omit the terminator. Exit,
removal or revocation of the parent ends its authority, aborts pending removal
dialogs and frees the slot; children keep running. Snapshots carry a main-computed `orchestration`
view (role, children, last 20 actions); validated session metadata retains bounded history across restart. `take-over` is a sidebar
command that removes the orchestrator's stop, tail and wait access to that child.

Foom also reads PR and required-check status for orchestrator-owned child
worktrees through a main-owned forge provider. GitHub is supported through your
own `gh` CLI and existing login; Foom stores no tokens, makes no forge writes and
sends no terminal content. The CLI contacts GitHub with repository and branch/PR
identifiers to read PR and CI metadata. Unknown remotes and missing, logged-out or
unavailable CLIs leave these fields absent. Validated PR number, head SHA, state
and required-check conclusion appear in session metadata, and `wait_for` wakes on
conclusion changes. The mapping survives restart and a new orchestrator generation,
without transferring authority over old children. Successful reads recur every
30 seconds; unavailable results back off from 60 seconds to at most 10 minutes.
Polling is serial with at least a second between worktrees and stops on shutdown.
See [the data, persistence and polling contract](orchestration.md#child-pr-and-required-checks-340).

**Sidebar nesting and action log implemented in #157.** The board source exposes
main-owned relationships and the private audit API. In the expanded sidebar, children appear under their
orchestrator, with their own worktree label, light, row panel and keyboard access.
Filtering retains matching children and their parent context; a missing parent
leaves the child in its own checkout with an explicit unavailable-parent label.
Exited and revoked parents stay visible, and an exited parent cannot be closed
until its child rows are closed. Takeover remains explicit and ends API authority.
The compact rail shows each session once in a flat list. Reveal expands the parent’s
checkout for nested children. Nesting does not attach a view or change terminal
execution or activity subscriptions.

The app menu's Action log opens a searchable, paginated view of actor/parent,
repository/worktree, operation and target/result IDs, action, outcome, fixed reason,
and redacted reply proposals. Reads and clears are board-only validated IPC routes;
components use the source interface. The log refreshes on main's audit notifications.
Only allowlisted redacted metadata crosses IPC. Initial prompts, raw request payloads,
terminal tails, credentials and deduplication fingerprints never enter the audit UI.
Refused API operations and human Make/Revoke/Transfer orchestrator and Take over
commands are logged; authority changes wait for persisted intent. Clearing the
serialized audit history preserves live deduplication records. Private history is
bounded to five 10 MiB files and 30 days, with pruning on reads and writes. Recovery
records indeterminate outcomes for unfinished operations without replaying them.
Read, storage and clearing failures remain visible without blocking human input.

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
sessions to grant generations, validate every payload and target at runtime, and recheck
revocation before effects. Reject browser origins and unexpected Host values; bind
only `127.0.0.1` on an ephemeral port. Never expose tokens through renderer IPC,
logs, argv or tool results. Child launches scrub inherited credentials and receive
fresh read-only tokens. Exit, failed launch and shutdown revoke grants.

Ordinary agents can use `sessions`, `session_state` and `whoami` for their
repository, without terminal contents. Only a main-granted orchestrator principal
can use `create_worktree`, `launch`, `tail`, `reply`, `stop`, `remove_worktree`,
`wait_for` and `operation_status`; listing a tool grants nothing.
Enforce authorization in the service for every call. Making a session the
orchestrator reserves one slot per repository atomically; reserve child slots up to the current General setting
(default 4, integer 1–16), including starting/stopping children. Lowering the setting
never stops existing children; it blocks new launches until below the limit.
`wait_for` accepts up to the current configured limit of IDs. Children run only in new worktrees created by
that orchestrator. No child can gain orchestration through the API. #84 config-only
roles and #67 remote access are separate capabilities, not implicit extensions.

Existing main-owned git validation, argument-array execution, launch/removal locks
and confirmations are reused. Removal asks the human unless the profile opts this
repository into the [strict merged-clean policy](orchestration.md#orchestrators-and-children-155);
no API force flag bypasses identity or dirty-state checks. Mutations use
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

Agent output, hooks and names are untrusted data. `tail` authorizes
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
Proposals bind to the live principal, actor generation, child, verdict and output/input revisions;
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

### Agent-editable settings format (#206)

`~/.foom/config/settings.json` is a JSON object with `"kind": "settings"` and any
subset of the following keys. Unknown keys are rejected, including nested sound
and agent fields. Main reads and writes these keys through this file (see
[Foom config environment](#foom-config-environment-84)); every other setting stays
in the profile. Validation alone grants no approval.

| Allowed key | Value |
| --- | --- |
| `colorMode` | `system`, `light`, `dark` |
| `panelColor` | `vivid`, `subtle`, `plain` |
| `interfaceTheme`, `terminalTheme` | `follow`, a corresponding built-in ID, or `user:<filename>.json`; no inline palette objects |
| `interfaceScale` | 80–150 in steps of 10, then 175, 200, 250 and 300 |
| `terminalFont` | Validated family name, default Hack Nerd Font Mono |
| `terminalFontSize` | Integer 10–32 |
| `sound` | Exact current `shared/sounds.ts` settings format |
| `agents` | Exactly boolean `claude`, `codex`, `agy` switches |
| `agentArguments` | Exactly `claude`, `codex`, `agy` literal argument lists, validated by `parseAgentDefaults`; every file change requires Allow |
| `hooks` | Boolean |

`shared/config-settings.ts` supplies the same value validation to main's settings
patch parser and the file parser; theme files use `shared/theme-files.ts` directly.
Theme IDs are checked syntactically, without opening any other file or profile.

| Excluded key | Reason |
| --- | --- |
| `agentBypassAcknowledged` | Records human consent to bypass mode |
| `codexNotifierAcknowledged` | Records human consent to notifier replacement |
| `setupComplete` | Records human setup progress |
| `codeFolder`, `worktreeLocation` | Select filesystem paths or placement |
| `environment` | Variables reach every agent launch, like `agentArguments`, and may hold secrets; set only through Settings (#215) |

Excluded keys report `unknown-key` at their fixed `$.<key>` path. Arbitrary unknown
property names are never echoed. The allowlist applies even when an excluded value
is null, false or otherwise harmless in isolation.


**Today:** First run is the preflight countdown from [product](product.md#first-run). `src/main/setup/settings.ts` stores versioned `settings.json` in user data: profile settings and consent records plus approved config digests. The config service stores hooks, enabled agents, launch arguments, appearance and sound choices in the config folder. Writes are atomic (private temporary file, then rename) and serialized; a failed write leaves the settings unchanged. Missing, corrupt or unsupported files start from defaults, so preflight runs again. Every patch, from IPC or disk, is validated field by field and unknown fields are rejected.

`src/main/setup/setup.ts` applies the settings to the running app at startup and on each save, and coordinates repository scanning. Legacy inference fields are discarded only when loading a profile; IPC patches still reject them.

Appearance lives in Settings and the preflight rail through the same `AppearanceControls` component and applies at once. `colorMode` (system, light or dark) sets `nativeTheme.themeSource` for Eclipse; fixed interface themes supply their own base. Main applies the source before the window is created at startup, so the CSS (`prefers-color-scheme`), the window background and terminals using Follow interface all follow it; changing the resolved terminal palette resets colors a program set in the terminal; fixed terminal themes ignore interface changes. `interfaceScale` (80–150% in steps of 10, then 175, 200, 250 and 300%, matching Chromium's zoom steps; `SCALES` in `src/shared/config-settings.ts` is the one list) is Chromium zoom: the window starts with it as `zoomFactor` and later changes use `setZoomFactor`. The window resizes with it in both directions (`src/main/window/window-scale.ts`): main remembers the window's size at 100% and sets the window to that size times the scale, capped to the display's usable area and moved back on screen if needed, so zooming in and back out restores the same size. A resize by the user sets a new size at 100%. On first launch, the window uses 60% of the primary display’s usable width and height. After a successful quit, main saves every window's normal bounds, display, maximized state and interface scale in `windows.json` in user data and restores them on connected displays, clamped to the current work area and minimum. The legacy `window-size.json` remains a fallback for the first window. Missing or invalid saved geometry uses the first-launch size. The minimum size (900 × 640 at 100%) scales too. The scaled minimum is capped to the work area, so a large size on a small or OS-scaled display can leave less CSS space than the 100% minimum; the layout compacts instead of refusing the zoom: the page never scrolls sideways, the compact sidebar wraps its tile layouts, Settings scrolls as a whole on a short window, and dialogs (the shortcut sheet, which is portaled so the compact sidebar cannot hide it, and the trusted confirmation, which measures its natural size in fractional pixels so a capped window settles) scroll within themselves. Maximized and full-screen windows keep their size. Tiling window managers may ignore the resize; zoom still applies. Main handles the zoom keys before the terminal sees them: ⌘ =, − and 0 on macOS, and Ctrl+Shift+= / Ctrl+Shift+− and Ctrl+0 elsewhere, because plain Ctrl+− is readline's undo. A shortcut saves the new scale and sends `setup:changed` so preflight's controls follow. `terminalFontSize` is a separate validated integer setting (10–32 CSS pixels, default 14). Each mounted terminal controller reads it before its initial attachment, subscribes to `setup:changed`, and updates xterm options. Visible attachments refit and send an ID-scoped resize; hidden views use the new size on their next attachment. Disposal removes the subscription.

Interface colors are independently stored as `interfaceTheme`: `follow` (default),
a built-in ID, a `user:<filename>` ID, or a version 1 portable object with `name`, `base` and `colors`.
Follow retains existing `colorMode` preferences and uses Eclipse Light/Dark; the
Themes picker’s System choice sets both Follow and System. A `colorMode`-only save
returns to Follow, while changing zoom or terminal settings retains the theme.
Fixed themes override `colorMode` with their declared light/dark base for
`nativeTheme.themeSource`. Main uses the palette's exact background both at startup
and after saves, including switches between themes with the same base.

`shared/interface-themes.ts` validates exact keys, six-digit opaque hex colors,
brand hue and color-distance rules, contrast and the declared base. Built-in palettes
pass the same gate used for user data. The object requires the original 19 color
tokens and optionally accepts the paired
`highlight` / `highlight-deep` decoration colors, falling back to accent / accent-deep.
Fonts stay fixed and bundled. There are no CSS filenames,
imports, URLs or arbitrary CSS values in theme data. See [brand](brand.md#interface-themes)
for the numerical invariants. Custom files use the same gate, as described below.

`renderer/ui/interface-theme.ts` subscribes to the setup source and system media
changes, sets color tokens on the root element and removes its listeners on unmount.
It ignores stale initial reads after a newer save or disposal. CSS keeps the original
Eclipse tokens as a startup/failure fallback. Settings → Themes uses token-scoped
previews of every board status, including the halo, square failure light and labels.
It neither renders terminal output nor subscribes to activity. The CSP and preload
surface are unchanged.

Terminal colors are independently stored as `terminalTheme`: `follow` (default), a built-in ID (`foom-light`, `foom-dark`, `solarized-light`, `solarized-dark`, `dracula`), or a portable palette object for future user configuration files. The object has exactly foreground, background, cursor, selectionBackground and the 16 named ANSI colors (black through brightWhite), each a six-digit `#RRGGBB` color. Main validates every key and value; the host protocol validates palettes again. Both processes and the renderer share the same resolver. Palette replacement resets OSC overrides; OSC 104 restores the active theme's ANSI defaults. Settings previews all 16 colors, bold, dim and selection. Third-party palette licenses are bundled in the packaged notices.

The renderer shows preflight until setup is complete; subsequent configuration lives in Settings. The default worktree location applies to the New worktree flow.

Settings opens beside the persistent sidebar with the board button or ⌘/Ctrl+,.
Main reserves the shortcut through the existing validated `board:command` channel.
Each registered window has its own trusted IPC sender and setup coordinator. The board keeps its terminal
controllers mounted but detaches and hides their views while Settings is open. Esc
restores sidebar row focus after the terminal has reattached; selecting a sidebar
terminal closes Settings. The shared setup coordinator renders the same Agents,
Repositories, Worktrees, Evaluator and Appearance controls in both paths, with guided
navigation only in preflight. Settings adds Terminal font and size, interface Themes and
Sound controls. Successful `setup:save` calls publish `setup:changed` to keep live
consumers synchronized. Repository selection changes save immediately in Settings,
with controls disabled during the write and refused selections restored to the
registered repositories. Scans in Settings start from existing registrations;
preflight continues to suggest recent repositories and save when leaving the step.

Repositories come from the user's code folder (one, saved as `codeFolder`). Main offers common folders under home (`~/code`, `~/src`, `~/projects` and similar) that hold repositories, each with a count from a quick scan (the same walk, stopped at 5,000 folders), or shows the native picker; then `src/main/setup/code-scan.ts` walks the folder breadth first with live progress: at most three levels and 20,000 folders (reporting when it stopped early), never following symbolic links, skipping hidden folders, `node_modules`, `Library`, `AppData`, `Applications` and Foom's worktree folder, stopping at each repository, and skipping `.git` files (linked worktrees and submodules). Last activity comes from the modification times of `.git/logs/HEAD`, `.git/index` and `.git/HEAD`, without running git; activity in the last 30 days preselects a repository, as does already being added. The renderer may add or remove only paths from main's latest scan; leaving the step applies the selection, and a refusal (for example a repository with Foom-made worktrees) keeps the user on the step with the reason. `npm run start:fresh` runs the app with a throwaway profile to test first run.

## Agent signals

Claude and Codex hooks attach per launch. Antigravity has an explicit opt-in plugin exception:

- Claude Code: `claude --settings <inline-json>` with Stop, PermissionRequest, and Notification hooks; JSON arrives on stdin. Permission notifications may be delayed, and Stop means a response ended, not necessarily task success.
- Codex: `codex -c notify=[...]`; JSON arrives as an argument. The external callback reports turn completion, not approval requests, and replaces the effective notify command for that launch.
- Antigravity: Settings discloses and installs the static Foom observer with `agy plugin install <bundled-directory>`. Remove uses `agy plugin uninstall foom`; enable uses `agy plugin enable foom`. All calls use resolved executables, argument arrays, bounded output and deadlines. No direct global configuration writes occur. Without the plugin, launch uses output evaluation.

See [agent research](agents.md) for versions, payloads, local probes, sources, and remaining verification. Completion events trigger classification; they do not unconditionally set Done. Echo-off alone is not a password signal: all three tested CLIs disabled echo at startup.

**Today:** `src/main/agents/hook-receiver.ts` provides an independently usable main-process service. `HookReceiver.listen(onSignal)` binds only `127.0.0.1` on an OS-assigned port. `register(terminalId, agent)` returns fresh `FOOM_SESSION`, `FOOM_TOKEN`, and `FOOM_HOOK_URL` environment additions and an idempotent `revoke()` capability. The launcher must revoke on launch failure, terminal exit, or removal; application shutdown must call `close()`. The workspace maps receiver keys back to terminal IDs before signals reach the evaluator. The app doesn't start a listener until a launch needs one.

Requests POST JSON to `/hooks`, with `X-Foom-Session` and `Authorization` containing the launch session and raw token. Tokens contain 256 random bits; comparison uses constant-time equality of fixed-length SHA-256 digests, including for unknown sessions. The listener rejects browser origins and nonliteral Host headers, limits headers to 8 KiB and bodies to 64 KiB (including chunked requests), caps connections, and times out stalled requests. It checks revocation again before delivery. Unknown/revoked sessions and incorrect tokens all receive 401. Unsupported events are acknowledged without changing state; malformed events receive 400.

The first supported event pins the agent session/thread ID for that launch. Subsequent events must match; Codex also requires a turn ID. Only `{ terminalId, action, signal, conversationId }` escapes the receiver. The validated conversation ID is saved locally by Workspace and is not forwarded into evaluation. PermissionRequest and `permission_prompt` produce `needs_input`; Stop, `idle_prompt`, and Codex `agent-turn-complete` produce `classify`. No event directly sets Done. Agent text, paths, tool inputs, and Codex `input-messages` are discarded, never logged, executed, or forwarded to the evaluator. Classification still uses only the redacted terminal tail.

The hook command cannot run Node from the packaged app because the RunAsNode fuse is disabled. `src/main/agents/hook-adapters.ts` supplies distinct observer scripts for Claude stdin and Codex's final JSON argument: POSIX `sh` plus `curl`, and Windows PowerShell plus `Invoke-WebRequest`. The launcher writes the returned source to a private launch directory, invokes POSIX files with `sh` or Windows files with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, supplies the launch environment, and removes the files afterward. On Windows it first runs the generated script in probe mode; a missing interpreter or enforced policy that blocks the script rejects launch with an error and cleans up the script. The execution policy applies only to that PowerShell invocation; user and machine settings are unchanged. Codex's configured notify argument array must end at the script's configured arguments so the CLI can append its JSON argument. Payloads remain data throughout; scripts emit no output or approval decisions, have a three-second HTTP timeout, and exit successfully even when the receiver is unavailable. Per-launch settings and notify attachment, tool availability checks, and notifier-replacement disclosure belong to #12.

## Saved conversations

Checkout panels parse pasted resume lines locally; raw pasted text never crosses IPC.
`workspace:sidebar-command` accepts `{kind: "resume-id", checkout: {repository, worktree},
agent, id}`. Main validates the exact shape, agent, conversation ID, registered checkout
identity and current agent availability. The ID uses the shared `conversationId` validator;
`resumeArguments` and the reserved launch-default selector rules still own argv construction.
The conversation ID is not a terminal ID and grants no terminal ownership capability.
Per-conversation launch serialization prevents duplicate concurrent pastes across checkouts.
An existing live session is revealed through main's window-aware navigation. Otherwise the
usual manual launch path creates a row with the pasted ID, fresh hooks and credentials,
current defaults and shared-checkout confirmation. Hook events pin against that ID. CLI
rejection exits the row normally and keeps the ID; no agent transcript or runtime file is read.


Main writes ordered, atomic replacements of private `sessions.json` in the active
profile. It stores terminal ID, agent, registered repository, worktree, branch and
validated conversation ID, last known running state and main-owned orchestration provenance (repository identity, parent relationship, bounded action history, owned worktree paths/identities and unused/used state, plus the uncertain-creation budget). Credentials and terminal contents are never stored. Loading validates bounded records and rejects
malformed IDs, paths, agents and duplicate terminal IDs. Unregistered repositories keep exited rows without launch authority. With restore enabled, eligible running records launch after all saved windows are shown, at most three at a time, with parents first and shared checkouts serialized. Every launch uses the manual resume path and fresh credentials; views attach only once the new host exists. Orchestrator re-grants additionally require the saved repository identity and a verified Claude Code or Codex CLI; see orchestration.md. Restoring a parent validates every owned checkout against the live Git inventory: it must still be a Foom-managed linked worktree in the parent's repository, with matching checkout identity; main, missing, foreign and replaced checkouts grant no ownership. Restored children, including already exited children, recover owned worktrees as used; legacy records without an ownership list use the child path and the host's current branch and identity. Unused owned worktrees remain launchable after restart, within the four-worktree unused budget; used worktrees cannot be launched into again. In-flight launches are saved as used to prevent reuse after an ambiguous shutdown. Restored running children still count against the configured child limit. Shutdown freezes the running records before terminating PTYs, so shutdown exits cannot overwrite the saved state.

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

`quiet` or parsed metadata event → process exit → permission hook → per-agent title/progress/screen rules → shell facts and generic text patterns → verdict `{ state, reason, signal, confidence }` → `terminal:state` and the verdict log.

States: `needs_input`, `done`, `failed`, `quiet_ok`, `working`.

**Today:** `src/main/evaluator/evaluator.ts` supplies the pure main-process `evaluateRules` classifier,
and `src/main/evaluator/verdict-log.ts` supplies `VerdictLog`. `Workspace` runs them for every terminal
the app owns, including shells: on quiet, on a hook signal, and on exit. Each
evaluation reads the last 40 host lines and runs in order per terminal, so a slow one
can't overwrite a newer verdict; a failure is logged and the next one still runs. The
result goes out on `terminal:state` and into the verdict log.

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
while failed writes remain retryable. No automatic
inference of ignored actions or log retention policy is implemented yet. The reusable fixture suite in
`tests/fixtures/evaluator.ts` contains sanitized, representative terminal tails.

The quiet debounce does not publish an intermediate state. Ambiguous input immediately
returns the existing neutral rules verdict. No production classifier calls a model provider.
Control API and MCP responses never send `checking`; clients may retain that deprecated
value in existing schemas for compatibility.

## Secrets

Use Electron `safeStorage` for any secret Foom stores; never store plaintext or expose
secrets to the renderer. Foom sends no terminal content to models or network services.
On profile load, `SettingsStore` drops legacy `inference` and `inferenceTimeoutMs`
fields and atomically saves the migrated settings. It deletes the three fixed
`inference-{anthropic,openai,google}.key` ciphertext files and strictly UUID-named
temporary key files left by interrupted writes, without decrypting them. Unrelated files are preserved.
Environment secrets (#215) are the only stored secrets; see
[Launch environment](#launch-environment-215).
Cleanup is idempotent and does not require OS encryption to be available; deletion
errors fail startup instead of silently retaining secrets. Removed setup key/probe
IPC channels have no handlers, and inference fields remain invalid in IPC patches.

`terminal-tail.ts` retains `prepareTail` for control metadata redaction. It removes
likely labelled credentials, bearer/API tokens, JWTs, URL credentials and private-key
blocks before selecting at most 40 physical lines. Truncated private-key fragments
are redacted too. Oversized input is rejected. Redaction is heuristic and cannot
identify every unlabelled secret.

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
process exit retain precedence. Lifecycle transitions, new output, user input and removal invalidate pending classification.
There is no Checking state. Ambiguous results say
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
Refusal voice. Full tile placement no longer calls Refusal. The retained Refusal preview obeys Alerts and its
volume without verdict settling or debounce. Context resume, gain ramps, asynchronous
decode cancellation and cleanup are owned here. Audio failure leaves terminals and
visual status operational. Settings previews stop on replacement/unmount and after
five seconds for Working (two seconds for other kinds). No synthesis remains.

## Board shortcut definitions

`main/window/commands.ts` owns the command registry: IDs, native and wordmark
labels, platform bindings, enabled/checked state, agent badges, shortcut-sheet
rows, native roles and actions. `app-menu.ts` projects this one registry two
ways: every implemented command to the macOS menu bar, and a curated, fixed
layout to the wordmark menu on every platform. The wordmark projection is data
only (`AppMenuEntry`): commands, separators, the Settings submenu (the agent
routes come from `main/agents/agent-list.ts`, followed by Via Settings UI), and a
`size` row carrying Bigger/Smaller and main's current interface scale. Action log
is an enabled board command in both the wordmark and macOS menus; it has no direct
shortcut binding.
Main owns one `before-input-event` dispatcher; native accelerators are
display-only (`registerAccelerator: false`). Windows/Linux have no native
application menu. The existing two-second Ctrl+Shift+Space tile leader resolves
from the registry; blur, timeout and unmatched input cancel it. Alt alone and F10
open the wordmark menu. Plain Ctrl letters and numbers reach the terminal; the
Keyboard shortcuts binding is Ctrl+Shift+/ (Command+/ on macOS).

The `app-menu:list`, `app-menu:shortcuts`, `app-menu:execute` and `app-menu:view`
invoke handlers accept only the owning window's trusted top-level frame. Execute
accepts an existing, enabled command ID and awaits its action, so a Size step
resolves after main saves the new scale; it never accepts code, URLs, paths or
arbitrary terminal IDs, and it refuses submenu and row IDs and every disabled
command. Shortcuts returns the sheet columns generated from the registry for the
current platform; `app-menu:shortcuts` from main to renderer (no payload) asks
the board to show it. View accepts bounded tile counts and booleans solely for
presentation availability and the maximize checkmark. The board source exposes
this small typed capability. Add repository reaches the board as the
`add-repository` board command and uses the sidebar's picker path.
The three `via-<agent>` commands use the same registry for native and wordmark
menus. Main derives their availability from discovery and saved agent switches;
the board reports config-launch availability separately from tile availability,
so Settings can stay open while choosing an agent. Preflight disables these routes. Availability refreshes on menu reads, execution, window
focus and settings updates. The preload accepts only the three fixed route IDs.
The board dispatches the existing `config-launch` command with `origin: "menu"`,
awaits the source's refreshed inventory, and opens the running config session
through normal cross-window selection. This optional, validated origin changes
only notifier confirmation presentation: main uses a trusted disclosure dialog
for menu launches and keeps click-again for sidebar launches. It grants no consent
and cannot change the executable, directory or launch policy.

The renderer reuses RowMenu's keyboard navigation, portal and dismissal behavior.
RowMenu renders a submenu as a nested portal anchored to its item: the top-level
menu owns outside-press, scroll and resize dismissal for both, and each level
handles its own keys. A stepper row is one navigation stop whose buttons run
without dismissing; the app menu repositions rather than closing when an
interface size step resizes the window. Menu selection and native shortcuts
dispatch identical main-owned actions. Application-menu actions dismiss before
dispatch, independently of row-action confirmation cancellation. They restore
the previous focus and selection first, so native editing targets the original
input; navigation commands then own their destination focus. Escape continues to
return focus to the wordmark, including when a press on a disabled item left
focus on the body. The shortcut sheet is a modal `<dialog>` that closes itself
before restoring the focus it captured.
Development commands are omitted when packaged; packaged webContents also set
`devTools: false`. Quit goes through the app-level confirmed shutdown; Close Window hides its views unless it is the last Windows/Linux window.

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
facts/generic text rules**. Main chooses the agent from its launch record;
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
events, so they cannot trigger classification during streaming output. Existing generation/output guards discard stale results, exits stay
final. Permission hooks persist until a working hook, or a reply followed by fresh
working title evidence and no matching agent permission form; dismissal only hides attention.

Screen matching uses the existing 40-line host tail, capped to 500 characters per
line, and only the bottom nonempty lines or text after the last horizontal divider.
Titles and progress are separate local evidence. Pattern strings have a 128-character
limit; the regex subset forbids groups, repetition, alternation and backreferences.
Only fixed-width atoms, classes, anchors and approved escapes are accepted. A five
millisecond evaluation budget supplements those bounds; it is not presented as a
way to interrupt a running JavaScript regex. No matcher can type into a terminal.

Codex provider capacity/rate-limit/model-switch rules produce human-only `provider`
attention and fixed `provider_unavailable` control metadata; see
[the adapter limits](orchestration.md#provider-stalls-339). They cannot authorize replies. Codex provider history rules sit below working and
Action Required titles, so a resumed turn wins over a still-visible provider line.
Working and blocked rules produce fixed reasons and `rules:<agent>:<rule-id>` signals.
Idle evidence has low confidence and continues through generic rules,
never directly to Done. Workspace execution promotes an ambiguous result to Done
only after a recorded working-to-idle transition; Claude with hooks additionally
requires Stop, so title-only interrupts stay neutral. Initial readiness stays neutral. All rules run locally; no terminal content is sent to a model.


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
| Antigravity | Opt-in PreInvocation/PostToolUse observers | Screen rules | Fully idle Stop; error/step-limit Stop is failure |

Evidence precedence is: process exit; lifecycle hooks (including Codex); active permission hooks; agent-specific
blocked forms/titles; agent working titles; generic shell patterns; neutral fallback.
A blocked agent permission form wins over a simultaneous working title; Codex
provider history is weaker than a working title. Generic password,
yes/no and Enter strings do not override supported agent working evidence.

Hooks are strongest evidence. An explicit permission hook survives spinner frames
until a working hook proves progress, or user input is followed by a fresh working
title and classification finds no agent-specific permission form. Input alone and
dismissal never resume execution. A new permission hook resets that reply evidence.
Permission screen blockers beat working titles during
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
Antigravity lifecycle hooks use the opt-in #178 plugin; Claude and Codex global configuration
is unchanged. Observer hooks emit no permission decision.

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


### Antigravity plugin ownership

`agy-plugin.ts` owns status and serializes explicit install/update/enable/remove
operations. It reads at most 64 KiB from fixed Antigravity metadata paths because
`plugin list` omits version and enabled state. Unrecognized or unreadable metadata
is unavailable, never permission to overwrite. The sandboxed bridge accepts exactly
one enumerated operation on `agents:agy-plugin`; main validates the owning top frame
and chooses the executable and bundled directory. Settings and preflight share
inline agy row controls: Install, Update or Enable,
with Remove inside Plugin details. Install and update require a main-owned trusted
confirmation before the existing CLI path runs. The dialog discloses
`~/.gemini/config/plugins/foom`, observation without approval, no stored credentials,
inert behavior outside Foom launches, and removal through the row or
`agy plugin uninstall foom`. Main persists the profile-only boolean
`agyPluginOfferAnswered` after an answer (including Not now). Missing values default
to false; invalid values are rejected. Settings marks Agents and hooks with neutral
Plugin available text only for detected agy with no plugin and an unanswered offer.
The row action remains available after dismissal; no launch modal or toast is used.
No credentials, arbitrary commands, paths or plugin
names come from the renderer. CLI errors become fixed Foom messages.

The build ships the plugin outside ASAR under `build/observers/foom`. Versioned
metadata enables an update offer without silently changing an installation. Launch
adds credentials only when hooks are enabled and the installed plugin is active.
A private temporary per-launch counter orders background reports; it contains no
credentials and is removed with the launch binding. Observers allocate a sequence
under an exclusive local lock before starting transport. Main ignores duplicate or
older sequence numbers, including a delayed Stop from before newer progress.
A validated fully idle Stop recovers the turn identity if its working report was
overtaken, then classifies the current tail; questions and failures still win.
The observer sends fixed event and sequence headers with stdin JSON; the receiver validates them
against the Antigravity launch, pins `conversationId`, and emits only event/action,
terminal ID, validated conversation ID and enumerated Stop facts. The pinned ID
is retained as local session metadata for Resume and Copy session ID, using the
same validation and persistence as Claude and Codex. See the [probe record](agents.md#opt-in-antigravity-lifecycle-plugin-178)
for the documented-versus-observed Stop spelling and remaining platform verification.


## Sidebar panels and home shells (#197)

`PanelIntent` owns cancellable 400/120/250 ms hover timers, pinning and drag
suppression. The sidebar derives panel subjects and commands from its source;
`RowMenu` shares positioning, keyboard and main-owned confirmations between the
application menu and labelled sidebar dialogs. Panel facts load through the
source, ignore superseded replies and remain inert text. Session title edits
remain local view preferences. The theme subscription applies the validated
`panelColor` setting as root metadata; CSS forces undecorated panels for High
Contrast and increased OS contrast without weakening status outlines.

`workspace:panel-facts` accepts exactly a repository and worktree path from the
trusted top frame. WorktreeService validates registered membership and canonical
launch identity even on cache hits. Local Git reads use argument arrays and
three-second deadlines, and results are cached for three seconds per checkout
identity. Failed reads return null facts. The request never calls fetch: merge
comparison uses only the last successful default commit already fetched by the
cleanup service. Default-branch and last-fetch facts also read the local remote HEAD and FETCH_HEAD timestamp, including repositories with no linked checkouts. Sidebar eligibility supplies the same count used by cleanup.

Fact-copy actions use validated sidebar commands and main’s clipboard capability: home paths are main-owned, checkout paths require a registered checkout identity, and conversation IDs come from the selected session. Browser clipboard permissions remain denied.

`home-shell` is a path-free sidebar command. Main chooses the home directory and
shell, starts a normal sandboxed-host PTY and records `home: true` alongside
ordinary session metadata. Restore accepts home records only for shells with
matching home paths; previously running home shells restart when restore is enabled. Restart uses the same
main-owned launch path. Home sessions remain outside the Git repository tree
and repository-scoped agent control; no arbitrary cwd or executable capability
is added. The bounded shell version probe is main-owned and cached.

The read-only mockup reference is `docs/mockups/sidebar-panels.html`; its existing
README entry describes these panels. Contributor rules keep that reference
folder unchanged.


## Custom theme files (#205)

Main creates `~/.foom/config/themes/` for interface themes and
`~/.foom/config/terminal-themes/` for terminal palettes, alongside sounds.
`shared/theme-files.ts` is the platform-neutral parser for main and the offline
`foom config validate` command. Interface files contain exactly
`{ "kind": "theme", "name": "…", "base": "light" | "dark", "colors": { … } }`.
Colors require the original 19 interface tokens; `highlight` and `highlight-deep`
are optional only as a pair. Contrast remains mandatory. User themes report
brand-policy deviations as warnings; version 2 extensions and approval rules are
defined below. Built-in themes retain their strict validation.

Terminal files contain exactly `{ "kind": "terminal-theme", "name": "…",
"background": "#rrggbb", "foreground": "#rrggbb", "cursor": "#rrggbb",
"ansi": [16 colors] }`. ANSI order is black through white, then bright black
through bright white. Selection uses ANSI bright black. Like built-in terminal
palettes, arbitrary ANSI colors are permitted; interface status hue and contrast
rules do not apply to terminal output. Every color in either format is an opaque
six-digit hex value. Names are 1–40 letters, numbers, spaces, dots, underscores
or hyphens, with at least one nonspace character. Unknown keys, including `id`,
reject the whole file; files cannot choose or replace a built-in ID.

`main/themes/library.ts` reads at most 50 eligible JSON files per folder, at most
64 KiB each. Names are at most 100 characters, nonhidden and path-free. Reads
inspect an open descriptor, reject nonregular files and links outside the direct
folder, bound allocation, and recheck file and directory identity. Subfolders and
redirected theme directories are refused. Invalid names and nonfiles do not consume
the file budget. Previously loaded files are considered first so added files cannot
evict their last-good versions; remaining names are sorted. Folder failures produce fixed diagnostics.
The read descriptor closes before parsing or waiting for the config approval queue,
so a queued restore never waits behind a reader holding its rename target open.
The folder watcher debounces changes for 250 ms, reloads serially and closes on
shutdown. Parsed palettes and bounded diagnostics contain no absolute paths or
raw file contents; diagnostics have a filename, JSON path and fixed reason code.
They never echo parser exception messages or arbitrary unknown property names.

Main keeps the last good palette for a rejected edit during the current session.
A missing file disappears from the catalog. Invalid or missing selections after
restart use Follow without overwriting the saved ID, and recover when a valid file
returns. Built-ins precede custom themes; colliding names gain “(custom)”.
`theme:list` and `theme:open-folder` validate the owning top frame and exact argument
counts. Open accepts only the enumerated theme kind and chooses the folder in main.
Updates travel through `setup:changed`; native backgrounds, interface tokens,
terminal views and the headless terminal host receive the resolved colors. The
sandboxed preload adds no runtime imports and CSP remains unchanged.

## Foom config environment (#84)

`~/.foom/config` is the agent-editable configuration folder. It is not Electron's
userData: API keys, worktree ownership, the repository list and
consent records stay in the profile. The folder holds `settings.json`, `themes/`,
`terminal-themes/`, `sounds/{working,done,needs-you,refusal}/`, and Foom-owned
`README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore` and `schemas/` (JSON Schemas for
settings and both theme formats, generated from the shared validators). Foom writes
its files at first launch and replaces one on upgrade only when it is missing or
byte-identical to a version Foom shipped earlier (`OWNED_HISTORY`), so user edits
survive. `.gitignore` excludes recordings under `sounds/` and keeps `.gitkeep`
files so the folder structure is tracked. `WorktreeService` refuses to register a
repository that is, contains or sits inside the folder, checking before it runs any
git command there. The check is installed before saved repositories load, so a
conflicting saved registration is dropped, and config sessions refuse to start if a
registered repository contains the folder. `foom config validate` skips the Foom-owned entries and `.gitkeep`.

**Git.** If `.git` does not exist in the folder itself (a parent repository never
counts), main runs `git init` with an empty template and makes an initial commit;
an existing repository is left as it is. The repository is untrusted: an agent can
write `.git/config`, hooks, attributes and refs. `main/config/git.ts` runs every
call through `execFile` with an argument array, `--git-dir`/`--work-tree`, and:

- an environment without inherited `GIT_*` variables, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL` set to an empty Foom-owned file, `GIT_ATTR_NOSYSTEM=1` and no
  terminal prompts;
- `-c core.hooksPath=<empty Foom-owned folder>`, `core.fsmonitor=false`,
  `core.untrackedCache=false`, `--no-pager`, `core.pager=cat`, `core.editor=:`,
  `commit.gpgSign=false`, `log.showSignature=false`, `diff.external=`,
  `core.attributesFile=`, `credential.helper=`, `gc.auto=0` and `protocol.allow=never`.

The hooks folder, template folder and global file live in the profile's
`config-git/` and are recreated empty on every launch. Foom uses plumbing only:
`hash-object --no-filters`, `read-tree`/`update-index --cacheinfo` against a private
index, `write-tree`, `commit-tree`, `update-ref` with the expected old value,
`ls-tree`, `cat-file blob`, and `log`/`diff-tree` without patches, text conversion
or external diff. None of these reads filters, diff or merge drivers. Porcelain
`add`, `commit`, `status`, `diff`, `checkout` and `revert` are never used. Blob IDs
for comparisons are computed in main from bytes Foom read itself. After a commit
Foom mirrors the committed paths into the real index, best effort.

Before every git call Foom checks that `.git` is a real folder inside the config
folder, not a link or a `gitdir:` file, has no `commondir`, and that its `HEAD`,
`objects`, `refs` and `index` are not links. Otherwise git would follow them to
another repository and Foom would commit there. Redirected metadata, including a
replacement after setup, stops recording with a status naming the entry; settings
still apply from the file.

**Settings.** The allowlisted keys from #206 live in `config/settings.json`. On the
first launch with a version 1 profile, main writes them into a new `settings.json`
(an existing file wins and the profile values are dropped), then rewrites the
profile as version 2 without them in the same step. Values the file cannot express,
such as portable palette objects, fall back to the default. A version 2 profile
stores only profile settings plus `configDigest`: the SHA-256 of the settings file
this profile last applied. If the folder cannot be prepared, settings stay in the
version 1 profile and migration is retried at the next launch. On upgrade from either profile version, nonempty validated per-agent launch
arguments move once into settings.json when its key is absent. Invalid profile
lists retain the existing per-agent drop rule. The migration trusts only the
profile arguments, preserves other file holds, and records a recoverable approved
baseline before removing the profile copy. A failed migration retains the profile
copy for retry. An existing argument key remains a file proposal, compared against
the migrated profile defaults. Empty profile defaults leave the key absent.
Settings saves split
the patch: config keys are written to the file atomically and committed with a
subject naming the change; profile keys go to the profile. On Windows only, atomic
replacement retries EPERM/EBUSY up to five attempts with 25, 50, 100 and 200 ms
backoff for transient external sharing locks. It never unlinks the destination;
exhaustion removes the temporary file, reports a fixed error naming the config
file, and retains the existing file, applied values and pending approval.

**Live reload.** Main watches `settings.json`, `themes/` and `terminal-themes/`,
waits 250 ms after the last event and scans serially. When `themes` or
`terminal-themes` is replaced, the root watcher resubscribes to it. Reads refuse
links, nonregular files and files over 64 KiB; a theme folder that is a link or
resolves elsewhere is refused for reads, writes and removals, so nothing outside the
folder is committed or deleted. `settings.json` is compared with the text
Foom last applied, theme files with the last commit. Settings use the #206 parser
and theme files the #205 parser; an invalid file is rejected whole with a filename,
JSON path and fixed reason, and the last good version stays in effect. A valid
settings change applies live and is committed (Settings saves return once applied;
each save is committed from its own snapshot right after). If a commit fails, a
later scan records the applied file again; valid theme additions, edits and
removals are committed one file per commit (the theme library applies them through
its own watcher). Sound catalogs still refresh when Settings → Sound opens.

**Approval.** A change is held instead of applied when, compared with the effective
settings in force, it turns alerts off, sets the alert volume to 0, turns hooks off,
or turns an agent off, enables restoreSessions, or changes any agentArguments list. A missing key means the default. Sizes and turning things on apply without approval. Theme changes follow the
attention-distinctness hold described below. Settings → Foom config
and the config footer dock show the held change in amber. The held change carries an ID,
the digest of its text, and a decision must name it: if an agent replaced the
proposal after the banner was shown, the decision is refused and the new one shown.
**Allow** rechecks that the file still has the held content, applies it and commits. **Keep it on** writes back the
last applied text (the last commit's bytes when they match it) and commits that if
the last commit differs. At startup the working file is trusted only if its digest
matches `configDigest`; otherwise the last commit is trusted if its digest matches;
otherwise the baseline is the defaults (`{ "kind": "settings" }`), so an off switch
written while Foom was closed, or committed by an agent, is held and Keep it on
restores a valid default file. A Settings save replaces a held change. Every file argument change holds,
regardless of known bypass detection. Allow opens the existing main-owned trusted
dialog containing literal before/after lists and known bypass flags, then rechecks
the proposal bytes before applying. Accepted bypass changes persist per-agent
acknowledgement in the profile. Argument text never enters board status metadata.
Settings UI edits use the config writer directly and retain their bypass dialog.

**Recent changes and Revert.** Status lists the last 20 commits with time, subject,
files and short hash, merged with rejected and pending entries recorded this
session. Revert accepts only a full commit ID from that list whose paths are all
`settings.json` or theme files, and refuses commits that would delete
`settings.json` or whose files changed since. Foom writes each path's parent
version (or removes an added file) and scans; the result is validated, held or
committed as `Revert "<subject>"` like any other change. This replaces the
`git revert` the issue proposed, whose merge machinery can run repository-configured
merge drivers and checkout filters.

**Sessions and IPC.** The board's Foom config footer panel runs agents and shells in the
folder: no worktree, no repository-scoped control grant, the usual per-launch hooks
and evaluator, the same Environment layers as other sessions, and the bundled
console directory first on `PATH`, ahead of Environment entries, even if the CLI was
never installed. A new agent config session receives a fixed, main-only greeting
that asks what the user wants to change; resuming a conversation adds no greeting.
Antigravity receives it only when interactive prompts are supported, preserving
any user default prompts. `config-launch` carries no prompt.
One config session runs at a time; a second launch starts
nothing and the renderer focuses the running session. Session records keep a
validated `config` flag (folder path equal to itself, no branch) and restore only
for the current folder. Sidebar commands
`config-launch` (a run kind and optional menu origin) and `copy-config-path`
carry no paths.
`config:status`, `config:decide` (`allow` or `keep`), `config:revert` (a full hex
commit ID) and `config:open-folder` check the trusted top frame and exact argument
counts; main pushes `config:changed`. File contents, raw parser messages and
absolute paths other than the folder itself never reach the renderer. The folder
never holds secrets; Foom sends nothing from it to any network service.


### Foreground shell program names

For explicit shell launches, the terminal host reads node-pty’s foreground process name on Linux and macOS. Output triggers at most one lookup per second, coalescing throttled output into one trailing lookup so the final prompt clears names in shells without lifecycle markers; Bash lifecycle markers force a refresh and prompt completion clears the name. Because PS0 precedes the fork, command start also schedules one lookup after 100 ms for silent commands. Completion, removal and exit cancel it; no idle terminal is polled. The host suppresses the launched shell’s own name, rejects paths, whitespace and control characters, and bounds the name to 32 printable characters. Windows never queries ConPTY for this metadata. A validated ID-scoped host event reaches main only for live owned terminals, updates the existing workspace session snapshot, and passes through the board source as text. Session persistence omits the field.

## User interface themes version 2 (#246)

User theme files accept `{ version: 2, name, base, colors, areas?, states?, shape? }`
with optional `kind: "theme"`. Legacy kind-based files and version 1 remain valid;
built-ins retain their strict version 1 validation. Terminal themes are unchanged.
The global colors and optional paired highlight colors remain required as before.
Every nested object has exact keys, colors are opaque six-digit hex, files are at
most 64 KiB, and no file data becomes a selector or raw CSS.

Areas override a subset of colors: sidebar on `.sidebar-shell`, tiles on
`.tile-area` and `.terminal-tile` chrome (terminal content retains its independent
palette), panels on `.row-menu.sidebar-panel` (including tile panels), dialogs on
Settings, preflight and confirmation/dialog roots, menus on row menus/submenus and
the wordmark menu. Portal roots get their own area variables. Raised colors derive
at each root from its effective palette. State colors override selected, hover,
focus and scrollbar colors; omitted values retain existing derivations. Shape
supports radius 0–12 px, panel-radius 0–16 px, border 0–2 px and shadow 0–1.
Panel radius inherits an explicit control radius when omitted. Existing
per-element radius fallbacks preserve built-in geometry; circles and
intentional zeros remain literal.

Contrast below 4.5:1 rejects the whole file, retaining the last good theme. It is
checked globally and against every area's effective bg/surface for ink, muted,
accent, highlight and status inks, plus badge and space-ink pairs. Brand hue,
reserved-color, color-distance, base-luminance and hole deviations are warnings.
Warnings contain a filename, fixed JSON path, fixed reason and warning severity;
Settings lists Applied · N warnings and the CLI prints them with exit status 0.
Parser exceptions and file contents never travel to the renderer.

Both the config scanner and theme library pass through a serialized main-owned
approval gate. An edit to the active theme's file holds the palette when it adds
an attention conflict: a color pair within ΔE 40 of attention, globally or in an
area, that the approved version lacks. Pairs are compared individually, so an
approved pair never approves a new one on the same color. Selecting a warned
theme through settings.json also holds. Inactive themes, hue-only warnings and
direct Appearance selections do not hold. Attention distinctness includes
separation from readable ink as well as failure, accent, highlight and done.

The approved version is the one this profile last applied, recorded as a
per-file digest in the profile like the settings baseline. Agents can commit in
the config folder, so a commit alone never approves a palette: after a restart,
a committed theme counts only if its digest matches. Allow verifies the proposal
digest and current bytes and records the new digest. Keep it on restores the
approved version, or a committed version with no attention conflicts; when
neither exists it switches `interfaceTheme` back to the default and leaves the
file in place.

## Previews

Main owns a `PreviewHost` per board window and registers the standard, secure
`foom-preview` scheme before readiness. Each view has an in-memory `preview-<id>`
partition and an origin named by a random 128-bit ID. Its session handler captures
`canonicalRoot` once at preview open and passes only that root and its exact
`foom-preview://<id>` origin to `readPreview`. URL normalization
precedes per-segment decoding; credentials, ports and foreign origins are refused.
The pure policy rejects empty/dot segments, encoded separators, NUL, controls,
hidden names and Windows aliases (colons, trailing dots/spaces, device names and
reserved characters) on every OS. Queries and fragments do not name files.

Resolution uses `realpath.native`, a byte-exact root/separator comparison with no
case folding, and another segment check after symlinks. Directories resolve their
`index.html` through the same containment checks. Main stats before opening,
refuses non-files, opens the resolved path with `O_NOFOLLOW | O_NONBLOCK`, and
verifies descriptor type and `dev`/`ino`. Windows exposes neither flag through
Node; zero substitutes explicitly there, with the descriptor checks retained.
Only the verified descriptor supplies bytes; reads are bounded by its checked
size (16 MiB, or 2 MiB for Markdown) and handles close even on read failure.
`openInside` transfers handle ownership to its caller, which must close it.

Malformed paths return 400, escapes/hidden targets/non-files 403, missing or
unreadable files 404, and oversized files 413. Types use a fixed extension map,
with unknown extensions served as `application/octet-stream`. Success and refusal
headers include `nosniff`, `no-store` and `no-referrer`; HTML uses the default CSP
in `docs/previews.md` §4, and Markdown has no inline scripts, frames or workers.
There is no network-enabled policy. Each session filters requests to its own
origin plus `data:` and `blob:`, denies permission checks, permission requests and
device requests, and prevents downloads. The view has no preload, uses sandboxing
and context isolation, disables Node integration (including workers and child
frames), dialogs, drag navigation and webviews, and disables devtools in packaged
builds. Window opens and redirects are denied. Only same-origin `.md` or
`.markdown` page navigation is allowed; HTML and external links are blocked.
Markdown rendering and the confirmed external-link/network flow remain separate
follow-ups.
Every non-hidden file in the captured worktree is readable by a preview page.

As in the spike, a parent directory swap between realpath/stat and open is not
fully prevented: `O_NOFOLLOW` protects only the final component. Descriptor
identity checks catch a different opened file, but are not an atomic directory
traversal guarantee. This residual race must not be treated as a general-purpose
filesystem sandbox. Junction escape tests run on Windows; all pure filename and
URL rules run on every OS.

The main-owned registry stores `{ id, worktree, relativePath, network: false }`
per stable window ID in profile JSON, with bounded validation and serialized
atomic writes. Paths never enter layout localStorage. Opens revalidate membership
and canonical checkout identity against registered worktrees, then validate and
read the contained document. `preview:open`, `preview:close` and `preview:bounds`
use `WindowIpcRouter` to validate the owning board, exact app URL and top frame,
and validate argument counts, document paths, IDs and finite bounded rectangles.
IDs grant access only within their owning window. Sidebar inventory reports those
IDs and display facts; renderer UI placement and measurement belong to #296.
Restored registry entries stay detached and allocate no view until bounds arrive.
Worktree removal closes previews when workspace inventory refreshes.

An unfocused preview never acquires keyboard focus on open, reload or navigation. Main loads
it detached and attaches only after `did-finish-load`, when its board rectangle is
visible. Main-frame reloads and allowed navigation replace the old native
contents with a fresh detached view in the same partition, preserving ID and bounds.
If the old preview held user focus, the replacement receives focus after loading
and attachment, unless the user clicked elsewhere while it loaded. Before detaching
or closing a user-focused preview, main blocks the board's native keyboard events
(including shortcuts) until that handoff completes. Native fallback focus does not
cancel the handoff; a native mouse-down on the board or another preview does,
allowing ordinary input immediately. Hiding or closing the pending preview also
unblocks board input. These listeners belong to the host and are disposed with it.
Recreation is bounded to once per 250 ms per preview; the old contents closes immediately
and only one replacement can be pending. Closing cancels pending recreation.
A previously clicked native contents can reacquire keyboard focus during reload on
macOS even when detached; replacing it prevents that remembered focus grant.
`did-start-loading` also detaches any loading view. Refused navigation leaves the
loaded view in place. A native mouse-down grants focus; navigation carries that intent to the replacement.
Blur or detachment otherwise revokes the native click grant. Unsolicited
focus on an attached view returns to the last human-focused contents. This guard
supplements detached loading; returning focus after load alone loses keystrokes.
Main scales CSS rectangles by board zoom, applies that zoom to each view, clamps
them to window content bounds, and refreshes on resize and interface-scale changes.
Closing destroys contents, unregisters its protocol/request handler, clears storage
and cache, and removes the registry entry. Quit preserves validated registry
metadata while releasing views and partitions. Watchers and live reload are #294;
there are no watchers to stop yet. Overlay composition and shortcut forwarding
remain #292.

### Terminal font selection (#363)

Main enumerates installed monospace families with fixed `execFile` arguments:
Fontconfig `fc-list` spacing 100 on Linux, AppKit fixed-pitch fonts through a fixed
JXA script on macOS, and WPF glyph advance widths through a fixed PowerShell script
on Windows. Commands accept no renderer data, have bounded output and a ten-second
deadline, and return an empty list on failure. `setup:terminal-fonts` checks the
trusted top frame and accepts no arguments; preload exposes only the family list.
No font permission, sandbox, context isolation or CSP changes are needed.

`terminalFont` defaults to `Hack Nerd Font Mono` and uses the shared config settings
validation for IPC and disk. Family names are 1–128 Unicode letters/numbers, spaces,
dots, underscores, parentheses, plus signs or hyphens, beginning with a letter or
number and without leading/trailing whitespace. Main validates enumeration output;
the renderer revalidates lists and settings before constructing a quoted stack.
Every stack retains the bundled Hack Nerd Font Mono, Geist Mono and `monospace`
fallbacks. Uninstalled families remain saved and degrade silently. Controllers
apply family and size together through their existing settings subscription,
refitting visible attachments and deferring hidden grids until attachment. Settings
uses the same stack for its preview.
