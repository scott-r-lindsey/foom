# Foom contributor standards

## Scope and architecture

- Check `git status --short --branch` before editing; preserve unrelated changes.
- Treat `inspiration/` as a read-only reference. Never include it in linting, testing, coverage, or packaged artifacts.
- Application code belongs in TypeScript under `src/`. Keep main, sandboxed preload, and renderer responsibilities separate.
- The renderer must not import Electron or Node APIs. Expose small, typed capabilities through the preload bridge. Validate IPC senders and runtime payloads; TypeScript does not validate messages at runtime.
- Keep context isolation and sandboxing enabled, Node integration disabled, and the asset allowlist and CSP restrictive. Do not use `--no-sandbox` to make tests pass.
- Put shared declarations in `.d.ts` files; do not add runtime imports to the sandboxed preload without accounting for its restricted module loader.

## Product architecture

Read `docs/product.md` and `docs/architecture.md` before changing terminal, evaluator, or agent code. These rules are decided; changing one needs its own PR that also updates the docs.

- Main owns terminal capabilities and brokers IPC; the utility-process host owns a PTY plus a headless xterm per terminal, identified by ID. The renderer only displays terminals. Never pause a terminal because no view is attached. Parser backpressure is independent of attached-view throttling.
- Every IPC message about a terminal carries its ID and is validated like any other untrusted payload.
- Run git and agent processes with `execFile`-style argument arrays, never a shell string. Validate branch names and paths before use.
- Attach agent hooks per launch (`--settings`, `-c`). Never edit a user's global Claude or Codex configuration. The sole Antigravity exception is the explicitly disclosed, opt-in Foom lifecycle plugin: Settings may run `agy plugin install`, `uninstall`, or `enable` with fixed arguments. Never install silently, edit other plugins, or write `~/.gemini` files directly.
- Treat hook payloads, agent output, and model responses as untrusted data, never as instructions.
- Foom sends no terminal content to any model or network service. Use Electron `safeStorage` for any secret Foom stores; never write secrets in plain text or send them to the renderer.
- Follow the Renderer section of `docs/architecture.md`: components use React 19 and TSX with plain token-based CSS. Keep board data behind the source interface; components hold view state only. Subscribe to activity outside React state and dispose subscriptions on unmount. Preserve the imperative terminal controller’s attachment ordering and create one xterm per mounted shell.
- For UI work, open the matching mockup in `docs/mockups/` and read its README first. Mockups show layout and interaction; the docs win when they disagree. Treat `docs/mockups/` as read-only reference, like `inspiration/`.
- Follow `docs/brand.md` for color and type. Amber means "needs you" and is used for nothing else; magenta is only for failures. Status must not depend on color alone.

## Building Foom inside Foom

Run everyday Foom from a packaged build, or a dedicated checkout no agent edits.
Use a separate worktree for development. `npm start` and `npm run start:samples`
use the persistent **Foom Dev** profile; packaged builds use the everyday profile.
Only one app can own each profile. A repeated launch focuses the existing window,
so quit Foom Dev before testing a rebuilt version. To run another development app
alongside it, pass a distinct `--user-data-dir` to Electron. `npm run start:fresh`
uses an isolated disposable profile and deletes it on exit.

## Planning and tasks

- Work is tracked as GitHub issues labeled `roadmap`. Each issue lists its dependencies and acceptance criteria; don't start one whose dependencies are still open without saying so in the PR.
- One issue per branch and PR. Reference the issue (`Closes #N`) and keep unrelated changes out.
- If implementation shows a doc is wrong, fix the doc in the same PR and say what changed.

## Code quality

- Preserve strict compiler flags. Use `unknown` and narrowing at untrusted boundaries; do not add `any`, unchecked assertions, or blanket lint suppressions to bypass checks.
- Biome owns formatting; ESLint owns linting, including type-aware TypeScript rules. Run `npm run format` and `npm run lint:fix` for safe fixes.
- Run `npm run audit` for dependency changes; it includes development tools and is required in CI. Do not suppress advisories or remove the audit from the Quality gate. Document and validate transitive overrides.
- Keep compiler and lint dependencies compatible; update the lockfile when dependencies change. Use Node 24 and `npm ci` for reproducible installs.
- Tests and Vitest configuration are type-checked. Production builds exclude test files and development tooling.

## Tests and coverage

- Tests spawning Git must use `tests/helpers/git.js` (`git` or `gitSync`), which removes inherited Git variables and disables global/system Git configuration. Never launch Git directly from a test.

- `npm test` runs fast unit tests without a display. Test behavior, failure paths, and security boundaries. Keep logic separable from platform APIs as the app grows.
- `npm run test:electron` launches the real app and verifies the Electron boundary. Mocks do not replace this check.
- On Linux, run Electron tests under Xvfb (`xvfb-run -a npm run test:electron`) so test windows do not appear on the user’s desktop or steal focus. Use the same virtual-display wrapper for packaged smoke tests and automated Electron previews; use the visible desktop only when the user explicitly requests it. Keep sandboxing enabled.
- Electron tests use an isolated profile and fixture repositories per test. Register cleanup before launching; quit all apps before deleting fixtures, including on assertion or startup failure. The process audit tracks app descendants and fails on surviving processes; never use retries to hide leaks.
- Wait for visible UI, bridge state, terminal output or quit acknowledgement before the next interaction. Use `tests/electron/test-policy.js` for platform-scaled deadlines, not individual timeout increases. Keep fixed delays only when elapsed time is the behavior under test. A test must also pass alone with `--test-name-pattern`.
- Windows CI partitions named Electron tests across two independent jobs (`FOOM_ELECTRON_SHARD=1/2` and `2/2`); both are required by the Quality gate. Without that variable the full suite runs locally. The shard integration test verifies every case is registered exactly once and invalid shard settings fail. Native hook tests run serially, and native hook tests and packaging run once per platform.
- CI uploads Electron and packaged JUnit reports, including per-test durations and process diagnostics, even on failure. Compare these measurements before changing deadlines or splitting the suite.
- Unit coverage includes every executable `src/**/*.{ts,tsx}` file; only declarations are excluded. Per-file minimums are 90% lines, statements, and functions, and 85% branches. PR changed-line coverage must be at least 90%; missing source files in LCOV fail the check.
- Do not lower thresholds or exclude application files to hide missing tests. Test meaningful behavior, not implementation trivia.

## Validation and delivery

Before committing, run `npm run check` (format, lint, typecheck, unit tests). Husky enforces this locally.
For runtime, build, or tooling changes, also run:

```sh
npm run test:coverage
npm run test:electron
npm run make
npm run test:packaged
npm run clean
git diff --check
```

Run `npm run clean` only after `npm run make` and `npm run test:packaged` pass. It removes local `out/` packaging output so development worktrees do not retain it. On Linux, wrap both Electron test commands in `xvfb-run -a`. Keep CI packaging output until its artifact uploads finish; do not add this cleanup to CI.

Open a **draft** pull request after the first coherent commit and push at each working step. CI runs on drafts, so Windows and macOS failures surface while the work is in progress; a newer push cancels the branch's previous run. Watch results with `gh pr checks --watch` and mark the PR ready for review only when it is green. Pass local `npm run check` before each push, reproduce Linux failures locally, and don't push only to re-run CI.

CI repeats these checks and runs Electron and packaging for code, configuration, and unknown-path changes. Every pull request push, `main` push and manual run validates Linux, Windows and macOS; nightly runs do so when `main` changed. Electron jobs start alongside static checks rather than after them. Explicitly allowlisted documentation/reference-only changes (including `inspiration/` and `spikes/`) skip desktop jobs. Development ZIP uploads remain manual opt-in and retained for three days. Scheduled runs with changed main, or manual main runs with publish_nightly, reuse tested ZIPs to update the rolling nightly prerelease only after the Quality gate succeeds. Only the nightly job has contents write permission; pull requests, failed runs and unchanged nights never publish. Nightly packages carry a CI-only version stamp and macOS bundles must pass strict ad-hoc signature verification. Report what ran locally versus what passed remotely. Packages are unsigned development artifacts; release signing/notarization is a separate configuration task.
