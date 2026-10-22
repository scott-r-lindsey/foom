# Validation, CI and packages

[AGENTS.md](../AGENTS.md#validation-and-delivery) owns required local checks,
coverage thresholds, test isolation and delivery policy. This guide explains the
current tooling and CI graph. See the [documentation map](README.md) for other entry points.

## Tests and coverage

`tests/unit/` mirrors source ownership and contains TypeScript unit tests for the main process, preload, renderer, and coverage-reporting tools. Tests exercise IPC trust boundaries, asset restrictions, permissions, startup failures, UI pending/error states, and bridge response validation. Electron is mocked in unit tests; jsdom provides the UI environment.

Real-app integration tests are split into discovered feature suites, with a separate
packaged smoke test. See [Electron test layout and sharding](electron-shards.md)
for suite ownership, four named-test shards per platform and local commands, and
[explicit Electron fixtures](electron-fixtures.md) for fixture selection and timing.
On Linux, wrap Electron and packaged-smoke commands in `xvfb-run -a`.

Unit coverage includes every executable TypeScript file under `src/`, including
files no test imports; only declarations are excluded. Thresholds are defined in
[contributor standards](../AGENTS.md#tests-and-coverage). Successful
`pnpm run test:coverage` prints a `file://` URL for the ignored HTML report at
`coverage/index.html`. Unit coverage does not imply real Electron instrumentation.

PR checks enforce the contributor changed-line coverage threshold and fail if a changed application file is missing from LCOV. The scripts under `scripts/` adapt the reporting tools from the Crab Attack II reference, with stricter enforcement and regression tests.

## CI and packages

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pull requests and pushes to `main`, plus scheduled and manual runs:

1. Independent Linux jobs for change detection, static checks (format, lint, typecheck, full dependency audit and CI policy tests), and unit coverage.
2. Electron launch tests and Forge installer/ZIP packaging on Ubuntu, Windows, and macOS, alongside static checks when desktop validation is required.
3. A stable **Quality gate** status that requires all three Linux jobs to succeed and desktop validation to pass, or to be explicitly classified as unnecessary and skipped. Failed detection never permits a skip.

CI runs for pull requests and pushes to `main`, avoiding duplicate branch-push runs for PRs. The [Electron sharding guide](electron-shards.md) owns the desktop job layout and assignment details. Test deadlines come from `tests/electron/test-policy.js`.

Desktop validation is skipped only when every changed path is `README.md`, `AGENTS.md`, `LICENSE`, `NOTICE`, Markdown under `docs/`, direct HTML mockups under `docs/mockups/`, or reference/prototype material under `inspiration/` or `spikes/` (the exact allowlist is in [`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs)). Reference files are classified by path only; CI never tests or packages their contents. Unknown paths, empty diffs, and manual runs require desktop validation. PR detection uses the merge-base diff against the base branch; pushes compare the previous commit with the new commit. Renames include both old and new paths. Missing comparison history fails change detection.

CI retains HTML/LCOV coverage for three days. Platform installers and ZIPs are built and validated on every required desktop run, and are uploaded on main pushes, for scheduled nightlies or **Actions → CI → Run workflow → publish_nightly** on `main`. Only the nightly publication job has repository contents write permission in CI, and it waits for the Quality gate. An unchanged or failing night leaves the previous nightly up. Manual runs without `publish_nightly` never publish. The separate `upload_packages` option uploads development ZIPs without publishing. These manually requested ZIPs are retained for three days. macOS CI also uploads its tested ZIP on PRs and other desktop runs, then downloads it to exercise the release artifact layout with ad-hoc signing; this artifact has the same three-day retention. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `pnpm install --frozen-lockfile`, and Node comes from `.nvmrc`.

`main` requires a pull request, an up-to-date branch, and a passing **Quality gate**, including for administrators. No second-person approval is required. Force pushes and deletion are blocked. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Follow [AGENTS.md](../AGENTS.md#validation-and-delivery) for pre-push checks and delivery. Keep cancellation of superseded runs enabled.

Account owners should configure an Actions budget with **Stop usage when budget limit is reached** enabled in GitHub billing settings, plus usage alerts. Budget alerts alone do not stop spending. Review and delete obsolete development artifacts in Actions after preserving any needed downloads; reducing workflow retention affects new uploads, and deleting old artifacts prevents future storage accrual without reversing existing charges. Billing settings and existing artifact cleanup are account operations, not changes this workflow applies. See [GitHub budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets) and [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Local `package` output goes to `out/`; `make` installers and ZIPs go to `out/make/`. Build on each target OS. These are ad-hoc development artifacts on macOS and unsigned on Linux/Windows. Published macOS nightlies are Developer ID signed, notarized and stapled in the main-only `Release` job after the Quality gate; the publisher waits for its signed artifact. See [packaging and signing](architecture.md#packaging-and-macos-signing-601) for credentials, entitlements and the manual credential check. Windows signing remains #665; unsigned Windows installers are published only on the nightly channel. The rolling nightly is a public prerelease, never Latest; its tag points to the tested commit. Publication reuses the tested ZIPs. CI stamps the version only in its disposable checkout, leaving the committed package and lockfile versions unchanged. A serialized publisher ignores duplicate or older commits. Auto-update remains #603. Versioned draft publication is described below.

The independent Real CLI MCP probe runs on every scheduled and manual dispatch
except credential-only checks, including nights without changes to main. It is excluded from the Quality gate and
nightly publication dependencies; its isolated real-CLI policy is documented in
[AGENTS.md](../AGENTS.md#validation-and-delivery).

## Installers and versioned drafts (#602)

`pnpm run make` builds the native platform formats alongside the development ZIP:
macOS DMG plus ZIP (the latter supports Squirrel.Mac), Windows Squirrel.Windows
Setup.exe plus full nupkg and RELEASES, and Linux deb/rpm plus ZIP. Squirrel.Windows
was chosen for the update.electronjs.org path planned in #603. Windows remains
unsigned until #665 and ships only on the nightly channel; versioned drafts
contain macOS and Linux assets only. This supersedes #602's original assumption
that #601 would also provide Windows signing.

The DMG uses a local Forge maker backed by Apple's `hdiutil` (ULFO), with Foom.app
and an Applications shortcut. This avoids appdmg's vulnerable image-size chain
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
ASAR, console and fixture-isolation checks. Linux also verifies its desktop entry
and executable symlink. Desktop entries launch `/usr/lib/foom/Foom` directly so
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
file references the renamed full nupkg; rolling prereleases do not yet provide
an auto-update endpoint (#603).

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
retry transient network/CloudKit failures, missing ticket records, and Error 65/68
up to six attempts, 30 seconds apart. Each attempt logs a timestamp, artifact and
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
