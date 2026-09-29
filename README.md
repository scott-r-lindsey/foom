# Foom

A minimal Electron terminal using strict TypeScript, xterm.js, node-pty, and Electron Forge.

## Develop

Use Node.js 24 LTS (`nvm use`) and npm:

```sh
npm ci
npm start
```

The window opens a real interactive shell in the project directory (`$SHELL` on Linux/macOS, PowerShell on Windows). Try `vim`, `top`, or your usual CLI tools; those programs must be installed on your machine. Resizing the window resizes the PTY. Ctrl+C interrupts commands, and full-screen programs use the alternate screen buffer. Type `exit` to end the shell, then use **Restart shell** for a fresh session. Closing the window terminates its PTY. Packaged builds start in your home directory.

This first version has one terminal with 10,000 lines of scrollback. It does not yet create worktrees or restore sessions. Restart `npm start` after editing source files.

`node-pty` is a native dependency. If a prebuilt binary is unavailable, installation/rebuild requires Python and a C++ toolchain (Xcode command line tools on macOS, build-essential on Linux, Visual Studio C++ build tools on Windows).

`npm ci` installs the Husky pre-commit hook. Every commit checks formatting, lint, types, and fast unit tests. It does not launch a desktop window or silently rewrite files.

## How TypeScript fits into Electron

Electron runs JavaScript compiled from your TypeScript. `npm start`, `npm run test:electron`, `npm run package`, and `npm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git.

- **Main process** (`src/main.ts`): Node.js code that manages the desktop window and validates IPC requests.
- **Renderer** (`src/renderer/renderer.ts`): browser code that controls the HTML interface.
- **Preload** (`src/preload.ts`): exposes the explicitly allowed `window.desktop` bridge.
- **Shared contract** (`src/shared/desktop.d.ts`): types for that bridge. Runtime validation remains necessary because TypeScript types disappear after compilation.

Main and preload compile to CommonJS for Electron's sandboxed preload. esbuild bundles the renderer and xterm CSS for the browser. The main process owns the PTY; the preload exposes only start, input, resize, output, exit, and output acknowledgements. Acknowledgements apply backpressure so fast output does not overwhelm the renderer. Their compiler environments remain separate. TypeScript 6 is pinned for compatibility with the installed TypeScript ESLint tooling.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Formatting, lint, all type checks, and fast unit tests; also the pre-commit check |
| `npm run format` | Apply Biome formatting |
| `npm run format:check` | Check formatting without changing files |
| `npm run lint` / `npm run lint:fix` | Type-aware ESLint checks / safe autofixes |
| `npm run audit` | Scan the full dependency tree, including development tools; fail on any reported vulnerability |
| `npm run typecheck` | Check application, tests, and Vitest configuration without emitting files |
| `npm test` / `npm run test:watch` | Run Vitest once / in watch mode, without a desktop display |
| `npm run test:coverage` | Enforce per-file coverage and write HTML, LCOV, JSON, and terminal reports |
| `npm run test:electron` | Build and launch the real Electron integration test |
| `npm run build` | Compile application code, bundle xterm, and copy assets |
| `npm run package` / `npm run make` | Create an executable application / a distributable ZIP |

Biome owns formatting, and ESLint owns lint rules. Strict TypeScript includes checked indexed access, exact optional properties, explicit overrides, and unused-code checks. ESLint uses type information to catch unsafe values and mishandled promises. No generated output or `inspiration/` content is checked or packaged.

## Tests and coverage

`tests/` contains TypeScript unit tests for the main process, preload, renderer, and coverage-reporting tools. Tests exercise IPC trust boundaries, asset restrictions, permissions, startup failures, UI pending/error states, and bridge response validation. Electron is mocked in unit tests; jsdom provides the UI environment.

`test/app.test.js` is a separate real Electron smoke test for real shell I/O, exit/restart, the isolated bridge, sandbox settings, asset restrictions, and popup blocking. On Linux/macOS it also checks TTY support, Ctrl+C, vim, and top; these tools must be installed. On Linux, use a graphical session or `xvfb-run -a npm run test:electron` with Electron's system libraries installed. Keep Chromium's sandbox enabled.

Coverage includes every executable TypeScript file under `src/`, including files no test imports. Only `.d.ts` declarations are excluded. Each file must reach **90% lines, statements, and functions, and 85% branches**. Open `coverage/index.html` after running coverage. This is unit-test coverage; it does not imply the real Electron process was instrumented.

PR checks additionally require **90% changed executable line coverage**, and fail if a changed application file is missing from LCOV. The scripts under `scripts/` adapt the reporting tools from the Crab Attack II reference, with stricter enforcement and regression tests.

## CI and packages

`.github/workflows/ci.yml` runs on pushes and pull requests:

1. Independent formatting, lint, typecheck, full dependency audit, and unit-coverage jobs.
2. Electron launch tests and Forge ZIP packaging on Ubuntu, Windows, and macOS, after the fast checks pass.
3. A stable **Quality gate** status that requires all jobs to succeed.

CI uploads HTML/LCOV coverage and unsigned platform ZIPs for 14 days. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `npm ci`, and Node comes from `.nvmrc`.

`main` requires a pull request, an up-to-date branch, and a passing **Quality gate**, including for administrators. No second-person approval is required. Force pushes and deletion are blocked. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Local `package` output goes to `out/`; `make` ZIPs go to `out/make/`. Build on each target OS. These are unsigned development artifacts. Public releases still need your app identifier, icons, installers, signing, and macOS notarization. No automatic public release or deployment is configured.

## Security defaults

The renderer uses sandboxing, context isolation, and no Node integration. The Content Security Policy allows only local scripts. Styles allow inline declarations because xterm generates positioning and color styles at runtime; script policy remains restrictive. The `app://` protocol serves an explicit asset allowlist. Navigation, new windows, webviews, and permission requests are blocked. IPC checks the owning window, sender URL, main frame, and message payloads. Production packages use ASAR and hardened Electron fuses, and include compiled application files, package metadata, and production dependencies. Native node-pty binaries and spawn helpers are unpacked from ASAR.

Keep Electron updated and review the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) when adding capabilities. Contributor instructions are in [AGENTS.md](AGENTS.md).

### Dependency maintenance

The full `npm run audit` scan currently reports **zero vulnerabilities**, including development dependencies. It runs as a required CI job before packaging. A registry failure also fails that job; advisories are not suppressed. This scan does not replace monitoring Electron's Chromium and Node.js security updates.

Forge 7.11.2 is the latest stable Forge release at the time of this update, but still requests older transitive dependencies. Three pinned npm overrides remove the previous 25 findings:

| Override | Reason |
| --- | --- |
| `@electron/rebuild` → `4.2.0` | Replaces the old Electron node-gyp fork and vulnerable `tar` 6 dependency chain with maintained node-gyp and patched `tar` 7.5.22. |
| `@electron/packager` → `extract-zip` alias to `@electron-internal/extract-zip@1.0.5` | The original `extract-zip` has no patched release. Electron's maintained extractor provides the API used by Packager and protects extraction paths. |
| `external-editor` → `tmp@0.2.7` | Fixes temporary-file path handling while retaining the API used by Forge's prompt dependency. |

These cross upstream version ranges. Keep validating clean installs and packaging on all three operating systems when changing them, and remove the overrides when a stable Forge release incorporates the fixes. The real Electron tests exercise the native node-pty addon, and Forge rebuilds it for the target Electron version during startup and packaging.

Vitest and its V8 coverage provider are updated together to 5.0.2. Some dependencies intentionally remain below their newest major: TypeScript 6 matches typescript-eslint's supported range; Node types match Node 24; fuses 1.8 matches Forge's plugin peer requirement. Use Node 24 LTS (`nvm use`); Vitest 5 does not support Node 25.

Sources: [Electron's maintained ZIP extractor](https://github.com/electron/extract-zip), [original extractor advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), and the installed packages' peer/engine requirements.
