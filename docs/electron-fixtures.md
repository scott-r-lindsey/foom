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
