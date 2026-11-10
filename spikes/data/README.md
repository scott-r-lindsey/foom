# Data architecture A (#1160)

Isolated comparison, not application code. Foom does not import this package,
depend on these engines, or write a production database. Use Node 24 and the
repository-pinned pnpm. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir spikes/data install --frozen-lockfile
pnpm exec tsc -p spikes/data/tsconfig.json
pnpm run audit
pnpm --dir spikes/data run audit
node spikes/data/prepare.mjs
xvfb-run -a node spikes/data/run.mjs
```

Omit `xvfb-run -a` on macOS and Windows. On a shared development machine, put the
last command through the orchestrator's heavy-command lock. The separate
preparation command downloads/verifies the pinned Electron ZIP and installs it;
the runner requires that prepared ZIP and performs no network requests,
agent discovery, SSH or access to ordinary Foom profiles. Electron receives an
explicit scratch `--user-data-dir`; it creates no windows. Sandboxing stays enabled.

`schema.ts` is the Drizzle schema. `pnpm --dir spikes/data run generate` generated
the checked-in migration and snapshot. rc.5 has no STRICT table option: the
reviewed migration appends `STRICT` and explicit NOT NULL text primary keys, and
adds change triggers (except `_changes` itself). Preserve these additions when
generating future migrations. The runner applies the generated SQL in a Drizzle
transaction, sets `user_version`, checks the deployed schema, then reopens it.
This minimal spike migration runner is not the phase-C production migrator.

`measure.ts` uses native Drizzle drivers and the same schema/workload for both
engines. It asserts FK readback on every open, all three referenced-parent delete
failures, orphan rejection, STRICT/CHECK rejection, rollback with no changes,
trigger coverage, raw SQL notifications and a post-commit change read. It seeds
10,000 sessions in a transaction, then measures 30 single-row committed writes
and full 10,000-row ordered, filtered lists, reporting median and p95. There is
one timed reopen/schema/FK check; OS page caches are not flushed. Module imports,
Electron launch, migration and seeding are outside that timing. No hard performance
threshold is inferred from shared-machine results.

`run.mjs` bundles and runs the comparison in Node, a spike-only `foom-host` SEA
variant (same Node 24/postject/asset recipe as `scripts/build-remote-host.mjs`,
benchmark entry in place of the daemon), Electron 44 main and a dedicated packaged
Electron fixture. The fixture has ASAR integrity and the production RunAsNode,
NodeOptions and inspector fuses disabled. It exercises SQLite from the archived
main bundle; the fallback native payload is explicitly unpacked. macOS signs and
verifies the app and SEA ad-hoc. This does not exercise remote daemon protocol,
real SSH, Developer ID signing or notarization. Windows SEA is comparison evidence;
Foom's remote host product remains Linux/macOS only.

better-sqlite3 13 ships N-API prebuilds: no rebuild is required for the tested
targets. The isolated package explicitly ignores its implicit lifecycle build:
pnpm otherwise invokes node-gyp despite `gypfile: false`, and node-gyp initializes
Visual Studio discovery on Windows even when binding.gyp selects a no-op prebuild
target. All fixtures load the shipped platform prebuild explicitly, so an absent
or incompatible prebuild fails the spike. This does not change Foom's production
build-script allowlist. The SEA embeds the selected prebuild and its SHA-256, verifies it before
loading a private temporary extraction, and removes it afterward. The built-in
engine needs no asset/extraction. Both versions/ABIs and SQLite versions are in
each JSON report. Cross-platform proof uses the same three-target
`Data architecture spike` workflow, without changing the existing Quality gate.

Reports survive under ignored `test-results/data-spike/`; large scratch apps,
database files and SEA build files are removed in `finally`. CI uploads the JSON
even when a later fixture fails. Bundle sizes measure minified Drizzle + schema +
engine JS plus the selected native prebuild, both raw and gzip, independently of
the benchmark harness. They are incremental payload estimates, not installer-size
deltas. The combined fixture also records actual ASAR and unpacked-addon sizes.

Pinned licences: Drizzle ORM and Kit Apache-2.0; better-sqlite3 MIT, bundled SQLite
public domain; node-addon-api MIT. The isolated esbuild override to 0.28.2 avoids
the older Kit tooling dependency and matches Foom's audited compiler. Both
`pnpm run audit` and the isolated package's audit include development tooling.

See [the decision and findings](../../docs/research/data-spike.md) and
[the target architecture](../../docs/areas/data.md).
