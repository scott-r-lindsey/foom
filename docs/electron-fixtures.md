# Explicit Electron fixtures

`launchApp(context, options)` creates one isolated app and profile per call. Select
`options.fixture` according to the assertions; fixture CLIs remain test-owned files
passed through `env.PATH`. No fixture shares an app/profile between tests.

| Fixture | Initial inventory |
| --- | --- |
| `first-run` | Preflight, no seeded repository or terminal |
| `empty-board` | Completed setup, no seeded repository or terminal |
| `repository` | One registered `shell-fixture` Git checkout, no terminal |
| `running-shell` | Registered checkout and one live, focused shell |
| `running-shell`, `shell: "hidden"` | Same live shell, hidden tile and focused sidebar row |
| `agent` | Completed setup and controlled fixture CLI PATH; the test launches its agents |
| `restored` | Existing explicitly supplied profile; no additional repository or shell |

The default running-shell launch remains solely for the application-menu test
owned by #509/#511. All other callers select their fixture explicitly. Restore
callers supply `--user-data-dir` and assert their own persisted inventory. Empty,
repository and agent launches assert the absence of implicit terminals. Running
shells assert that the process is live before returning, including hidden shells.

Quit-confirmation, restore, terminal focus, fullscreen redraw, terminal font and
attention-routing cases keep their live-shell preconditions. The tile-leader
case also retains a populated tile so its close shortcut changes observable state. In particular the
agent-attention case switches back to a hidden shell, and the 300% accessibility
case checks its terminal and quit confirmation at the small window size.
Repository-only previews obtain their checkout from repository inventory instead
of borrowing a shell's working directory. Settings/environment tests create a
terminal only when their body explicitly needs one.

The launch path retains the shared native compositor readiness gate, independent
animation-frame assertion and startup diagnostics. The sandbox, controlled login
shell/PATH, agent guard, process audit and quit-before-directory-removal ordering
are unchanged.

## Shared scenario setup

`tests/electron/agent-fixture.js` registers no tests. `codexFixture` creates an
isolated checkout, home and fixture-only CLI PATH and registers cleanup before
launch. Its caller supplies the fake CLI source and optional help text.
`launchTrustedParent` registers a caller-owned checkout, launches its fixture
Claude and reads the existing atomic credential record under case cancellation.
Callers register their root with `removeAfterApps` first and supply explicit
launch options. Trust approval, control requests and scenario assertions remain
in the test files. Both helpers use the existing harness readiness, display
isolation, agent guard and quit-before-removal cleanup.

The owned child review-loop scenarios keep their disposable Linux profiles in
`/dev/shm`, separately from their checkouts and fake CLIs. This isolates mandatory
audit and operation `fsync` calls from concurrent build/packaging disk I/O while
retaining real private-file writes, atomic replacement and restart persistence.
Cleanup quits every app before removing its profile. Other platforms use the
ordinary temporary directory.

## Chromium session storage

`createMemoryFixture(context, prefix)` owns all shared-memory fixture allocation
and both normal and hard-exit cleanup. Review-loop user-data profiles and Chromium
session storage use distinct allocations and names. It selects writable Linux
tmpfs with at least 128 MiB free, with ordinary temporary storage as fallback.

Each isolated development profile gets a separate, disposable `sessionData`
directory before Electron creates its default session. Restored launches within
the same test reuse it, retaining board local storage and encryption metadata.
This includes Chromium's preferences, network state, performance-observer database
and caches; Foom's ordinary `userData` profiles and Git fixtures retain their
normal disk storage. The explicit review-loop profile above uses its own separate
allocation, including across restore launches. Browser session data is fresh for
unrelated profiles and is removed only after every app in the test quits.

On Linux, the harness uses `/dev/shm` when it is a writable tmpfs with at least
128 MiB free. Otherwise, and on other platforms, it uses the fixture temporary
directory. This avoids Chromium's native shutdown waiting for shared-disk journal
commits for disposable browser files after Foom's quit barrier has completed.
The graceful-quit deadline, normal-exit assertion and process audit are unchanged.
Packaged smoke continues to exercise the package's ordinary profile storage.

The test runner supplies an owned enclosing tmpfs root when available, and a
separate owned root on the worktree filesystem for the concurrent-review fixture.
It removes these after the runner exits, including a worker killed by a timeout.
Direct standalone fixture checks retain the ordinary temporary/shared-memory
fallbacks below; use the package test commands for parent-owned cleanup.

A synchronous worker exit handler also removes all storage directories allocated
by that worker when the hard watchdog calls `process.exit(1)`, which skips test
after hooks. It checks the original directory identity and owner with `lstat`
and refuses substituted symlinks. Normal teardown still quits apps before
removing fixtures. This does not cover `SIGKILL` or machine failure; the harness
does not sweep unmarked shared-memory entries whose ownership it cannot prove.

## Timing method

The harness emits `Fixture timing: {...}` diagnostics into Node's JUnit comments
and `test-results/fixture-timings-PID.jsonl` into the existing CI artifacts. Each
record names the case and completed fixtures and reports milliseconds:

- Setup: sum of successful `launchApp` calls, including profile/isolation, native
  startup readiness and the selected repository/shell setup.
- Body: time from registering fixture cleanup to starting teardown, minus setup.
  Test-owned repository/CLI construction after cleanup registration, explicit
  restarts/quits and assertions belong here.
- Teardown: process capture, app quits, process audit, agent-guard checks and
  fixture deletion. Writing the timing record itself is excluded.

JUnit case durations also include test work before cleanup registration and
reporting overhead. Phase sums therefore need not equal JUnit totals. Multiple
launches within one restore test are summed; they never represent shared apps
between independent tests. These are observations on shared local hardware and
hosted CI runners, not guaranteed speedups. CI case sums measure aggregate test
compute; the longest shard and job/step wall times measure elapsed feedback.

## Linux display isolation

Every development and packaged GUI launch uses the shared
`tests/electron/display-isolation.js` guard. Run under `xvfb-run -a`: the guard
requires a local DISPLAY whose lock identifies Xvfb, with the matching authority
file and an ancestor `xvfb-run` owner. An unset DISPLAY, a real X server, a foreign
Xvfb server or a mismatched authority fails before launch. It does not fall back
to a desktop display.

The child environment drops WAYLAND_DISPLAY and WAYLAND_SOCKET and sets
XDG_SESSION_TYPE and ELECTRON_OZONE_PLATFORM_HINT to `x11`. The effective override
on Electron 44 is `--ozone-platform=x11`; the older hint is retained only for
compatibility. Conflicting Ozone arguments are removed. See
[Electron's breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
for the removal of the environment hint. A real Electron harness test supplies
fake Wayland settings and checks the effective main-process switch and environment.
