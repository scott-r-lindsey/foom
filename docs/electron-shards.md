# Electron test layout and shard balance

CI runs four named-test shards per platform. `tests/electron/shard-plan.json`
assigns measured tests to shards; `test-shard.js` hashes new or renamed tests,
and all tests at other shard counts. With no shard setting the full suite runs.
Native hooks and packaging still run only on shard 1. The Quality gate requires
all twelve Electron jobs. Test deadlines, step limits and retries are unchanged.

## Feature suites and local runs

`tests/electron/test-suites.js` discovers the sorted `*.test.js` files in
`tests/electron/`. Both the runner and shard integration check use this inventory:

| Suite | Scenarios |
| --- | --- |
| `terminal.test.js` | Shell I/O, cursor, PTY host, output, input and restart |
| `confirmations.test.js` | Trusted dialogs, quit and config argument consent |
| `workspace.test.js` | Repositories, worktrees, sessions, windows, sidebar and tiles |
| `previews.test.js` | Markdown/HTML views, focus, composition, security and reload |
| `settings.test.js` | Preflight, accessibility, appearance, sound and persisted settings |
| `agents.test.js` | Fixture agents, hooks, conversations, orchestration and plugins |
| `application.test.js` | Native board startup, fonts/themes and production bundle |
| `harness.test.js` | Launch environment, quit acknowledgement and cleanup contracts |

`harness.js` owns reusable launch, fixture, cleanup, diagnostics and interaction
helpers. Feature-specific helpers stay beside their scenarios. It registers no
tests. Launches retain isolated profiles and repositories, fixture login shells
and controlled PATH, the agent guard, process auditing, sandboxing and shared
`test-policy.js` deadlines. Cleanup quits every app before removing fixtures.

The wrapper passes `--test-concurrency=1` explicitly: feature files run serially
within each job, preserving native desktop/focus behavior. CI jobs remain
independent. `FOOM_ELECTRON_SHARD` partitions named tests across all feature
files, rather than partitioning files. With no setting, every suite runs fully.
The split preserves all 130 existing names and leaves `shard-plan.json` unchanged.
Generated loop cases are included in registration audits. Empty files on a shard
may appear as Node runner placeholders; these are not named test registrations.

```sh
# Full suite, no sharding (Linux)
xvfb-run -a pnpm run test:electron
# One exact test across discovered suites
xvfb-run -a pnpm run test:electron --test-name-pattern='^agent discovery uses the fixture login shell and controlled PATH$'
# Reuse the verified build for another focused run
xvfb-run -a pnpm run test:electron --reuse-build --test-name-pattern='^agent discovery uses the fixture login shell and controlled PATH$'
# Match CI shard 2 of 4
FOOM_ELECTRON_SHARD=2/4 xvfb-run -a pnpm run test:electron
# Registration, sharding and filter checks without launching Electron
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs scripts/electron-tests.test.mjs
```

On Windows/macOS omit `xvfb-run -a`. Both `--test-name-pattern=REGEX` and
`--test-name-pattern REGEX` are supported. Filters precede all suite paths;
zero passing selected tests fail. `--reuse-build` verifies the wrapper's build
receipt and rejects changed inputs/output. Focused checks do not replace the
full validation required by `AGENTS.md`.

## Measurements

Downloaded all nine `electron-results-*` artifacts from green main runs
[38627968212](https://github.com/scott-r-lindsey/foom/actions/runs/38627968212)
and [38611379264](https://github.com/scott-r-lindsey/foom/actions/runs/38611379264).
Each contains 119 named cases across three shards.

Run 38627968212, seconds in shard order (1, 2, 3):

| Platform | JUnit case duration sums | Electron step wall time | Step limit |
| --- | --- | --- | --- |
| Linux | 302.8 / 164.8 / 267.4 | 315 / 180 / 279 | 420 |
| Windows | 476.9 / 444.3 / 379.6 | 495 / 470 / 401 | 600 |
| macOS | 530.4 / 328.2 / 487.3 | 551 / 353 / 516 | 600 |

The second run's total case durations were Linux 725.6s, Windows 1235.5s,
and macOS 1177.9s. In the newer run macOS totals 1345.9s: even perfect
three-way balancing needs 448.6s before build/runner overhead, already at 75%
of the ten-minute step limit. Four shards provide room for that overhead and
variation without increasing timeouts.

The first PR run,
[38638986050](https://github.com/scott-r-lindsey/foom/actions/runs/38638986050),
passed all checks but Windows shard 4 took 486s (301 / 359 / 345 / 486s across
its four shards). Three Windows cases exceeded prior maxima substantially:
window restoration 77s versus 15s, preview handoff 54s versus 18s, and agent
discovery 37s versus 9s. The final plan includes all twelve reports from that
run as a third source and redistributes those costs. Linux steps took
200 / 191 / 204 / 186s; macOS steps took 359 / 361 / 346 / 328s.

## Assignment method

The plan records seconds per test in the listed platform order, taking the
maximum observed duration on each platform across the three source runs. Sort
cases by descending maximum fraction of a platform's total duration, breaking
ties by test name. Place each case on the shard that minimizes the largest
projected fraction across all platform/shard pairs; break ties by the selected
shard's sum of platform fractions, then shard index. This balances all three
platforms with one deterministic assignment.

Conservative projected case sums (maxima across all three runs), seconds:

| Platform | Shard 1 | Shard 2 | Shard 3 | Shard 4 |
| --- | ---: | ---: | ---: | ---: |
| Linux | 196.2 | 188.2 | 196.3 | 194.0 |
| Windows | 393.0 | 390.4 | 392.9 | 390.9 |
| macOS | 357.9 | 357.5 | 342.8 | 354.9 |

These are estimates, excluding build/runner overhead. Compare new CI JUnit
and step wall times when refreshing the plan. Update the source runs, durations
and assignment together. The shard integration test catches stale/duplicate
plan names, checks the explicit assignment and hash fallback, and verifies
exactly-once registration, name filtering and invalid-setting failures.
