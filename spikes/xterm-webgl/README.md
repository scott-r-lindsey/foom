# xterm WebGL evaluation (#620)

Research only, 2026-10-19, Linux x64. **Enable WebGL for visible tiles, with a bounded DOM fallback.**
The matching addon showed a clear renderer CPU win on a real NVIDIA GPU, after
functional validation with SwiftShader. The application now uses the tested
visible-context budget and DOM recovery policy; no security settings are weakened.

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

Production and spike dependencies both pin addon-webgl 0.19.0; both lockfiles
record its integrity. Its published package identifies upstream commit
`f447274f430fd22513f6adbf9862d19524471c04`, matching the xterm 6.0.0 release.
Both audits found no known vulnerabilities.

`build.mjs` produces two instrumented comparison bundles via an in-memory
transform of the imperative shell controller. `instrument.ts` tracks public xterm
objects and attachment boundaries in both modes, limits WebGL to 12 visible
controllers, disposes it when hidden/unmounted, and permanently falls back to DOM
on context loss for that controller. It preserves the existing attach/drain/reset/
fit/snapshot path and uses the public addon manager for disposal. This instrumented prototype is retained for reproduction. The shipped policy
lives in `src/renderer/terminal/webgl-renderer.ts`; the comparison transform strips
that policy before adding its own, so it never stacks two addons. Production also
refits the DOM grid on fallback, accounting for different cell-width rounding. Both published packages identify
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

## Hardware results and shipping decision

The authorized session used the inherited `DISPLAY=:0.0` and no added GPU
switches. WebGL2 identified **ANGLE / NVIDIA GeForce RTX 3060 / OpenGL 4.5.0**,
NVIDIA driver **580.178.04**. Every addon in both WebGL cases had its own live
hardware WebGL2 context. GPU compositing and WebGL were enabled. All recorded board
windows were visible and **unfocused**, with sandboxing retained.

The initial fixture launch failed before GPU preflight because the larger display
created multiple blank tiles. It cleaned up; its selectors were corrected and
validated on a 3840×2160 Xvfb display, then the same bounded measurement window
continued without changing GPU flags. `hardware-session.json` records the full
161,889 ms window (2m42s), including that recovery; there was only one GPU preflight
and one successful set of four cases. All cases passed, with no surviving fixture
descendants. No further visible-desktop sessions are authorized by this task.

| Renderer | Tiles | Task ms | Script ms | Layout ms | Style ms | Paint ms | rAF p95 ms | Long tasks | Board RSS MiB/tile | GPU RSS MiB/tile | Heap MiB/tile |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dom | 4 | 2325 | 802 | 318 | 298 | 240 | 16.8 | 0 | 91.3 | 66.7 | 11.93 |
| dom | 9 | 2693 | 1043 | 284 | 342 | 234 | 16.7 | 0 | 48.7 | 30.1 | 7.04 |
| webgl | 4 | 943 | 484 | 8 | 63 | 16 | 16.7 | 0 | 75.9 | 67.1 | 6.85 |
| webgl | 9 | 1706 | 945 | 14 | 97 | 27 | 16.8 | 0 | 44.1 | 32.5 | 6.38 |

The board viewport was 2304×1254 at scale 1 in all cases; normalized terminal grids
were 40×18 (four tiles) and 20×6 (nine). Over each eight-second sample, renderer task
time fell **59.4%** (four tiles) and **36.6%** (nine). Layout CPU fell 97.4%/95.2%
and paint CPU 93.3%/88.6%. rAF p95 stayed near 16.7 ms and both renderers had zero
long tasks; WebGL had isolated 33 ms frame intervals. This is a CPU-headroom win,
not evidence of improved presentation or input latency.

Streaming board RSS was 61.6/41.6 MiB lower with WebGL; GPU-process RSS was
1.6/21.5 MiB higher. Combined board+GPU RSS was about 60.0/20.1 MiB lower. Per-tile
values above amortize shared process overhead; they are point-in-time samples
without forced GC and do not isolate GPU allocations. The four cases were one
sequential session on a shared host, not a statistical multi-machine benchmark.
The consistent, large task/layout/paint reductions justify enabling the addon.

Ship the 12-visible-view budget with permanent DOM fallback after initialization
failure or context loss for that mounted controller. Overflow stays on DOM until
another attachment can claim an available slot. Hiding disposes its addon; removing
a view also disposes its xterm. Never recreate the terminal or reset/reattach it
just to recover GL. On fallback, refit and resize the same attachment to account
for DOM's different cell width. The pinned addon can first attempt its own context
restoration; its public loss notification selects DOM if restoration fails.

Production unit tests cover lazy activation, initialization/constructor failures,
loss, budget release and idempotent disposal, plus controller fallback refitting
without reset/reattach. Dedicated real-app Electron tests request fixture-only
SwiftShader and verify loss/scrollback/attachment continuity and 18-tile resource
allocation. Existing DOM-specific pixel/cursor tests and packaged smoke explicitly
exercise the unavailable-GPU fallback; their fixture flags never affect shipped
launches. Full runtime validation accompanies this production change.

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
hardware performance evidence. The shipping decision above uses the hardware session, never SwiftShader timings.
