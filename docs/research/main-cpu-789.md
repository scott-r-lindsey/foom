# Main-process CPU with ten owned fixture children (#789)

## Repeatable capture

Use Node 24, the pinned pnpm, and `pnpm install --frozen-lockfile`. Build with
`pnpm run build`, then run on Linux under Xvfb:

```sh
FOOM_CPU_EVIDENCE=test-results/789-before xvfb-run -a \
  node scripts/test-temp.mjs --test tests/electron/profile-owned-children.js
```

On a shared machine, run both commands through its shared heavy-command lock.
For the issue's machine, prefix each command with:

```sh
/tmp/claude-1000/-var-www-html-scott-foom/683aa1e2-6afe-4cbd-84c2-a350b5681a27/scratchpad/heavy.sh
```

Put the `FOOM_CPU_EVIDENCE` environment assignment before that prefix. Keep all
captures, logs and screenshots under ignored `test-results/`; do not commit them.
Use a different evidence directory for each run.

The recipe uses the real sandboxed Electron application, a temporary
`--user-data-dir`, fixture HOME/login shell/PATH, the real ownership/control
boundary and process audit. No real agent or forge CLIs run. Git operates only
on an isolated empty fixture repository, without global/system configuration.
Updates are disabled and the fixture has no remotes. Only the local control
endpoint is contacted.

The fixture elevates one fake Claude parent through the trusted dialog, creates
ten owned worktrees and launches ten fixture children. Each child writes one
progress line every two seconds and approximately 123 KiB every thirty seconds
(1,024 lines of 123 bytes), respecting backpressure and sleeping after writes.
There are no busy loops or disk load generators. New children follow normal
board placement. The parent polls `sessions` with limit 100, then `wait_for` for
ten children with a one-second timeout, then sleeps one second. This intentionally
polls more often than the reported sixty-second watcher, exposing repeated work
without generating aggressive output.

The main process's Node inspector `Profiler` captures V8 stacks from before child
creation through 120 seconds of steady load. This is the main inspector, not the
renderer DevTools profiler. Open `main.cpuprofile` in Chrome DevTools' Performance
panel. `metrics.json` records main-process user/system CPU over just the steady
interval, wall duration and one-core CPU percentage:
`(user microseconds + system microseconds) / (wall milliseconds * 10)`.
It excludes child, renderer and utility-host CPU. The lifecycle/setup portion
remains in the profile but is excluded from steady CPU accounting. Inspector
sampling is wall-time sampling; idle samples must not be reported as CPU time.

The manual recipe reserves its deliberate 120-second capture in the harness
watchdog; existing feature-test, assertion and quit deadlines are unchanged.
Teardown quits the app and audits descendants before removing its temporary
profile and fixture repository. The enclosing test-temp runner also owns
interrupted-worker cleanup.

## Findings

Baseline: current main `677d402306c9d1aaa1ba2bfaa8b2bb4f2b6a38dd`, Linux,
Electron 44.9.3, Node 24.17.0 for the driver, captured on 2026-10-25 UTC
(October 24 local). Other children were running on this shared machine. All
captures use the heavy lock; this is not an isolated-machine benchmark.

The baseline steady interval was 120.792 seconds: main used 2.818 user + 2.350
system CPU seconds, **4.28% of one core**. The old 30–60% steady load and repeated
30-second >100% spikes were not reproduced. The issue notes its original build
predated main by about sixteen hours; this result cannot identify which intervening
change, workload difference or shared-machine condition accounts for the gap.

The 123.177-second inspector profile includes 2.341 seconds of child creation and
launch. Time-delta-weighted stacks, aggregated by function and URL, show:

| Phase | Non-idle sampled time | Inclusive hot paths |
| --- | ---: | --- |
| Create/launch ten children | 1,729 ms | Git helper 1,341 ms (77.6%); listWorktrees 769 ms; checkoutIdentity 597 ms; sidebarInventory 450 ms |
| Steady output + polling | 1,711 ms | Git helper 937 ms (54.8%); listWorktrees 683 ms; sidebarInventory 497 ms; checkoutIdentity 282 ms |

Inclusive categories overlap and must not be summed. The steady interval was
98.6% idle in V8 sampling. Its sampled time differs from process CPU accounting:
V8 does not account for all Chromium/native worker-thread CPU, and sampling is
wall time rather than a CPU timer. Native `spawn` was 854 ms self time in steady
state (49.9% of non-idle samples). Git children themselves are outside main's CPU
measurement; their launch overhead is inside it.

The candidate paths resolve as follows:

- Inventory/checkout refresh fan-out dominates observed main-thread work, both
  during lifecycle changes and steady activity. Even the empty fixture repository
  still requires local Git membership/identity checks; no forge network requests
  occur. This does not establish the cost of real forge responses.
- Metadata polling is smaller: `waitFor` had 83 ms inclusive steady samples,
  `SessionMetadata.read` 58 ms, and workspace snapshot projection 83 ms across
  all consumers. Hashing is not the dominant sampled cost.
- Action-log durability participates in create/launch, but does not dominate
  these main-thread samples. No audit durability guarantees are weakened.
- Preview work is absent in this workload. This capture cannot rule out preview
  costs in the original report.

A narrow fix batches session metadata reads in both bounded and event-driven
waits: ten target metadata projections now use one fresh workspace snapshot
per check rather than ten. It retains repository filtering, target order,
not-found behavior, live authority checks and fresh revisions. The regression
compares ten individual reads with one batch, counts source invocations, verifies
identical metadata, observes output revision changes and rejects foreign/missing
IDs. Both wait paths also have integration regressions exercising batching.

The paired after capture used the identical fixture, cadence, two-minute interval,
Xvfb/temp profile and shared heavy lock, with other children still running. It
measured **4.52% of one core** (3.044 user + 2.388 system CPU seconds over
120.132 seconds), versus **4.28% before**: +0.24 percentage points. This pair
shows no overall CPU improvement; it is not evidence of a regression or a claimed
speedup on a shared host. The deterministic result is the 90% reduction in
workspace projections for each ten-target metadata check.

Steady `waitFor` inclusive samples were 83 ms before / 76 ms after, and snapshot
projection across all consumers 83 ms / 72 ms. Git helper stacks remained dominant
(937 ms / 1,001 ms); sidebar inventory was 497 ms / 578 ms. These small sampled
values are descriptive, not statistically significant benchmarks. Repeated
snapshot work also remains in acknowledgements and automation consumers.

A larger inventory/forge refresh redesign is proposed separately in the PR body,
without filing another issue. It must preserve fresh security-sensitive checkout
identity checks at launch/removal. This narrow fix does not resolve the original
high-CPU report, which needs a capture of the affected workload/build if it recurs.
