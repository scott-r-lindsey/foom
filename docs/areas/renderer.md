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

## Flight art and About (#670, #725)

`ui/flight-art.ts` shares the original procedural stars, depth/warp layers,
rocket and flight geometry between first-run flight and About's full-bleed
illustration. `singularity.ts` uploads those already-drawn star layers as the
WebGL sampler, then composites only a disc of three shadow radii around the hole.
Its outer band (2.1–3 radii) feathers back to the unchanged source sky. Pixels
outside the disc are never cleared or painted by the compositor. There is no
second sky texture, injected alignment star or full-viewport replacement.
The finite lookup also fades back to the original coordinates before its
rectangular boundary, so a passing star cannot expose its edge.
The offline R3 Schwarzschild map bends the original stars; a small reconstruction
filter softens magnified streaks into starlight rather than a hard white circle.
The two map halves hold 16-bit signed sky coordinates (±256 M); blue channels
hold escape visibility and actual shadow coverage. It does no runtime ray tracing.
The rocket and its trail draw in front of the disk and lensed arch, preserving
the original flight path and About hit area. The sky plane sits 16 M behind
the hole, keeping its Einstein ring inside the baked field of view.
Without WebGL, on initialization failure or context loss, Canvas2D layers the
same baked transparent still over the existing starfield. A loading failure
retains an opaque black shadow.

`flight-canvas.tsx` owns animation and disposal. It pauses on window blur and
hidden documents, unmounts with its surface, and draws a still reduced-motion
frame. About explicitly deactivates its canvas when replay covers it. Loading
assets and resizing can repaint a paused still without starting a frame loop.
A disposable ResizeObserver also updates the rocket hit area after layout/zoom
changes. GPU resources are owned per surface, released on disposal, and capped
at 1440 pixels across the local disc independently of display pixel ratio.
The board schedules no flight frames when these surfaces are absent.

About is a modal portal with view state only; its note reuses `.row-menu`
surface, notch and opening animation, returns focus to its button on dismissal,
and closes before About on Escape. `app-menu:version` returns main's app and
Electron versions through a bounded, runtime-validated preload capability.

### Reproducing the flight assets

Run `node scripts/bake-flight.mjs` with Node 24. It reuses
`scripts/icon/blackhole.mjs`, the approved `VIEW` / `TONE` in `foom-icon.mjs`
(roll −25°, inclination 83°), and the shared PNG encoder. The icon's tile
centre offset is removed so the shadow aligns with flight geometry; the sky
plane distance affects lensing without changing its emitted light. The three
checked-in files under `src/renderer/art/` total 915,195 bytes (0.87 MiB):

| Asset | Dimensions | Bytes | Purpose |
| --- | --- | ---: | --- |
| `singularity.png` | 512 × 512 | 141,180 | Straight-alpha fallback, emission plus opaque shadow |
| `emission.png` | 512 × 512 | 142,866 | Opaque RGB light for GPU composition |
| `lens.png` | 1024 × 512 | 631,149 | Two coordinate halves, 16-bit values, visibility and shadow |

The build copies only these local assets into the bundle. Each URL is explicitly
allowlisted by `main/wiring/application.ts`; images remain within `img-src 'self'`
without changing CSP, enabling fetch or permitting remote assets. The bake
round-trip test checks byte reproducibility, map opacity, shadow coverage and
the aggregate asset budget.

### Measuring flight work

After `pnpm run build`, run
`MEASURE_LABEL=after xvfb-run -a node --test tests/electron/flight-measurement.js`
on Linux. Like #697's idle measurement, it uses isolated harness profiles,
Chromium traces and cumulative per-process CPU deltas. It settles for one second
then samples six seconds each of About, launch, the closed board and reduced
motion. Linux explicitly uses SwiftShader software WebGL, so GPU-process CPU
is software-rendering work, not a hardware GPU-utilization measurement. Reports
and traces go to ignored `test-results/flight-725/`; screenshots go to untracked
`screenshots-725/`. No real agent CLI or everyday profile is used.

## Modal focus restoration (#852)

Settings and Action Log retain the last focused board element while covered.
Closing them restores that element, including an xterm textarea, rather than
always selecting a sidebar row. Interim tile focus while reattaching does not
replace the saved xterm target, including during rapid Settings reopening.
Restoration captures its expected DOM target and request generation at dismissal, before React queues the
view focus effect. Queued terminal focus restoration is cancelled by a newer DOM focus choice, another focus
request, hiding the view for a new modal, or unmounting it (#903). Explicit tile
focus still completes after the browser's own click focus action. An earlier queued
modal hide may blur the opener to the document body; that implicit fallback does
not revoke a later dismissal's restoration request.
Trusted scrims, About, legal views, action errors
and menu dismissal share `board/focus-restore.ts` for detached or unfocusable
opener fallback. A coalesced prepare/dismiss pair still commits its dismissal effect, even when
the final visible flag is unchanged. Serial handoffs retain the original focus
until the scrim is actually removed, with a stable native-popover ref.
Scrim restoration runs in a layout effect after removing the top-layer popover;
its native focus cleanup must finish before selecting the fallback. A closed
terminal falls back to the stable sidebar navigation root ahead of session rows,
which can disappear when a later workspace snapshot reaches the renderer.
Restoration requires no delayed focus retry. DOM restoration
never requests native app activation. Native
trusted-window restoration follows the [confirmation rules](confirmations.md#focus-restoration-852).
