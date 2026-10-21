# Terminal Rendering

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/tiles.md).

## Tile renderer measurement

After `pnpm run make`, run
`xvfb-run -a node tests/electron/tiles-measurement.js` on Linux (omit Xvfb on
other platforms). It starts the packaged app with a private profile and temporary
repository, opens six real terminal tiles, and floods two of them for 12 seconds.
It records ten seconds of animation-frame intervals, browser long tasks, and ten
input-to-render probes on another terminal, plus final flood byte counts. The
fixture uses the DOM renderer and retains sandboxing. Measurements are machine-
and workload-specific; record the report and interpretation in the PR rather
than treating frame timings as portable pass/fail thresholds.

### WebGL renderer (#620)

Visible terminal controllers load matching `@xterm/addon-webgl` 0.19.0 after xterm
6.0.0 opens and before the visible grid is fitted/attached. Each mounted shell
still owns one xterm. A page-local budget permits at most 12 visible WebGL addons;
overflow uses DOM and can claim a free slot on a later attachment. Hidden views
dispose their addon; unmount also disposes xterm and subscriptions. Initialization
failure or the addon's context-loss notification permanently selects DOM for that
controller. Recovery preserves the xterm, scrollback, PTY and attachment token;
it never resets or reattaches. The controller refits and resizes the same view
because DOM/WebGL cell-width rounding differs. Parser and view backpressure are
unchanged and independent of GPU resources.

The [evaluation and raw reports](../../spikes/xterm-webgl/README.md) include functional
SwiftShader assertions, a 16-context exhaustion probe and 18 occupied tiles with
12 actual WebGL2 contexts and six DOM fallbacks. Six saved visual pairs cover
palettes, selection, cursor, fonts, font sizes and interface zoom. Logical content
and colors match; rasterization and fitted columns differ, particularly at small
font sizes. No sandbox, CSP or asset-allowlist changes are needed: the existing
renderer bundle contains GLSL strings and creates in-memory glyph atlases, with
no new protocol URLs, worker, WASM, eval or network assets.

Performance measurements and hardware/driver limits: [#620](https://github.com/scott-r-lindsey/foom/issues/620) and [raw reports](../../spikes/xterm-webgl/README.md).

Performance evidence does not establish presentation/input latency or marginal GPU memory. Reports must state dimensions, normalized grids, GPU/driver and memory attribution limits. SwiftShader timings and failed-context DOM runs are not hardware WebGL performance evidence.

## Idle-quiet board (#697)

Terminal output does not justify unrelated board polling. After activity and trace
history settle, the board's light, wait-label and audio controllers sleep until
source or DOM structure events require work. A mounted terminal's intentional
cursor blink and live output remain independent of that rule. Preserve PTY parser
and attachment backpressure; measurements must show a main-process forwarding
bottleneck before changing output IPC batching.

`pnpm run build` followed by
`MEASURE_LABEL=after xvfb-run -a node --test tests/electron/idle-measurement.js`
records idle and five-stream traces plus CPU summaries under `test-results/`.
It uses the isolated Electron fixture harness, six visible DOM terminal tiles in
an 1800×1200 window, 22 seconds of settling, and ten key-to-DOM-echo probes in the
sixth tile. Each of five streams writes 100 78-byte lines every 20 ms for 16 seconds.
CPU is the delta of Electron's cumulative process CPU time divided by elapsed
wall time (100% is one core). Tracing and Playwright add overhead. This fixture
explicitly disables GPU acceleration to keep DOM echo observable; GPU-process
CPU is software-compositor evidence, not hardware WebGL performance or physical
key-to-photon latency. Intentional cursor blinking remains in the idle trace.
