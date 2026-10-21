# Renderer

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/attention.md).

## Renderer

Board windows disable Electron's `backgroundThrottling`. Native occlusion must not
suspend the board's animation frames or an attached terminal's paints, including
across the initially hidden window's show transition. Board activity and mounted
terminal views therefore keep rendering while a window is covered, minimized or
hidden; this trades background rendering work for continuous display updates.
PTY consumption remains owned by the utility host and independent of painting.
Electron reports document visibility as visible with throttling disabled, so
native visibility/focus checks remain necessary for window reachability.

Agent preview attribution (#298) comes from main: the host keeps the opener’s
terminal ID and agent identity as transient display facts, stripped from registry
persistence and restart restoration. Sidebar-only entries nest below the opener;
if the session has closed, attribution stays and the row falls back to its worktree.
The broker retains the latest 256 successful opens (including reuse) for session
panels, independently of preview lifetime; the existing redacted audit is the
persistent action log. Neither history includes page contents. Showing a row uses
human tile placement. Tile arrivals are local view state with accent tint and an
edge, cleared by hover or focus, with reduced motion disabling the flare.

**Today:** The board uses React 19 with TSX and reads one typed source through `useSyncExternalStore`. Each stable tile mounts one imperative terminal controller through the source adapter using `board/terminal-tile.tsx` and disposes xterm and subscriptions on unmount. Terminal attachment and measurement remain in the controller to preserve attachment ordering. Board focus and pane selection are independent view state; hovering or focusing a row does not fetch terminal output or select a terminal. The source also supplies path-identified repositories and their complete Git worktree inventory, including empty worktrees and the main checkout, plus validated main-process navigation commands. `sidebar-model.ts` computes stable pin/active/idle sections, filtering, hidden attention counts and roll-ups. `sidebar-view.tsx` renders the tree (or compact session rail by window choice, forced below 720px), with view state, panel intent and row action builders in `use-sidebar.tsx`, and responsive collapse, overlay and toggle focus handling in `use-sidebar-layout.ts`. `board-view.tsx` composes tile placement and view reservations from `use-board-tiles.ts` and DOM-only activity and wait-label subscriptions from `use-board-activity.ts`. Repository and checkout name clicks do not change the terminal pane. Sidebar focus does not attach a terminal; only the board's presentation callback requests that from the tile controller. Open row panels derive actions from current source data so delayed eligibility updates are visible without reopening. `row-menu.tsx` portals panels to the document body, positions them from the row’s viewport rectangle, and owns keyboard navigation and dismissal. `sidebar-preferences.ts` validates versioned localStorage metadata for pins, expansion and terminal-ID names; this metadata grants no process or filesystem capabilities. Each pin, expansion choice and name is written independently under `foom.sidebar.v2.` keys; only fields changed from the rendered snapshot are saved, so stale windows cannot overwrite unrelated edits. The v1 snapshot remains a read-only fallback, with explicit false/null tombstones for resets. A disposable external store observes storage events and rereads current validated metadata (rather than replaying potentially stale event values), feeding React through `useSyncExternalStore`. Tile layout and sidebar collapse/width remain per-window. Session restoration follows the [saved-conversation contract](sessions.md#saved-conversations): eligible running sessions launch fresh PTYs when enabled; screens and scrollback are never persisted. Activity batches feed a disposable DOM-only light controller with logarithmic rate mapping, 120 ms attack and 700 ms release. It holds rate targets for at least one third of a second, writes brightness, scale and halo styles, and samples bounded eight-second SVG traces at 4 Hz in sidebar rows. Trace history independently retains the maximum mapped rate observed during each sample window, bypassing the glow target hold and attack/release envelope. A peak is reset only after sampling, including one-second reduced-motion windows. Reduced motion renders four brightness steps and trace samples at 1 Hz without scaling. Latest activity rates are cached independently of mounted histories, including final zero batches while rows are hidden. New subscribers receive cached rates so remounting cannot revive stale snapshot activity. Closed, exited and nonmoving sessions discard history; unmount removes subscriptions and timers. A separate clock updates wait labels without React commits. Activity goes directly from IPC to light styles without changing the React row snapshot.

`agentOutputLevel` and `shellOutputLevel` are separately tested entry points using
`min(1, ln(1 + max(0, rate)/40) / ln(101))`: 0 B/s → 0, 200 B/s → 0.39,
4,000 B/s → 1. [Measured rate rationale (#412)](https://github.com/scott-r-lindsey/foom/issues/412) records the version-specific rates; keep glow and trace scaling consistent while preserving their separate peak/envelope behavior.
Trace coordinates map level 0–1 to y=11–1 in a 34×12 viewBox (10 px excursion).
A constant rate intentionally produces a horizontal line above the baseline.

- **React 19 with TSX**, bundled by esbuild as a production build (`process.env.NODE_ENV` defined). No other UI framework, component kit, or CSS-in-JS. Styles are plain CSS using the tokens in `tokens.css`.
- **The renderer holds view state only.** Terminal, verdict, and worktree truth lives in main and arrives through `window.desktop`. Components don't call the bridge directly; they read from one board data-source interface shaped like the IPC contract. A sample source serves explicit development builds and tests; the app uses the live source.
- **High-frequency data bypasses React.** Activity arrives about 10 times a second for up to 10 terminals. A small subscriber writes each light's brightness to a CSS custom property on the light element; React re-renders only when structure or verdicts change. Terminal output never goes into React state.
- **xterm.js stays imperative.** One component owns the `Terminal` through a ref, creates it once, and keeps the attach, drain, reset, fit, snapshot, acknowledgement, and reply-suppression order described in [Terminals](terminals.md).
- **Keyboard first.** Every board action works without a mouse. The Electron suite runs axe; serious or critical violations fail.
- **Linting:** `eslint-plugin-react-hooks` and `@eslint-react/eslint-plugin` on top of the existing type-aware rules. `eslint-plugin-react` and `eslint-plugin-jsx-a11y` don't support ESLint 10 and are not used.
- **Coverage and lint globs include `.tsx`.** A component outside them would silently skip the per-file thresholds or the renderer import restrictions.
- The CSP doesn't change. React needs no `eval`.

## Flight art and About (#670)

`ui/flight-art.ts` shares typed canvas drawing between the first-run flight path
and About's full-bleed illustration. `flight-canvas.tsx` owns animation and disposal,
pauses on window blur, and draws a single reduced-motion frame. About is a modal
portal with view state only; its note reuses `.row-menu` surface, notch and opening
animation, returns focus to its button on dismissal, and closes before About on
Escape. The native About panel is gone. `app-menu:version` returns main's app and
Electron versions through a bounded, runtime-validated preload capability.
