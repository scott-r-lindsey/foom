# Foom

A small Electron hello world using strict TypeScript and Electron Forge. No UI framework or application bundler is needed yet.

## Develop

Use Node.js 24 LTS (`nvm use`) and npm:

```sh
npm ci
npm start
```

Click **Say hello** to send a request through the preload bridge to the main process. Restart `npm start` after editing source files. Open Developer Tools using Ctrl+Shift+I (Command+Option+I on macOS).

`npm ci` installs the Husky pre-commit hook. Every commit checks formatting, lint, types, and fast unit tests. It does not launch a desktop window or silently rewrite files.

## How TypeScript fits into Electron

Electron runs JavaScript compiled from your TypeScript. `npm start`, `npm run test:electron`, `npm run package`, and `npm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git.

- **Main process** (`src/main.ts`): Node.js code that manages the desktop window and validates IPC requests.
- **Renderer** (`src/renderer/renderer.ts`): browser code that controls the HTML interface.
- **Preload** (`src/preload.ts`): exposes the explicitly allowed `window.desktop` bridge.
- **Shared contract** (`src/shared/desktop.d.ts`): types for that bridge. Runtime validation remains necessary because TypeScript types disappear after compilation.

Main and preload compile to CommonJS for Electron's sandboxed preload. Renderer code compiles as browser modules. Their compiler environments remain separate. TypeScript 6 is pinned for compatibility with the installed TypeScript ESLint tooling.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Formatting, lint, all type checks, and fast unit tests; also the pre-commit check |
| `npm run format` | Apply Biome formatting |
| `npm run format:check` | Check formatting without changing files |
| `npm run lint` / `npm run lint:fix` | Type-aware ESLint checks / safe autofixes |
| `npm run typecheck` | Check application, tests, and Vitest configuration without emitting files |
| `npm test` / `npm run test:watch` | Run Vitest once / in watch mode, without a desktop display |
| `npm run test:coverage` | Enforce per-file coverage and write HTML, LCOV, JSON, and terminal reports |
| `npm run test:electron` | Build and launch the real Electron integration test |
| `npm run build` | Compile application code and copy HTML/CSS |
| `npm run package` / `npm run make` | Create an executable application / a distributable ZIP |

Biome owns formatting, and ESLint owns lint rules. Strict TypeScript includes checked indexed access, exact optional properties, explicit overrides, and unused-code checks. ESLint uses type information to catch unsafe values and mishandled promises. No generated output or `inspiration/` content is checked or packaged.

## Tests and coverage

`tests/` contains TypeScript unit tests for the main process, preload, renderer, and coverage-reporting tools. Tests exercise IPC trust boundaries, asset restrictions, permissions, startup failures, UI pending/error states, and bridge response validation. Electron is mocked in unit tests; jsdom provides the UI environment.

`test/app.test.js` is a separate real Electron smoke test for the greeting, isolated bridge, sandbox settings, asset restrictions, and popup blocking. On Linux, use a graphical session or `xvfb-run -a npm run test:electron` with Electron's system libraries installed. Keep Chromium's sandbox enabled.

Coverage includes every executable TypeScript file under `src/`, including files no test imports. Only `.d.ts` declarations are excluded. Each file must reach **90% lines, statements, and functions, and 85% branches**. Open `coverage/index.html` after running coverage. This is unit-test coverage; it does not imply the real Electron process was instrumented.

PR checks additionally require **90% changed executable line coverage**, and fail if a changed application file is missing from LCOV. The scripts under `scripts/` adapt the reporting tools from the Crab Attack II reference, with stricter enforcement and regression tests.

## CI and packages

`.github/workflows/ci.yml` runs on pushes and pull requests:

1. Independent formatting, lint, typecheck, and unit-coverage jobs.
2. Electron launch tests and Forge ZIP packaging on Ubuntu, Windows, and macOS, after the fast checks pass.
3. A stable **Quality gate** status that requires all jobs to succeed.

CI uploads HTML/LCOV coverage and unsigned platform ZIPs for 14 days. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `npm ci`, and Node comes from `.nvmrc`.

To enforce checks before merging, configure the repository's branch rules to require **Quality gate**. The workflow alone does not configure branch protection. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Local `package` output goes to `out/`; `make` ZIPs go to `out/make/`. Build on each target OS. These are unsigned development artifacts. Public releases still need your app identifier, icons, installers, signing, and macOS notarization. No automatic public release or deployment is configured.

## Security defaults

The renderer uses sandboxing, context isolation, and no Node integration. A strict Content Security Policy allows only local scripts and styles. The `app://` protocol serves an explicit asset allowlist. Navigation, new windows, webviews, and permission requests are blocked. IPC checks the sender's URL and main frame. Production packages use ASAR and hardened Electron fuses, and include only compiled application files and package metadata.

Keep Electron updated and review the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) when adding capabilities. Contributor instructions are in [AGENTS.md](AGENTS.md).

### Known dependency audit findings

The current dependency tree reports 25 development-tooling advisories (3 low, 21 high, 1 critical), including archive extraction and temporary-file packages under Forge. Compatible `npm audit fix` does not resolve them; its forced alternative proposes a Forge downgrade. These remain outstanding. Recheck upstream updates before release and use trusted build inputs. `npm audit --omit=dev` reports zero advisories; this does not audit Electron's bundled Chromium or Node.js runtime.
