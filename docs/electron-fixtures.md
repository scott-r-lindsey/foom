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

## Agents scope review captures (#1070)

The twelve-agent/twelve-host case checks desktop/light and narrow/dark, including
picker navigation, statuses, offline actions and keyboard scrolling; its offline
accessibility check covers both themes. Set `FOOM_AGENT_SCOPES_SCREENSHOTS=1` to
run the full width/theme review matrix and save Global, Machines, remote-plugin
and offline images under `test-results/1070-step2/`. Ordinary CI retains every
functional assertion without repeating the full review matrix or writing images.

## Remote host SEA fixture (#905)

On Linux and macOS, the development Electron runner builds one native remote-host
SEA after the app build and before starting test workers. It verifies the host's
platform, architecture, app version, protocol, checkout revision, compressed and
expanded hashes, and executable hash, then prepares the production gzip catalog.
Both remote suites reuse that executable; each case still creates its own remote
HOME, daemon, app profile and cleanup audit. Windows skips these remote cases and
does not build a host. Packaged smoke uses its packaged catalog.

The build receipt covers the host and catalog alongside the app. Explicit
`--reuse-build` requires unchanged inputs and outputs and rechecks the host against
the current checkout revision. A failed host build or verification stops before
test bodies run. No case deadline includes SEA assembly.

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

`tests/electron/preview-fixture.js` registers no tests. It shares file picking,
bounded native-content inspection, view-state checks and native keyboard input
across the seven preview suites. Each caller creates its own isolated app and
registers cleanup through the existing harness. `composedPreview` is shared by
composition and focus scenarios; `movePreviewTile` is shared by move and agent
scenarios. Their native attachment, focus, identity and cleanup assertions remain
in the shared implementations. Scenario-specific frame helpers, stuck handoffs,
agent setup and moved-pixel inspection stay in their owning suites.

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

## Appearance picker readiness (#1035)

The terminal-font case holds its fixture enumeration reply until the Terminal
section's heading has received focus, then waits for the requested family in the
closed menu before typing. Section visibility alone precedes both the heading's
focus effect and the font IPC reply. Typing before enumeration finishes can leave
the family present but inactive after the reply; installed host fonts are not a
precondition for this case.

The first-run theme case drains the serialized save queue and observes the
renderer’s resolved Default label before forcing native light/dark changes.
Config publication and the final save apply both set the native theme source;
main-process save completion alone does not drain renderer IPC or React updates.
The complete menu contents use a retrying UI assertion, retaining both resolved
names and the full choice order. Neither case changes its deadline or relies on
the desktop's initial light/dark preference.

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

On POSIX, fixture PATH includes only fixture directories and links to the named
system tools needed for shell, Git and observer tests. It never exposes entire
`/usr/bin` or `/bin` directories: those can contain real agent shims, including
VS Code’s Copilot shim. Fixture-provided tools take precedence. The exec/spawn
guard and descendant process audit remain enabled; packaged smoke uses the same
controlled PATH.


## Startup tracing lifetime

The first Linux CI app in each worker records native window events from creation.
Its Chromium trace starts after the board document has loaded, before the shared
compositor/rAF readiness checks finish. Starting the recorder alongside app readiness
races cold renderer registration: Chromium can delay its start acknowledgement for
several seconds even after the board has painted. Each worker previously charged
that delay to fixture setup. Tracing still stops and writes its artifact before
interaction or quit; cancelled/failed navigation starts no recording. The existing
compositor and animation-frame assertions remain independent of trace collection.

## Executable replacement during discovery (#929)

An installed agent card can retain a completed scan's result while a config or
Settings-entry refresh is still probing the same executable. The missing-agent
reload case tracks the fixture's actual discovery scans and child `close` events
before unlinking its copied executable. Its controlled `--help` reader stays alive
until a fixture file is removed, proving that an enabled card alone is not a process
exit barrier. The ordinary unlink happens before this controlled demonstration,
so the held reader cannot mask the original race with extra elapsed time. On
Windows the demonstration also asserts `EPERM` while that known reader is alive.
Teardown releases that reader and waits before quitting the app.
Windows unlink failures remain errors; the test neither retries nor ignores them.

## Modal and review-loop CI races (#1008)

In main run [41385523238](https://github.com/scott-r-lindsey/foom/actions/runs/41385523238),
Windows shard 1's modal-restoration case spent 30 seconds waiting for About to
close; Linux shard 1's review-loop `fix` case spent 15 seconds waiting for absent
PR checks (19.215 seconds total). Both original reports show empty process lists
after teardown. The modal case now waits for board document and dialog focus,
then sends Escape through the native focused WebContents. A visible in-board
modal alone does not establish native keyboard readiness after dismissing a
separate trusted confirmation window.

The forge regression reproduces an explicit PR binding replacing a tracker entry
while an older poll prepares its provider context. Recollecting entries for that
batch mixed the old context with the new entry, hiding the fresh binding and
applying repository backoff. Batches retain the captured entry set and skip
replaced entries; the next ordinary tick samples the new binding. The regression
holds provider preparation explicitly rather than relying on elapsed time or load.

The earlier macOS shard 2 failure in
[41382537712](https://github.com/scott-r-lindsey/foom/actions/runs/41382537712/job/125076298948)
was an Actions step timeout, not an identified third case failure or worker
watchdog stop. Its log explicitly reports the 14-minute limit after completing
the profile-lock case at 03:35:04 UTC. The uploaded JUnit contains only its opening
envelope and the summary is empty: the runner was interrupted before finalizing
reports. Orphan termination is subsequent Actions cleanup. No test, worker or CI
deadline changes are made for these failures.

## Native zoom resize before tile menus (#1040)

The narrow tile-menu case arms a one-shot renderer resize listener before setting
native WebContents zoom, then waits for that event before opening the menu.
`innerWidth` can already reflect the new zoom before Chromium dispatches `resize`.
`RowMenu` intentionally dismisses on resize, so opening it after only a width poll
can immediately remove the dialog; its locator then waits until the layout poll's
existing deadline. A local event trace reproduced native resize arriving after the
dialog was added, followed by its removal, while the viewport remained 500×300
and native zoom remained 3. Waiting for the event preserves both resize dismissal
and the original narrow layout assertion without fixed sleeps or a larger deadline.

The failure-only diagnostic retains the final viewport, native zoom, grid columns
and command/facts bounds. A missing grid distinguishes an absent menu from a
present menu whose facts do not stack. Neither earlier macOS nor Linux CI artifacts
recorded those final values; the original bare predicate timeout does not itself
establish an incorrect grid layout.

## Preview restore before native drags (#1056)

The composition drag case waits for tile transition completion before sampling
its shell-title coordinates. A decoded snapshot and a visible native preview do
not mean restore geometry has settled. The case still observes the live preview
and snapshot during maximize/restore, with the deliberately lengthened one-second
transition; it then waits on the actual animation promises before starting the
separate drag assertion. Maximize completes first so restore exercises its full
travel rather than reversing an animation that has barely started.

A controlled local trace held the restore transition at its first frame. Mouse-down
at the shell title's measured `(315, 14)` instead hit the preview, whose left edge
was still at 306 rather than 900. Native `dragstart` therefore selected the preview,
and every `dragover` targeted that same tile. The product correctly suppresses a
drop preview on the origin tile. The original test reproduced the missing
`.tile-drop-preview` assertion; this establishes a fixture ordering defect, without
claiming the older Windows reports recorded that same ordering. The case now also
asserts that native drag-start selected the shell and reports a bounded input-event
trace only on failure, so CI can distinguish a different native drag defect.
No product hit testing, animation duration or test deadline changes.

## Quit acknowledgement ordering (#1056)

The harness cancels an unprevented native `will-quit` after Foom's save, PTY
shutdown and service-disposal barrier. It publishes readiness on the following
event-loop turn, after the cancelled native quit has unwound. Electron keeps its
native quitting flag set while notifying `will-quit` observers and ignores a
reentrant `app.quit` in that interval. Publishing readiness inside the observer
can let Playwright issue its final quit too early, detach its inspector and wait
for a process exit that was never requested. The existing final `before-quit`
guard still lets Playwright's evaluation return before actual native shutdown.

A natural Linux failure recorded native `will-quit` and acknowledgement at 196 ms,
then the harness entered `app.close()` before the recorded next event-loop turn
at 341 ms. No final `before-quit` guard fired, and Electron stayed alive through
the unchanged ten-second deadline with no windows. The native regression proves
that readiness inside `will-quit` authorizes a quit which Electron ignores; it
fails before the fix and requires readiness to remain false in that event after
the fix. The real reattachment fixture also exited normally in 623 ms with the
Node inspector detached at final native quit, retaining normal confirmation and
production cleanup. The captured failure stalls after Foom's cleanup barrier;
its frequency has not been attributed to #1083, and the same signature occurred
on main before that change.

The harness retains a bounded stderr lifecycle trace and prints it only when
app teardown fails. It records native quit events, acknowledgement delivery and
the next event-loop turn, together with harness phases, the final window list,
and connection/process closure. Main and harness records include a common wall
clock, with main's monotonic elapsed time retained. These are fixed lifecycle
facts; terminal output, paths, credentials and message payloads are excluded.
The trace starts in the existing acknowledgement evaluation before requesting
quit and survives inspector disconnection. It neither wraps `app.quit` nor adds
an inspector round trip, which could change the ordering being measured.

A teardown phase named `invoke Playwright quit evaluation` covers the entire
public `app.close()` call, including Playwright's work before its evaluation.
That label alone cannot establish a product quit hang. Use the event order to
distinguish an evaluation that never reaches main, an ignored/reentrant native
quit, a pending service barrier and a process waiting for debugger disconnect.
The normal-exit assertion, shutdown deadline and forced cleanup on failure remain
unchanged.


## Launch pressure fixtures (#1046)

The development harness replaces main's local resource reader with deterministic
healthy measurements before loading the application; pressure scenarios explicitly
supply fixture values. The Electron runner builds its disposable remote SEA with
`--fixture-resources`, replacing only the daemon launch-resource reader at bundle
time. Production builds omit this flag and read real OS facts; there is no runtime
or profile switch. Ordinary app/package builds clear the disposable build tree.
Daemon unit tests exercise the real admission path with fixture OS measurements,
including reservations, refusals, disconnects and unreadable observations.

## Group cleanup completion ordering (#1146)

The untracked/detached cleanup case holds delivery of the second detached
checkout's real removal result. It verifies the trusted progress dialog remains
at 2/3 with Hide available and no Done, then awaits `CleanupRun.settled()` before
asserting the finished UI. The gate releases on failure before app shutdown.
All real Git checks and trusted dirty approval still run.

Both macOS JUnit reports from runs 42601978396 and 42606320501 show the same
`Deleting merged worktrees` progress dialog at 2/3, with `review-detached-b`
still removing. The repeated alertdialog interception is the harness's native
focus readiness handler, not evidence of another unanswered dialog. The original
Done assertion starts its ten-second UI deadline while native removals are still
running. Holding that completion reproduces the original failure deterministically;
waiting for the run separates native operation completion from UI rendering.
This establishes the ordering defect without claiming the reports captured the
underlying Git operation timing. Test deadlines and product deletion policy stay
unchanged.

## Close-test shell readiness before layout changes (#1137)

The optimistic-close case finishes its interactive fixture shell before growing
or splitting the board. It observes the initial prompt and editable input, types
`echo FOOM_CLOSE_READY` through native keyboard input, observes the standalone
output marker and the returned prompt, then types `exit` and observes the exited
row. Only then does it prepare the two-tile close scenario. The slow-cleanup gate,
failed-row restoration and close timing assertions remain unchanged.

The original headless reproduction established that xterm's default resize
policy clips a completed cursor row: shrinking the 96-column Windows prompt to
68 columns leaves the exact `foom-pr` prefix. For exited PTYs this corrupts the
retained authoritative screen, tails and attachment snapshots with no remaining
program to redraw it. Host and renderer now enable normal-buffer cursor-row
reflow only after the native PTY exits. Known-exited attachments select that
policy before fitting; a reused live view restores the default live policy.

Live programs retain ownership of cursor-row redraw. Enabling xterm 6.0.0's
cursor-row reflow while live duplicates a long Bash prompt and leaves the cursor
at the wrong column for a raw PTY's later writes. Live narrowing can clip content
when an application does not redraw; the exited policy preserves only the
content remaining at exit. See [the terminal resize policy](areas/terminals.md).

The exited manager and sandboxed Electron regressions retain the fixed
96-column output across shrink, grow and fresh attachment. The Electron case
launches a controlled Node process, waits for its ready marker and a wide host
grid, then uses native input to request a cleared screen with the fixed prompt
and no newline before process exit. It checks the full authoritative tail and
rendered text at 1500×900, after 900×900 shrink, after growth, and after Settings
forces a new attachment token.

Separate live regressions exercise a real fixture Bash with a 94-P prompt plus
`> `, waiting for that initial prompt in both host and renderer before shrinking,
then checking one prompt after shrink and standalone `SHRINK_MARKER` output after
typing while narrow and growing. A raw Node child writes 96 P characters, stays
alive through shrink, growth and Settings reattachment, then writes Z. Host tail
and renderer must agree with Z at the end, without a stale reflow suffix. The
same raw case runs over fixture SSH in the remote-shell scenario. Windows also
exercises its ConPTY-owned console redraw; the Bash-only case is POSIX. Unit
coverage checks live/default writes, exited replay, and renderer lifecycle and
view-reuse policy. No fixture uses a real agent CLI, real SSH or user startup
files, and the close timing assertions remain unchanged.

Run 42551903310 attempt 1 artifact **13646043326** failed at readiness in
37.033 seconds; attempt 2 artifact **13648420047** passed in 7.195 seconds.
Run 42618694514 attempt 1 artifact **13676860593** repeated the same cutoff in
37.836 seconds. Neither older failure captured raw ConPTY output or cursor/resize
ordering, so the deterministic reproduction establishes the clipping mechanism
without claiming those artifacts contain that ordering trace. Future readiness
failures also print the bounded fixture tail, renderer grid/cursor geometry,
input editability and terminal exit state. No deadlines change.

The Bash resize precondition includes rendered text, not only the authoritative
tail. A controlled delayed-view reproduction held the wide prompt's stream until
after shrink: the host correctly retained one prompt, while parsing both the old
wide prompt and Bash's redraw at the new width left an extra 68-P prefix in the
renderer. This matched run 42646014373's Linux 4 failure at the renderer assertion
(artifact **13689210376**).
Waiting for both initial parsers before the resize retains every post-resize
assertion and changes no product policy or deadline.
