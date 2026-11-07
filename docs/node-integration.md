# Real Node integration pilot (#1101)

Run `pnpm run test:integration`. This small in-place lane bundles production core
and console entry points with esbuild, then runs Node's test runner against real
Git repositories, native node-pty terminals, headless xterm, files and authenticated
loopback control HTTP. It needs no display or application build. A runtime resolve
hook rejects Electron imports (with negative checks for `electron` and
`electron/main`), and the runner asserts it is not executing under Electron.
External native dependencies use the installed packages; no rebuild overwrites
Electron's addons.

The lane runs before native checks in the existing **Native checks and packaging**
job on Linux, Windows and macOS. That matrix is already required by the Quality
gate. No jobs are added; required checks, deadlines and coverage policies stay unchanged. The user
merges this CI change.

## Ported assertions and retained boundaries

The single port comes from **a child hands off results through the CLI without
terminal input and the parent pulls them** in
`tests/electron/orchestration.test.js` and `orchestrator-scenario.js`.

| Portable assertion | Node pilot |
| --- | --- |
| Ordinary agent cannot create children; trusted main elevation grants orchestrator role | Real AgentService discovery/launch and Workspace role transition; approval callback accepts |
| Worktree creation is idempotent; child launches in its own branch | Authenticated HTTP, durable operations, real Git worktree and branch inspection |
| Launch guidance includes reporting; child cannot create worktrees | Real provider argv and fresh child control grant |
| CLI file handoff, sequence and parent pull | Production console source bundle, real UTF-8 file and HTTP; same failed status, markup-like summary and HTTPS link |
| Accepted report visible immediately; waiting wakes with metadata only | Session-state and wait-for assertions preserve sequence/status and omit summary |
| Handoff is pull-only | Both terminal input capabilities recorded; neither called; fixture stdin records remain absent |
| Action history identifies child and parent without summary | Real private action log read |
| Human takeover revokes reporting and parent reads | Workspace takeover, fixed `no_parent` and `not_found` results |

The pilot additionally checks replay deduplication, untrusted report marking,
headless PTY output, actual fixture process exit, empty agent-guard log and control
discovery removal. The executable guard covers native PTY creation as well as
exec/spawn probes. All homes, profiles, shell files and CLI binaries are test-owned;
Windows embeds the fixture in a copied Node SEA, POSIX uses a script. The fixture
login shell never sources the user's rc files. No real agent or forge CLI runs.

Every Electron test remains intact. Native dialog disclosure/approval, CLI SEA
packaging, MCP attachment, renderer/IPC, inert summary rendering, HTTPS link UI,
accessibility, focus and the Electron descendant-process audit still belong to the
retained test and desktop/native suite. The Node terminal adapter runs in process:
it proves neither utility-process transport nor process isolation/recovery. Hooks,
restart/session persistence, remote hosts and review loops are outside this pilot.

## Measurement method

`test-results/node-integration/runner.json` separates the two esbuild bundles from
the child test-process wall time and their total. That total excludes pnpm startup
and the outer temporary-root wrapper; the CI step duration includes them.
JUnit records the case duration, and its diagnostic records setup/body/teardown.
Setup includes fixture CLI creation (including Windows SEA injection), Git, core
loading, control startup, parent discovery/launch and main-owned elevation.
Body starts before child worktree creation. Teardown shuts down PTYs, observes
Workspace exit work, disposes core services and removes owned files.

Compare the retained named case in each platform's Electron JUnit artifacts,
including skipped status, plus its existing fixture phase timings. Windows skips
that retained POSIX-agent case: its Electron time is zero executed seconds, not a
Windows equivalence claim. The new Windows Node case must actually pass.

The native platform artifact includes the Node JSON and JUnit files. CI job/step
start and completion times provide build/job overhead. This adds a step to existing
jobs, so there is no new runner provisioning/install job; integration bundle and
fixture setup costs are still counted. Existing native/packaging and desktop build
costs are retained. Hosted-job variation is not causal overhead measurement.

The PR records observed values from its CI run on all three platforms, along with
the retained case and platform job/step walls. No Electron coverage is deleted;
achieved removal savings are zero. Net added work is the Node step. A faster core
case alone cannot establish faster PR feedback or justify deleting desktop checks.
