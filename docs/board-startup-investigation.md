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
