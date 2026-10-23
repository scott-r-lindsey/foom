# Review-loop and Windows test readiness (#750)

## CI measurements

Downloaded the retained `electron-results-*` and `platform-results-*` artifacts
from 23 PR runs dated October 21–23, 2026, outside the checkout under
`/tmp/p750-ci`. The 621 JUnit XML files include successful, failed and skipped
cases. This is a diagnostic sample (all failed runs in the queried period plus
three recent green runs), not a claim that every sampled run passed. Test bodies
changed during this period; durations below describe the retained reports, not a
controlled before/after benchmark. Skipped cases are excluded.

| Case / platform | Samples | Minimum / median / maximum seconds |
| --- | ---: | --- |
| Review fix / Linux | 13 | 16.168 / 21.238 / 24.907 |
| Review fix / macOS | 13 | 22.500 / 25.661 / 27.952 |
| Review blocked / Linux | 13 | 4.428 / 16.643 / 19.225 |
| Review blocked / macOS | 13 | 7.657 / 21.152 / 33.492 |
| Review concurrent / Linux | 10 | 12.138 / 14.368 / 18.516 |
| Review concurrent / macOS | 10 | 22.296 / 32.442 / 39.259 |
| Hook default temporary directory / Windows | 23 | 1.667 / 2.576 / 5.015 |
| Hook PowerShell argv / Windows | 23 | 2.560 / 3.713 / 4.166 |
| Board hidden/show readiness regression / Windows | 22 | 6.688 / 8.040 / 13.928 |

Review cases skip Windows because their fixture agent is a POSIX script.
The board row measures the complete hidden/show regression, not an individual
readiness phase. Phase timings and native lifecycle diagnostics accompany the
JUnit reports; total case time includes fixture setup and teardown.

Specific failure points:

- [39711224331](https://github.com/scott-r-lindsey/foom/actions/runs/39711224331):
  Windows `hook-launch.test.ts`'s **defaults to the system temporary directory**
  hit Vitest's 5-second deadline at 5.015s. The supposedly structural check
  actually created private directories/files, doing repeated native ACL checks
  through PowerShell even though the observer executor was stubbed. The separate
  **uses PowerShell on Windows** case passed in this sample.
- [39903325790](https://github.com/scott-r-lindsey/foom/actions/runs/39903325790):
  macOS **owned child review loop: concurrent** failed at 37.343s with
  `TimeoutError: The operation was aborted due to timeout`. This comes from the
  fixture control client's five-second per-request abort; the report has no
  request-method stack, so it cannot identify which mutation was pending.
- [39926560803](https://github.com/scott-r-lindsey/foom/actions/runs/39926560803):
  Windows **host answers color queries once through real view transitions and
  system themes** failed at 46.007s in `boardPage`'s target/document predicate
  (30-second platform-scaled assertion). `board-startup-7416.json` shows a native
  board created at 1087ms with an empty URL, no Playwright pages, and no navigation
  events. Main was still performing pre-navigation initialization. A second
  `board-startup-1372.json` in the same artifact comes from the intentionally
  withheld-animation-callback regression and is not another startup failure.
- [39691584486](https://github.com/scott-r-lindsey/foom/actions/runs/39691584486):
  the older macOS blocked case failed at 9.842s expecting `author blocked` but
  receiving `author failed`. That body predates the current interactive blocked
  flow; it is not evidence that today's blocked-resume assertion failed.

No retained report in this sample contains the current fix case failing. The
current fixture nevertheless has a deterministic timing conflict: author
handoffs retain a ten-second production cooldown across resume, while step-file
polls used the same ten-second budget for the cooldown, scheduling, persistence,
process exit and reviewer startup combined. Blocked resume has the same conflict.

## Changes and preserved limits

Fixture step waits subscribe to atomic record renames, also observe fixture error
records, and cancel with the owning test. They no longer spend an assertion
budget on a required production cooldown. Watchers close on success, error and
cancellation, including an already-aborted test.

Worktree creation and launch await their HTTP completion under the existing case
deadline. Reads and input retain the five-second request bound, and the concurrent
case retains its five-second responsiveness assertions around `whoami`;
Git/worktree/launch completion is not a responsiveness measurement.

The default-directory unit case stubs the hook-preparation boundary and checks
the forwarded native platform, `tmpdir()`, executor and bundled-provider flag.
Other cases retain real private-file creation and native policy/transport checks.
This removes unnecessary native work instead of extending Vitest's deadline.

Board startup awaits the first native board's document-load event before checking
Playwright's page list. This initialization prerequisite uses the existing launch
watchdog, like compositor initialization. Load failure, renderer exit and window
close reject the wait and release listeners. The independent frame assertion,
focus checks, platform scale and overall watchdog remain unchanged.

Sandboxing, fixture CLI isolation, process auditing, production rate limits and
test-case deadlines are unchanged. No workflow was dispatched or rerun to collect
the measurements. Local stress results and final CI validation are recorded in
the PR.

Source run IDs: 39671932967, 39677865540, 39678181853, 39678975631, 39689238543,
39691584486, 39695976236, 39710612410, 39711224331, 39713360719, 39836376192,
39841254630, 39849077337, 39903325790, 39903379185, 39903684211, 39926560803,
39931665073, 39933127620, 39939944624, 39944321971, 39946613615, 39946804406.
