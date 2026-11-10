# Real Git worktree test waits (#1050)

## CI evidence

[Main run 42538602408](https://github.com/scott-r-lindsey/foom/actions/runs/42538602408),
unit/coverage job 128908330117, failed after #1120. Its log shows **one**
5-second test timeout, followed by 18 10-second afterEach failures (including
that same test): 18 failed tests in total. The other 17 test bodies did not
independently exhaust five seconds. The first test was “detached group cleanup
cannot release a later explicit removal reservation”. There was also an
unhandled `expected 'checking' to be 'ready'` rejection in that test's confirmation.

The confirmation used `vi.waitFor`, whose default one-second budget was shorter
than the test budget. On rejection, the group command rejected, but the test was
awaiting `branchesEntered.promise`. Only a successful group could resolve that
promise. The callback never reached its finally block. The fixture's pending
callback set then made every afterEach wait for the same stranded operation.
This explains the cascade and approximately 180 seconds of teardown waiting.
The log does not contain individual Git durations for the original failure.

## Local measurements

Measured on Linux, Node 24.17.0, on the shared development host, without synthetic
load. A temporary `execFile` preload recorded each Git invocation and its
callback completion; phase markers bracketed the real test steps. Instrumentation
adds overhead. These are single-run observations, not performance guarantees.
Raw JSONL/log evidence remains ignored under `test-results/1050/` in the worktree.

The unmodified 89-test merge suite passed. It invoked Git **8,505 times**, with
23,683 ms summed subprocess duration and a 2.33 ms median. The slowest test was
1,074 ms; the detached-reservation scenario took 711 ms. No multi-second Git wait
was reproduced. Summed durations include overlapping operations.

After the fix, a focused detached-reservation scenario produced these steps:

| Step | Wall ms | Git calls | Summed Git ms |
| --- | ---: | ---: | ---: |
| Create/detach checkout and configure local bare remote | 28 | 7 | 20.8 |
| Start group command / enter confirmation | 6 | 1 | 2.3 |
| Eligibility scan to ready notification | 148 | 56 | 123.4 |
| Approved cleanup to branch transaction callback | 323 | 138 | 268.4 |
| Confirm removed path | 1 | 1 | 1.8 |
| Create second detached checkout / explicit confirmation / finish group | 43 | 14 | 36.6 |

The entire focused run, including beforeEach and teardown, made 222 Git calls
with 469 ms summed subprocess duration. The scan alone needs dozens of real Git
processes; its duration varies with scheduling and filesystem/process overhead.
There is no basis here to remove production safety rechecks or increase deadlines.

## Corrections

Merge tests now subscribe to the real cleanup feed's ready notification instead
of polling under an unrelated one-second deadline. The concurrency test observes
the group command's rejection while waiting for each gate, releases its own gates
on cancellation, and includes a real-Git confirmation-failure regression case.
This makes failure unwind and allows fixture teardown to finish.

A separate isolation defect also existed: setup installed `GIT_CONFIG_GLOBAL`
and `GIT_CONFIG_NOSYSTEM`, but production's Git helper removes inherited `GIT_*`
variables. Real-Git worktree fixtures now enforce global/system config isolation
at the subprocess boundary, preserving production's history-overlay guards,
local config, timeouts and stdin. A fixture HOME containing a global marker
verifies the marker cannot leak through production calls, while local config and
stdin still work. No developer configuration is read or changed by that test.
Production configuration behavior is unchanged.

## Historical sandbox comparison remains unverified

The original dozer trace was deleted. This host did not reproduce its 8–20 seconds
of additional waiting, and no paired sandbox trace is available. Disabling access
to developer config could change Git behavior, but the measurements do **not**
establish that this caused the historical sandbox difference. The confirmed CI
cascade and config-isolation defect should not be presented as proof of that
historical cause. If it recurs, capture paired per-process Git/strace timings on
the affected host before choosing a further fix. All existing test deadlines and
coverage thresholds remain unchanged.
