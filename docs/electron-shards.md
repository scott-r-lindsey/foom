# Electron test layout and shard balance

Full CI runs use four named-test shards on Linux, six on Windows and eight on macOS.
Draft PRs with entirely mapped changes run the affected suites once per platform
using shard `1/1`; any unmapped path retains the full matrix. The ready transition
runs the full matrix unless CI verifies a completed full run for the same head SHA,
base and workflow file. `tests/electron/shard-plan.json`
stores assignments keyed by shard count and the CI count for each platform; `test-shard.js` hashes new or renamed tests,
and all tests at unplanned shard counts. With no shard setting the full suite runs.
Native checks, packaging and packaged smoke run sequentially in one independent
companion job per platform after all host builds succeed. Linux and Windows
Electron and all host builds can start as soon as change detection finishes.
macOS Electron and macOS native checks and packaging wait for all Linux
Electron shards to succeed.
The Quality gate requires all eighteen Electron jobs, host builds and all three
packaging jobs. Draft quality gate requires the selected Electron jobs and the
same host build and packaging jobs.
It cannot satisfy the required Quality gate. See [merge safety](validation.md#ci-and-packages).
Failed, cancelled or skipped required jobs fail the gate; documentation-only runs
permit skipping all desktop jobs together. Native hook probes stay serial.
Electron steps allow fourteen minutes on Linux, Windows and macOS. Per-test
deadlines and the worker watchdog are unchanged.

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
within each job, preserving native desktop/focus behavior. Shards within a
platform run in separate CI jobs. `FOOM_ELECTRON_SHARD` partitions named tests across all feature
files, rather than partitioning files. With no setting, every suite runs fully.
Suite discovery preserves named registrations independently of file layout.
Generated loop cases are included in registration audits. Empty files on a shard
may appear as Node runner placeholders; these are not named test registrations.

```sh
# Full suite, no sharding (Linux)
xvfb-run -a pnpm run test:electron
# One exact test across discovered suites
xvfb-run -a pnpm run test:electron --test-name-pattern='^agent discovery uses the fixture login shell and controlled PATH$'
# Run the same command again to reuse a matching build
# Match CI shard 2 of 4
FOOM_ELECTRON_SHARD=2/4 xvfb-run -a pnpm run test:electron
# Registration, sharding and filter checks without launching Electron
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs scripts/electron-tests.test.mjs
```

On Windows/macOS omit `xvfb-run -a`. Both `--test-name-pattern=REGEX` and
`--test-name-pattern REGEX` are supported. Filters precede all suite paths;
zero passing selected tests fail. See [build reuse](validation.md#tests-and-coverage)
for the local default and strict `--reuse-build` mode. Follow the full validation
workflow in `AGENTS.md` before delivery.

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
platforms with one deterministic assignment for each configured shard count.

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
uses only Node standard-library modules. Download all twelve historical Electron artifacts
per run into ignored
`test-results/rebalance/sources/RUN_ID/`; keep the artifact directories intact:

```sh
for run in 39698958046 39717071939 39718663296; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/sources/$run"
done
# Preview before/after totals without changing the plan:
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/* --source-shards=4
# Rebuild, then apply repository JSON formatting:
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/* --source-shards=4 --write
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
The current platform shard counts come from the plan. Use `--source-shards=4`
for historical inputs with four reports per platform. A run-specific override,
for example `--source-shards=41409300263:4,5,5`, permits combining historical
and current matrices without guessing missing artifact counts. Regeneration keeps the
configured counts, test deadlines and workflow step limits. Unchanged plans
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


## Windows and macOS step headroom (#868)

Keep the current four-shard assignment and raise the Windows/macOS Electron step
from 600s to 840s. Downloaded the unmodified `electron-results-*` JUnit and fixture
timing artifacts with `gh run download` from runs
[40232541625](https://github.com/scott-r-lindsey/foom/actions/runs/40232541625),
[40234284775](https://github.com/scott-r-lindsey/foom/actions/runs/40234284775), and
[40246912522](https://github.com/scott-r-lindsey/foom/actions/runs/40246912522).
The Actions jobs/steps API supplies elapsed step time, excluding job setup.
These runs use the current shard plan; later reports include new hash-assigned cases.

Seconds in shard order (1 / 2 / 3 / 4):

| Run / platform | Named JUnit case sums | Electron step wall time |
| --- | --- | --- |
| 40232541625 Windows | 476.6 / 383.3 / 355.4 / 353.5 | 540 / 419 / 394 / 391 |
| 40232541625 macOS | 405.1 / 339.1 / 409.6 / 387.1 | 466 / 390 / 476 / 439 |
| 40234284775 Windows | 464.9 / 523.5 / 472.3 / 382.9 | 528 / 585 / 534 / 426 |
| 40234284775 macOS | 319.7 / interrupted / 400.5 / 362.2 | 364 / 613 (cancelled) / 481 / 417 |
| 40246912522 Windows | 486.3 / 489.5 / 517.5 / 486.5 | 549 / 544 / 582 / 549 |
| 40246912522 macOS | 442.8 / 404.1 / 506.2 / 365.6 | 502 / 475 / 587 / 424 |

The last run's Windows shard 2 and macOS shard 3 timings/reports are successful
reruns; their first attempts were cancelled at 601s and 613s respectively. The
main-run macOS shard 2 log explicitly reports the ten-minute action timeout;
its last completed case passed seven seconds before cancellation. Its incomplete
report is not a passing measurement or rebalance input. Its 41 completed fixture records already sum to 512.1s
(130.9s setup, 338.8s body, 42.4s teardown), before remaining cases and runner
work. Complete JUnit rows above contain no failed named cases.

Successful Windows steps leave as little as 15s under 600s; macOS leaves 13s.
The observed cancellations and macOS rerun at 587s support increasing both
platforms rather than Windows alone. An 840s budget leaves 255s above the
slowest observed successful Windows step and 253s above macOS, allowing about
43% variation beyond those observations. This is explicit headroom, not a
prediction of interrupted runs' completion times. The existing 20-minute job
limit remains the outer bound, including setup and diagnostic uploads.

All four Windows shards reach 544–582s in the latest run. Reassignment alone
cannot provide comparable headroom across the platform, so no tests move and
the plan needs no regeneration. Linux retains 600s; test deadlines, worker
watchdog, coverage and Quality gate required jobs are unchanged.

## Removal-dialog regression cases (#929)

Refresh the measured plan after adding fifteen removal-dialog cases. Downloaded
all twelve Electron artifacts from green PR runs
[41337210641](https://github.com/scott-r-lindsey/foom/actions/runs/41337210641)
and [41344658085](https://github.com/scott-r-lindsey/foom/actions/runs/41344658085),
selecting the latest artifact for each platform/shard by creation timestamp and
checking its ID against the successful job log. Artifact IDs are not chronological.
Both runs became green after their single failed-jobs rerun; only their complete
passing JUnit reports are inputs. The existing rebalance script accepts all 261
registrations present at that refresh across these 24 unmodified reports.
The later queued-board-close regression uses the existing name-hash fallback
until a subsequent measurement refresh.

The latter run's first macOS shard 2 attempt exhausted its 840s step budget;
main run [41339094760](https://github.com/scott-r-lindsey/foom/actions/runs/41339094760)
had already exhausted the same shard budget. Interrupted reports are diagnostic
evidence and are excluded from this refresh. Its Windows shard 4 passed the
fixture executable-lifetime fix; that within-case race is independent of assignment.
Main and the two preceding failed PR attempts ran the missing-agent case third,
with the same predecessors and common-case order. The two new shard-4 removal
cases came later.

Conservative case-duration sums, taking each case's maximum per platform across
the two passing runs (seconds; the before plan includes hash fallback):

| Platform | Before: shards 1 / 2 / 3 / 4 | After: shards 1 / 2 / 3 / 4 |
| --- | --- | --- |
| Linux | 486.6 / 468.0 / 487.9 / 414.3 | 464.1 / 468.4 / 461.5 / 462.8 |
| Windows | 754.4 / 657.6 / 784.6 / 598.7 | 699.3 / 700.1 / 699.1 / 696.7 |
| macOS | 658.1 / 779.1 / 737.2 / 667.1 | 717.2 / 692.5 / 715.4 / 716.6 |

These projections exclude build/runner overhead and combine maxima from different
runs. Validate actual step times on the refreshed PR before treating the balance
as verified. Four shards, per-test deadlines, workflow step limits, process audit,
coverage rules and Quality gate requirements stay unchanged.

## Windows/macOS headroom (#1014)

The first refinement used 40 complete passing Electron JUnit reports from three green runs covering
all 268 registrations after the tile-size fixture changes on main:

- [41410112211](https://github.com/scott-r-lindsey/foom/actions/runs/41410112211): four shards per platform.
- [41423707884](https://github.com/scott-r-lindsey/foom/actions/runs/41423707884): four Linux and five Windows/macOS shards.
- [41434373269](https://github.com/scott-r-lindsey/foom/actions/runs/41434373269): the same four/five/five matrix.

The initial refresh also used the requested historical reports from
[41390347255](https://github.com/scott-r-lindsey/foom/actions/runs/41390347255),
[41397433670](https://github.com/scott-r-lindsey/foom/actions/runs/41397433670),
[41398569843](https://github.com/scott-r-lindsey/foom/actions/runs/41398569843),
[41402156082](https://github.com/scott-r-lindsey/foom/actions/runs/41402156082), and
[41409300263](https://github.com/scott-r-lindsey/foom/actions/runs/41409300263).
Those inputs span older fixture behavior. After main repaired occupied tile grids
and restored window sizes, their maxima overestimated some now-cheaper scenarios
and left other groups too heavy. Retain them as historical evidence, but use the
three latest green reports with the current fixtures for that refinement.
The maximum-per-case rule and deterministic assignment algorithm are unchanged;
no slow passing observation in the current-fixture reports is discarded.

For duplicate artifact names, select by creation time and match the ID against
the successful job's upload log; IDs are not chronological. Use only complete
passing reports. Failed/interrupted attempts remain diagnostic evidence. Keep
unmodified reports under ignored `test-results/rebalance/current-sources/`:

```sh
for run in 41410112211 41423707884 41434373269; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/current-sources/$run"
done
node scripts/rebalance-electron-shards.mjs test-results/rebalance/current-sources/{41410112211,41423707884,41434373269} --source-shards=4,5,5 --source-shards=41410112211:4 --write
pnpm run format
```

These sources used the earlier four/five/five matrix. The explicit per-run override
requires four reports per platform in the older source rather than guessing a
smaller matrix from missing artifacts.

Four-way rebalancing cannot meet approximately 660 seconds: Windows case maxima
total 2980.9 seconds, requiring at least 745.2 seconds per shard before overhead,
even with perfect balance. macOS totals 2915.6 seconds, or 728.9 per shard. Keep
four Linux shards and initially use five on Windows/macOS. The matrix reads platform counts
from the plan; the helper selects the measured assignment for the requested
count. New names and unplanned counts retain name hashing. All fourteen Electron
jobs and three companions remained required in that first matrix; deadlines, watchdogs and step limits
were unchanged. That matrix added two desktop jobs and requested seven macOS jobs including
the combined Darwin host builder.

Case-sum projections in seconds, using per-case/platform maxima across these
three current-fixture runs:

| Platform | Regenerated four shards | Regenerated five shards |
| --- | --- | --- |
| Linux | 482.2 / 485.8 / 491.7 / 483.2 | unused |
| Windows | 746.1 / 741.8 / 746.2 / 746.8 | 594.8 / 594.6 / 595.0 / 595.7 / 600.9 |
| macOS | 734.9 / 738.0 / 707.5 / 735.2 | 589.3 / 589.8 / 563.9 / 586.7 / 585.8 |

With the same measurements, the prior five-way assignment peaked at 648.1 seconds
on Windows and 624.7 seconds on macOS. The refresh reduces those maxima by 47.2
and 34.9 seconds. These sums combine maxima from different runs and exclude build,
runner and empty-file overhead; actual step wall times establish acceptance.

### Earlier five-shard observations

Passing Electron step seconds in shard order, before the current-fixture refresh:

| Run | Platform | Shard step seconds |
| --- | --- | --- |
| [41423707884](https://github.com/scott-r-lindsey/foom/actions/runs/41423707884) | Linux | 542 / 436 / 562 / 508 |
| [41423707884](https://github.com/scott-r-lindsey/foom/actions/runs/41423707884) | Windows | 588 / 490 / 604 / 620 / 637 |
| [41423707884](https://github.com/scott-r-lindsey/foom/actions/runs/41423707884) | macOS | 620 / 617 / 595 / 615 / 548 |
| [41434373269](https://github.com/scott-r-lindsey/foom/actions/runs/41434373269) | Linux | 547 / 533 / 533 / 519 |
| [41434373269](https://github.com/scott-r-lindsey/foom/actions/runs/41434373269) | Windows | 600 / 532 / 442 / 632 / 682 |
| [41434373269](https://github.com/scott-r-lindsey/foom/actions/runs/41434373269) | macOS | 562 / 713 / 721 / 636 / 572 |

Every required check passed in both runs after one failed-jobs rerun each.
41423707884 recovered a Windows native-input exit assertion. 41434373269 recovered
a Windows packaged CDP startup wait and a macOS remote-child restore timeout.
No test body or deadline changed for recovery. The latter run's 11m53s and 12m01s
passing macOS steps are above target; green checks alone are insufficient.

Replaying each run's case measurements through the new assignment while retaining
its observed per-shard overhead projects Windows maxima of 615.4 / 600.9 seconds
and macOS maxima of 626.1 / 654.2 seconds. This is a model, not observed speedup:
moving cases between runners can change their cost. Three actual CI runs with the
refreshed assignment must verify the approximately eleven-minute target. Further
validation results are recorded below and in PR #1015.

### Five-way current-fixture validation

Passing Electron step wall seconds in shard order, including test-runner overhead:

| Run | Platform | Shard step seconds |
| --- | --- | --- |
| [41444554329](https://github.com/scott-r-lindsey/foom/actions/runs/41444554329) | Linux | 429 / 518 / 472 / 486 |
| [41444554329](https://github.com/scott-r-lindsey/foom/actions/runs/41444554329) | Windows | 448 / 566 / 568 / 636 / 593 |
| [41444554329](https://github.com/scott-r-lindsey/foom/actions/runs/41444554329) | macOS | 592 / 649 / 525 / 480 / 649 |
| [41452846093](https://github.com/scott-r-lindsey/foom/actions/runs/41452846093) | Linux | 393 / 540 / 460 / 526 |
| [41452846093](https://github.com/scott-r-lindsey/foom/actions/runs/41452846093) | Windows | 577 / 560 / 470 / 599 / 607 |
| [41452846093](https://github.com/scott-r-lindsey/foom/actions/runs/41452846093) | macOS | 621 / 621 / 602 / 701 / 803 |

The Windows shard 4 native-input readiness assertion failed on its first attempt
and passed the single failed-jobs rerun. No test body or deadline changed.
Windows peaks at 10m36s and macOS at 10m49s in the first run. Every required check
passed in both runs, but macOS reached 11m41s and 13m23s in the second run, without
test failures. Five-way sharding did not establish repeatable headroom.

### Six macOS shards after the measured five-way miss

Retain all 68 complete passing reports from the five current-fixture runs above,
including the slow passing observations in 41452846093. That run's macOS shard 4
contains 590.3 seconds of named cases and 110.7 seconds of build/runner overhead;
shard 5 contains 698.5 seconds of cases and 104.5 seconds of overhead. Its largest
case increases include remote Pi/OpenCode setup, child review and SSH-loss replay.
No individual failure or timeout explains the slow passing step.

Across all five runs, macOS case maxima total 3117.4 seconds. Perfect five-way
balance would still require 623.5 seconds before overhead. The regenerated plan
peaks at 629.5 seconds, leaving only 30.5 seconds for overhead under a 660-second
target, versus the observed 104.5–110.7 seconds in that run. Increase macOS to six
shards. Windows remains at five: both validation runs met the target on every
Windows shard. Linux remains at four.

Regenerate all three measured assignments from the same five-run corpus:

```sh
for run in 41410112211 41423707884 41434373269 41444554329 41452846093; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/current-sources/$run"
done
node scripts/rebalance-electron-shards.mjs test-results/rebalance/current-sources/* --source-shards=4,5,5 --source-shards=41410112211:4 --write
pnpm run format
```

| Platform | Configured count | Projected case seconds per shard |
| --- | --- | --- |
| Linux | 4 | 495.6 / 489.2 / 487.0 / 490.3 |
| Windows | 5 | 640.7 / 637.9 / 633.8 / 637.4 / 640.4 |
| macOS | 6 | 521.8 / 520.1 / 522.7 / 523.8 / 505.5 / 523.4 |

That six-shard matrix required fifteen Electron jobs and three native/packaging jobs.
It requested eight macOS jobs including the companion and combined Darwin host
builder, one more than the measured five-way matrix. Step limits, individual
deadlines, the watchdog, process auditing and Quality gate semantics remain
unchanged. These case-sum projections require actual CI timing validation;
the five-way results above do not establish acceptance for this assignment.

### Four/five/six timing validation

Passing Electron step wall seconds in shard order, including build/runner overhead:

| Run | Platform | Shard step seconds |
| --- | --- | --- |
| [41456673621](https://github.com/scott-r-lindsey/foom/actions/runs/41456673621) | Linux | 530 / 462 / 517 / 493 |
| [41456673621](https://github.com/scott-r-lindsey/foom/actions/runs/41456673621) | Windows | 553 / 571 / 422 / 600 / 621 |
| [41456673621](https://github.com/scott-r-lindsey/foom/actions/runs/41456673621) | macOS | 545 / 552 / 531 / 545 / 447 / 537 |
| [41461085057](https://github.com/scott-r-lindsey/foom/actions/runs/41461085057) | Linux | 539 / 529 / 486 / 530 |
| [41461085057](https://github.com/scott-r-lindsey/foom/actions/runs/41461085057) | Windows | 605 / 691 / 610 / 610 / 608 |
| [41461085057](https://github.com/scott-r-lindsey/foom/actions/runs/41461085057) | macOS | 485 / 473 / 479 / 578 / 638 / 471 |

Every required check passed on the first attempt in both runs. Windows peaks at
10m21s / 11m31s and macOS at 9m12s / 10m38s. The second Windows peak is 31 seconds
above the nominal eleven-minute target, retaining 2m29s under the unchanged
14-minute limit. That shard contains 623.3 seconds of cases and 67.7 seconds of
overhead. Its merged-cleanup progress case rose from the source maximum of 43.2
seconds to 82.6 seconds; the other four Windows shards finished within 10m10s.
This passing observation remains in the evidence.
See PR #1015 for the third unchanged-plan run's timings and final headroom
assessment.

## macOS step exhaustion investigation (#1142)

Refresh the duration plan from all fifteen original Electron reports in each of
these green main runs, with the unchanged four/five/six matrix:

```sh
for run in 42552592630 42586109373; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/1142/sources/$run"
done
node scripts/rebalance-electron-shards.mjs test-results/1142/sources/* --write
pnpm run format
```

These sources measure all 327 current registrations on all three platforms. The
plan retains per-case platform maxima, including skipped cases as zero, and
regenerates all three assignments together. No test, fixture, deadline, watchdog,
step limit, shard count, process audit or CLI isolation changes.

Observed macOS seconds in shard order, from original JUnit and Actions jobs/steps:

| Green main run | Named-case sums | Electron step wall time | Wall minus named cases |
| --- | --- | --- | --- |
| [42552592630](https://github.com/scott-r-lindsey/foom/actions/runs/42552592630) | 617.4 / 581.1 / 487.8 / 374.9 / 548.2 / 514.2 | 726 / 670 / 609 / 433 / 630 / 598 | 108.6 / 88.9 / 121.2 / 58.1 / 81.8 / 83.8 |
| [42586109373](https://github.com/scott-r-lindsey/foom/actions/runs/42586109373) | 362.8 / 515.2 / 506.0 / 508.5 / 539.8 / 578.4 | 424 / 607 / 603 / 600 / 637 / 663 | 61.2 / 91.8 / 97.0 / 91.5 / 97.2 / 84.6 |

The residual includes build, SEA assembly, runner/file startup and reporting; it
is not fixture teardown, which is already included in JUnit case durations.
These runs use the current configuration but different revisions, so this is an
observational comparison, not a controlled performance experiment.

### Interrupted attempts

Preserve the original run/attempt log ZIPs, artifact-list and jobs API responses,
and original artifact ZIPs before extracting. In
[42589044729](https://github.com/scott-r-lindsey/foom/actions/runs/42589044729),
macOS shard 3/6 failed on both attempts:

| Attempt / job | Original artifact ID | Step start → stop (UTC) | Completed fixture records | Setup / body / teardown seconds |
| --- | --- | --- | --- | --- |
| [1 / 129065943838](https://github.com/scott-r-lindsey/foom/actions/runs/42589044729/job/129065943838) | 13663065813 | 09:17:22 → 09:31:35 | 39 | 166.116 / 470.471 / 62.019 |
| [2 / 129091217658](https://github.com/scott-r-lindsey/foom/actions/runs/42589044729/job/129091217658) | 13666267710 | 10:25:40 → 10:39:53 | 34 | 160.578 / 458.719 / 62.677 |

Both steps lasted 853 seconds by the jobs API, with an explicit Actions
fourteen-minute timeout. Each artifact has a 52-byte JUnit opening envelope and
zero-byte summary. Neither is a passing rebalance input. Preserve both artifacts
by numeric ID: downloading only by name can replace one attempt with another.
The original shard-6 failure and its passing rerun are separate artifacts
13661746896 and 13665936430; they are not shard-3 completion evidence.

The same 39 completed fixture cases cost 412.891 / 436.679 seconds on the two
green sources, versus 698.606 seconds in attempt 1. The same 34 cases cost
375.878 / 396.242 seconds on green main, versus 681.974 seconds in attempt 2.
All three phases increased. The five largest attempt-1 fixture totals are
detached PR review (65.743s), registered-host clean reviewer (54.689s),
registered-host agy lifecycle (47.368s), OpenCode cards/resume (34.928s), and
review-loop cap (33.589s). These are fixture phase sums, not JUnit durations.

Attempt 1 completed a passing case at 09:31:24 before the 09:31:35 timeout.
Attempt 2 completed the host color-query case at 10:39:52.467 before the
10:39:53.412 timeout. Their logs contain no named test or watchdog failure.
Attempt 2's SEA preparation output continues through 10:27:30; test-runner
warnings appear at 10:27:51. This demonstrates substantial pre-case work as
well as ongoing passing test progress near interruption. It supports repeated
whole-shard workload/overhead exhaustion; it does not establish a hung fixture,
runner load, or the duration of the interrupted/missing cases. Completed fixture
records alone cannot identify the final in-progress operation. If that distinction
is needed next, capture bounded case-start and setup/body/teardown transition
events with wall and monotonic timestamps, including incomplete launches; retain
payload-free events on interruption. Do not infer the missing phase from the
empty JUnit or change deadlines to obtain it.

### Rebalance and remaining headroom

Projected case seconds using each current case's maximum across both green runs:

| Platform / configured count | Before (including hash fallback) | After |
| --- | --- | --- |
| Linux / 4 | 535.2 / 544.8 / 525.1 / 574.2 | 542.7 / 546.1 / 546.8 / 543.7 |
| Windows / 5 | 572.2 / 659.8 / 577.0 / 557.0 / 554.0 | 583.1 / 586.9 / 581.4 / 587.4 / 581.2 |
| macOS / 6 | 617.4 / 604.8 / 530.2 / 508.5 / 574.4 / 601.9 | 574.4 / 576.3 / 570.8 / 568.0 / 573.6 / 574.1 |

The macOS peak falls 41.1 seconds (6.7%). Replaying individual source durations
through the new assignments peaks at 528.4 / 525.9 seconds. Adding each run's
largest observed residual gives modeled peaks of 649.6 / 623.1 seconds; these
are estimates, not observed new-assignment wall times. Applying the largest
observed residual to the conservative maxima gives 697.5 seconds, only 17.0%
headroom. Even perfect balance of the 3437.1-second maxima total needs 572.8
seconds of cases, leaving just 57.2 seconds for overhead under the requested
630-second target (25% headroom below 840 seconds). Every observed green-source
residual exceeds that allowance.

Balancing alone therefore does **not** establish 25% headroom for every macOS
shard. Retain the decided limits and counts. A follow-up proposal is to measure
and reduce repeated per-shard app/console and remote SEA preparation (including
verification/signing and runner startup) before considering additional macOS
jobs: the conservative projection needs at least 67.5 seconds removed from its
peak to reach 630 seconds. Sharing verified same-revision build inputs would
need its own artifact/fixture-isolation design and queue-time comparison. The
existing phase totals do not prove an avoidable operation inside the heavy
fixtures, so this refresh removes none. Actual PR CI step wall times must still
validate the new assignment; a passing run alone is not proof of 25% headroom.

## macOS refresh for repeated step exhaustion (#1214)

Download the original reports without replacing interrupted XML with synthesized
cases:

```sh
for run in 43800091934 43822818958 43812020241; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/sources/$run"
done
```

The macOS assignment uses per-case maxima from all six passing macOS reports in
green main [43800091934](https://github.com/scott-r-lindsey/foom/actions/runs/43800091934)
and the five passing macOS reports in main
[43822818958](https://github.com/scott-r-lindsey/foom/actions/runs/43822818958).
Exclude the latter's failed shard-3 report in its entirety; the green source
measures those cases. Together the eleven reports measure all 399 current cases.
Apply `balance` from `scripts/rebalance-electron-shards.mjs` to the macOS-only
vectors, rounded to milliseconds, with six shards. This focused refresh changes
only the six-way assignment: four/five-way assignments and their measurements
retain the earlier sources. `sourceRuns` lists the union of those sources; the
new six-way entries retain earlier Linux/Windows measurements where available,
and use the new main reports for newly planned cases on those platforms.
The ordinary all-platform CLI remains appropriate for a complete future refresh;
it intentionally rejects these partially passing source runs.

| macOS projected named-case seconds | Shards 1 / 2 / 3 / 4 / 5 / 6 |
| --- | --- |
| Before, including hash fallback | 638.2 / 649.3 / 651.3 / 727.7 / 572.1 / 588.0 |
| After | 637.5 / 637.5 / 637.8 / 637.5 / 637.5 / 638.7 |

Green main's observed step seconds were 645 / 728 / 732 / 790 / 663 / 636;
its largest wall-minus-named-case residual was 113.9 seconds. Adding that
residual to the new conservative maximum models 752.6 seconds, leaving 87.4
seconds under the unchanged 840-second limit. This is a projection, not observed
new-assignment performance or a guarantee against slower runners.

### Pending approval-queue tests in #1191

Compare [43812020241](https://github.com/scott-r-lindsey/foom/actions/runs/43812020241)
with green main. The interrupted macOS shard-3 JUnit is only a 52-byte opening
envelope, with no testcase durations. Its 49 completed fixture records total
715.5 seconds; the same cases cost 467.7 seconds of JUnit time on green main.
Fixture phases and JUnit are different measurements, but these observations
show substantial slowdown in shared cases. The interrupted report is diagnostic
evidence only, never a passing rebalance input.

At #1191 head `4ab321841c95cad9d91f39fb97380976eaa4132b`, seven additional
registrations hash to shards 1 / 2 / 3 / 5 / 5 / 5 / 6. Six have passing JUnit
measurements in that run: 9.8 / 6.4 / 8.9 / 10.7 / 10.9 / 27.1 seconds.
The missing shard-3 background-removal variant is budgeted at 10.9 seconds, the
largest measured sibling; this is an estimate, not a fabricated observation.
Exclude the five main-only repository-setup registrations absent from that head
when modeling its workload. The resulting before/after projections are:

| #1191 projected named-case seconds | Shards 1 / 2 / 3 / 4 / 5 / 6 |
| --- | --- |
| Before | 647.9 / 655.6 / 662.2 / 713.6 / 599.6 / 589.7 |
| After | 630.3 / 641.0 / 642.5 / 629.1 / 667.9 / 657.9 |

Adding the green source's largest residual gives a modeled peak of 781.8
seconds, with 58.2 seconds of headroom. These pending names retain hash fallback
until merged; adding them to the checked-in plan now would violate the stale-name
registration guard. Limits, deadlines, shard counts and test bodies are unchanged.
Actual CI step timings must validate the refresh, particularly given the slower
shared fixtures on the interrupted run.

## Seventh macOS shard (#1214)

After #1220, the issue reports repeated six-way timeouts in runs
[43839284342](https://github.com/scott-r-lindsey/foom/actions/runs/43839284342),
[43909947998](https://github.com/scott-r-lindsey/foom/actions/runs/43909947998) and
[43928221344](https://github.com/scott-r-lindsey/foom/actions/runs/43928221344).
The user approved a seventh macOS shard. Linux stays at four and Windows at five.
The #1214 matrix required sixteen Electron jobs through the Quality gate's
aggregate desktop result, plus three native/packaging jobs. Each full run
requested nine macOS jobs: seven Electron shards, the native/packaging companion
and the combined Darwin host builder.

Reuse #1220's recorded maxima for its 399 measured cases, whose passing macOS
reports and exclusions are documented above. Apply the same deterministic
`balance` function to macOS-only vectors with seven buckets. Retain the complete
measurement vectors and source-run provenance; preserve the four/five-way plans
byte-for-byte. New registrations continue to use the existing hash fallback.
No interrupted reports, estimated durations or new measurements enter this plan.

Reproduce the focused assignment from #1220's merged plan:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { balance, writePlan } from './scripts/rebalance-electron-shards.mjs';
const plan = JSON.parse(execFileSync('git', [
  'show', '7428241f3a4a42e3a72a89e3580c7b7a762dbd19:tests/electron/shard-plan.json',
], { encoding: 'utf8' }));
const measured = new Map(plan.shards[6].flatMap(Object.entries));
const macOS = plan.platforms.indexOf('macos-15');
const durations = new Map([...measured].map(([name, values]) => [name, [values[macOS]]]));
plan.shards[7] = balance(durations, 7).map(shard =>
  Object.fromEntries(Object.keys(shard).map(name => [name, measured.get(name)])));
delete plan.shards[6];
plan.shardCounts['macos-15'] = 7;
writePlan('tests/electron/shard-plan.json', plan);
JS
pnpm run format
```

| macOS projected named-case seconds | Shards in order |
| --- | --- |
| Six-way measured plan | 637.5 / 637.5 / 637.8 / 637.5 / 637.5 / 638.7 |
| Seven-way measured plan | 546.4 / 547.7 / 546.4 / 546.7 / 546.4 / 546.5 / 546.4 |

The projected peak falls 91.0 seconds (14.2%). Adding the same observed 113.9s
residual from the green source models a 661.6s peak, leaving 178.4s below 840s.
These totals cover the measured corpus; newer hashed cases and runner variation
can add time. Actual macOS CI step timings must validate the added headroom.
The fourteen-minute step limits, individual deadlines, watchdog, process audit
and fixture isolation remain unchanged. The registration integration test audits
all configured counts, including seven, for exactly-once execution.

## Three-platform refresh after repeated step exhaustion (#1245)

The existing generator uses 64 complete passing Electron JUnit reports from
main runs [44037904482](https://github.com/scott-r-lindsey/foom/actions/runs/44037904482),
[44119885508](https://github.com/scott-r-lindsey/foom/actions/runs/44119885508),
[44141637064](https://github.com/scott-r-lindsey/foom/actions/runs/44141637064)
and [44213383357](https://github.com/scott-r-lindsey/foom/actions/runs/44213383357).
All sixteen Electron jobs passed in each source. The runs measure 408, 419,
421 and 423 current cases respectively and together cover all 423 registrations
on every platform. Interrupted or failing Electron reports were excluded.

```sh
for run in 44037904482 44119885508 44141637064 44213383357; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/sources/$run"
done
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/{44037904482,44119885508,44141637064,44213383357}
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/{44037904482,44119885508,44141637064,44213383357} --write
pnpm run format
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs
```

Both assignments use the same per-platform maximum for each case. The before
projection includes the existing hash fallback. All values are seconds in shard
order. Headroom is 840 seconds minus the projected named-case sum, before
build and runner overhead.

| Platform | Assignment | Named-case sums | Headroom |
| --- | --- | --- | --- |
| Linux / 4 | Before | 792.8 / 781.2 / 812.9 / 699.0 | 47.2 / 58.8 / 27.1 / 141.0 |
| Linux / 4 | After | 777.6 / 766.9 / 763.8 / 777.6 | 62.4 / 73.1 / 76.2 / 62.4 |
| Windows / 5 | Before | 803.7 / 684.8 / 683.9 / 810.6 / 771.6 | 36.3 / 155.2 / 156.1 / 29.4 / 68.4 |
| Windows / 5 | After | 752.4 / 752.9 / 751.1 / 750.5 / 747.8 | 87.6 / 87.1 / 88.9 / 89.5 / 92.2 |
| macOS / 7 | Before | 672.0 / 579.2 / 703.1 / 664.9 / 653.2 / 669.3 / 646.4 | 168.0 / 260.8 / 136.9 / 175.1 / 186.8 / 170.7 / 193.6 |
| macOS / 7 | After | 660.1 / 657.9 / 635.1 / 658.5 / 660.1 / 658.9 / 657.4 | 179.9 / 182.1 / 204.9 / 181.5 / 179.9 / 181.1 / 182.6 |

The largest observed difference between a successful Electron step's wall time
and its JUnit named-case sum was 65.5 seconds on Linux, 78.9 on Windows and
140.6 on macOS. Adding those residuals to the conservative post-refresh peaks
models 843.1 / 831.8 / 800.7 seconds respectively. Replaying each source run
through the new assignment and adding its own largest residual gives worst
modeled steps of 741.5 / 789.2 / 740.3 seconds. The models use fixed historical
durations. New CI step timings will show how the reassignment behaves in practice.

Even an ideal partition of the conservative case sums would require at least
771.5 / 750.9 / 655.4 seconds at the current shard counts, before overhead. To
target 660 seconds including the largest observed residual, one follow-up
option is six Linux, seven Windows and nine macOS shards. The existing generator
models peaks of 586.4 / 617.5 / 654.9 seconds at those counts. That option adds
two jobs per platform per full run (22 Electron jobs instead of 16), each with
its own checkout, dependency and Electron preparation, build and reporting.
At the measured maximum residuals, the six jobs add about 9.5 runner-minutes
inside the Electron steps alone, plus job setup and upload. This refresh keeps
the current matrix and validation budgets.

## Windows 3/5 headroom after the approval queue changes (#1293)

The refresh uses 48 complete passing Electron JUnit reports from
[main run 44665936702](https://github.com/scott-r-lindsey/foom/actions/runs/44665936702),
[the passing #1290 run 44666177737](https://github.com/scott-r-lindsey/foom/actions/runs/44666177737)
and [the passing #1294 run 44691673046](https://github.com/scott-r-lindsey/foom/actions/runs/44691673046).
They contain 443, 444 and 444 named cases per platform respectively. The #1290
reports include the new Hosts case with measured timings on Linux and macOS
and its existing Windows skip. The generator covers all 444 cases on the
merged tree. Interrupted and failed reports are excluded.

Download the `electron-results-*` artifacts to
`test-results/rebalance/1293/<run-id>/<artifact-name>/electron.xml`. For
duplicate artifact names on reruns, use the latest passing copy. The selected
artifact IDs on run 44665936702 were `14601037935` (Windows 5/5) and
`14601237294` (macOS 3/7). On run 44666177737 the selected copy was
`14601264162` (macOS 1/7).

Run the existing JUnit generator, then apply the Windows-only adjustment below.
It starts with the generated Windows 5/5 assignment on shard 3 and adjusts
individual cases using the same measured durations. The adjustment targets a
maximum replay of 688 seconds for shard 3 and a maximum conservative estimate
of 830 seconds for any Windows shard. It budgets seven extra seconds for the
approval queue case, based on the local measurement of its consolidated
scenario. That allowance is used for projection only. The plan stores the
measured JUnit durations.

```sh
node scripts/rebalance-electron-shards.mjs test-results/rebalance/1293/{44665936702,44666177737,44691673046} --write
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { writePlan } from "./scripts/rebalance-electron-shards.mjs";
const path = "tests/electron/shard-plan.json";
const plan = JSON.parse(readFileSync(path, "utf8"));
const shards = plan.shards[5];
[shards[2], shards[4]] = [shards[4], shards[2]];
for (const [name, from, to] of [
  ["bundled notices and licenses scroll and dismiss from About and menu commands", 1, 3],
  ["Hosts preload rejects an unversioned live SSH pass", 2, 3],
  ["Agents Global list and machine picker scale to twelve agents and twelve saved hosts", 3, 2],
  ["a user-authored code extension reports external hooks through the CLI and resumes on close", 3, 5],
  ["native queue recentering re-arms decisions before a stationary screen-point click", 3, 1],
  ["raster image previews validate content, fit, show actual size and preserve pixels in both themes", 3, 2],
  ["recorded sounds refresh and preview user files while shell attention and completion stay silent", 3, 1],
  ["user-started trusted confirmation stays pending during simulated app deactivation", 3, 5],
  ["quit via shortcut confirms, cancel preserves PTYs, and confirm reaps shells", 5, 3],
  ["the branch field creates a worktree by keyboard without launching; dirty removal confirms", 5, 3],
]) {
  const source = shards[from - 1];
  const destination = shards[to - 1];
  if (!Object.hasOwn(source, name) || Object.hasOwn(destination, name))
    throw new Error(`Unexpected source assignment for ${name}`);
  destination[name] = source[name];
  delete source[name];
}
plan.shards[5] = shards.map(shard =>
  Object.fromEntries(Object.entries(shard).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
);
writePlan(path, plan);
JS
pnpm exec biome format --write tests/electron/shard-plan.json
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs scripts/rebalance-electron-shards.test.mjs
```

All values below are seconds in shard order. Named-case sums use the largest
measured duration per case and platform across the three runs. For the replay,
add each run's largest observed difference between step wall time and its
original JUnit sum to that run's reassigned cases, then take the slowest replay
per shard. The conservative estimate combines the maximum case sums with the
largest residual across all three runs (Linux 63.0, Windows 78.5, macOS 121.3).
The after estimates include the Windows allowance.

| Platform | Measure | Before | After |
| --- | --- | --- | --- |
| Linux / 4 | Named-case sums | 789.2 / 739.5 / 673.1 / 785.3 | 747.0 / 753.5 / 753.0 / 733.7 |
| Windows / 5 | Named-case sums | 750.1 / 706.1 / 677.4 / 760.5 / 816.1 | 750.5 / 751.4 / 716.1 / 740.7 / 751.4 |
| macOS / 7 | Named-case sums | 662.5 / 624.1 / 620.1 / 699.6 / 604.5 / 716.6 / 681.7 | 639.1 / 663.1 / 662.7 / 662.2 / 656.7 / 662.7 / 662.6 |
| Linux / 4 | Slowest replay | 777.7 / 721.7 / 726.0 / 785.0 | 743.4 / 741.3 / 733.5 / 715.4 |
| Windows / 5 | Slowest replay | 755.0 / 754.0 / 716.3 / 817.5 / 826.1 | 755.7 / 776.0 / 687.7 / 773.7 / 770.5 |
| macOS / 7 | Slowest replay | 741.5 / 717.5 / 713.8 / 780.4 / 676.3 / 820.0 / 734.2 | 703.6 / 725.3 / 732.6 / 721.9 / 715.5 / 722.1 / 718.9 |

The conservative estimates after the move are:

- Linux 810.0 / 816.5 / 815.9 / 796.7.
- Windows 829.0 / 829.9 / 794.6 / 826.2 / 829.9.
- macOS 760.4 / 784.4 / 784.0 / 783.4 / 778.0 / 784.0 / 783.8.

Windows 3/5 observed 699 seconds on main run 44665936702. Its slowest passing
replay is now 687.7 seconds. The combined maximum estimate leaves at least
10 seconds under the existing 840-second limit on every shard. These are
projections from passing runs. A new CI run measures the reassigned shards.

## Sixth Windows and eighth macOS shards (#1295)

The plan uses 48 passing Electron reports from main runs
[44716973671](https://github.com/scott-r-lindsey/foom/actions/runs/44716973671),
[44784501944](https://github.com/scott-r-lindsey/foom/actions/runs/44784501944) and
[44833390270](https://github.com/scott-r-lindsey/foom/actions/runs/44833390270).
They contain 444, 447 and 448 named cases per platform, respectively, and cover
all 448 current registrations. The source matrix is four/five/seven. The new
six- and eight-way assignments start from the generator output. Four macOS
case swaps balance the slowest replay (44716973671) while keeping each macOS
shard's maximum-duration sum below 600 seconds.

```sh
for run in 44716973671 44784501944 44833390270; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "/tmp/foom-1295-junit/$run"
done
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { writePlan } from "./scripts/rebalance-electron-shards.mjs";
const path = "tests/electron/shard-plan.json";
const plan = JSON.parse(readFileSync(path, "utf8"));
for (const [platform, count] of [["windows-2025", 6], ["macos-15", 8]]) {
  plan.shardCounts[platform] = count;
  plan.shards[count] ??= Array.from({ length: count }, () => ({}));
}
writePlan(path, plan);
JS
node scripts/rebalance-electron-shards.mjs /tmp/foom-1295-junit/{44716973671,44784501944,44833390270} --source-shards=4,5,7 --write
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { writePlan } from "./scripts/rebalance-electron-shards.mjs";
const path = "tests/electron/shard-plan.json";
const plan = JSON.parse(readFileSync(path, "utf8"));
const shards = plan.shards[8];
for (const [left, right, outgoing, incoming] of [
  [8, 1, "restores running claude in a linked worktree, shell and orchestrator children across windows",
    "preview live reload follows retargeted symlinks and junctions"],
  [4, 2, "Hosts opens saved checks without SSH and keeps ready repositories compact",
    "local and registered-host installers stop their whole group after supervisor SIGKILL"],
  [3, 5, "Antigravity plugin Settings disclosure installs and removes an observer that reports lifecycle",
    "sidebar machines launch human shells and agents and keep remote worktrees under repositories"],
  [6, 5, "preview history restores scroll, goes forward and recovers missing html links",
    "Hosts repository reloads bypass the SSH master and update the completed SSH row"],
]) {
  const a = shards[left - 1];
  const b = shards[right - 1];
  if (!Object.hasOwn(a, outgoing) || !Object.hasOwn(b, incoming))
    throw new Error(`Unexpected assignments for shards ${left} and ${right}`);
  b[outgoing] = a[outgoing];
  a[incoming] = b[incoming];
  delete a[outgoing];
  delete b[incoming];
}
plan.shards[8] = shards.map(shard =>
  Object.fromEntries(Object.entries(shard).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
);
writePlan(path, plan);
JS
pnpm exec biome format --write tests/electron/shard-plan.json
```

The table lists values in shard order. Each replay uses one run's measured case
times and adds that run's largest difference between an Electron step's wall
time and its original named-case sum. The table takes the slowest replay per
shard. Headroom is relative to the 840-second step limit.

| Platform | Named-case sums (s) | Slowest observed-run replay (s) | Minimum replay headroom (s) |
| --- | --- | --- | --- |
| Linux / 4 | 735.7 / 732.0 / 728.9 / 740.2 | 701.6 / 700.6 / 688.8 / 690.0 | 138.4 |
| Windows / 6 | 626.0 / 626.8 / 627.3 / 626.1 / 625.4 / 625.9 | 651.7 / 652.8 / 677.6 / 677.2 / 625.7 / 645.9 | 162.4 |
| macOS / 8 | 586.4 / 599.9 / 599.6 / 581.5 / 599.6 / 597.2 / 597.1 / 576.0 | 711.5 / 712.0 / 712.4 / 711.9 / 706.7 / 711.4 / 713.0 / 711.7 | 127.0 |

Combining the maximum case sums with the largest observed residual per platform
(65.2 / 80.1 / 161.1 seconds) gives peak step estimates of 805.4 / 707.4 /
761.1 seconds on Linux / Windows / macOS. Actual headroom will be measured in
the first full ready-PR run.
