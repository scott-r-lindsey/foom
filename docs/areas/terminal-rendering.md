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
sixth tile. Each of five streams writes 100 80-byte records every 20 ms for 16 seconds
(literal backslash-r/backslash-n separators, wrapping at the terminal's grid width).
CPU is the delta of Electron's cumulative process CPU time divided by elapsed
wall time (100% is one core). Tracing and Playwright add overhead. This fixture
explicitly disables GPU acceleration to keep DOM echo observable; GPU-process
CPU is software-compositor evidence, not hardware WebGL performance or physical
key-to-photon latency. Intentional cursor blinking remains in the idle trace.

## Streaming and covered tiles (#711)

After `pnpm run build`, run
`MEASURE_LABEL=before xvfb-run -a node --test tests/electron/streaming-measurement.js`
on Linux; repeat with `MEASURE_LABEL=after` after rebuilding the change. This
fixture uses nine isolated shells running bounded Node output fixtures: five
streaming tiles, three detached streams, and a sixth visible shell for echo
probes. No real agent CLI runs. Each stream emits 100 actual 78-byte CRLF lines
every 20 ms for 32 seconds. The 1800×1200 board first measures six visible tiles,
then maximizes the echo tile over the other five. Each phase records ten
key-to-DOM-echo probes, animation-frame intervals, process CPU deltas and a
Chromium trace in ignored `test-results/<label>-<phase>*` files. Reports include
screen dimensions and row counts. CPU uses 100% for one core; the fixture retains
sandboxing and the controlled login shell/PATH. Like the idle fixture, it uses
DOM with GPU acceleration disabled: GPU-process CPU measures the software
compositor, not hardware WebGL performance, and echo includes Playwright overhead.
Compare repeated runs on the same machine rather than enforcing timing thresholds.

Fully covered terminal screens use `display: none` after the 180 ms tile fade
(immediately with reduced motion). Chromium skips their layout and paint, while
xterm's existing intersection observer defers regular refreshes and requests a
complete repaint when restored. Selection/resize work may still update the
backing renderer; this does not establish hardware WebGL savings. The xterm,
attachment, parser, acknowledgement path and outer fitting box remain live.
Uncovered tiles and native window occlusion keep their existing rendering policy.

## Visible streaming investigation (#711)

The [source-mapped profile, repeated measurements and rejected prototypes](../../spikes/terminal-streaming/README.md)
record the visible-streaming investigation. In the measured DOM/software-
compositor workload, native layout/paint/raster and xterm row construction dominate;
per-chunk controller/ACK JS, activity and React samples are much smaller. The
steady fixture produces no attention/state events or per-chunk sound updates.

Frame coalescing with focused-terminal bypass reduced ACKs but did not establish
a consistent CPU/latency win. Compositor promotion lowered renderer CPU while
raising GPU-process CPU substantially; row containment and an alternative dimming
paint also failed the combined CPU/latency test. None ships. Visible terminal
writing, parsing, acknowledgements/backpressure and input scheduling remain
unchanged; only the separately measured covered-screen optimization is retained.

The benchmark supports `MEASURE_PROFILE=1` to save a renderer V8 `.cpuprofile`,
`MEASURE_VISIBLE_ONLY=1` to omit the covered phase, and `MEASURE_PROBES=1..30`
(default 10). Probe gaps vary to avoid sampling one animation-frame phase.
Experimental `MEASURE_LAYER=0|1`, `MEASURE_CONTAIN_ROWS=0|1` and
`MEASURE_DIM_OVERLAY=0|1` flags assert/record computed styles before measuring.
Fixture counters record data/ACK volume, activity, state changes and replaced
sidebar rows. Source-map instructions and eight prototype fidelity tests live in
the reference report; no instrumentation or rejected candidate ships in the app.
