# Electron test layout and shard balance

CI runs four named-test shards per platform. `tests/electron/shard-plan.json`
assigns measured tests to shards; `test-shard.js` hashes new or renamed tests,
and all tests at other shard counts. With no shard setting the full suite runs.
Native checks, packaging and packaged smoke run sequentially in one independent
companion job per platform, alongside the four Electron shards and static checks.
The Quality gate requires all twelve Electron jobs and all three companion jobs.
Failed, cancelled or skipped required jobs fail the gate; documentation-only runs
permit skipping both desktop matrices together. Native hook probes stay serial.
Electron steps have a ten-minute budget on every platform. Test deadlines are unchanged.

## Feature suites and local runs

`tests/electron/test-suites.js` discovers the sorted `*.test.js` files in
`tests/electron/`. Both the runner and shard integration check use this inventory:

| Suite | Scenarios |
| --- | --- |
| `terminal.test.js` | Shell I/O, cursor, PTY host, output, input and restart |
| `confirmations.test.js` | Trusted dialogs, quit and config argument consent |
| `workspace-cleanup.test.js` | Merged worktree cleanup, review and progress |
| `workspace-commands.test.js` | Application menu and native keyboard commands |
| `workspace-repositories.test.js` | Repository inventory, worktrees and guarded removal |
| `workspace-sidebar.test.js` | Sidebar focus, accessibility, panels and preferences |
| `workspace-tiles.test.js` | Tile placement, drag/split/swap, restore and focus |
| `workspace-windows.test.js` | Profile locks, exclusive views and window restore |
| `previews-files.test.js` | Contained file picks, persistence, removal and Markdown rendering |
| `previews-focus.test.js` | Native keyboard focus, navigation handoff and board shortcuts |
| `previews-security.test.js` | Page isolation, trusted external links and local HTTPS permissions |
| `previews-agent.test.js` | Agent preview columns, ownership, focus and human close |
| `previews-composition.test.js` | Panels, scrims, native frames, hit testing and gutter attachment |
| `previews-reload.test.js` | File saves, assets, missing files, scroll, watchers and symlink retargeting |
| `previews-move.test.js` | HTML/Markdown window moves and destination placement recovery |
| `preflight.test.js` | First-run setup, responsive steps and repository scans |
| `settings-accessibility.test.js` | Fullscreen transitions, keyboard focus, zoom and section accessibility |
| `settings-appearance.test.js` | Themes, native chrome, identity badges, fonts, window size and shared zoom |
| `settings-sound.test.js` | Dragged volume, recordings and synchronized footer volume/zoom |
| `settings-agents.test.js` | Environment, agent defaults, config menus and independent config shells |
| `settings-general.test.js` | Legacy migration, forge hosts, navigation, repository names, updates and close-finished preference |
| `pi-extension.test.js` | Fixed Pi per-launch extension, lifecycle, current-role MCP exposure and private-file cleanup |
| `agents.test.js` | Fixture agents, hooks, conversations, orchestration and plugins |
| `application.test.js` | Native board startup, fonts/themes and production bundle |
| `harness.test.js` | Launch environment, quit acknowledgement and cleanup contracts |
| `session-storage.test.js` | Chromium storage isolation, restore, temporary-directory fallback and cleanup |

`harness.js` owns reusable launch, fixture, cleanup, diagnostics and interaction
helpers. Feature-specific helpers stay beside their scenarios. It registers no
tests. See [explicit fixtures](electron-fixtures.md) for fixture selection and
setup/body/teardown timing definitions. Launches retain isolated profiles and
repositories, fixture login shells and controlled PATH, the agent guard, process
auditing, sandboxing and shared
`test-policy.js` deadlines. Cleanup quits every app before removing fixtures.

The wrapper passes `--test-concurrency=1` explicitly: feature files run serially
within each job, preserving native desktop/focus behavior. CI jobs remain
independent. `FOOM_ELECTRON_SHARD` partitions named tests across all feature
files, rather than partitioning files. With no setting, every suite runs fully.
Suite discovery preserves named registrations independently of file layout.
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

## Scheduling shard-1 extras (#490)

The companion job keeps native checks and packaging/smoke together. Separating
those into two additional jobs per platform would increase desktop concurrency
from 12 to 18; the chosen graph uses 15. Each job needs its own checkout, Node,
pnpm install and Electron preparation. The existing four-shard plan remains
unchanged so Electron coverage and balancing are independent of native/packaging
costs. Moving cases away from shard 1 would couple test assignment to variable
native and packaging overhead, while retaining their serial critical path.

Measured green main runs via the Actions jobs/steps API (seconds, all three
platforms; compute is unweighted runner wall time, not billed cost):

| Run | Longest desktop job | Total desktop runner seconds | Modeled longest after split | Modeled compute after split |
| --- | ---: | ---: | ---: | ---: |
| [38776482441](https://github.com/scott-r-lindsey/foom/actions/runs/38776482441) | 615 | 4352 | 522 | 4429 |
| [38783252713](https://github.com/scott-r-lindsey/foom/actions/runs/38783252713) | 838 | 4958 | 521 | 5061 |

The model moves native, packaging, signature and smoke step seconds out of each
shard 1, duplicating its measured setup/cleanup/upload seconds in one new job.
It estimates 15–38% shorter longest jobs for 1.8–2.1% more runner time, before
queueing. These green runs predate #491's single packaging build; they establish
historical variability, not the final comparable baseline. Two green #491 PR runs provide a single-build comparison:

| Run | Longest job / compute | Combined model / compute | Separate native + packaging model / compute |
| --- | ---: | ---: | ---: |
| [38782389108](https://github.com/scott-r-lindsey/foom/actions/runs/38782389108) | 643 / 4447 | 467 / 4547 | 467 / 4647 |
| [38786409426](https://github.com/scott-r-lindsey/foom/actions/runs/38786409426) | 979 / 4923 | 562 / 5012 | 524 / 5101 |

The second run's Windows packaging step took 328s versus 140s in the first.
Separating native from packaging saves a further 38s in that outlier, and no time
in the other run, at the cost of another three setups (89–100 runner seconds,
plus runner availability). Combined jobs are the chosen compromise: 27–43%
modeled longest-job reduction for 1.8–2.2% more runner time. Four shards remain
necessary for the Electron steps; rebalancing alone cannot remove all of the
serial extras. Runner queues and observed PR runs must be compared before
treating modeled savings as achieved.

Runner availability matters: desktop start times spanned 68s / 437s in the two
green main runs and 755s / 1015s in the green single-build PR runs. Queueing can
dominate the gate even when no job is slow. These observations favor three
additional jobs over six, and require reporting actual elapsed gate time as well
as job duration and compute in the PR comparison.

### Observed companion-job run

[38794446976](https://github.com/scott-r-lindsey/foom/actions/runs/38794446976)
uses the same application/test inputs as starting main
[38792710373](https://github.com/scott-r-lindsey/foom/actions/runs/38792710373),
including #491 and #486. The workflow and policy/docs are the changed inputs.
Both runs fail the same Windows shard-2 Settings visibility assertion; main also
fails Linux shard 3's board animation assertion (#470). These are failed runs,
not green validation evidence. All fifteen desktop jobs completed, so their
runner/step timings remain usable observations.

| Measurement (seconds) | Starting main | Companion PR run | Change |
| --- | ---: | ---: | ---: |
| Change detection complete → Quality gate complete | 727 | 481 | −246 (−33.8%) |
| Longest desktop job | 719 | 474 | −245 (−34.1%) |
| Total desktop runner time | 4542 | 4706 | +164 (+3.6%) |
| Desktop job start spread | 6 | 88 | +82 |
| Linux desktop runner time | 888 | 919 | +31 |
| Windows desktop runner time | 2092 | 2174 | +82 |
| macOS desktop runner time | 1562 | 1613 | +51 |

The companion jobs passed in Linux 77s, Windows 402s and macOS 149s; all Linux
and macOS Electron shards passed. Windows shard 2 failed in 474s; successful
Windows shard 4 took 471s. The Quality gate failed as required. Splitting native
and packaging into separate jobs would not shorten this observed critical path:
Windows Electron, rather than its 402s companion, was the longest job.
Aggregate compute excludes static checks, unit coverage and gate/queue time;
platform runner seconds are unweighted, not billing estimates. Queueing, runner
variation and assertion failures limit causal comparisons; multiple baseline
runs above show why a single percentage is not a promised saving. Further PR
run comparisons and validation outcomes are recorded in the PR body.

Companion diagnostics use `platform-results-OS`; Electron diagnostics retain
`electron-results-OS-INDEX`. Both upload `test-results/` on failure, with the
same three-day retention and missing-file failure. Only companion jobs build
and smoke-test ZIPs, verify strict macOS signatures, stamp eligible nightly
versions and upload `Foom-OS` artifacts. Nightly publication still waits for the
complete Quality gate and downloads those same tested artifacts without rebuilding.
Workflow permissions are unchanged. See the [documentation map](README.md) and
[validation guide](validation.md) for contributor entry points and the CI overview.

## Assignment method

The plan records seconds per test in the listed platform order, taking the
maximum observed duration on each platform across the listed source runs. Sort
cases by descending maximum fraction of a platform's total duration, breaking
ties by test name. Place each case on the shard that minimizes the largest
projected fraction across all platform/shard pairs; break ties by the selected
shard's sum of platform fractions, then shard index. This balances all three
platforms with one deterministic assignment.

Historical projected case sums for the original plan (maxima across its three
source runs), seconds:

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

## Rebalancing from current reports (#708)

Run with Node 24 and the installed project dependencies. The rebalance script
uses only Node standard-library modules. Download all twelve Electron artifacts
per run into ignored
`test-results/rebalance/sources/RUN_ID/`; keep the artifact directories intact:

```sh
for run in 39698958046 39717071939 39718663296; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/sources/$run"
done
# Preview before/after totals without changing the plan:
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/*
# Rebuild, then apply repository JSON formatting:
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/* --write
pnpm run format
# Registration audit, including exactly-once coverage and hash fallback:
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs
```

Choose recent green runs covering the current cases on all three platforms.
The script uses actual suite registrations (including generated cases) without
running test bodies, discards removed names and empty-file placeholders, decodes
JUnit names with a strict reader for Node JUnit XML (no DTDs or external
entities), and records skipped cases as zero. It rejects
missing reports, duplicate cases, failed cases, invalid durations and current
cases without measurements on any platform. It prints the old assignment's
projected totals using the same new measurements, including hash fallback for
previously unplanned names, then applies the deterministic assignment above.
No test deadlines, shard count or workflow step limits change. Unchanged plans
retain their existing bytes. Parser, input-validation and deterministic-assignment
fixtures run in `pnpm run test:ci`.

The refresh uses green main runs
[39698958046](https://github.com/scott-r-lindsey/foom/actions/runs/39698958046)
and [39717071939](https://github.com/scott-r-lindsey/foom/actions/runs/39717071939),
plus the original reports from triggering main run
[39718663296](https://github.com/scott-r-lindsey/foom/actions/runs/39718663296).
That last run's Linux shard 3 exceeded its step budget although all its named
cases passed; its JUnit reports contain no failed cases. It supplies measurements
for six newly added review-loop cases absent from the two green runs. It is
measurement evidence, not a green validation run. These reports cover all 167
current cases; earlier runs cover 156 and 161 respectively.

Conservative case-duration sums, using each case's maximum per platform across
these three runs (seconds; old plan includes hash assignments for new cases):

| Platform | Before: shards 1 / 2 / 3 / 4 | After: shards 1 / 2 / 3 / 4 |
| --- | --- | --- |
| Linux | 246.3 / 291.0 / 426.5 / 279.7 | 311.6 / 311.2 / 310.2 / 310.5 |
| Windows | 428.8 / 396.1 / 513.6 / 533.0 | 466.3 / 468.3 / 468.5 / 468.3 |
| macOS | 357.7 / 363.6 / 482.7 / 357.4 | 387.7 / 391.8 / 390.6 / 391.2 |

The maximum Linux case sum drops by 114.9s (27%); Windows by 64.5s (12%)
and macOS by 90.9s (19%). These projections exclude build, runner and empty-file
overhead, and combine maxima that need not occur in the same run. Check actual
PR step wall times against the unchanged 420s Linux / 600s Windows and macOS
limits before calling the balance validated. The earlier measurements above
remain historical context, not this refresh's inputs.

## Merged worktree cleanup validation (#729)

After merging main's newer desktop scenarios, PR #736's Windows shard 2 reached
its ten-minute step limit twice in run
[39977391256](https://github.com/scott-r-lindsey/foom/actions/runs/39977391256).
The second attempt completed cases with normal fixture timings but could not
finish the assigned workload. These interrupted reports are diagnostic evidence,
not passing validation or inputs to the rebalance tool.

Refresh the plan from the unmodified JUnit reports of green PR run
[39946613615](https://github.com/scott-r-lindsey/foom/actions/runs/39946613615)
and green merged-main run
[39970696968](https://github.com/scott-r-lindsey/foom/actions/runs/39970696968).
Together their 24 reports measure all 184 current registered cases on all three
platforms, including the cleanup scenarios and newly merged desktop cases.
The existing rebalance script takes per-case maxima across both sources and
keeps the same four shards and registration checks.

| Platform | Before: shards 1 / 2 / 3 / 4 | After: shards 1 / 2 / 3 / 4 |
| --- | --- | --- |
| Linux | 304.7 / 332.9 / 340.7 / 316.8 | 320.6 / 327.2 / 322.8 / 324.5 |
| Windows | 442.5 / 586.6 / 510.4 / 442.8 | 493.6 / 497.2 / 496.0 / 495.5 |
| macOS | 350.2 / 433.5 / 440.6 / 373.2 | 403.0 / 391.8 / 401.3 / 401.2 |

These are conservative case sums in seconds, excluding build and runner overhead.
Windows shard 2 previously left only 13.4 seconds for that overhead; the refreshed
maximum leaves 102.8 seconds. Actual CI outcomes remain the validation evidence.
Test deadlines and workflow step limits retain their existing values.
## Rebalancing from current reports (#751)

Refreshed all 185 current named cases using passing main runs
[39918020774](https://github.com/scott-r-lindsey/foom/actions/runs/39918020774)
and [39970696968](https://github.com/scott-r-lindsey/foom/actions/runs/39970696968),
plus passing PR runs
[39946804406](https://github.com/scott-r-lindsey/foom/actions/runs/39946804406),
[39973853488](https://github.com/scott-r-lindsey/foom/actions/runs/39973853488),
and [39981523976](https://github.com/scott-r-lindsey/foom/actions/runs/39981523976).
All twelve Electron reports from each run are inputs. The newest main reports
cover the GitLab cases added after this branch was created; the latest update PR
reports measure the update-settings case subsequently merged into main. The
#750 reports also measure its two new harness cases after incorporating those
flake fixes from main. The existing script
uses per-case maxima across these runs; older runs may omit newer cases when
another input measures them on every platform.

| Platform | Before: shards 1 / 2 / 3 / 4 | After: shards 1 / 2 / 3 / 4 | After max/min spread | Case-sum headroom |
| --- | --- | --- | --- | --- |
| Linux | 315.0 / 349.5 / 378.2 / 341.6 | 346.9 / 345.3 / 348.0 / 344.1 | 1.1% | 72.0s / 17.1% |
| Windows | 560.7 / 574.1 / 548.1 / 487.1 | 540.3 / 546.2 / 545.3 / 538.2 | 1.5% | 53.8s / 9.0% |
| macOS | 408.5 / 530.0 / 475.9 / 428.7 | 460.5 / 463.0 / 455.6 / 464.0 | 1.8% | 136.0s / 22.7% |

Values are seconds; spread is `(maximum / minimum - 1) * 100`.
Headroom subtracts the largest projected case sum from the unchanged step budget
(420s Linux, 600s Windows/macOS). These conservative projections combine maxima
that may come from different runs and exclude build/runner overhead. Actual PR
step times remain the validation evidence. No shard count, workflow budget or
test deadline changed. The [validation guide](validation.md#refreshing-the-electron-shard-plan)
includes the repeatable refresh procedure.

## Combined cleanup and current-main measurements (#729)

Merging main at `529b53d2` brings the #751 refresh and three newer named cases.
Regenerate from the union of the two refreshes' green sources: the five runs
listed above plus [39946613615](https://github.com/scott-r-lindsey/foom/actions/runs/39946613615).
All 72 unmodified Electron reports feed the existing script; its per-platform
maxima cover all 187 current registrations, including both new cleanup cases.
Both earlier refresh descriptions remain historical evidence.

| Platform | Main plan plus hash fallback | Combined measured plan |
| --- | --- | --- |
| Linux | 348.5 / 351.9 / 354.1 / 345.4 | 351.0 / 351.0 / 345.3 / 352.7 |
| Windows | 555.8 / 585.1 / 560.4 / 551.0 | 563.2 / 565.8 / 562.0 / 561.3 |
| macOS | 463.1 / 481.8 / 461.8 / 467.5 | 462.9 / 470.4 / 469.4 / 471.6 |

Values are conservative case sums in seconds, excluding build/runner overhead.
The largest sums leave 67.3s Linux, 34.2s Windows and 128.4s macOS step headroom.
Four shards, test deadlines, coverage thresholds and workflow budgets retain
main's values. Actual CI step outcomes remain the validation evidence.

## Linux step headroom and current measurements (#839)

Keep four shards per platform and raise only the Linux Electron step budget from
420s to 600s, matching Windows and macOS. The previous budget left too little
room for build/runner overhead and variation as new cases accumulated.

Refresh all 195 current named cases from all twelve Electron JUnit reports in each
green PR run: [40172284285](https://github.com/scott-r-lindsey/foom/actions/runs/40172284285),
[40172098574](https://github.com/scott-r-lindsey/foom/actions/runs/40172098574), and
[40167686820](https://github.com/scott-r-lindsey/foom/actions/runs/40167686820).
The existing generator takes per-case maxima on each platform and places previously
hash-assigned cases using those measurements.

| Platform | Before: shards 1 / 2 / 3 / 4 | After: shards 1 / 2 / 3 / 4 |
| --- | --- | --- |
| Linux | 409.4 / 394.8 / 370.6 / 400.1 | 396.4 / 390.6 / 397.3 / 390.5 |
| Windows | 483.6 / 494.5 / 491.2 / 491.2 | 483.5 / 491.7 / 493.0 / 492.3 |
| macOS | 440.7 / 527.2 / 407.8 / 428.4 | 453.1 / 452.2 / 443.5 / 455.4 |

These conservative case sums are seconds, combining maxima from different runs
and excluding build/runner overhead. The largest Linux projection leaves 202.7s
(33.8%) under the new budget, versus 10.6s under the former budget before the
refresh. Actual PR step wall times must leave at least 60s; record those separately
in the PR body. Earlier budget statements and measurements above are historical.
Per-test deadlines, worker watchdog, shard count, coverage and Quality gate
requirements remain unchanged.
