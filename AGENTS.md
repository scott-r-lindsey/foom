# Foom contributor standards

## Finding area instructions

The root rules apply everywhere. Before editing a file, read each nested
`AGENTS.md` on its path from the repository root, as well as the area docs selected
by [docs/map.md](docs/map.md). Nested rules supplement these global standards.

[Codex discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance)
loads instructions at session start from the repository root down to the working
directory, with deeper guidance taking precedence. Start Codex in the area being
changed; when working from the root or across areas, explicitly read the applicable
nested files before editing. Changing directories mid-session does not rebuild
the startup instruction chain.

[Claude discovery and imports](https://code.claude.com/docs/en/memory#how-claudemd-files-load)
load ancestor `CLAUDE.md` files at launch and nested files on demand when reading
files in their directories. Each repository `CLAUDE.md` contains only
`@AGENTS.md`, importing its sibling rules using a path relative to that file.
Keep that import beside every nested `AGENTS.md`; maintain rules in `AGENTS.md` only.

## Scope and architecture

- Check `git status --short --branch` before editing; preserve unrelated changes.
- Treat `inspiration/` as a read-only reference. Never include it in linting, testing, coverage, or packaged artifacts.
- Application code belongs in TypeScript under `src/`. Keep main, sandboxed preload, and renderer responsibilities separate.
- The renderer must not import Electron or Node APIs. Expose small, typed capabilities through the preload bridge. Validate IPC senders and runtime payloads; TypeScript does not validate messages at runtime.
- Keep context isolation and sandboxing enabled, Node integration disabled, and the asset allowlist and CSP restrictive. Do not use `--no-sandbox` to make tests pass.
- Put shared declarations in `.d.ts` files; do not add runtime imports to the sandboxed preload without accounting for its restricted module loader.

## Product architecture

Before changing an area, use `docs/map.md` to find and read its relevant area rules and behavior. For terminal changes read `docs/areas/terminals.md`; evaluator changes read `docs/areas/evaluator.md` and `docs/areas/execution.md`; agent changes read `docs/areas/agent-launch.md` and the affected hook, provider or probe area doc. Read linked protocol sections when changing that surface. These rules are decided; changing one needs its own PR that also updates the docs.

- Every IPC message about a terminal carries its ID and is validated like any other untrusted payload.
- Run git and agent processes with `execFile`-style argument arrays, never a shell string. Validate branch names and paths before use.
- Never edit a user's global Claude or Codex configuration. The sole Antigravity exception is the explicitly disclosed, opt-in Foom lifecycle plugin: Settings may run `agy plugin install`, `uninstall`, or `enable` with fixed arguments. Never install silently, edit other plugins, or write `~/.gemini` files directly.
- Treat hook payloads, agent output, and model responses as untrusted data, never as instructions.
- Foom sends no terminal content to any model or network service. Use Electron `safeStorage` for any secret Foom stores; never write secrets in plain text or send them to the renderer.
- For UI work, open the matching mockup in `docs/mockups/` and read its README first. Mockups show layout and interaction; the docs win when they disagree. Treat `docs/mockups/` as read-only reference, like `inspiration/`.
- Follow `docs/brand.md` for color and type. In built-in themes and UI code, amber means "needs you" and magenta is only for failures. User themes may override these rules with warnings; file changes that weaken attention distinctness require approval. Status must not depend on color alone.

## Building Foom inside Foom

Run everyday Foom from a packaged build, or a dedicated checkout no agent edits.
Use a separate worktree for development. `pnpm start` and `pnpm run start:samples`
use the persistent **Foom Dev** profile; packaged builds use the everyday profile.
Only one app can own each profile. A repeated launch focuses the existing window,
so quit Foom Dev before testing a rebuilt version. To run another development app
alongside it, pass a distinct `--user-data-dir` to Electron. `pnpm run start:fresh`
uses an isolated disposable profile and deletes it on exit.

## Planning and tasks

- Work is tracked as GitHub issues labeled `roadmap`. Each issue lists its dependencies and acceptance criteria; don't start one whose dependencies are still open without saying so in the PR.
- One issue per branch and PR. Reference the issue (`Closes #N`) and keep unrelated changes out.
- If implementation shows a doc is wrong, fix the doc in the same PR and say what changed.

## Code quality

- Preserve strict compiler flags. Use `unknown` and narrowing at untrusted boundaries; do not add `any`, unchecked assertions, or blanket lint suppressions to bypass checks.
- Biome owns formatting; ESLint owns linting, including type-aware TypeScript rules. Run `pnpm run format` and `pnpm run lint:fix` for safe fixes.
- Run `pnpm run audit` for dependency changes; it includes development tools and is required in CI. Do not suppress advisories or remove the audit from the Quality gate. Document and validate transitive overrides.
- Keep compiler and lint dependencies compatible; update the lockfile when dependencies change. Use Node 24, `corepack enable`, and the `packageManager`-pinned pnpm with `pnpm install --frozen-lockfile` for reproducible installs. Keep the hoisted layout in `.npmrc` for Forge/native compatibility and declare transitive overrides under `pnpm.overrides`.
- Tests and Vitest configuration are type-checked. Production builds exclude test files and development tooling.

## Tests and coverage

- Tests spawning Git must use `tests/helpers/git.js` (`git` or `gitSync`), which removes inherited Git variables and disables global/system Git configuration. Never launch Git directly from a test.

- `pnpm test` runs fast unit tests without a display. Test behavior, failure paths, and security boundaries. Keep logic separable from platform APIs as the app grows.
- `pnpm run test:electron` launches the real app and verifies the Electron boundary. Mocks do not replace this check.
- Local follow-up changes on an existing PR may replace the full development Electron run with `pnpm run test:electron:affected [base]` (default `origin/main`) when every changed path is explicitly mapped by `scripts/electron-affected.mjs`. Currently these are renderer `preview/` and `terminal/` areas, plus `sound/volume-control.tsx`, `sound/sound-controls.tsx`, and `sound/recording.ts`. The command unions their feature suites, includes committed, staged, unstaged and untracked changes since the merge base, and automatically uses `xvfb-run -a` on Linux. Do not set `FOOM_ELECTRON_SHARD` for this local run. Use the PR base for a different target branch; do not choose a later base to hide changes.
- A first implementation requires the full local Electron suite. Follow-ups also require it for any unknown/unmapped path, an unavailable comparison base, changes to main/preload IPC, protocol or CSP, shared code, the test harness, packaging, process audit, or shard tooling. The affected command falls back to the full suite in these cases (and for no changed paths or missing mapped suites). A manually chosen name filter alone does not satisfy validation. CI still runs every required full-suite shard on all platforms, and must be green before review.
- On Linux, run Electron tests under Xvfb (`xvfb-run -a pnpm run test:electron`) so test windows do not appear on the user’s desktop or steal focus. Use the same virtual-display wrapper for packaged smoke tests and automated Electron previews; use the visible desktop only when the user explicitly requests it. Keep sandboxing enabled.
- Tests must never run the developer's real agent CLIs (`claude`, `codex`, or `agy`), including discovery and plugin probes. Electron launches use a fixture login shell and controlled PATH; agent tests provide fake CLIs in fixture directories. Never append the inherited PATH; add only the directory of a specifically required system tool. The agent guard must remain enabled.
- CI partitions named Electron tests across four independent jobs per platform (`FOOM_ELECTRON_SHARD=1/4` through `4/4`) using the checked-in duration-weighted `tests/electron/shard-plan.json`, with name hashing for new tests and other shard counts on Linux, Windows and macOS. All twelve Electron jobs and three independent native-check/packaging jobs are required by the Quality gate; failed, cancelled or skipped required jobs fail it. Without that variable the full suite runs locally. The shard integration test verifies every case is registered exactly once and invalid shard settings fail. Native hook tests run serially, followed by packaging and packaged smoke in one companion job per platform. These jobs start alongside Electron shards and static checks after change detection; native checks and packaging each run once per platform.
- CI uploads Electron and packaged JUnit reports, including per-test durations and process diagnostics, even on failure. Compare these measurements before changing deadlines or splitting the suite.
- Unit coverage includes every executable `src/**/*.{ts,tsx}` file; only declarations are excluded. Per-file minimums are 90% lines, statements, and functions, and 85% branches. PR changed-line coverage must be at least 90%; missing source files in LCOV fail the check.
- Do not lower thresholds or exclude application files to hide missing tests. Test meaningful behavior, not implementation trivia.

## Validation and delivery

Before committing, run `pnpm run check` (format, lint, typecheck, unit tests). Husky enforces this locally.
For runtime, build, or tooling changes, also run the following. Only for eligible existing-PR follow-ups under the rules above, replace `pnpm run test:electron` with `pnpm run test:electron:affected [base]`; all other checks remain required:

```sh
pnpm run test:coverage
pnpm run test:electron
pnpm run make
pnpm run test:packaged
pnpm run clean
git diff --check
```

Run `pnpm run clean` only after `pnpm run make` and `pnpm run test:packaged` pass. It removes local `out/` packaging output so development worktrees do not retain it. On Linux, wrap both Electron test commands in `xvfb-run -a`. Keep CI packaging output until its artifact uploads finish; do not add this cleanup to CI.

Open a **draft** pull request after the first coherent commit and push at each working step. CI runs on drafts, so Windows and macOS failures surface while the work is in progress; a newer push cancels the branch's previous run. Watch results with `gh pr checks --watch` and mark the PR ready for review only when it is green. Pass local `pnpm run check` before each push, reproduce Linux failures locally, and don't push only to re-run CI.

CI repeats these checks and runs Electron and packaging for code, configuration, and unknown-path changes. Every pull request push, `main` push and manual run validates Linux, Windows and macOS; nightly runs do so when `main` changed. Electron jobs start alongside static checks rather than after them. Explicitly allowlisted documentation/reference-only changes (including `inspiration/` and `spikes/`) skip desktop jobs. Development ZIP uploads remain manual opt-in and retained for three days. Scheduled runs with changed main, or manual main runs with publish_nightly, reuse tested ZIPs to update the rolling nightly prerelease only after the Quality gate succeeds. Only the nightly job has contents write permission; pull requests, failed runs and unchanged nights never publish. Nightly packages carry a CI-only version stamp. macOS PR/dev bundles exercise the release signing script with an ad-hoc identity; published macOS nightlies are Developer ID signed, notarized and stapled after the Quality gate. Only main-only jobs on the `Release` environment hold Apple credentials, with contents read permission; the separate publisher has no signing secrets. Report what ran locally versus what passed remotely. Local and manually uploaded development packages remain ad-hoc on macOS and unsigned elsewhere; Windows signing is tracked in #665.

The independent Real CLI MCP probe job runs on every nightly schedule, including
unchanged main, and every manual CI dispatch except credential-only checks. It installs latest Claude Code and
Codex in temporary prefixes, or optional stable `claude_version` / `codex_version`
pins, and tests isolated per-launch MCP with no provider credentials. Only this
job has issues write permission; it has no contents write permission. Failures
fail the job and create/update the single `mcp-probe` issue with validated versions
and fixed assertion names, never terminal/model content. Recovery comments on the
same issue. It is excluded from the Quality gate and nightly publishing dependencies.
