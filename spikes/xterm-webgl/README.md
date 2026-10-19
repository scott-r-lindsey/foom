# xterm WebGL evaluation (#620)

Research only, 2026-10-19, Linux x64. **Retain the DOM renderer; defer WebGL.**
This environment cannot provide a valid GPU comparison. No application source,
production dependency, security policy or packaged asset changes are included.
The issue remains open for measurements on GPU-capable infrastructure.

## Method and reproduction

Requires Node 24, the pinned pnpm, Xvfb and the ordinary Electron test prerequisites.
From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --dir spikes/xterm-webgl install --frozen-lockfile
pnpm run audit
pnpm --dir spikes/xterm-webgl audit --audit-level=low
pnpm run build
node spikes/xterm-webgl/build.mjs
for renderer in dom webgl; do
  for tiles in 4 9; do
    FOOM_WEBGL_RENDERER="$renderer" FOOM_WEBGL_TILES="$tiles" \
      xvfb-run -a -s '-screen 0 1920x1200x24' \
      node --require ./tests/helpers/setup.js --test spikes/xterm-webgl/measure.cjs
  done
done
```

The root lockfile is unchanged. The spike pins addon-webgl 0.19.0 in its own
lockfile. Its published package identifies upstream commit
`f447274f430fd22513f6adbf9862d19524471c04`, matching the xterm 6.0.0 release.
Both audits found no known vulnerabilities.

`build.mjs` bundles the real renderer with an in-memory transform of the imperative
shell controller. It loads one addon immediately after `terminal.open`, before
initial attachment, registers DOM fallback on context loss, and uses xterm's addon
manager for disposal. Initialization exceptions are recorded and disposed. It
refuses a changed injection point. No source file or production build is replaced.
The fixture routes only the existing allowlisted `renderer.js` URL to this
comparison bundle; no CSP, sandbox or asset allowlist changes are made.

`measure.cjs` uses the same isolated profile, fixture login shell, controlled PATH,
agent guard, cleanup and descendant-process audit as
`tests/electron/preview-composition-measurement.js`. It explicitly places each new
session into an empty tile (mounted xterms alone do not prove occupied tiles),
splits the largest tile, and runs only `tests/electron/tile-flood.js` in the PTYs.
The workload emits about 390 KB/s per terminal for 12 seconds, independently of
terminal dimensions. Every host must show flood output; DOM views must show it as
well. After a one-second warmup, the probe samples eight seconds and waits for
`FLOOD_DONE` in every host. Elapsed-time windows are intentional measurements.
The app quits before fixtures are removed; all completed runs passed the process
audit with no surviving descendants.

Reports go to `test-results/620-{dom,webgl}-{4,9}.json` (override with
`FOOM_WEBGL_REPORT`). Committed `results/` files are raw observations from this
machine, not portable thresholds. They include:

- CDP renderer task/script, layout and style durations and counts;
- trace `Paint` CPU durations (not GPU raster or presentation time);
- rAF interval percentiles (not actual presented-frame latency), long-task counts,
  total durations and maximum duration;
- idle and streaming JS heap, DOM counters and Electron process working sets;
- actual/requested renderer, per-shell addon outcomes, viewport and terminal sizes,
  Electron/Chromium versions, GPU feature status and GPU-information failure.

Memory is a point-in-time observation without forced GC. Dividing board-process
working set or JS heap by tile count includes the shared board and baseline costs;
it is an amortized footprint, not marginal memory per terminal. GPU working set
is process-wide and cannot establish GPU allocation per tile here.

## Results and decision

| Requested mode (actual: DOM) | Tiles | Task ms | Script ms | Layout ms | Style ms | Paint ms | rAF p95 ms | Long tasks | Heap MiB/tile | Board RSS MiB/tile |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dom | 4 | 2890 | 961 | 414 | 349 | 309 | 16.7 | 0 | 4.55 | 87.3 |
| dom | 9 | 3287 | 1181 | 394 | 391 | 317 | 16.8 | 0 | 3.75 | 50.5 |
| WebGL attempt → DOM | 4 | 2280 | 759 | 336 | 278 | 246 | 16.7 | 0 | 9.78 | 92.5 |
| WebGL attempt → DOM | 9 | 4296 | 1544 | 522 | 546 | 393 | 16.7 | 0 | 5.23 | 53.1 |

All four runs used a 1152 × 720 CSS-pixel board viewport at device scale 1.
Four tiles each had a 396 × 320 xterm screen; nine tiles had seven 396 × 128
screens and two 185 × 128 screens. Sizes matched between requested modes.
The fixture uses the app's default window size on the isolated 1920 × 1200 display.

Every requested WebGL shell failed initialization with
`Error: WebGL2 not supported null`; the independent WebGL2 probe also returned
null. Electron reported `webgl: disabled_off`, `gpu_compositing:
disabled_software`, and `GPU access is disabled due to frequent crashes` when
queried for complete GPU information. Both requested modes therefore painted
with DOM. No hardware WebGL or software WebGL measurements were obtained.
Reported timings are observational; other development work shared the host, so
small differences between runs are not evidence about renderer performance.

The initialization-failure path continued streaming and completed each PTY flood.
Actual context loss, context-cap exhaustion, GPU memory per tile, pixel fidelity,
selection, cursor, theme, font sizes and interface zoom were **not validated** for
WebGL because no context could be created. The comparison injection is an
experiment, not a production-ready lifecycle implementation.

Do not ship the addon on this evidence. Repeat on GPU-capable isolated fixtures
before deciding. If it wins, integrate it in the existing imperative controller,
keep one xterm per mounted shell and the existing attach/drain/reset/fit/snapshot
order, scope GPU resources to visible tiles, and dispose the addon on context loss
to keep that terminal usable through DOM. Test exhaustion beyond the observed
platform context cap instead of assuming a fixed cap; never destroy a PTY or
recreate its xterm just to recover a GPU context. Run the visual matrix and full
runtime validation on all supported platforms before enabling it. No security
policy weakening is justified by this experiment.
