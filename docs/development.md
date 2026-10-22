# Development guide

Start with the [documentation map](README.md) and follow the mandatory contributor
workflow in [AGENTS.md](../AGENTS.md). This guide explains the local tooling;
AGENTS.md owns required validation and delivery policy.

## Installation and native dependencies

The package manager is pinned in `package.json`. `.npmrc` keeps a hoisted layout for Electron Forge and native addons, with hardlinks to pnpm’s shared content-addressed store on the same filesystem. Only Electron, esbuild, and node-pty may run dependency build scripts. Side-effect caching stays disabled because Forge rebuilds native modules for Electron. Use `pnpm store path` to locate the shared store; generated binaries still occupy space in each worktree.

`node-pty` is a native dependency. The build corrects executable permissions on its macOS prebuilt spawn helper to work around [node-pty #850](https://github.com/microsoft/node-pty/issues/850). If a prebuilt binary is unavailable, installation/rebuild requires Python and a C++ toolchain (Xcode command line tools on macOS, build-essential on Linux, Visual Studio C++ build tools on Windows).

## How TypeScript fits into Electron

Electron runs JavaScript compiled from your TypeScript. `pnpm start`, `pnpm run test:electron`, `pnpm run package`, and `pnpm run make` compile automatically. Edit files in `src/`; `build/` is generated and ignored by Git.

Packaging commands delegate to Forge, whose mandatory `prePackage` hook performs one fresh production build. Direct `pnpm exec electron-forge package` and `pnpm exec electron-forge make` use the same hook. A previous `pnpm run start:samples` build is replaced before packaging, so its development sample data cannot ship.

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

Main, host, and preload compile to CommonJS. esbuild bundles the renderer and xterm CSS for the browser. The build bundles the ordered feature styles in `src/renderer/styles/styles.css` and copies the tokens into `build/renderer/`, retaining the existing asset URLs and allowlist. Compiler environments remain separate. TypeScript 6 is pinned for compatibility with the installed TypeScript ESLint tooling.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `pnpm run check` | Formatting, lint, all type checks, unit tests and CI-policy tests; also the pre-commit check |
| `pnpm run format` | Apply Biome formatting |
| `pnpm run format:check` | Check formatting without changing files |
| `pnpm run lint` / `pnpm run lint:fix` | Type-aware ESLint checks / safe autofixes |
| `pnpm run audit` | Scan the full dependency tree, including development tools; fail on any reported vulnerability |
| `pnpm run typecheck` | Check application, tests, and Vitest configuration without emitting files |
| `pnpm test` / `pnpm run test:watch` | Run Vitest once / in watch mode, without a desktop display |
| `pnpm run test:coverage` | Enforce per-file coverage and write HTML, LCOV, JSON, and terminal reports |
| `pnpm run test:electron` | Build and launch the real Electron feature suites |
| `pnpm run build` | Compile application code, bundle xterm, and copy assets |
| `pnpm run package` / `pnpm run make` | Create an executable application / native installers and ZIP |

Biome owns formatting, and ESLint owns lint rules. Strict TypeScript includes checked indexed access, exact optional properties, explicit overrides, and unused-code checks. ESLint uses type information to catch unsafe values and mishandled promises. Generated output, `inspiration/` references and `spikes/` prototypes are excluded from application checks and packaging.

## Dependency maintenance

The full `pnpm run audit` scan includes development dependencies and fails on any reported vulnerability. It runs in the required static-checks job alongside desktop validation. A registry failure also fails that job; advisories are not suppressed. This scan does not replace monitoring Electron's Chromium and Node.js security updates.

Forge CLI, installer/ZIP makers, GitHub publisher, and fuses plugin are pinned together at 8.0.1, with `@electron/fuses` 2.1.3 to satisfy the plugin peer requirement. Forge 8 removes the vulnerable `braces` and `http-cache-semantics` dependency chains that blocked the audit gate. Its maintained rebuild and Packager dependencies also replace the older chains, so the previous rebuild, ZIP-extractor, and temporary-file overrides are no longer needed.

Validate clean installs, real Electron tests, packaging, and packaged smoke tests when updating Forge. The Electron tests exercise the native node-pty addon, and Forge rebuilds it for the target Electron version during startup and packaging. The three-platform CI matrix checks the resulting artifacts with sandboxing and application fuses enabled.

Vitest and its V8 coverage provider are updated together to 5.0.2. TypeScript 6 matches typescript-eslint's supported range, and Node types match Node 24. Use Node 24 LTS (`nvm use`); Vitest 5 does not support Node 25.

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
installed dependency change invalidates the whole result; this avoids ESLint's
per-file cache missing type changes in other files. The ignored `.eslintcache`
file can be deleted to force a miss. Reference and generated output directories
are excluded. `pnpm run lint` and `pnpm run lint:fix` remain uncached.

`pnpm run check:local` overlaps that local lint with one sequential lane of format,
typecheck, unit tests and CI-policy tests. At most two stages run simultaneously;
unit/native tests never overlap CI-policy tests. Vitest uses at most four workers
(and fewer on small machines); explicit native-test serialization still wins.
Every stage finishes and failures are aggregated into a nonzero exit. Use the sequential authoritative gate on
memory-constrained machines. Local measurements and tradeoffs are recorded in the
#494 pull request; elapsed savings depend on machine load and cache state.

The macOS signer invokes `notarytool` directly with bounded polling and visible
submission progress (see [validation](validation.md)). The build dependencies
retain the `@electron/notarize` 3.1.2 pin. A transitive
`pnpm.overrides.vite` pin to 8.3.3 fixes GHSA-698v-4r3x-3vcv in Vitest's
Vite dependency. It satisfies Vitest 5's Vite peer range; frozen installation,
`pnpm run audit` and the full check/coverage runs validate the override.

`electron-winstaller` is pinned directly at 5.4.4 because the Windows packaging
hook uses its bundled tools. Keeping it required also prevents pnpm's hoisted
optional-platform graph from dropping its legacy glob dependency on clean
Windows installs. Validate dependency loading with a clean Windows-target
optional-dependency install, plus the native Windows maker and smoke tests.
Its lifecycle script stays disabled; Forge selects the bundled host 7-Zip files.
