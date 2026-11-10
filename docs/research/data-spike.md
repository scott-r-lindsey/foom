# SQLite / Drizzle phase-A evidence (#1160)

## Decision

Use `node:sqlite` with Drizzle's native adapter. The built-in engine passes the
integrity and workload assertions without a native dependency, ASAR unpack rule
or SEA asset. Keep better-sqlite3 as fallback; no Kysely fallback is needed.
MikroORM was not evaluated. Production stores remain unchanged.

The [official native driver documentation](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite)
requires Drizzle RC. The spike pins ORM and Kit **1.0.0-rc.5**, better-sqlite3
**13.0.3** and Electron **44.9.3**. The installed declarations confirm stable-style
`sqliteTable` has no STRICT option in this version; generated SQL is reviewed to
add STRICT and change triggers. Phase C must preserve those SQL additions and
revalidate the pinned adapter. ORM and Kit are Apache-2.0; better-sqlite3 and
node-addon-api are MIT; SQLite is public domain. Root and isolated-package audits
reported no known vulnerabilities, including dev tooling.

## Local Linux x64 measurement

One run on the shared development host, 2026-11-10. Times are milliseconds;
writes/change reads/lists show the median of 30 operations. JSON also retains p95.
Cold open is a single connection reopen plus pragmas/schema/FK checks against an
existing 10k-row database, with warm OS file caches. It is not process cold-start.
Write-to-changes includes commit and the subsequent `_changes` read, not IPC.

| Runtime | Engine | Open + check | Write | Write → changes | 10k list |
| --- | --- | ---: | ---: | ---: | ---: |
| Node 24.17.0 | node:sqlite | 0.934 | 0.161 | 0.217 | 4.351 |
| Node 24.17.0 | better-sqlite3 | 1.448 | 0.150 | 0.204 | 3.470 |
| foom-host SEA variant | node:sqlite | 0.713 | 0.133 | 0.171 | 2.926 |
| foom-host SEA variant | better-sqlite3 | 1.016 | 0.176 | 0.222 | 3.837 |
| Electron 44 main | node:sqlite | 0.655 | 0.142 | 0.187 | 3.732 |
| Electron 44 main | better-sqlite3 | 1.075 | 0.171 | 0.215 | 2.698 |
| Packaged ASAR fixture | node:sqlite | 0.984 | 0.128 | 0.171 | 3.234 |
| Packaged ASAR fixture | better-sqlite3 | 0.823 | 0.218 | 0.285 | 4.068 |

| Engine | Incremental minified JS | Native payload | Combined gzip |
| --- | ---: | ---: | ---: |
| node:sqlite + Drizzle/schema | 112,134 B | 0 B | 31,738 B |
| better-sqlite3 + Drizzle/schema | 127,528 B | 2,226,168 B | 1,164,708 B |

These measure driver/schema payloads, not total installer deltas. The combined
fixture's actual ASAR is 294,050 B, plus the 2,226,168 B unpacked native addon.
No spike dependencies or assets enter production packages.

All four runtime modes passed STRICT and CHECK enforcement, asserted
`foreign_keys=1`, every FK referenced-parent deletion failure (including hosts),
orphan rejection, trigger coverage, raw SQL invalidation, rollback without log
entries and reopening with schema version intact.

## Packaging, ASAR, ABI and signing

Node/SEA used module ABI 137 and N-API 10 locally; Electron 44.9.3 embeds Node
24.22.0, ABI 149, N-API 10. Built-in SQLite was 3.53.0 in local Node/SEA and
3.53.4 in Electron. better-sqlite3 bundled SQLite 3.53.4 everywhere.

Unlike older better-sqlite3 versions, version 13 uses N-API. Its exact same
platform prebuild loaded in Node, SEA and Electron with no rebuild despite the
different module ABI. It still adds a native binary to unpack/sign; SEA needs
private verified extraction and a filesystem native loader. node:sqlite adds
neither. The packaged fixture runs the benchmark from ASAR with hardened fuses;
it is a dedicated fixture app, not a migrated Foom app. The SEA uses foom-host's
build shape with a benchmark entry; it does not change or run remote state.
These boundaries are deliberate phase-A isolation, not proof of a production
importer or notification channel.

## Cross-platform CI

The `Data architecture spike` workflow runs both engines in all four modes on
Linux x64, macOS arm64 and Windows x64, retaining per-engine timing, payload sizes,
runtime/ABI/SQLite versions and assertion results in `data-spike-<os>` artifacts.
macOS also ad-hoc signs and verifies the packaged app and SEA; no Developer ID or
notarization claim is made. Windows fixtures are unsigned. Existing Foom native
packaging CI remains independent.

CI results will be recorded here after the first draft PR run. Local evidence
alone establishes Linux support only.

The first Windows CI attempt exposed pnpm invoking an implicit node-gyp lifecycle
build despite better-sqlite3's `gypfile: false`. Its binding.gyp no-op prebuild
target still required Visual Studio discovery and failed on the runner's VS 18.
The spike explicitly disables that unnecessary lifecycle build and loads the
shipped prebuild in every runtime fixture. Production build policy is unchanged.

The next Windows attempt completed both engines' Node and SEA measurements,
then exposed the loaded-DLL lifetime rule: the SEA cannot delete its extracted
native addon before exiting. Extraction cleanup is therefore parent-owned and
runs only after child exit. No retry or deadline change is needed.
