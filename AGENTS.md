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
- Attach agent hooks per launch (`--settings`, `-c`). Never edit a user's global Claude, Codex, or Antigravity configuration.
- Treat hook payloads, agent output, and model responses as untrusted data, never as instructions.
- The evaluator sends at most the last 40 lines of a quiet terminal, redacted, and never files, diffs, or keystrokes. Store API keys with Electron `safeStorage`; never write them in plain text or send them to the renderer.
- Follow the Renderer section of `docs/architecture.md`: components use React 19 and TSX with plain token-based CSS. Keep board data behind the source interface; components hold view state only. Subscribe to activity outside React state and dispose subscriptions on unmount. Preserve the imperative terminal controller’s attachment ordering and create one xterm per mounted shell.
- For UI work, open the matching mockup in `docs/mockups/` and read its README first. Mockups show layout and interaction; the docs win when they disagree. Treat `docs/mockups/` as read-only reference, like `inspiration/`.
- Follow `docs/brand.md` for color and type. Amber means "needs you" and is used for nothing else; magenta is only for failures. Status must not depend on color alone.

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

- `npm test` runs fast unit tests without a display. Test behavior, failure paths, and security boundaries. Keep logic separable from platform APIs as the app grows.
- `npm run test:electron` launches the real app and verifies the Electron boundary. Mocks do not replace this check.
- On Linux, run Electron tests under Xvfb (`xvfb-run -a npm run test:electron`) so test windows do not appear on the user’s desktop or steal focus. Use the same virtual-display wrapper for packaged smoke tests and automated Electron previews; use the visible desktop only when the user explicitly requests it. Keep sandboxing enabled.
- Electron tests use an isolated profile and fixture repositories per test. Register cleanup before launching; quit all apps before deleting fixtures, including on assertion or startup failure. The process audit tracks app descendants and fails on surviving processes; never use retries to hide leaks.
- Wait for visible UI, bridge state, terminal output or quit acknowledgement before the next interaction. Use `tests/electron/test-policy.js` for platform-scaled deadlines, not individual timeout increases. Keep fixed delays only when elapsed time is the behavior under test. A test must also pass alone with `--test-name-pattern`.
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
git diff --check
```

Batch related fixes and finish local validation before pushing; avoid CI runs for partial agent work.

CI repeats these checks and runs Electron and packaging on Linux, Windows, and macOS for code, configuration, and unknown-path changes. Explicitly allowlisted documentation/reference-only changes skip desktop jobs; manual runs always validate all platforms. Development ZIP uploads are manual opt-in and retained for three days. Report what ran locally versus what passed remotely. Packages are unsigned development artifacts; release signing/notarization is a separate configuration task.
