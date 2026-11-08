# Validation, CI and packages

[AGENTS.md](../AGENTS.md#validation-and-delivery) owns required local checks,
coverage thresholds, test isolation and delivery policy. This guide explains the
current tooling and CI graph. See the [documentation map](README.md) for other entry points.

## Tests and coverage

`tests/unit/` mirrors source ownership and contains TypeScript unit tests for the main process, preload, renderer, and coverage-reporting tools. Tests exercise IPC trust boundaries, asset restrictions, permissions, startup failures, UI pending/error states, and bridge response validation. Electron is mocked in unit tests; jsdom provides the UI environment.

Real-app integration tests are split into discovered feature suites, with a separate
packaged smoke test. See [Electron test layout and sharding](electron-shards.md)
for suite ownership, four Linux, five Windows and six macOS named-test shards and local commands, and
[explicit Electron fixtures](electron-fixtures.md) for fixture selection and timing.
On Linux, wrap Electron and packaged-smoke commands in `xvfb-run -a`.

Unit coverage includes every executable TypeScript file under `src/`, including
files no test imports; only declarations are excluded. Thresholds are defined in
[contributor standards](../AGENTS.md#tests-and-coverage). Successful
`pnpm run test:coverage` prints a `file://` URL for the ignored HTML report at
`coverage/index.html`. Unit coverage does not imply real Electron instrumentation.

PR checks enforce the contributor changed-line coverage threshold and fail if a changed application file is missing from LCOV. The scripts under `scripts/` adapt the reporting tools from the Crab Attack II reference, with stricter enforcement and regression tests.

Simulated hook argv, registration/cleanup, plugin setup/staging and health tests replace only
`node-common/private-file-permissions.ts`'s Windows ACL capability. They retain
real temporary files and storage behavior without starting ACL PowerShell.
Native hook lifecycle cases explicitly restore that capability; plugin staging
in `v2-native.test.ts` and ACL security tests in `private-native.test.ts` use it
unmocked. No production permission checks or test deadlines are disabled.

Windows observer unit tests run under a test-only job supervisor. Successful runs
publish the same parent result without diagnostic output. On failure, the
supervisor emits buffered UTC phases (parent start/exit/result and drain), the
parent's PID and available exit code/time, and a bounded snapshot of the owned
job's active/total/limit-terminated counts and member PIDs with exit metadata.
Query failures and exit races report numeric errors; no command lines,
environment, paths or observer payloads are collected. These diagnostics do not
change the observer measurement, wait deadlines or kill-on-close cleanup.

## Test evidence and worktree cleanliness (#822)

Electron and packaged tests write evidence images through
`tests/helpers/evidence.js` under the ignored `test-results/` tree. This includes
native desktop captures, optional review screenshots and manual measurement
captures. Optional `FOOM_*_SCREENSHOTS` switches enable captures in fixed
subdirectories of `test-results/`; their values no longer select an external path.
Fixture images used as test input remain in their disposable fixture directories.

The Electron wrapper snapshots untracked files before running and checks again
after teardown, including failed runs and packaged smoke. New untracked files
outside `test-results/` or the OS temporary directory fail the command. Existing
untracked developer files are preserved and do not fail validation. Ignored build
and dependency output is excluded by Git's ignore rules.

## Temporary-directory ownership (#813)

The unit, watch, coverage, CI-policy, Electron (including affected suites), and
packaged/installer test commands run through `scripts/test-temp.mjs`. The parent allocates
a private `foom-tests-*` root for `TMPDIR`, `TMP` and `TEMP`, a worktree-filesystem
root for the concurrent-review fixture, and an optional Linux tmpfs root for
browser storage. It waits for the runner, then synchronously removes and checks all roots on success,
failure or worker timeout. An inert invalid `.git` file prevents non-repository
fixtures from discovering an enclosing worktree when `TMPDIR` is inside one. Interrupts forward to the runner's Unix process group
(or the Windows runner), with a bounded forced termination fallback. After any
Unix runner exit, the parent probes the entire process group, sends SIGTERM to
remaining members, allows five seconds before SIGKILL, and waits up to five more
seconds for the group probe to report ESRCH before deleting roots. A surviving
group fails cleanup loudly and retains its roots. Successful cleanup preserves
the runner or interruption exit code. Windows has no Unix process-group probe;
only runner termination is guaranteed there. Normal
Electron teardown still quits apps and audits processes before fixture removal.
Runner tests cover assertion failures, hard exits, actual test-worker timeouts,
interrupts, SIGTERM-ignoring descendants after normal and interrupted exits,
removal only after those descendants die, and preservation of unrelated entries. CI uses these same commands;
every unit and Electron run performs the temp leak check. A killed parent
(`SIGKILL`) or machine failure cannot run cleanup; no shared-directory sweep is
performed.

The reported prefixes have these owners on current main:

| Prefix | Owner and lifetime |
| --- | --- |
| `foom-v2-hooks-*` | Runtime per-launch hook adapters/counters; credentials are revoked and files removed synchronously on release, quit or failed preparation. |
| `foom-v2-*` | Runtime per-launch manifest/MCP data without a hook directory; removed synchronously by launch disposal. |
| `foom-hooks-*` | Historical hook adapters; no current allocator. |
| `foom-shell-*` | Terminal host Bash startup files; synchronous removal on spawn failure and native PTY exit, including shutdown. |
| `foom-health-*` | Unit workspace fixture's observer/plugin directory; ordinary afterEach cleanup plus the run root. Runtime health is persistent profile-owned state, not this temp prefix. |
| `foom-verdict-*`, `foom-environment-*` | Unit evaluator/settings fixtures; ordinary afterEach cleanup plus the run root. |
| `foom-probe-verification-*` | Unit probe fixture; finally cleanup plus the run root. Unix fixtures now link Node instead of copying it (#791). |
| `foom-entry-*`, `foom-agent-isolation-*` | Electron bootstrap and fixture CLI guard directories; quit-before-removal harness cleanup plus the run root. |
| `scoped_dir*`, `electron-download-*`, `playwright-artifacts-*` | Chromium, Electron download/extraction and Playwright scratch; inherited run root covers residual files from failures. Chromium shared-memory fixtures also retain their identity-checked worker cleanup; the parent owns their enclosing tmpfs root. |

To measure a full local unit and Electron run, allocate a dedicated empty directory
inside ignored `test-results/`, set all three temp variables to its absolute path
**inside** any external validation wrapper that replaces `TMPDIR`, run `pnpm test`
and `xvfb-run -a pnpm run test:electron`, then list that dedicated directory.
It must contain no new `foom-*` entries. Use the canonical measurement path for
unit tests, whose descriptor-race fixtures compare path spellings. Chromium's Unix socket path limit may
require a short, uniquely allocated symlink to that directory; create the link
inside the external wrapper's own temp root, and set the temp variables to the
link for the Electron command after the wrapper has set its environment. Removing the link must leave the
measurement target intact. Node's reusable compile cache may remain in the
measurement directory, outside the test-owned run root. Never inspect or remove
other runs' files in the real temporary directory. Test-run cleanup is a fallback for fixtures;
product lifecycle regressions separately assert immediate hook/MCP removal and
shell removal on native exit and shutdown.

## Refreshing the Electron shard plan

Use Node 24 and installed dependencies. Download every `electron-results-*` artifact per selected recent passing CI run
(fifteen for the current matrix, fourteen for the earlier four/five/five matrix, and twelve for historical four-shard runs). Keep numeric run-ID directories and
artifact subdirectories intact, outside the repository or under ignored
`test-results/`. Use a fresh source directory for each refresh:

```sh
for run in 39918020774 39946804406 39970696968 39973853488 39981523976; do
  gh run download "$run" --pattern 'electron-results-*' \
    --dir "test-results/rebalance/sources/$run"
done
# Preview with the same measurements for both assignments, then regenerate:
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/* --source-shards=4
node scripts/rebalance-electron-shards.mjs test-results/rebalance/sources/* --source-shards=4 --write
pnpm run format
node --require ./tests/helpers/setup.js --test scripts/electron-shard.test.mjs
```

Replace the example IDs with recent runs covering every current case on all three
platforms. The script rejects failed cases, missing reports and unmeasured current
cases. It takes each case's maximum duration per platform and includes hash
assignments for previously unplanned cases in the before projection. Review balance
and headroom under the 840s Linux, Windows and macOS step limits.
The examples select historical four-shard inputs with `--source-shards=4`. Omit
that option for current runs with four Linux, five Windows and six macOS shards. Each source run must have the expected report count per platform.
When combining old and current matrices, specify per-run counts explicitly. For
example, `--source-shards=4 --source-shards=41409300263:4,5,5` uses four reports
per platform for historical sources and four/five/five for that newer run, in
`platforms` order from the plan. Options can appear in any order. Unknown run IDs,
duplicate overrides, invalid counts and missing artifacts fail; the tool never
infers a smaller matrix from missing reports.

Case sums exclude build/runner overhead; compare actual CI step times before
calling the refresh validated. Regenerate after incorporating new tests from main
and run full contributor validation. See the [sharding guide](electron-shards.md)
for the assignment method and measurement history.

## CI and packages

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pull requests and pushes to `main`, plus scheduled and manual runs:

1. Independent Linux jobs for change detection, static checks (format, documentation integrity, lint, typecheck, full dependency audit and CI policy tests), and unit coverage.
2. Electron launch tests and Forge installer/ZIP packaging on Ubuntu, Windows, and macOS, alongside static checks when desktop validation is required.
3. A stable **Quality gate** status that requires all three Linux jobs to succeed and desktop validation to pass, or to be explicitly classified as unnecessary and skipped. Failed detection never permits a skip.

CI runs for pull requests and pushes to `main`, avoiding duplicate branch-push runs for PRs. The [Electron sharding guide](electron-shards.md) owns the desktop job layout and assignment details. Test deadlines come from `tests/electron/test-policy.js`.

Desktop validation is skipped only when every changed path is `README.md`, `AGENTS.md`, `LICENSE`, `NOTICE`, Markdown under `docs/`, direct HTML mockups under `docs/mockups/`, or reference/prototype material under `inspiration/` or `spikes/` (the exact allowlist is in [`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs)). Reference files are classified by path only; CI never tests or packages their contents. Unknown paths, empty diffs, and manual runs require desktop validation. PR detection uses the merge-base diff against the base branch; pushes compare the previous commit with the new commit. Renames include both old and new paths. Missing comparison history fails change detection.

CI retains HTML/LCOV coverage for three days. Platform installers and ZIPs are built and validated on every required desktop run, and are uploaded on main pushes, for scheduled nightlies or **Actions → CI → Run workflow → publish_nightly** on `main`. Only the nightly publication job has repository contents write permission in CI, and it waits for the Quality gate. An unchanged or failing night leaves the previous nightly up. Manual runs without `publish_nightly` never publish. The separate `upload_packages` option uploads development ZIPs without publishing. These manually requested ZIPs are retained for three days. macOS CI also uploads its tested ZIP on PRs and other desktop runs, then downloads it to exercise the release artifact layout with ad-hoc signing; this artifact has the same three-day retention. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `pnpm install --frozen-lockfile`, and Node comes from `.nvmrc`.

`main` requires a pull request, an up-to-date branch, and a passing **Quality gate**, including for administrators. No second-person approval is required. Force pushes and deletion are blocked. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Follow [AGENTS.md](../AGENTS.md#validation-and-delivery) for pre-push checks and delivery. Keep cancellation of superseded runs enabled.

Account owners should configure an Actions budget with **Stop usage when budget limit is reached** enabled in GitHub billing settings, plus usage alerts. Budget alerts alone do not stop spending. Review and delete obsolete development artifacts in Actions after preserving any needed downloads; reducing workflow retention affects new uploads, and deleting old artifacts prevents future storage accrual without reversing existing charges. Billing settings and existing artifact cleanup are account operations, not changes this workflow applies. See [GitHub budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets) and [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Local `package` output goes to `out/`; `make` installers and ZIPs go to `out/make/`. Build on each target OS. These are ad-hoc development artifacts on macOS and unsigned on Linux/Windows. Published macOS nightlies are Developer ID signed, notarized and stapled in the main-only `Release` job after the Quality gate; the publisher waits for its signed artifact. See [packaging and signing](architecture.md#packaging-and-macos-signing-601) for credentials, entitlements and the manual credential check. Windows signing remains #665; unsigned Windows installers are published only on the nightly channel. The rolling nightly is a public prerelease, never Latest; its tag points to the tested commit. Publication reuses the tested ZIPs. CI stamps the version only in its disposable checkout, leaving the committed package and lockfile versions unchanged. A serialized publisher ignores duplicate or older commits. Updates follow the [stable/nightly policy](product.md#updates-603); nightly macOS installs on quit through the [static feed](#nightly-feed-provisioning-604), while Linux/Windows remain notice-only. Versioned draft publication is described below.

The independent Real CLI MCP probe runs on every scheduled and manual dispatch
except credential-only checks, including nights without changes to main. It is excluded from the Quality gate and
nightly publication dependencies; its isolated real-CLI policy is documented in
[AGENTS.md](../AGENTS.md#validation-and-delivery).

## Bundled remote host artifacts (#825)

The `Remote host` matrix builds native Node 24 SEAs on `ubuntu-24.04` (linux-x64),
`ubuntu-24.04-arm` (linux-arm64), and one `macos-15` runner for both
Darwin architectures, from the same checkout as the desktop app. The Mac first
builds and probes arm64, then selects the same pinned x64 Node version and builds
and probes x64 under the hosted image’s Rosetta. Both architectures retain the
embedded-native signing/PTY spike and SEA startup check. The spike checks each SEA's
Mach-O architecture with `lipo -archs`. Before each x64 PTY/library-load probe it
primes that freshly signed SEA with a fixture-only architecture handshake (no
native load), reporting the translation/startup duration. This includes the second
code identity after re-signing without the library-validation exception. Priming
has a separate 60-second bound and must return `x64`; failure stops the job with
the executable's diagnostics. The actual native-load probes retain their 20-second
bounds and exact success/error assertions. Merely launching x64 Node does not
prime a newly assembled or re-signed SEA. The x64 build reuses the
installed arm64 esbuild service, whose JavaScript output is architecture independent.
Each target writes a version/protocol/source-revision/size/SHA-256 manifest and gzip
metadata, verifies native SEA startup with invalid arguments (no daemon or
network), and uploads its catalog entry with three-day retention. Nightly version
stamping uses the same condition and deterministic stamp as desktop packaging.

The three existing native-check/packaging jobs wait for the complete host matrix,
download only their own run's four artifacts into `.cache/remote-hosts`, and
package all four compressed hosts outside ASAR. Packaging verifies every target,
revision, version, protocol, size and hash and refuses missing entries. Both host
and app builders use `git rev-parse HEAD` with argument arrays, including local
builds; neither trusts `GITHUB_SHA` or a catalog entry as the checkout identity.
Every entry must match the app checkout's full commit, never `development`.
The app build embeds that commit in `build/build-metadata.json` inside ASAR;
runtime catalog selection requires the manifest source to match before upload,
so an older same-version gzip/manifest pair is rejected. CI packaged
and extracted-installer smoke tests decompress and hash all four entries. The
Quality gate's required-job rules, coverage thresholds, permissions and Release
configuration are unchanged: a failed host build blocks packaging, which remains
required. Electron shards still start independently after change detection.

The combined Darwin job also uploads credential-free SEA inputs (#851): the bundled
JavaScript, target Node executable, node-pty addon and spawn helper, plus a
format/version/protocol/source-revision manifest with each file's size and SHA-256.
The Node patch is pinned in `.nvmrc`: the blob generator must exactly match the
input executable's version. Finished ad-hoc catalog entries remain available to
Linux/Windows packaging; the separate inputs are downloaded only by macOS
packaging and the main-only signer, from the same workflow run. Inputs never ship
inside the application or its installers. Missing, stale, corrupt or incompatible
inputs stop signing before modifying the catalog.

#851 amends #844's re-sign-only path: the signer verifies these inputs against
the version and source revision sealed in ASAR, signs copies of `pty.node` and
`spawn-helper` first, generates a fresh SEA blob from the signed bytes, injects it
into the target Node binary with postject, and signs the resulting host. Snapshots
and V8 code cache are disabled, so one macOS signing runner can assemble both
Darwin architectures without executing the other architecture's Node binary.
No app rebuild or ASAR rewrite occurs. Developer ID signatures use hardened
runtime, secure timestamps and allow-jit only; the signer reads back the host
entitlements and requires both native assets and host to have the same Team ID.
Only ad-hoc host signatures use the library-validation exception.

PR CI exercises that same assembly path with the ad-hoc identity on both
Darwin architectures (x64 under Rosetta), including a fixture PTY and verification of the extracted
native signatures. The downloaded tested-ZIP round trip also rebuilds both hosts
from this run's verified inputs. Fixture Apple tools cover both signing identities,
failures and mismatched Team IDs without credentials. Ad-hoc loading behavior is
not evidence of Developer ID library enforcement; the initial spike's runners
accepted an ad-hoc addon even without the exception. See the
[spike evidence](../spikes/remote-host-signing/README.md).

Runtime extraction retains its private-directory, descriptor and SHA-256 checks.
The filesystem verify-then-reopen race remains on Linux/ad-hoc builds; Developer
ID library validation rejects substituted unsigned/other-team native code at load.
Signing does not make those filesystem operations atomic or distinguish other
code signed by the same team. Real Developer ID loading, unsigned-swap rejection
and notarization are human post-merge checks via `publish_nightly`.

Before modification, all catalog entries must match the version and source
revision sealed inside ASAR and pass both compressed and expanded size/hash
checks. Signing preserves version, protocol, platform, architecture and source;
it regenerates both sizes and SHA-256 hashes and verifies the rewritten entries.
Linux entries and ASAR bytes stay unchanged. Bootstrap verifies both hashes before
upload and the expanded hash after upload and on cache reuse. No Release secrets,
environments, workflow permissions or credential stages change. The user verifies
real notarization after merge with `publish_nightly`.

For development, run `pnpm run start:hosts`. The
[start:hosts wrapper](development.md#how-typescript-fits-into-electron) reuses a
verified cache or fetches and verifies all four exact-HEAD main push artifacts
before normal startup. If no matching catalog is available, startup continues
without remote hosts.

Development builds (`pnpm start`, `pnpm run start:fresh`) and local `package` and
`make` try `.cache/remote-hosts/TARGET/`, or the catalog root specified by
`FOOM_REMOTE_HOST_ARTIFACTS`. These build commands do not download artifacts or
need a detached checkout. If any entry is missing, stale or invalid, the build
warns and omits the **entire** catalog, removes any partially copied entries, and
records `remoteHostsAvailable: false` in build metadata (inside ASAR for packages).
Remote shells then refuse with "Remote host artifact unavailable in this local
build." The sealed omission is checked before SSH discovery or bootstrap; the
transport and client preserve a fixed application error code through launch and
IPC, never SSH output. An explicit native artifact override still undergoes
runtime platform, version and byte verification. A complete supplied catalog must
pass the same checks as CI.

Besides `pnpm run start:hosts`, developers can place all four same-revision
artifacts in `.cache/remote-hosts/TARGET/`, or run
`FOOM_REMOTE_HOST_ARTIFACTS=/absolute/catalog pnpm start`. Rebuild after replacing
the catalog. A missing or invalid runtime artifact also reports artifact
unavailable; SSH failures retain Host unreachable. Local packaged smoke verifies
the sealed omission and absence of unpacked hosts, or validates all four entries
when present.

For packaging, `CI` or `GITHUB_ACTIONS` being nonempty always requires all four exact-revision
artifacts; `FOOM_REQUIRE_REMOTE_HOSTS=0` cannot weaken this. Local release/packaging
jobs must set `FOOM_REQUIRE_REMOTE_HOSTS=1` to select that same strict path.
Missing entries, wrong revision/version/protocol, sizes or hashes stop packaging.
Development fixture builds on CI may omit the catalog; their Electron harness
installs only its verified native fixture. An explicitly supplied CI catalog is strict.
Fixture tests exercise missing, stale and corrupt entries through both modes.
Developer ID signing also refuses a sealed omission; only local ad-hoc signing
accepts it. Each native builder accepts `FOOM_REMOTE_HOST_OUTPUT` as a catalog
root and places its entry under `PLATFORM-ARCH/`.
When a catalog is present on macOS, also populate
`.cache/remote-host-inputs/TARGET/` from the same run's `host-inputs-darwin-*`
artifacts, or set `FOOM_REMOTE_HOST_INPUTS` to that input catalog root. Native
Darwin builds write inputs under `build/remote-host-inputs/` by default;
`FOOM_REMOTE_HOST_INPUTS_OUTPUT` selects another input catalog root. The complete
catalog and both Darwin input manifests are verified before any signing or SEA
assembly. A sealed omission is accepted only if the unpacked catalog is absent;
it cannot hide present artifacts from verification. CI's download/assembly steps
show the layout.

The builder prints expanded/gzip byte counts, SHA-256 values, gzip elapsed time
and saved percentage for compression measurement without a remote host.

Local Linux x64 measurement with Node 24.17.0: 123,997,376 bytes (118.25 MiB)
expanded, 44,040,707 bytes (42.00 MiB) with default gzip, saving 64.48% of upload
bytes at about 2.02 seconds compression time. Level 1 produced 47,824,219 bytes
(45.61 MiB), saving 61.43%, in about 1.16 seconds. Adopt level 1 for package and
bootstrap payloads: it preserves most byte savings with less compression delay.
The remote Electron fixture uses the generated gzip catalog directly, avoiding a
second compression of the raw developer override while exercising production
selection. Each native CI job prints its own measurements; these are single
byte/CPU observations on shared hardware, not a network throughput benchmark.

## Installers and versioned drafts (#602)

`pnpm run make` builds the native platform formats alongside the development ZIP:
macOS DMG plus ZIP (the latter supports Squirrel.Mac), Windows Squirrel.Windows
Setup.exe plus full nupkg and RELEASES, and Linux deb/rpm plus ZIP. Squirrel.Windows
remains the installer format; #603 uses notices only on Windows. Windows remains
unsigned until #665 and ships only on the nightly channel; versioned drafts
contain macOS and Linux assets only. This supersedes #602's original assumption
that #601 would also provide Windows signing.

The DMG uses a local Forge maker backed by Apple's `hdiutil` (ULFO), with Foom.app
and an Applications shortcut. Each `hdiutil create` attempt logs a timestamp and
exit status and prints captured output. Only output containing `Resource busy`
retries, up to five attempts, waiting 1, 2, 3 and 4 seconds and removing any partial
DMG before each retry. Other failures stop immediately; exhaustion reports the
last error. The same maker serves Forge and the signing job. This avoids appdmg's vulnerable image-size chain
(GHSA-w3rx-r6r6-pgpr), incompatible image-size API upgrade, and extra native build
scripts. All Forge packages are pinned at 8.0.1. Squirrel's bundled host 7-Zip
files are selected explicitly in preMake; its transitive install script stays
disabled. No additional dependency lifecycle scripts are allowed. Linux builds
need `dpkg`, `fakeroot`, `rpmbuild`, `rpm2cpio` and `cpio`. The RPM spec
disables binary post-processing so RPM cannot strip the SEA payload or native
prebuilds for other architectures. Extracted-payload smoke checks their integrity.

After the regular packaged smoke, CI runs `pnpm run test:installers` (under Xvfb
on Linux). It extracts deb/rpm into temporary directories, mounts DMG read-only
and copies its app into scratch, and extracts Squirrel's full nupkg payload on
Windows. Every extracted application runs the same packaged native PTY, fuse,
ASAR, icon, console and fixture-isolation checks. The icon check compares the
macOS bundle icon, the icon embedded in `Foom.exe` and the archived Linux window
icon with the generated `build/icons/` set. Linux also verifies its desktop entry,
executable symlink and icon pixmap. Desktop entries launch `/usr/lib/foom/Foom` directly so
a user-installed console helper named `foom` on PATH cannot shadow the GUI.
These tests exercise installed payload layouts without
installing packages system-wide, running Setup.exe, writing /Applications or
modifying a developer's profile. They do not claim to verify an interactive
installer UI or Windows registry integration.

Every desktop-required main push now retains tested packages for three days and,
after Quality gate success, signs/notarizes the macOS app and creates the DMG
from that exact stapled app in the main-only Release environment. That job also
signs, notarizes, staples and assesses the DMG itself. The original ad-hoc DMG
is never published. PRs exercise the same maker and downloaded-ZIP path ad-hoc,
without credentials. Nightly publication consumes these signed macOS assets and
the tested Linux/unsigned Windows installers plus ZIPs and checksums. Installer
asset names include the commit identity so staging a new nightly never overwrites
previous assets before the metadata/checksum commit. The commit-scoped RELEASES
file references the renamed full nupkg; the separate [nightly feed](#nightly-feed-provisioning-604) provides macOS updates
and Linux/Windows notices.

Human release procedure: commit the desired stable package version and lockfile,
merge to main, and wait for CI including **Sign and notarize tested macOS ZIP and
DMG** to succeed. Within the three-day artifact retention period, create/push
`vX.Y.Z` matching package.json. The tag-triggered **Release draft** workflow
requires the tag commit to be on main and consumes only that commit's successful
main-push CI artifacts, with explicit successful Quality/signing jobs. Missing,
expired or nightly-version artifacts fail closed; it never rebuilds. Only its
publisher job has contents write permission in that workflow, and it has no Apple
credentials. `@electron-forge/publisher-github` creates a draft with generated
notes; retries may resume a draft with identical existing assets, but refuse
published releases or different bytes. Review and publication remain human
actions. Implementation/testing never creates tags or releases or dispatches CI.

Notarization submits the ZIP and DMG without waiting in the submit command, then
polls with timestamped submission IDs and statuses every 30 seconds. Invalid or
Rejected submissions print Apple's issues log summary. Both submissions share a
120-minute deadline defined in `scripts/macos-sign.mjs`; failures include all
returned IDs and their last statuses. Submit uses the remaining overall budget
and logs its ID as soon as the tool prints it. Info and log queries are bounded to
one minute (or the remaining budget). App and DMG stapling and staple validation
retry NSURL transport codes -1001, -1003, -1004, -1005 and -1009, missing CloudKit
records, and tickets not yet available up to six attempts, 30 seconds apart.
The domain or Error 65/68 alone never triggers retries; certificate and signature
failures stop immediately. Each attempt logs a timestamp, artifact and
exit status. Each command is bounded to one minute (or the remaining budget),
and retry waits never exceed that shared budget. Other failures stop immediately;
exhaustion reports the last error and submission IDs. The signing job allows 150 minutes for this
budget plus setup, signing, image creation, verification and credential cleanup.
Main-push signing remains necessary: the tag workflow consumes signed artifacts
from a successful same-commit main-push run and never rebuilds or signs on tags.
Consequently each desktop-required main push can hold a macOS runner for that
budget, and superseding main runs can cancel in-flight submissions. Restricting
signing to nightlies needs a separate release-preparation artifact contract.
Real notarization is verified by the user after merge with `publish_nightly`;
PR tests use fixture Apple tools and no Release credentials.

Nightly stamping also records `foomNightlyDate` in the disposable package manifest
and retains its full semver through Packager's pre-ASAR version rewrite. Native
macOS plist versions are set separately before signing. The stamped-nightly
signing fixture exercises that rewrite and exact host verification; packaged
smoke compares the sealed and runtime semver and both native plist versions.
The commit date is used for same-day notice ordering against the rolling release's
commit date. Existing nightlies without that field can detect a later UTC day, but do not guess the
order of two different commits from the same day. Nightly macOS installation now uses the [static feed](#nightly-feed-provisioning-604).

## Nightly feed provisioning (#604)

The user-approved URL contract is in [architecture](architecture.md#nightly-update-feed-604).
`scripts/nightly-feed.mjs` generates metadata from the same tested packages used
by the rolling prerelease publisher. The existing `nightly` job remains gated by
successful Quality and macOS signing jobs, main, and schedule/opt-in publication.
It downloads only this run's tested Linux/Windows packages and Developer ID signed,
notarized and stapled macOS package; no rebuild or ad-hoc fallback is allowed.
`scripts/nightly-feed.test.mjs` tests generation, conditional writes, failure and
retry behavior through a fake AWS boundary. App update tests use fake HTTP/updaters,
including the `/u/v1/` counting proxy and per-channel fallback. The proxy does not
change publication paths or archive validation. Its infrastructure is tracked in
foom-site#34 and is not yet live; manual dev-endpoint verification depends on
that deployment. Client fixture tests cover unavailable endpoints without
contacting production update services.

Upload uses short-lived GitHub OIDC credentials, with `id-token: write` only on
the existing nightly publisher. It uses no AWS access-key secrets and no additional
GitHub environment. If `NIGHTLY_FEED_ROLE_ARN` is absent, both credential and upload
steps are skipped, with a clear log line; GitHub nightly release publication still
works. Setting the variable before the remaining infrastructure is ready makes
publication fail closed. No code in this change provisions infrastructure or
modifies repository settings, environments, secrets, or foom-site.

The user must provision the following in AWS/foom-site and GitHub; this repository
only names the configuration:

1. In the AWS account holding the foom-site bucket/distribution, create or reuse
   the IAM OIDC provider `https://token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`. Create a dedicated assumable role. Its trust policy must
   allow only `sts:AssumeRoleWithWebIdentity` from that account's
   `arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com`,
   with **StringEquals** conditions:
   `token.actions.githubusercontent.com:aud = sts.amazonaws.com` and
   `token.actions.githubusercontent.com:sub = repo:scott-r-lindsey/foom:ref:refs/heads/main`.
   Do not allow wildcard subjects, pull requests, other branches or environment
   subjects. If immutable OIDC subjects have been explicitly enabled for this
   repository, use the exact corresponding subject containing owner ID `457016`
   and repository ID `1394006699` instead:
   `repo:scott-r-lindsey@457016/foom@1394006699:ref:refs/heads/main`.
   See [GitHub's AWS OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
2. Grant that role `s3:GetObject` and `s3:PutObject` only on
   `arn:aws:s3:::<BUCKET>/updates/nightly/*`. Also grant `s3:ListBucket` on `arn:aws:s3:::<BUCKET>` with the
   **StringEquals** condition `s3:prefix = updates/nightly/`, exclusively for
   inventorying this prefix before checking existing objects. Without ListBucket,
   S3 returns 403 for absent objects, so HEAD alone cannot safely detect absence.
   No deletion, ACL, settings or unrelated website writes are needed. Grant
   `cloudfront:CreateInvalidation` only on
   `arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>`.
   CloudFront IAM scopes this action to a distribution, not individual paths;
   the uploader restricts requested paths to the feed and fixed download files below.
   Use bucket policy enforcement of conditional `If-None-Match: *` puts for
   `updates/nightly/artifacts/*` as an additional immutable-storage guard.
   The uploader itself always uses conditional artifact creation and refuses
   existing bytes with a different recorded SHA-256 or length. Retries may reuse
   identical bytes; re-signing the same commit with different bytes fails rather
   than replacing a published archive. Never delete referenced archives.
3. Configure foom-site's existing S3/CloudFront to serve the bucket prefix
   `updates/nightly/` at the same public URL prefix on `https://foom-term.com`,
   without redirecting archive or feed requests. Its private S3 origin access
   must allow CloudFront to read that prefix. Return JSON as `application/json`;
   disable negative caching of missing feeds (a new architecture can appear).
   Honor feed and fixed-download `Cache-Control: no-cache,max-age=0,must-revalidate` and artifact
   `Cache-Control: public,max-age=31536000,immutable`; use a zero minimum TTL for
   all mutable objects. Preserve download Content-Disposition headers. Do not apply a website SPA fallback to this prefix. Document this
   contract in foom-site separately; this task cannot edit that repository.
4. Create repository Actions **variables**, not secrets:
   `NIGHTLY_FEED_ROLE_ARN` (the role ARN), `NIGHTLY_FEED_AWS_ACCOUNT_ID` (account
   ID), `NIGHTLY_FEED_REGION` (bucket region), `NIGHTLY_FEED_BUCKET` (bucket name,
   no `s3://` or path), and `NIGHTLY_FEED_DISTRIBUTION_ID` (distribution ID).
   Set the role variable last to enable uploading. No environment creation is
   required. Never store long-lived AWS keys for this flow.

The serialized publisher preflights existing immutable object checksums/lengths
and every feed/download-manifest commit date before any writes. Each mutable PUT
records `commit` and `commitdate` in S3 object metadata alongside `sha256`. HEADs
validate the identity of every existing fixed download and checksum (missing or
invalid identities fail closed), so an interrupted newer publish blocks older
queued commits even before its JSON pointers advance. Existing JSON feeds retain
their body-based identity check for compatibility. It refuses older
or equal-time different commits, including same-day earlier commits. All immutable
artifacts are uploaded first using S3 conditional creates, followed by the seven
fixed downloads, `download/SHA256SUMS`, `download/latest.json`, then the app update
feeds. Fixed files have `Cache-Control: no-cache,max-age=0,must-revalidate`;
package Content-Disposition uses the versioned immutable filename. Checksums
cover the fixed filenames, while the manifest records version, commit, commitDate
and per-file fixed name, SHA-256 and immutable URL (see the
[stable URL contract](architecture.md#nightly-update-feed-604)).

Failure before metadata publication leaves previous JSON pointers intact.
Failure between mutable writes can leave downloads or architectures on different
nightlies; each published JSON pointer references complete immutable artifacts.
A same-commit retry repairs the set, including files already written by that commit. These are individual atomic object replacements, not a
cross-object transaction. A conflicting conditional upload fails closed and may
be retried without replacing bytes.
Existing immutable objects are trusted only within this dedicated writer's prefix.

One invalidation contains exactly these paths after all writes succeed:

- `/updates/nightly/download/Foom-nightly-darwin-arm64.dmg`
- `/updates/nightly/download/Foom-nightly-darwin-arm64.zip`
- `/updates/nightly/download/Foom-nightly-linux-x64.deb`
- `/updates/nightly/download/Foom-nightly-linux-x64.rpm`
- `/updates/nightly/download/Foom-nightly-linux-x64.zip`
- `/updates/nightly/download/Foom-nightly-win32-x64-setup.exe`
- `/updates/nightly/download/Foom-nightly-win32-x64.zip`
- `/updates/nightly/download/SHA256SUMS`
- `/updates/nightly/download/latest.json`
- `/updates/nightly/darwin-arm64/latest-mac.json`
- `/updates/nightly/linux-x64/latest.json`
- `/updates/nightly/win32-x64/latest.json`

No wildcard website invalidation or artifact invalidation is issued. The uploader
never deletes S3 objects or overwrites immutable artifacts. After merge, the user
may run the already-existing main `publish_nightly` dispatch to verify real OIDC,
CloudFront delivery and notarized update installation. Also download all seven
stable URLs, verify `SHA256SUMS` and manifest hashes against the downloaded bytes,
and verify the macOS DMG/ZIP pass Gatekeeper. No new permissions, secrets or
variables are required; all keys remain under the existing `updates/nightly/*`
grant and the single invalidation uses the existing distribution
`EWHI9NJ60HNKA`. Implementation never
dispatches workflows or uses real AWS in tests. Until provisioned, new nightly
builds quietly see missing feed metadata and cannot update automatically.

## One-command remote host qualification (#964)

From a built checkout with the verified remote-host catalog, the human runs:

```sh
# Linux: use a virtual display, including on a desktop.
xvfb-run -a pnpm run smoke:host -- dozer
# macOS / Windows hub:
pnpm run smoke:host -- dozer
# Optional local repository and existing approved remote code folder:
xvfb-run -a pnpm run smoke:host -- dozer --repository /absolute/local/repo --code-folder "~/foom"
```

The default repository is the current working directory and the default remote
folder is `~/foom`. Its own origin must be credential-free HTTPS or SSH. Build
first with a complete same-revision catalog (see
[bundled artifacts](#bundled-remote-host-artifacts-825)). The command never downloads
artifacts or builds automatically. SSH uses normal user trust and configuration
with production BatchMode and forwarding restrictions. It does not edit SSH
configuration, credentials, agent configuration or the everyday profile. Only the
human runs it against a real host; CI uses fake SSH and a local fixture daemon.

This replaces the covered #949 manual steps and is the automated prelude to the
[manual qualification matrix](#manual-real-host-qualification-matrix-v1-943): record hub/host OS and architecture, build revision,
command exit code and printed PASS/FAIL lines for each matrix row. A disposable
windowless hub profile is created, persisted across an actual Electron process
restart, then deleted. The driver reuses onboarding's explicit `Hosts` `draft-preflight` action (#963,
#1005) before enrollment and fixed Git reasons (#1004). It never substitutes a draft
check for a refused registered-machine reload. Failed or unrun SSH, platform, artifact,
folder, Git or origin checks stop before enrollment. `origin-auth` means the host
has no usable Git credentials for origin; `artifact-unavailable` means the remote
daemon is not bundled in this build. Missing folders require explicit creation
through Settings; the smoke command never creates an approved code folder.

The sequence enrolls the host, clones or reuses the origin checkout, creates a
uniquely named remote worktree, and starts a fixed POSIX shell fixture in that
worktree. No real agent CLI is selected or probed. The fixture prints a random
marker and its PID, then answers a fixed challenge. After hub restart the driver
requires the same session ID, replayed marker and PID and a fresh reply from that
PID. It creates one second-profile fixture to verify foreign ownership and ends
only that exact confirmed incarnation. Existing foreign/legacy sessions are never
ended. Each step prints PASS/FAIL; skipped legacy End and 24h soak are explicit.
The exit code is nonzero for any failed step or cleanup.

Cleanup ends the command's sessions, removes its clean owned worktree and forgets
its registration. A clone is retained as a reusable checkout. Changed worktrees
are refused rather than deleted. Cleanup runs after failures and between-step
interrupts; if it fails, printed recovery identifiers identify remaining fixtures.
Machine failure/SIGKILL cannot guarantee cleanup. The command leaves the host's
verified daemon cache in place, like ordinary Foom enrollment.

Still manual: the 24h idle/detach soak, sleep/wake and network-loss checks,
and legacy-daemon upgrade/End with deliberately prepared legacy fixtures. Do not
use a user's existing sessions as legacy test fixtures. This command checks the
production shell/session and management path; provider-specific hooks, MCP and
sign-in remain separate qualification rows.


## Manual real-host qualification matrix v1 (#943)

This is matrix **v1**. Run it as a human against a **packaged build of an exact
revision**, after the [automated smoke prelude](#one-command-remote-host-qualification-964).
Smoke uses a built checkout and a shell fixture; record its revision separately
and require it to match the package. A successful smoke run establishes management,
fixture PTY/replay, hub restart and cleanup evidence. It does not qualify real CLI
configuration, provider interoperability, a clone longer than ten seconds, or the
remaining manual rows. Do not count a reused smoke checkout as a real clone.

Use dedicated, disposable test repositories, branches and sessions on hosts you
own. Prepare host-key trust, Git origin access and provider sign-in on the host
through the human's normal setup before testing. Never copy secrets from the hub,
forward credentials/agent sockets/ports, or edit global agent or SSH configuration
for this run. Keep the production BatchMode and forwarding restrictions. Use an
already installed opt-in Antigravity observer for its hook test; record its version
and enabled state. If it is unavailable, record the hook portion as unrun and test
the documented screen/CLI fallback without installing or changing global config.
Tails and handoffs may enter the local orchestrator's model context: use harmless
unique markers, never credentials, private source or raw launch files in evidence.
Automated tests continue to use fake SSH and fixture agents; this matrix is not
permission for an automated test or coding agent to contact real hosts or run real
agent CLIs.

Create one results record per hub/host OS and architecture pair, package revision
and CLI version set. Cover linux-x64, linux-arm64, darwin-arm64 and darwin-x64 host
artifacts with available human-owned machines; list missing pairs as unrun rather
than extrapolating from Linux or a translated process. Record native versus Rosetta
execution. Repeat affected rows after changing the package, daemon, CLI, plugin or
provider version. Keep the matrix version with the results so future checklist
changes do not silently reinterpret old evidence. A run is complete only when all
applicable rows pass; a missing agent, unavailable model or untested platform is a
qualification gap, not a pass. Record failures and follow-up links explicitly.

The expectations below follow [host enrollment and lifecycle](areas/hosts.md),
[remote launch attachments](areas/agent-launch.md#remote-agent-phase-2-755),
[host-bound forge tracking](contracts/forge-tracking.md#registered-remote-checkouts-940),
[child input](contracts/control-mutations.md) and
[handoff privacy](contracts/control-privacy.md). They do not widen remote grants
or give Foom merge authority.

| ID | Human procedure | Pass evidence |
| --- | --- | --- |
| H01 Enrollment | In the packaged app, use Settings → Hosts Add → Check → Fix with a test host and approved code folder; enroll and Refresh. Exercise an incomplete/missing folder and explicitly create or select it. | Independent SSH/platform/artifact/folder/origin/checkout observations remain visible; incomplete checks do not become passes. Successful refresh shows canonical folder, daemon version, live count and agent inventory. |
| H02 Missing CLI | On a dedicated account with one bundled CLI absent, Refresh, then attempt that agent's launch. Restore availability through the human's normal setup and Refresh. | Absent CLI shows Not found, failed probes show Unable to check, and launch gives a fixed refusal without spawning or falling back locally. Installed/probeable CLI becomes Ready; readiness alone is not sign-in proof. |
| H03 Origin access | Check an allowed credential-free HTTPS or SSH origin first without access, then with the host's own access. Inspect repository locations. | A specific fixed origin failure appears without raw output or prompts; successful access and checkout presence are independent observations. No hub credentials are copied and no shadow local checkout is created. |
| H04 Real long clone | Select a fresh test origin/destination and use Settings → Repositories → Clone here. Choose a real repository/link whose actual clone takes **more than 10 seconds**; record start/end UTC and elapsed seconds. Do not simulate delay with sleep. | Exactly one valid checkout is published and locations refresh after success; no ten-second unreachable failure. Record origin label and resulting HEAD. If elapsed ≤10 s, this row remains unrun and needs another real clone. |
| H05 Fresh/default worktree | From a local human-elevated orchestrator, create a new branch on the registered host without a PR selector. Inspect its branch, HEAD and placement. | Starts at freshly fetched origin default, has its own branch without tracking default, and returns a host-bound worktree ID. Launch stays on that host. |
| H06 PR worktree | Create/adopt an open same-repository PR through the PR selector on the host. Inspect branch, HEAD and tracking. Use it for a real child run. | Fetches the validated PR head and tracks its origin branch; placement and PR identity remain correct. An existing branch is refused rather than overwritten. This is ordinary PR adoption, not an unsupported detached remote review checkout. |
| H07 PR/check tracking | For a remote child's test PR, push a harmless commit with pending checks; observe a failing check and then a green head. Read tile, sessions/session_state and parent wait_for after each transition. | PR URL/head and check status agree with the forge and wake waits on revision changes. Forge reads use the hub's existing local forge CLI credentials; no credentials move to the host. Old-head green cannot qualify a newer head. |
| H08 Local merge | Once the test PR's required checks are green, the human or explicitly authorized local orchestrator performs the normal merge through its local forge CLI. Refresh remote PR state and fetched default. | Merge succeeds under existing repository policy; remote tile/session/wait shows MERGED and the fetched default contains the validated merge result. Foom itself performs no forge write and remote child tools gain no merge authority. |
| H09 Cleanup | Stop/close only run-owned children, then request their remote worktree removal. Exercise a dirty disposable worktree and decline removal before explicitly approving its discard. Remove the test host registration separately. | Active sessions prevent removal; dirty/unproved remote removals require trusted confirmation, decline preserves files, approved removal rechecks identity/changes and keeps the branch. Forgetting a host does not kill live sessions. Check no run-owned sessions or launch attachments remain; list retained clones/cache/branches. |
| H10 Network interruption | Interrupt the test host's connection during a clone/fetch/worktree mutation, then separately during a running agent. Restore the connection, Refresh locations and reconnect. Also exercise hub sleep/wake. | Lost mutation replies are reported as uncertain/refused rather than success; refresh reconciles actual locations before any deliberate retry and no duplicate clone/worktree is created. Existing live PTY reattaches with the same session/PID and replay, without relaunch; unavailable host/PR facts do not become green or merged proof. Record interruption point and recovery. |
| H11 Hub restart and soak | With a run-owned agent alive, quit/restart the same hub profile and verify replay. Detach/leave idle for 24 hours, then reconnect. | Same live session/PID survives; no live-detach expiry or replacement launch. Exited rows remain history. Record duration and observed idle resource use; do not infer a 24h result from smoke. |
| H12 Daemon upgrade | Prepare a dedicated older compatible daemon with a run-owned live session. Connect a newer exact-revision packaged hub, then end the test sessions and reconnect when idle. Separately prepare a disposable legacy daemon to exercise the explicit confirmed End path. | Compatible live daemon/PTYs survive with version negotiation; capability gaps show needs-update/facts-unavailable. Idle upgrade uses the new verified build only after sessions, outstanding work and clients settle. Legacy daemon is untouched by upgrade; End requires confirmation and targets the observed incarnation. Record old/new build/protocol and PID evidence, and do not use existing user sessions as fixtures. |

### Real CLI attachment cases

Run **A01–A08 for each of the six agents below** through the packaged app's
registered-host launch path. Use separate worktrees, a harmless initial marker and
a local owning orchestrator; include both H05 and H06 placements across the run.
Actual CLI consumption is required: directly invoking the helper MCP executable
cannot establish a provider's attachment result. Inspect only nonsecret UI/status
facts; never copy endpoint tokens or private config contents into a report.

| Agent | Attachment evidence to collect in addition to A01–A08 |
| --- | --- |
| Claude Code (`claude`) | Actual CLI loads invocation-only stdio MCP and manifest lifecycle hooks. |
| Codex (`codex`) | Actual CLI loads invocation-only stdio MCP; record lifecycle-hook versus notifier fallback and observed attention. |
| Antigravity (`agy`) | Remote Unix-socket observer when already installed/enabled, screen fallback otherwise, and launch-provided CLI handoff guidance. Remote loopback MCP remains inactive; do not claim local plugin MCP evidence as remote attachment evidence. |
| GitHub Copilot (`copilot`) | Actual CLI consumes its manifest stdio MCP and invocation-only lifecycle plugin attachments; record any measured fallback. |
| OpenCode (`opencode`) | Actual CLI consumes invocation-only config, generated context-event module and stdio MCP; new conversation ID retains `ses_` and resume reuses the conversation. |
| Pi (`pi`) | Actual CLI consumes the fixed private extension, context/events and session-only MCP registration; record connector policy and resumed conversation. |

| ID | Human procedure for each agent | Pass evidence |
| --- | --- | --- |
| A01 Restricted tools | Ask the real child to report available Foom tools, call manual and sanitized whoami, and attempt a harmless out-of-grant read such as sessions. Use the CLI fallback where remote MCP is intentionally unavailable. | Exactly handoff, manual and sanitized whoami are granted. Out-of-grant access is refused; no hub/parent terminal IDs or hub credentials appear. Native provider filesystem tools are not part of this Foom tool restriction. |
| A02 Model/effort | Launch with an explicit supported model and declared effort selector, where available. Compare launch selection metadata with the CLI's displayed active model. | Requested selectors reach the real CLI and it accepts/uses them. Metadata alone is not proof. Record actual model/effort and explicitly note unsupported effort capabilities. |
| A03 Prompt | Supply a unique harmless marker as the launch prompt; ask the child to echo it. | Real CLI receives exactly the intended task and marker through its declared prompt path, without command/subcommand interpretation. |
| A04 Attention | Run a short task and a harmless permission/question interaction, then answer it and let the turn finish. | Working, Needs you and completion/idle match observed behavior and text/glyphs; record hook/plugin/screen source and any fallback. Idle alone is not completion evidence. |
| A05 Parent prompt | From the owning local orchestrator, send a second marker with prompt and wait for the child's reply. | Input reaches only the owned remote child once; its real CLI processes it and attention clears appropriately. Use no sensitive input in this case. |
| A06 Tail and wait_for | Parent reads a bounded tail containing the marker and waits from the last metadata revision through attention, PR/check and handoff changes. | Tail is bounded, redacted and marked untrusted; waits wake with the correct child/revision and facts. These are parent operations, never extra remote child tools. |
| A07 Handoff | Ask the child to report a harmless summary and test URL using its actual attachment/CLI, with a unique idempotency key. Parent reads it; the child retries the same report/key. | One accepted sequence/status, untrusted summary/link, wait wake and matching idempotent replay. Handoff sends no PTY input and does not itself stop the child. |
| A08 Resume/revocation | Capture the conversation, end the invocation, Resume the remote child and ask it to recall the first marker and hand off again. Stop/close the run-owned session. | Same conversation on the same host, fresh launch identity/credentials and working attachments/model selection; former credentials/launch files are revoked/removed. No local fallback or global config edits. Record resume ID evidence without secrets. |

### Per-run results template (v1)

Copy this template into the run's human-maintained evidence record. Expand every
agent row into A01–A08 results; keep a separate result for every H row and smoke
step. Use **PASS / FAIL / UNRUN**, with notes and evidence/follow-up links. No blank
cell, skipped smoke step or missing platform counts as PASS. An unsupported
optional effort/hook path needs an explicit capability/fallback note; it does not
excuse skipping the agent or its other attachment cases.

```text
Matrix version: v1 (#943)
Run ID / human operator / UTC start and end:
Overall: PASS | FAIL | INCOMPLETE
Package version / full app source revision / artifact provenance and SHA-256:
Smoke checkout full revision (must match package) / command / exit code:
Hub OS version / architecture / native or translated execution:
Host OS version / architecture / native or translated execution:
Host daemon before and after: version / full revision / protocol / PID:
Host SSH implementation/version / Git version / login shell/version:
Hub forge CLI/version / forge type:
Repository nonsecret label / origin type / default branch and HEAD:
Test PR URL / branch / tested head / merged head:
Provider versions, active models/efforts and attachment/observer configuration:
  Claude Code version:
  Codex version:
  Antigravity version / existing observer version and enabled state:
  GitHub Copilot version:
  OpenCode version:
  Pi version / connector policy:

ID or smoke step | PASS/FAIL/UNRUN | observed result | notes / safe evidence link
Smoke <repeat each printed step, including cleanup> | | |
H01 | | |
H02 | | |
H03 | | |
H04 | | | start UTC / end UTC / elapsed seconds (>10 required) / clone HEAD
H05 | | |
H06 | | |
H07 | | | pending/failing/green head and wait revisions
H08 | | | required checks / local merge actor and result
H09 | | | remaining run-owned resources and recovery instructions
H10 | | | interrupted operation / reconciliation / same session and PID
H11 | | | restart / detach UTC and duration / idle resource observation
H12 | | | old/new daemon builds and protocols / live vs idle / legacy End
claude A01–A08 <one row per case> | | |
codex A01–A08 <one row per case> | | |
agy A01–A08 <one row per case> | | |
copilot A01–A08 <one row per case> | | |
opencode A01–A08 <one row per case> | | |
pi A01–A08 <one row per case> | | |

Unrun platform pairs / missing capabilities / failures and follow-up links:
Retained test clones/cache/branches / cleanup confirmation / recovery owner:
```
