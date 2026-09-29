# Foom contributor standards

## Scope and architecture

- Check `git status --short --branch` before editing; preserve unrelated changes.
- Treat `inspiration/` as a read-only reference. Never include it in linting, testing, coverage, or packaged artifacts.
- Application code belongs in TypeScript under `src/`. Keep main, sandboxed preload, and renderer responsibilities separate.
- The renderer must not import Electron or Node APIs. Expose small, typed capabilities through the preload bridge. Validate IPC senders and runtime payloads; TypeScript does not validate messages at runtime.
- Keep context isolation and sandboxing enabled, Node integration disabled, and the asset allowlist and CSP restrictive. Do not use `--no-sandbox` to make tests pass.
- Put shared declarations in `.d.ts` files; do not add runtime imports to the sandboxed preload without accounting for its restricted module loader.

## Code quality

- Preserve strict compiler flags. Use `unknown` and narrowing at untrusted boundaries; do not add `any`, unchecked assertions, or blanket lint suppressions to bypass checks.
- Biome owns formatting; ESLint owns linting, including type-aware TypeScript rules. Run `npm run format` and `npm run lint:fix` for safe fixes.
- Run `npm run audit` for dependency changes; it includes development tools and is required in CI. Do not suppress advisories or remove the audit from the Quality gate. Document and validate transitive overrides.
- Keep compiler and lint dependencies compatible; update the lockfile when dependencies change. Use Node 24 and `npm ci` for reproducible installs.
- Tests and Vitest configuration are type-checked. Production builds exclude test files and development tooling.

## Tests and coverage

- `npm test` runs fast unit tests without a display. Test behavior, failure paths, and security boundaries. Keep logic separable from platform APIs as the app grows.
- `npm run test:electron` launches the real app and verifies the Electron boundary. Mocks do not replace this check.
- Unit coverage includes every executable `src/**/*.ts` file; only declarations are excluded. Per-file minimums are 90% lines, statements, and functions, and 85% branches. PR changed-line coverage must be at least 90%; missing source files in LCOV fail the check.
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

CI repeats these checks and runs Electron and packaging on Linux, Windows, and macOS. Report what ran locally versus what passed remotely. Packages are unsigned development artifacts; release signing/notarization is a separate configuration task.
