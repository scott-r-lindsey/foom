# Foom

A minimal Electron terminal using strict TypeScript, xterm.js, node-pty, and Electron Forge.

## Try a nightly

Download the latest tested build from the [rolling nightly prerelease](https://github.com/scott-r-lindsey/foom/releases/tag/nightly).
It contains macOS arm64, Linux x64 and Windows x64 ZIPs and `SHA256SUMS`.
Follow the [unsigned-build opening steps](docs/nightly-opening.md), including
macOS's quarantine removal command and Windows's SmartScreen prompt.

## Develop

Use Node.js 24 LTS (`nvm use`) and npm:

```sh
npm ci
npm start
```

The first launch opens **preflight**, the setup countdown: agents, repositories, the evaluator, then go / no-go. To see it again, click **Preflight** on the board; your choices are prefilled. To see it exactly as a new user would, run:

```sh
npm run start:fresh          # a throwaway profile, deleted when Foom quits
npm run start:fresh -- --keep  # keep the profile to reopen it later
```

A fresh profile starts with no settings, repositories or keys. Your real profile isn't touched.

After preflight, the board starts empty. **Local shell** opens an interactive shell (`$SHELL` on Linux/macOS, PowerShell on Windows); **New worktree** creates or reuses a managed Git worktree and launches an agent or shell in it. Select a row to open its terminal. Hidden terminals keep running. Try `vim`, `top`, or your usual CLI tools; those programs must be installed on your machine. Resizing the view resizes the PTY, and Ctrl+C interrupts commands. Type `exit` to end a shell; **Restart shell** starts a fresh local-shell session. Quitting confirms before stopping running terminals.

Change the interface size with **⌘ +/−/0** on macOS, or **Ctrl+Shift+=/−** and **Ctrl+0** on Linux and Windows (plain Ctrl+− stays with the terminal, where it's readline's undo). Light or dark is under **Appearance** in preflight.

On Linux and Windows, select terminal text with the mouse and press **Ctrl+Shift+C** to copy. Press **Ctrl+Shift+V** to paste clipboard text into the terminal. These shortcuts work without an application menu; **Ctrl+C** still interrupts the running command.

Each terminal has 10,000 lines of scrollback. Terminal sessions are not restored after quitting. Restart `npm start` after editing source files.

`node-pty` is a native dependency. The build corrects executable permissions on its macOS prebuilt spawn helper to work around [node-pty #850](https://github.com/microsoft/node-pty/issues/850). If a prebuilt binary is unavailable, installation/rebuild requires Python and a C++ toolchain (Xcode command line tools on macOS, build-essential on Linux, Visual Studio C++ build tools on Windows).

`npm ci` installs the Husky pre-commit hook. Every commit checks formatting, lint, types, and fast unit tests. It does not launch a desktop window or silently rewrite files.

## How TypeScript fits into Electron

Electron runs JavaScript compiled from your TypeScript. `npm start`, `npm run test:electron`, `npm run package`, and `npm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git.

- **Main process** (`src/main/main.ts`): composes window management, terminal capabilities, workspace/worktree services, agents, evaluator, and setup. Each feature has its own directory under `src/main/`.
- **Terminal host** (`src/terminal-host/terminal-host.ts`): an Electron utility process owns PTYs, headless xterm screens, activity, and backpressure.
- **Preload** (`src/preload/preload.ts`): exposes the explicitly allowed `window.desktop` bridge in Electron's sandbox.
- **Renderer** (`src/renderer/renderer.tsx`): mounts `app.tsx`; browser UI is grouped into `board/`, `terminal/`, `preflight/`, and reusable `ui/` controls. Styles and fonts have their own directories.
- **Shared code** (`src/shared/`): `.d.ts` contracts plus platform-neutral terminal protocol validation and color handling. Runtime validation remains necessary because TypeScript types disappear after compilation.

ESLint enforces process import boundaries. Main, host, and renderer can import their own code and shared code; shared code cannot import process-owned code or Node/Electron capabilities. Preload runtime imports are limited to Electron, with shared contracts imported as types. Keep explicit module filenames; avoid catch-all utility folders and barrel exports that hide ownership. See [architecture](docs/architecture.md#source-layout) for the directory map.

Main, host, and preload compile to CommonJS. esbuild bundles the renderer and xterm CSS for the browser. The build bundles the ordered feature styles in `src/renderer/styles/styles.css` and copies the tokens into `build/renderer/`, retaining the existing asset URLs and allowlist. Compiler environments remain separate. TypeScript 6 is pinned for compatibility with the installed TypeScript ESLint tooling.

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

`tests/unit/` mirrors source ownership and contains TypeScript unit tests for the main process, preload, renderer, and coverage-reporting tools. Tests exercise IPC trust boundaries, asset restrictions, permissions, startup failures, UI pending/error states, and bridge response validation. Electron is mocked in unit tests; jsdom provides the UI environment.

`tests/electron/` contains the real Electron tests and their PTY probe scripts. `app.test.js` is the integration suite for real shell I/O, exit/restart, the isolated bridge, sandbox settings, asset restrictions, and popup blocking. On Linux and Windows it verifies mouse selection and Ctrl+Shift+C / Ctrl+Shift+V against the native clipboard and a real shell. On Linux/macOS it also checks TTY support and Ctrl+C. Detached output, snapshot restoration, and clean application shutdown are required on every platform. Alternate-screen behavior uses deterministic escape sequences in unit tests; Vim and top remain optional manual smoke tests. A second Electron test checks bundled fonts and system themes. Both Electron tests have bounded shutdown cleanup and a hard worker deadline. On Linux, use a graphical session or `xvfb-run -a npm run test:electron` with Electron's system libraries installed. Keep Chromium's sandbox enabled.

Coverage includes every executable TypeScript file under `src/`, including files no test imports. Only `.d.ts` declarations are excluded. Each file must reach **90% lines, statements, and functions, and 85% branches**. Every successful `npm run test:coverage` prints a `file://` URL for the HTML report at `coverage/index.html`; the `coverage/` directory is ignored by Git. This is unit-test coverage; it does not imply the real Electron process was instrumented.

PR checks additionally require **90% changed executable line coverage**, and fail if a changed application file is missing from LCOV. The scripts under `scripts/` adapt the reporting tools from the Crab Attack II reference, with stricter enforcement and regression tests.

## CI and packages

`.github/workflows/ci.yml` runs on pushes and pull requests:

1. One Linux job for formatting, lint, typecheck, full dependency audit, CI policy tests, and change detection, alongside a separate unit-coverage job.
2. Electron launch tests and Forge ZIP packaging on Ubuntu, Windows, and macOS, alongside static checks when desktop validation is required.
3. A stable **Quality gate** status that requires both Linux jobs to succeed and desktop validation to pass, or to be explicitly classified as unnecessary and skipped. Failed detection never permits a skip.

CI runs for pull requests and pushes to `main`, avoiding duplicate branch-push runs for PRs. Windows partitions the Electron suite across two jobs; native hook checks and packaging run once per platform. Test deadlines come from the shared policy.

Desktop validation is skipped only when every changed path is `README.md`, `AGENTS.md`, `LICENSE`, `NOTICE`, Markdown under `docs/`, or reference material under `inspiration/`. Reference files are classified by path only; CI never tests or packages their contents. Unknown paths, empty diffs, and manual runs require desktop validation. PR detection uses the merge-base diff against the base branch; pushes compare the previous commit with the new commit. Renames include both old and new paths. Missing comparison history fails the checks job.

CI retains HTML/LCOV coverage for three days. Platform ZIPs are still built and validated on every required desktop run, and are uploaded for scheduled nightlies or **Actions → CI → Run workflow → publish_nightly** on `main`. Only the publication job has repository contents write permission, and it waits for the Quality gate. An unchanged or failing night leaves the previous nightly up. Manual runs without `publish_nightly` never publish. The separate `upload_packages` option uploads development ZIPs without publishing. These manually requested ZIPs are retained for three days. PRs get changed-line annotations and a job summary; same-repository PRs also get one updated coverage comment. Comment permission failures do not bypass the coverage gate. GitHub Actions are pinned to commit SHAs, dependencies use `npm ci`, and Node comes from `.nvmrc`.

`main` requires a pull request, an up-to-date branch, and a passing **Quality gate**, including for administrators. No second-person approval is required. Force pushes and deletion are blocked. Linux CI permits unprivileged user namespaces on its ephemeral runner so Chromium can keep its sandbox enabled.

Before pushing, run the required local checks and batch related fixes into one push; avoid repeatedly pushing partial agent work or rerunning an unchanged failed run. Keep cancellation of superseded runs enabled.

Account owners should configure an Actions budget with **Stop usage when budget limit is reached** enabled in GitHub billing settings, plus usage alerts. Budget alerts alone do not stop spending. Review and delete obsolete development artifacts in Actions after preserving any needed downloads; reducing workflow retention affects new uploads, and deleting old artifacts prevents future storage accrual without reversing existing charges. Billing settings and existing artifact cleanup are account operations, not changes this workflow applies. See [GitHub budgets](https://docs.github.com/en/billing/how-tos/set-up-budgets) and [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Local `package` output goes to `out/`; `make` ZIPs go to `out/make/`. Build on each target OS. These are unsigned development artifacts. Public releases still need your app identifier, icons, installers, signing, and macOS notarization. The rolling nightly is a public prerelease, never Latest; its tag points to the tested commit. Publication reuses the tested ZIPs. CI stamps the version only in its disposable checkout, leaving the committed package and lockfile versions unchanged. A serialized publisher ignores duplicate or older commits. Versioned releases and auto-update remain out of scope.

## Security defaults

The renderer uses sandboxing, context isolation, and no Node integration. The Content Security Policy allows only local scripts. Styles allow inline declarations because xterm generates positioning and color styles at runtime; script policy remains restrictive. The `app://` protocol serves an explicit asset allowlist. Navigation, new windows, webviews, and permission requests are blocked. IPC checks the owning window, sender URL, main frame, and message payloads. Production packages use ASAR and hardened Electron fuses, and include compiled application files, package metadata, and production dependencies. Native node-pty binaries and spawn helpers are unpacked from ASAR. Windows uses node-pty’s bundled ConPTY DLL so shutdown does not depend on a Node subprocess (the RunAsNode fuse is disabled).

Keep Electron updated and review the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) when adding capabilities. Contributor instructions are in [AGENTS.md](AGENTS.md).

### Dependency maintenance

The full `npm run audit` scan currently reports **zero vulnerabilities**, including development dependencies. It runs as a required CI job before packaging. A registry failure also fails that job; advisories are not suppressed. This scan does not replace monitoring Electron's Chromium and Node.js security updates.

Forge CLI, ZIP maker, and fuses plugin are pinned together at 8.0.1, with `@electron/fuses` 2.1.3 to satisfy the plugin peer requirement. Forge 8 removes the vulnerable `braces` and `http-cache-semantics` dependency chains that blocked the audit gate. Its maintained rebuild and Packager dependencies also replace the older chains, so the previous rebuild, ZIP-extractor, and temporary-file overrides are no longer needed.

Validate clean installs, real Electron tests, packaging, and packaged smoke tests when updating Forge. The Electron tests exercise the native node-pty addon, and Forge rebuilds it for the target Electron version during startup and packaging. The three-platform CI matrix checks the resulting artifacts with sandboxing and application fuses enabled.

Vitest and its V8 coverage provider are updated together to 5.0.2. TypeScript 6 matches typescript-eslint's supported range, and Node types match Node 24. Use Node 24 LTS (`nvm use`); Vitest 5 does not support Node 25.

Sources: [Forge 8.0.1 release notes](https://github.com/electron/forge/releases/tag/v8.0.1), [Electron's maintained ZIP extractor](https://github.com/electron/extract-zip), and the installed packages' peer/engine requirements.

## License

Foom is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for project attribution. Third-party dependencies and bundled fonts retain their respective licenses and notices.
