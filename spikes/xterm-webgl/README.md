# xterm WebGL evaluation (#620)

Research only, 2026-10-19, Linux x64. **Retain the DOM renderer; defer WebGL.**
The initial Xvfb run could not create a context. The follow-up below validates
real WebGL2 functionality with fixture-only SwiftShader; hardware performance
validation is a separate, explicitly authorized session. No application source,
production dependency, security policy or packaged asset changes are included.
No renderer change ships without a clear hardware performance win.

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

```

The root lockfile is unchanged. The spike pins addon-webgl 0.19.0 in its own
lockfile. Its published package identifies upstream commit
`f447274f430fd22513f6adbf9862d19524471c04`, matching the xterm 6.0.0 release.
Both audits found no known vulnerabilities.

`build.mjs` produces two instrumented comparison bundles via an in-memory
transform of the imperative shell controller. `instrument.ts` tracks public xterm
objects and attachment boundaries in both modes, limits WebGL to 12 visible
controllers, disposes it when hidden/unmounted, and permanently falls back to DOM
on context loss for that controller. It preserves the existing attach/drain/reset/
fit/snapshot path and uses the public addon manager for disposal. This is a research
prototype; nothing imports it into production. Both published packages identify
upstream commit `f447274f430fd22513f6adbf9862d19524471c04`.

## Follow-up functional validation

```sh
node spikes/xterm-webgl/build.mjs
xvfb-run -a -s '-screen 0 1920x1200x24' \
  node --require ./tests/helpers/setup.js --test --test-concurrency=1 \
  spikes/xterm-webgl/functional.cjs
python3 spikes/xterm-webgl/compare-visual.py
```

Pillow is required only for the screenshot comparison script. Functional fixtures
pass `--use-angle=swiftshader --enable-unsafe-swiftshader` to their isolated
Electron app, without disabling sandboxing. The addon canvas reports **ANGLE /
SwiftShader Device (Subzero)** and a live WebGL2 context. These software runs are
functional evidence only; no SwiftShader timing is performance evidence.

The automated assertions and raw reports under `results/software/` cover:

- Forced `WEBGL_lose_context`: unchanged scrollback, base position, cursor and
  xterm identity; no detach/reset/reattach caused by loss; subsequent PTY input and
  output work through DOM. Switching sessions still drains, resets, fits, and
  attaches in order. Output produced by a hidden host appears in its fresh snapshot
  on reattachment and never contaminates the other session.
- Context exhaustion: creating 24 unmanaged contexts leaves 16 live and causes
  browser-driven loss of the terminal's older context. After releasing probes,
  **18 occupied tiles** use 12 verified WebGL2 contexts and six DOM fallbacks.
  No budgeted terminal loses its context; a budget fallback continues real PTY
  output. The cap is observed, not assumed portable. Twelve is a conservative
  experimental budget; loss fallback also handles a lower platform limit.
- Settings hides all attachments: all addons release while the 18 xterms remain.
  Returning reinstates at most 12 addons. Hiding and tidying a tile removes its
  controller, disposes its terminal exactly once, and leaves no addon attached.
- Security: renderer sandbox and context isolation stay enabled, Node integration
  stays disabled, the exact original CSP remains, and no CSP violations occur.
  Request/resource inventories contain only existing `app://bundle/` assets;
  requesting unlisted `addon-webgl.js` still returns 404. The addon is bundled into
  the existing `renderer.js`, compiles GLSL strings through WebGL `shaderSource`,
  and uploads in-memory canvas glyph atlases. It loads no worker, WASM, shader file,
  remote texture, network resource, eval code, or additional protocol URL. Existing
  local font URLs are the only font assets.

The six-case visual matrix compares Foom Dark/Light, Dracula, selection, a visible
block cursor, Hack Nerd Font Mono and Geist Mono, sizes 10/14/16/20, and interface
scales 80/100/150%. Screenshots use native `capturePage` with zoom-adjusted clipping;
PTY output is held quiet during the static cell comparison. Logical cell content,
theme, selection, cursor position and row count match. Saved pairs and the contact
sheet were inspected: palettes, bold text, cursor, selection and ligature-free
characters remain visible, but glyph spacing/rasterization is **not identical**.
WebGL integer cell-width rounding fits 103 versus DOM's 98 columns at 14 px and
165 versus 137 at 10 px/80% zoom. `visual-diff.json` records 3.49–6.38% differing
pixels with RGB tolerance 32. These are reported differences, not a pixel-perfect
pass. Font/zoom geometry needs attention before any future rollout.

The guarded `common.cjs` reuses the ordinary isolated profiles, fixture shells,
controlled PATH, agent guard, cleanup and process audit. For inactive desktop
readiness it compiles a fixture-only in-memory harness variant that replaces
focus-dependent readiness and installs `inactive.cjs` before main. Window `show`
uses `showInactive`; native focus calls are suppressed. Teardown exits fixture
shells before requesting quit, avoiding a focus-requiring quit dialog. Its normal
quit acknowledgement and process audit remain in place. This inactive variant is
also validated under Xvfb before any visible session.

## Hardware session

`desktop-session.cjs` is reserved for the one explicitly authorized visible-desktop
measurement session. All other Electron runs must use Xvfb. Do not run it again
without new authorization:

```sh
FOOM_WEBGL_DESKTOP_SESSION=1 node --require ./tests/helpers/setup.js \
  --test --test-concurrency=1 spikes/xterm-webgl/desktop-session.cjs
```

It inherits DISPLAY/WAYLAND_DISPLAY, adds no GPU switches, uses inactive windows,
and bounds the entire session to ten minutes. The first app records GPU/driver
information plus a real WebGL2 probe in `results/hardware-status.json`. If hardware
WebGL is unavailable or the renderer is software, it stops without trying flags
or launching the other cases. Otherwise it runs DOM/WebGL × 4/9 tiles, verifies a
real hardware context per WebGL addon, and writes raw reports. The workload is the
bounded `tests/electron/tile-flood.js`: about 390 KB/s per terminal for 12 seconds,
a one-second warmup and an eight-second sample. Cell counts are normalized between
renderers (40×18 for four tiles; 20×6 for nine) to avoid the observed font rounding
confound; board/viewport sizes are recorded. It waits for every flood to complete
and audits descendants at teardown. The report contains task/script/layout/style
and paint CPU durations, rAF interval percentiles, long tasks, heap/DOM counters,
and process working sets. rAF intervals are not presentation latency; paint CPU is
not GPU raster time. Memory includes shared board overhead and is not marginal
GPU allocation per tile. These qualifications also apply to the archived reports.

## Initial observations (superseded evaluation)

These four reports were produced by commit `7c564fd`; use that revision to
reproduce the initial failed-context experiment. Current scripts deliberately
require actual hardware contexts before labeling a WebGL performance run.

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

The initial initialization-failure path continued streaming and completed each PTY
flood. These initial reports are retained for provenance; the missing functional
checks are now covered by the SwiftShader follow-up above. They still provide no
hardware performance evidence. The final decision will use the authorized
hardware-session result, never the SwiftShader timings.
