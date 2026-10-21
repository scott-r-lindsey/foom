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
2. Electron launch tests and Forge ZIP packaging on Ubuntu, Windows, and macOS, alongside static checks when desktop validation is required.
3. A stable **Quality gate** status that requires all three Linux jobs to succeed and desktop validation to pass, or to be explicitly classified as unnecessary and skipped. Failed detection never permits a skip.

CI runs for pull requests and pushes to `main`, avoiding duplicate branch-push runs for PRs. The [Electron sharding guide](electron-shards.md) owns the desktop job layout and assignment details. Test deadlines come from `tests/electron/test-policy.js`.

Desktop validation is skipped only when every changed path is `README.md`, `AGENTS.md`, `LICENSE`, `NOTICE`, Markdown under `docs/`, direct HTML mockups under `docs/mockups/`, or reference/prototype material under `inspiration/` or `spikes/` (the exact allowlist is in [`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs)). Reference files are classified by path only; CI never tests or packages their contents. Unknown paths, empty diffs, and manual runs require desktop validation. PR detection uses the merge-base diff against the base branch; pushes compare the previous commit with the new commit. Renames include both old and new paths. Missing comparison history fails change detection.

CI retains HTML/LCOV coverage for three days. Platform ZIPs are still built and validated on every required desktop run, and are uploaded for scheduled nightlies or **Actions → CI → Run workflow → publish_nightly** on `main`. Only the publication job has repository contents write permission, and it waits for the Quality gate. An unchanged or failing night leaves the previous nightly up. Manual runs without `publish_nightly` never publish. The separate `upload_packages` option uploads development ZIPs without publishing. These manually requested ZIPs are retained for three days. macOS CI also uploads its tested ZIP on PRs and other desktop runs, then downloads it to exercise the release artifact layout with ad-hoc signing; this artifact has the same three-day retention. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `pnpm install --frozen-lockfile`, and Node comes from `.nvmrc`.

`main` requires a pull request, an up-to-date branch, and a passing **Quality gate**, including for administrators. No second-person approval is required. Force pushes and deletion are blocked. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Follow [AGENTS.md](../AGENTS.md#validation-and-delivery) for pre-push checks and delivery. Keep cancellation of superseded runs enabled.

Account owners should configure an Actions budget with **Stop usage when budget limit is reached** enabled in GitHub billing settings, plus usage alerts. Budget alerts alone do not stop spending. Review and delete obsolete development artifacts in Actions after preserving any needed downloads; reducing workflow retention affects new uploads, and deleting old artifacts prevents future storage accrual without reversing existing charges. Billing settings and existing artifact cleanup are account operations, not changes this workflow applies. See [GitHub budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets) and [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Local `package` output goes to `out/`; `make` ZIPs go to `out/make/`. Build on each target OS. These are ad-hoc development artifacts on macOS and unsigned on Linux/Windows. Published macOS nightlies are Developer ID signed, notarized and stapled in the main-only `Release` job after the Quality gate; the publisher waits for its signed artifact. See [packaging and signing](architecture.md#packaging-and-macos-signing-601) for credentials, entitlements and the manual credential check. Windows signing remains #665; public versioned releases still need icons/installers and release configuration. The rolling nightly is a public prerelease, never Latest; its tag points to the tested commit. Publication reuses the tested ZIPs. CI stamps the version only in its disposable checkout, leaving the committed package and lockfile versions unchanged. A serialized publisher ignores duplicate or older commits. Versioned releases and auto-update remain out of scope.

The independent Real CLI MCP probe runs on every scheduled and manual dispatch
except credential-only checks, including nights without changes to main. It is excluded from the Quality gate and
nightly publication dependencies; its isolated real-CLI policy is documented in
[AGENTS.md](../AGENTS.md#validation-and-delivery).
