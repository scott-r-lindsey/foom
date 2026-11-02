# Development guide

Start with the [documentation map](README.md) and follow the mandatory contributor
workflow in [AGENTS.md](../AGENTS.md). This guide explains the local tooling;
AGENTS.md owns required validation and delivery policy.

## Installation and native dependencies

The package manager is pinned in `package.json`. `.npmrc` keeps a hoisted layout for Electron Forge and native addons, with hardlinks to pnpm’s shared content-addressed store on the same filesystem. Only Electron, esbuild, and node-pty may run dependency build scripts. Side-effect caching stays disabled because Forge rebuilds native modules for Electron. Use `pnpm store path` to locate the shared store; generated binaries still occupy space in each worktree.

`node-pty` is a native dependency. The build corrects executable permissions on its macOS prebuilt spawn helper to work around [node-pty #850](https://github.com/microsoft/node-pty/issues/850). If a prebuilt binary is unavailable, installation/rebuild requires Python and a C++ toolchain (Xcode command line tools on macOS, build-essential on Linux, Visual Studio C++ build tools on Windows).

## How TypeScript fits into Electron

Electron runs JavaScript compiled from your TypeScript. `pnpm start`, `pnpm run test:electron`, `pnpm run package`, and `pnpm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git.

Packaging commands delegate to Forge, whose mandatory `prePackage` hook performs one fresh production build. Direct `pnpm exec electron-forge package` and `pnpm exec electron-forge make` use the same hook. Local packages can omit unavailable remote hosts with a warning; CI and explicit
`FOOM_REQUIRE_REMOTE_HOSTS=1` builds require the complete verified catalog (see
[validation](validation.md#bundled-remote-host-artifacts-825)).

For a development build with remote hosts on Linux or macOS, run
`pnpm run start:hosts`. It reuses `.cache/remote-hosts/` when all four targets
verify against the package version and `HEAD`; otherwise it uses authenticated
GitHub CLI (`gh`) to find the successful `ci.yml` push run on `main` for that exact
commit and download its four `remote-host-<target>` artifacts (retained three days).
All four must verify before the cache is replaced. Missing `gh`, authentication,
a matching successful run, expired artifacts or invalid downloads produce a
one-line reason and continue without hosts, preserving the previous cache.
Local commits and branches usually have no matching main push run.
The wrapper runs normal `pnpm start` with `FOOM_REMOTE_HOST_ARTIFACTS` pointing to
the cache, uses the persistent **Foom Dev** profile, and forwards extra arguments
and the exit status. It does not pull, install dependencies or change Git state.
To download and verify without launching a window, run:

```sh
node --input-type=module -e 'import { prepareHosts } from "./scripts/start-hosts.mjs"; await prepareHosts(process.cwd())'
```

A previous `pnpm run start:samples` build is replaced before packaging, so its development sample data cannot ship.

The build also writes the app icon set to `build/icons/` from the generator in
`scripts/icon/` (see [brand: mark](brand.md#mark)). The first build for a given
generator source renders it in a few seconds; later builds copy the set from the
Git-ignored `.cache/foom-icons/`. Each cache entry is published atomically with a
manifest of file sizes and SHA-256 digests; an entry with a missing, extra or
changed file, or a missing or invalid manifest, is discarded and rendered again. It stays outside `node_modules`, which the
Electron build fingerprint hashes before and after each build. Forge's
`prePackage` build runs before the packager and makers read their icon paths,
so no generated image is committed.
The packager embeds `foom.icns` in the macOS bundle and `foom.ico` in
`Foom.exe`, and Squirrel uses `foom.ico` for Setup.exe. The deb and rpm install
`foom-512.png` as `/usr/share/pixmaps/foom.png` for the desktop entry's
`Icon=foom`; Linux windows load the same file from the archive. The DMG carries
the icon inside `Foom.app`; a custom volume icon would need macOS-only tools, so
the volume keeps the default. Squirrel's `iconUrl` (the Apps & features icon)
needs a hosted image and is unset.

See [architecture: process model](architecture.md#process-model) for ownership and
security boundaries and the [source layout](architecture.md#source-layout) for directories
and import rules.

Main, host, and preload compile to CommonJS. esbuild bundles the renderer and xterm CSS for the browser. The build bundles the ordered feature styles in `src/renderer/styles/styles.css` and copies the tokens into `build/renderer/`, retaining the existing asset URLs and allowlist. Compiler environments remain separate. TypeScript 6 is pinned for compatibility with the installed TypeScript tooling.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm run check` | Formatting, documentation integrity, lint, all type checks, unit tests and CI-policy tests; also the pre-commit check |
| `pnpm run docs:check` | Check tracked Markdown local links/anchors and complete source-to-feature map coverage without network requests |
| `pnpm run format` | Apply Biome formatting |
| `pnpm run format:check` | Check formatting without changing files |
| `pnpm run lint` / `pnpm run lint:fix` | Type-aware Oxlint checks / safe autofixes |
| `pnpm run audit` | Scan the full dependency tree, including development tools; fail on any reported vulnerability |
| `pnpm run typecheck` | Check application, tests, and Vitest configuration without emitting files |
| `pnpm test` / `pnpm run test:watch` | Run Vitest once / in watch mode, without a desktop display |
| `pnpm run test:coverage` | Enforce per-file coverage and write HTML, LCOV, JSON, and terminal reports |
| `pnpm run test:electron` | Build and launch the real Electron feature suites |
| `pnpm run build` | Compile application code, bundle xterm, and copy assets |
| `pnpm run package` / `pnpm run make` | Create an executable application / native installers and ZIP |

Biome owns formatting, and Oxlint owns lint rules. Strict TypeScript includes checked indexed access, exact optional properties, explicit overrides, and unused-code checks. Oxlint uses type information to catch unsafe values and mishandled promises. Generated output, `inspiration/` references and `spikes/` prototypes are excluded from application checks and packaging.

## Dependency maintenance

The full `pnpm run audit` scan includes development dependencies and fails on any reported vulnerability. It runs in the required static-checks job alongside desktop validation. A registry failure also fails that job; advisories are not suppressed. This scan does not replace monitoring Electron's Chromium and Node.js security updates.

Forge CLI, installer/ZIP makers, GitHub publisher, and fuses plugin are pinned together at 8.0.1, with `@electron/fuses` 2.1.3 to satisfy the plugin peer requirement. Forge 8 removes the vulnerable `braces` and `http-cache-semantics` dependency chains that blocked the audit gate. Its maintained rebuild and Packager dependencies also replace the older chains, so the previous rebuild, ZIP-extractor, and temporary-file overrides are no longer needed.

Validate clean installs, real Electron tests, packaging, and packaged smoke tests when updating Forge. The Electron tests exercise the native node-pty addon, and Forge rebuilds it for the target Electron version during startup and packaging. The three-platform CI matrix checks the resulting artifacts with sandboxing and application fuses enabled.

Vitest and its V8 coverage provider are pinned together at 5.0.5. TypeScript 6 remains the compiler; Oxlint’s pinned Go backend supplies type-aware linting independently. Node types match Node 24. Use Node 24 LTS (`nvm use`); Vitest 5 does not support Node 25.

Sources: [Forge 8.0.1 release notes](https://github.com/electron/forge/releases/tag/v8.0.1), [Electron's maintained ZIP extractor](https://github.com/electron/extract-zip), and the installed packages' peer/engine requirements.

## Focused local validation

The required pre-commit/pre-push gate remains `pnpm run check`: complete, uncached,
sequential validation. Runtime/build/tooling changes also require the coverage,
Electron, make, packaged-smoke and cleanup checks in [AGENTS.md](../AGENTS.md). Focused feedback
and local cache hits do not replace those gates.

On Linux, run a named Electron test through the supported wrapper:

```sh
xvfb-run -a pnpm run test:electron --test-name-pattern='^agent discovery uses the fixture login shell and controlled PATH$'
xvfb-run -a pnpm run test:electron --reuse-build --test-name-pattern='^agent discovery uses the fixture login shell and controlled PATH$'
```

The first command builds by default. `--reuse-build` requires a successful build
receipt from this wrapper and verifies the current source, build scripts, compiler
configuration, installed dependency bytes and build output. Missing/changed inputs
or output fail; rerun without `--reuse-build`. A standalone build (including a
sample build) does not create a receipt. Do not edit inputs during validation.

Both `--test-name-pattern=REGEX` and `--test-name-pattern REGEX` work. The wrapper
forwards these Node options **before** all discovered feature suite paths. Unknown
options, malformed/empty patterns, and filters with no passing selected tests fail.
The summary reports the executed count; merely loading an empty suite is not a
passing focused check. `FOOM_ELECTRON_SHARD` still selects the shard first: use the
shard containing the named test, or unset it for local focused work. Packaged smoke
also accepts a filter, but never `--reuse-build`.

`pnpm run lint:local` memoizes a successful **whole-project** lint only while all
inputs remain byte-identical. Any source, declaration, configuration, script or
installed dependency change invalidates the whole result; this avoids a linter’s
per-file cache missing type changes in other files. The ignored `.oxlintcache`
file can be deleted to force a miss. Reference and generated output directories
are excluded. `pnpm run lint` and `pnpm run lint:fix` remain uncached.

`pnpm run check:local` overlaps that local lint with one sequential lane of format,
documentation integrity, typecheck, unit tests and CI-policy tests. At most two stages run simultaneously;
unit/native tests never overlap CI-policy tests. Vitest uses at most four workers
(and fewer on small machines); explicit native-test serialization still wins.
Every stage finishes and failures are aggregated into a nonzero exit. Use the sequential authoritative gate on
memory-constrained machines. Local measurements and tradeoffs are recorded in the
#494 pull request; elapsed savings depend on machine load and cache state.

The macOS signer invokes `notarytool` directly with bounded polling and visible
submission progress (see [validation](validation.md)). The build dependencies
retain the `@electron/notarize` 3.1.2 pin. A transitive
`pnpm.overrides.vite` pin and explicit Vite development dependency at 8.3.3 fix GHSA-698v-4r3x-3vcv in Vitest's
Vite dependency. The explicit dependency supplies Vitest’s required peer with peer auto-installation disabled. It satisfies Vitest 5's Vite peer range; frozen installation,
`pnpm run audit` and the full check/coverage runs validate the override.

Scoped transitive overrides address minimatch
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) and glob
[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) while
the latest ASAR and Forge installer parents still request vulnerable versions.
ASAR uses glob 14.0.3 and minimatch 11.0.3, retaining its named async `glob` and
`minimatch` calls. `electron-installer-common` and `electron-winstaller` use ASAR 4.3.1; their synchronous
`extractFile` call remains available through Node 24's `require(esm)` support.
The typescript-estree override retains its named `minimatch` API in the
React rule plugins’ utility dependency. The removed linter’s minimatch overrides
are no longer needed.

`electron-installer-common` also uses glob 14.0.3, with a two-line
[pnpm patch](../patches/electron-installer-common@0.10.4.patch) replacing its
promisified callback imports with `require('glob').glob`. Its metadata discovery
and installer output discovery continue to await string arrays. This avoids
forcing minimatch 11 into legacy glob 7, which relies on removed private matching
fields.

The Windows installer's `temp` dependency uses rimraf 6.1.3 with glob 14.0.3. A
[second patch](../patches/temp@0.9.4.patch) adapts rimraf's named promise API with
`callbackify`, selects `rimrafSync`, and maps `maxBusyTries` to `maxRetries` to
retain six cleanup retries. Exercise temp's file and directory cleanup through
callback, promise, synchronous and process-exit paths. Validate the graph with
frozen installation and audit, fixture metadata discovery and package moves,
ASAR packing/unpacking, full lint/check and coverage, Electron tests, Linux
DEB/RPM makers and packaged smoke. Three-platform CI verifies the native paths.
Remove the patches and overrides when maintained parent releases adopt the fixes.

`electron-winstaller` is pinned directly at 5.4.4 because the Windows packaging
hook uses its bundled tools. Keeping it required also prevents pnpm's hoisted
optional-platform graph from dropping its dependencies on clean Windows
installs. Validate dependency loading with a clean Windows-target
optional-dependency install, plus the native Windows maker and smoke tests.
Its lifecycle script stays disabled; Forge selects the bundled host 7-Zip files.

## Website product screenshots (#582)

On Linux with `xvfb-run` installed, run:

```sh
pnpm run start:samples --screenshots
```

The command builds the explicit sample board, then always creates its own Xvfb
display, even when launched from a desktop or an existing virtual display. It
writes six PNGs to ignored `test-results/screenshots-582/`: `eclipse-dark-{board,sidebar,needs-you}.png`
and `eclipse-light-{board,sidebar,needs-you}.png`. Reruns overwrite those six files.
Do not commit the images; keep the PR draft for human visual approval before
copying approved images to the website.

The full board has four tiles (Working, Done, Needs you and Failed); the sidebar
also includes Quiet and shell samples; the extra launchpad group is collapsed so
every state fits without scrolling. The Needs you crop includes the verdict's
reason and the synthetic approval prompt. These are the application's sample
rows and read-only terminal text, never a real agent screen. Separate disposable
homes, profiles, and three fixture Git repositories are created for each theme
and removed after the app quits. The existing Electron harness controls the login
shell and PATH, guards agent/forge CLI probes, audits processes and mutes audio.
No real agent CLI or user configuration is used. The shared launch guard verifies
that the display belongs to the capture's Xvfb wrapper and explicitly forces X11,
even when invoked from a Wayland session.

The capture entry point owns one temporary root containing every home, profile,
fixture and Xvfb authority directory. SIGINT, SIGTERM and SIGHUP terminate the
runner and detached app process groups, remove that root, and exit with the
signal's conventional code (130, 143 or 129). Normal completion removes it too.
To check existing images without overwriting them, run
`FOOM_COMPARE_PRODUCT_SHOTS=1 pnpm run start:samples --screenshots`; a changed or
missing image fails comparison.

Captures use a 1440 × 900 content area at device scale 1 and interface size 100%,
bundled fonts, a fixed clock, a fixed four-tile layout, reduced motion and a
settled activity history. Each shot is captured twice and must match byte
for byte before it is written. For cross-run comparisons use the same Linux,
Electron and font environment; rasterization may differ across systems. Normal
`pnpm run start:samples` still opens the interactive development sample board.
Packaging always rebuilds without samples.

## Profiling main-process CPU

The [owned-child CPU recipe](research/main-cpu-789.md) runs ten modest-output
fixture children and orchestrator polling in a disposable Xvfb application.
It captures main-process inspector stacks and steady-state process CPU without
real agent CLIs. Run captures through the shared heavy-command lock when sharing
a development machine; retain raw evidence only in ignored `test-results/`.

## Oxlint gate and migration (#981)

Oxlint 1.90.0 is the only lint runner; oxlint-tsgolint 7.0.2005 supplies its
native type-aware rules. `.oxlintrc.json` enables type awareness for ordinary CLI
and editor use as well as the package scripts. `lint`, `lint:fix`, `lint:local`,
the pre-commit check and CI all deny warnings. Unused disable directives retain
the former implicit warning through an explicit root option, so stale
suppressions also fail the gate. Biome remains the formatter.
The React and Hook rule packages run unchanged through Oxlint's JavaScript
plugin API, alongside `foom/process-boundaries`. No ESLint engine, parser,
configuration or fallback pass is installed. Peer auto-installation is disabled
so those plugins' unused engine peer cannot reinstall it; required peers remain
explicit project dependencies. Only that unused peer is ignored.

The inventory is frozen in `scripts/lint-rule-inventory.json`: 221 formerly
enabled rules, including 68 core, 71 TypeScript, 16 Hook, 65 React and one process
boundary rule. Explicit settings preserve their severities and options instead
of relying on Oxlint's evolving category defaults. The TypeScript aliases for
unused variables, unused expressions, array constructors and useless
constructors use the TypeScript-aware native core implementations. The empty
`errorClassNames` option of `preserve-caught-error` uses its equivalent native
default; its cause-preservation behavior has an invalid/valid fixture.
`strict-boolean-expressions` was not enabled by the former strict preset and is
not silently added or counted as a preserved rule.

Core rules cover `.js`, `.mjs` and `.cjs`, including both CommonJS packaging
modules (`scripts/maker-dmg.cjs` and `scripts/package-conpty.cjs`). Both are
representatives in the rule inventory. A production-config regression fixture
requires an undefined helper and a debugger statement in `.cjs` to fail lint,
while its valid CommonJS counterpart passes. CommonJS retains its original
globals and unused-argument defaults rather than inheriting the broader Node
globals and underscore-argument exception used for `.js` and `.mjs`.

The user explicitly accepted these two gaps in #981:

| Former rule | Remaining gap | Rationale |
| --- | --- | --- |
| `no-dupe-args` | Duplicate parameters in sloppy-mode CommonJS `tests/**/*.js` | TypeScript's compiler and strict ESM parsing reject them elsewhere. |
| `no-octal` | Legacy octal literals in sloppy-mode CommonJS `tests/**/*.js` | TypeScript and strict ESM parsing reject them elsewhere; explicit `0o` literals remain valid. |

Forge's CommonJS configuration and both `.cjs` packaging modules have explicit
`use strict` directives, keeping this exception confined to tests. No workaround rule or lint suppression hides
these gaps. Syntax/parser fixtures exercise the accepted sloppy-JS behavior and
strict-module rejection. The native safety corpus checks invalid and valid
programs, including unsafe values, promises, enum assignments, conditions,
strict operand options, type-only imports and the TypeScript-aware core aliases.
The original 32 boundary cases run under Oxlint's own RuleTester. A warning-only
JavaScript-plugin fixture verifies that `--deny-warnings` fails the gate.
These are regression certificates for the tested behaviors and pinned settings,
not a claim of exhaustive equivalence between two independent implementations.

`pnpm run lint:benchmark` measures separate fresh-process syntax and type-aware
runs with identical rule/plugin settings and warnings denied; syntax timing is
not a substitute for the type-aware gate. It creates and removes a temporary
config beside the real config so ignores and plugin paths remain identical.
This optional local command does not run in CI. Local and CI measurements are
recorded in the #981 PR body; OS caches are not flushed, and
shared-machine/runner variation limits comparisons.
