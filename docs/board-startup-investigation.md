# Board startup frame investigation (#470)

The cause is not established. Keep the native visibility, focus and animation-frame
assertions in `tests/electron/harness.js`; passing DOM queries alone is insufficient.
Do not substitute retries, longer deadlines or sleeps for a causal fix.

## Confirmed CI evidence

Downloaded the complete logs for these main jobs on 2026-10-15:

- [Linux 4/4, job 116598642272](https://github.com/scott-r-lindsey/foom/actions/runs/38786151412/job/116598642272):
  `trusted quit dialog appears above the board on first show and after hide/show reuse`.
- [Linux 3/4, job 116621158812](https://github.com/scott-r-lindsey/foom/actions/runs/38792710373/job/116621158812):
  `launches an agent in a managed worktree and routes its attention signals`.

Both fail in the first `boardPage` call inside `launchApp`, before the test's own
interactions. Both are the shard's first application launch. Before and after the
frame deadline, native window 1 (`app://bundle/index.html`) is visible, focused,
not minimized, and reports `backgroundThrottling: false`. Its document remains
visible, focused and responsive to evaluation, but the frame sentinel never runs.
Both apps then quit normally with no surviving descendants.

The `visible: false` snapshots belong to native window 2,
`app://confirmation/confirmation.html`. They do **not** show the board flipping
visibility. These two failures cannot have been caused by a test hiding the board
earlier in the same app. Disabling background throttling alone also did not fix
this failure; see [the issue history](https://github.com/scott-r-lindsey/foom/issues/470).

[Draft #484](https://github.com/scott-r-lindsey/foom/pull/484) did not reproduce
frame starvation in its local cohorts. It separately captured a discovery timeout
in a GPU-free Ubuntu 24.04 container on Node 24.21.0: no native windows, CDP pages
or window lifecycle events. That is an earlier startup stage, and existing
evidence does not establish a shared cause. Its temporary 20-trial CI probe must
not be carried forward.

## Evidence collected by the shared harness

The fixture bootstrap records up to 128 native window/navigation, app readiness,
GPU status and child-process exit events before loading application main. This
code never runs in the shipped application. On failure, `boardPage` writes full
JSON under `test-results/board-startup-<app-pid>.json`, including:

- Native/content bounds and renderer viewport, readiness and visibility.
- The frame sentinel's URL, time origin and weak document identity, alongside
  the current document, to distinguish replacement from compositor starvation.
- App readiness, active resource types, process metrics, Electron/Chromium versions,
  display geometry/refresh rate and GPU feature status.

Each feature worker's first ordinary Linux CI launch also records a bounded
16 MiB Chromium API trace and a Chromium log. Feature files run serially on the
same virtual display. Tracing starts alongside main's readiness continuation;
startup never awaits its start. The harness flushes the trace immediately after
the existing frame assertion, before interaction or quit, including on failure.
CLI startup tracing previously stalled shutdown in #484, so it is deliberately
avoided. Traces use app PIDs to avoid collisions between workers/launches. The
Chromium log uses the worker PID to correlate its first app with the trace.
Existing CI artifact collection retains `test-results/` on failure too.

The `blink.user_timing` category includes `foom:board-frame-requested` and
`foom:board-frame-delivered` marks around the sentinel. These locate the exact
request in a trace containing multiple windows and other animation callbacks.
Failure diagnostics also record `document.fonts.status`; they do not await fonts
or otherwise change the startup/frame gate.

## Hypotheses still requiring a captured recurrence

1. Cold GPU/frame-sink initialization or compositor scheduler stall. Check GPU
   exits/errors and whether browser/Viz begin frames reach the renderer.
2. Hidden-navigation/show surface transition. Compare native creation, navigation,
   show and ready-to-show ordering with surface activation in the trace.
3. Document lifecycle mismatch. Compare sentinel/current document identity and
   navigation events before treating a missed callback as a compositor failure.
4. For the separate no-window case, distinguish an unresolved app readiness gate
   from application initialization awaiting filesystem or child-process work.
   `app-ready`, `ready`, active resources and process metrics narrow this without
   asserting that it has the same cause as a shown board's missing frame.

Do not select production window flags or a harness workaround from these
hypotheses alone. A failing trace or causal reproduction is still required.

## Cold-cache follow-up (2026-10-15)

The six traces retained in `electron-results-ubuntu-24.04-3` from
[run 38797814952](https://github.com/scott-r-lindsey/foom/actions/runs/38797814952)
contain a useful successful cold-start comparison. Times below are milliseconds
from each trace's first non-metadata event, not application launch timestamps.

| Trace (application PID) | GPU initialized | Frame sinks initialized | First animation callback |
| --- | ---: | ---: | ---: |
| 2697 (job's first application) | 3652.2 | 3655.1–3656.3 | 3662.0 |
| 7540 | 82.4 | 340.4–455.4 | 802.6 |
| 8254 | 69.9 | 330.4–425.3 | 779.7 |
| 10184 | 78.8 | 350.9–436.3 | 798.0 |
| 12017 | 77.8 | 340.3–428.5 | 791.9 |
| 12705 | 78.6 | 351.1–453.4 | 807.7 |

In trace 2697 the renderer requests its GPU channel at 368.0/416.0 ms and
animation callbacks at 778.2/915.9 ms. The GPU channel callbacks arrive only at
3655.7/3655.8 ms, immediately followed by frame-sink initialization and frames.
Renderer JavaScript and font decoding execute before this gap; the longest
complete task in the trace is 61.1 ms. The GPU process contributes no trace
events until 3656.5 ms. This establishes a GPU initialization wait in a **passing**
cold launch; it does not establish why initialization was slow or prove that
the original ten-second frame starvation has the same cause. API tracing cannot
explain work performed before the GPU process connects to the tracing service.

Direct local experiments used the existing GPU-free Ubuntu 24.04 probe image,
Node 24.21.0, four CPUs, no network, Chromium sandboxing enabled, fixture agent
guard/PATH, fresh profiles and a fresh `xvfb-run -a` display in each container.
Docker's AppArmor/seccomp restrictions were disabled for these containers to
permit Chromium's user-namespace sandbox. The first attempt with Docker's default
seccomp policy failed before app launch; it is not a board/frame failure.

| Experiment | Discovery test duration | Result |
| --- | ---: | --- |
| Empty XDG cache, system fontconfig cache available | 1.14 s | Passed |
| Empty XDG and fontconfig caches, image's eight fonts | 1.23 s | Passed; new font and Mesa cache files |
| Empty caches, host's larger `/usr/share/fonts` mounted read-only | 1.21 s | Passed; new font cache files |
| Same larger font set, explicit `fc-cache` before launch | 1.15 s | Passed; cache preparation took 0.29 s |
| Larger font set, empty font cache, `MESA_SHADER_CACHE_DISABLE=true` | 1.60 s | Passed; no Mesa shader cache files |

To reproduce the font experiment, rewrite **all** `<cachedir>` elements in a
copy of `/etc/fonts/fonts.conf` to a new empty `/tmp/fontcache`, rewrite its
`conf.d` include to `/etc/fonts/conf.d`, and set `FONTCONFIG_FILE` to that copy.
Set `XDG_CACHE_HOME` to a separate empty directory. Merely setting XDG does not
prevent fontconfig reading `/var/cache/fontconfig`. Run the ordinary discovery
test, without modifying its assertion or deadline:

```sh
CI=true xvfb-run -a node --require ./tests/helpers/setup.js --test \
  '--test-name-pattern=^agent discovery uses the fixture login shell and controlled PATH$' \
  tests/electron/harness.test.js
```

The image's `fc-cache` (fontconfig 2.15.0) generates `cache-9` files; the Electron
launch also generates `cache-11` files. A separate `fc-cache`-only container
confirmed it produces no `cache-11` files. Therefore the prepared case measures
system cache preparation, not a fully warm Chromium font cache. Do not infer
that running the system `fc-cache` would warm every font cache Electron uses.

Each case is an independent experiment, not a retry of a failed startup. The
passing cases show that these empty caches, a fresh profile and a new Xvfb
display are insufficient on this machine to reproduce starvation. They do not
eliminate intermittent GPU initialization or scheduler failures. `xvfb-run`
waits for Xvfb's SIGUSR1 readiness notification before executing the test; there
is no evidence here justifying an added display delay or cache warm-up.

Disk-page-cache coldness remains untested: a new container still shares the host
kernel cache for mounted Electron resources. No host page caches were dropped.
The next discriminating evidence is a failing first-launch trace showing whether
GPU initialization/channel establishment ever completes. Keep the diagnostics
until that observation exists; neither a production window change nor a CI
warm-up follows from these passing samples.

## Readiness gate (#470 follow-up)

The harness now separates compositor readiness from the existing animation-frame
assertion. It temporarily subscribes to the board's composited frames with
`webContents.beginFrameSubscription`, waits for one callback, and unsubscribes
before requesting the sentinel. Pixel data is neither inspected nor saved.
Readiness is retained per native board ID and removed when that window closes.
The gate uses the existing test-policy assertion deadline; the sentinel keeps its
own unchanged deadline and visibility/focus checks. A compositor-ready board with
withheld animation callbacks must still fail the original frame assertion.

The alternatives are insufficient in the pinned Electron 44.4.5 implementation:

- [`getGPUInfo`](https://github.com/electron/electron/blob/v44.4.5/shell/browser/api/electron_api_app.cc)
  uses `FetchBasicInfo` for both `basic` and `complete` on Linux. That method
  [synchronously collects device metadata](https://github.com/electron/electron/blob/v44.4.5/shell/browser/api/gpuinfo_manager.cc),
  without awaiting GPU channel establishment. `gpu-info-update` also lacks a
  per-renderer channel or compositor-readiness guarantee.
- Despite the API documentation's first-render wording, `ready-to-show` is
  [emitted by `OnFirstNonEmptyLayout`](https://github.com/electron/electron/blob/v44.4.5/shell/browser/api/electron_api_web_contents.cc).
  It is not evidence of GPU channel establishment or a delivered compositor frame.
- A disposable renderer WebGL context would require a GPU channel, but a local
  probe returned null with `webgl: disabled_off` while ordinary software board
  rendering worked. Requiring WebGL would incorrectly reject that supported path.
- The chosen [frame subscriber](https://github.com/electron/electron/blob/v44.4.5/shell/browser/api/frame_subscriber.cc)
  consumes a frame from the view's Viz video capturer. This observes an actual
  compositor output on both hardware and software paths, rather than device
  metadata, layout, or the existence of a GPU process. It does add a temporary
  capture consumer, so the separate subsequent sentinel remains essential.

The downloaded #510 Linux 3/4 cold trace (PID 2484, run 38818934802) places the
sentinel request at trace timestamp 242327.15 ms, GPU channel callbacks at
246041.95/246041.96 ms, and delivery at 246045.16 ms. That is a 3.7-second
initialization wait inside the old frame deadline. A focused local Xvfb discovery
launch with the new gate (PID 149243) recorded channel callbacks at
2530753705.36/2530753720.91 ms, `foom:board-compositor-ready` at 2530753941.59 ms,
sentinel request at 2530753944.60 ms and delivery at 2530753950.72 ms. The readiness
mark is written after observing the capture callback, before the **new sentinel**;
it is deliberately after a captured compositor frame, not before every paint.
Cold CI comparison below verifies this ordering. The traces and
all earlier failure diagnostics stay in place. A readiness failure records its
own stage and still fails; it cannot wait indefinitely for GPU initialization.

This localizes and separates a demonstrated cold-start prerequisite; it does not
identify why initialization is slow or retroactively prove the cause of every
historical deadline failure. The shipped app can show its window after load and
before compositor readiness, so a slow GPU could leave users seeing the board's
background until rendering starts. These CI traces do not establish a visible
regression on users' desktops. Waiting to show would also delay native-window
feedback and revive the detached-board startup concern documented in main.
There is no demonstrated user-facing benefit justifying a production change here.

### Cold CI verification

[Run 38821880360](https://github.com/scott-r-lindsey/foom/actions/runs/38821880360)
at implementation commit `d9274db` retained the following first-launch traces.
Times are milliseconds from each trace's first non-metadata event. The readiness
request precedes GPU initialization; readiness observation follows channel
establishment, and only then does the harness request the independent sentinel.

| Linux shard / PID | Readiness requested | GPU channel callbacks | Readiness observed | Sentinel requested | Sentinel delivered |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1/4 / 2476 | 613.81 | 6273.48–6273.57 | 6486.17 | 6488.48 | 6488.94 |
| 2/4 / 2483 | 906.79 | 4524.64–4524.97 | 4774.31 | 4777.70 | 4778.17 |
| 3/4 / 2709 | 918.02 | 6845.43–6845.64 | 7796.75 | 7800.13 | 7800.70 |
| 4/4 / 2708 | 910.77 | 3682.33–3682.58 | 3776.30 | 3779.48 | 3780.01 |

All four Linux shards passed, including ordinary first launches; no warm-up process
was used. Later workers in the same jobs initialized the GPU in roughly 57–83 ms.
This directly verifies that the selected readiness signal does not resolve
trivially before the cold GPU-channel wait. It does not explain that wait's
underlying resource or replace the retained diagnostics for a future recurrence.
