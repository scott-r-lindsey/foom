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

## Cross-platform CI measurements

Evidence: [Linux/Windows run](https://github.com/scott-r-lindsey/foom/actions/runs/42794596114)
at `ebac6244`, and [macOS run](https://github.com/scott-r-lindsey/foom/actions/runs/42790479921)
at `901bc64c`. Engine, schema and timed workload code are identical; intervening
changes fix dependency installation and SEA extraction cleanup. Each run retains
`data-spike-<os>` JSON artifacts for three days. [PR #1171](https://github.com/scott-r-lindsey/foom/pull/1171)
links final-head verification and check results. These are dated measurements,
not a claim that one engine is always faster or that the fixtures are a migrated
Foom app/daemon.

Both engines passed all four runtime modes and integrity assertions on all three
platforms in the linked spike runs. Times below are milliseconds: one open/check
and the median of 30 writes, post-commit change reads and 10k-row lists. Raw
artifacts retain p95 and complete runtime versions.

| Platform | Runtime | Engine | Open + check | Write | Write → changes | 10k list |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Linux x64 | Node | node:sqlite | 1.066 | 0.099 | 0.154 | 4.495 |
| Linux x64 | Node | better-sqlite3 | 1.371 | 0.130 | 0.198 | 5.353 |
| Linux x64 | foom-host SEA | node:sqlite | 1.052 | 0.105 | 0.161 | 4.386 |
| Linux x64 | foom-host SEA | better-sqlite3 | 1.395 | 0.135 | 0.204 | 5.285 |
| Linux x64 | Electron main | node:sqlite | 1.134 | 0.127 | 0.176 | 5.099 |
| Linux x64 | Electron main | better-sqlite3 | 1.570 | 0.164 | 0.223 | 4.316 |
| Linux x64 | Packaged ASAR | node:sqlite | 1.116 | 0.129 | 0.178 | 5.002 |
| Linux x64 | Packaged ASAR | better-sqlite3 | 1.284 | 0.134 | 0.190 | 4.255 |
| macOS arm64 | Node | node:sqlite | 0.955 | 0.207 | 0.246 | 5.428 |
| macOS arm64 | Node | better-sqlite3 | 2.949 | 0.353 | 0.453 | 5.243 |
| macOS arm64 | foom-host SEA | node:sqlite | 0.974 | 0.160 | 0.203 | 4.309 |
| macOS arm64 | foom-host SEA | better-sqlite3 | 1.346 | 0.174 | 0.218 | 3.672 |
| macOS arm64 | Electron main | node:sqlite | 3.790 | 0.279 | 0.378 | 6.002 |
| macOS arm64 | Electron main | better-sqlite3 | 1.449 | 0.205 | 0.253 | 3.580 |
| macOS arm64 | Packaged ASAR | node:sqlite | 2.143 | 0.173 | 0.236 | 5.231 |
| macOS arm64 | Packaged ASAR | better-sqlite3 | 3.425 | 0.206 | 0.271 | 4.018 |
| Windows x64 | Node | node:sqlite | 1.410 | 0.172 | 0.221 | 5.088 |
| Windows x64 | Node | better-sqlite3 | 1.920 | 0.161 | 0.233 | 5.048 |
| Windows x64 | foom-host SEA | node:sqlite | 1.537 | 0.165 | 0.214 | 5.293 |
| Windows x64 | foom-host SEA | better-sqlite3 | 2.464 | 0.163 | 0.229 | 5.311 |
| Windows x64 | Electron main | node:sqlite | 1.379 | 0.140 | 0.186 | 4.825 |
| Windows x64 | Electron main | better-sqlite3 | 1.789 | 0.138 | 0.196 | 4.176 |
| Windows x64 | Packaged ASAR | node:sqlite | 1.411 | 0.149 | 0.197 | 4.752 |
| Windows x64 | Packaged ASAR | better-sqlite3 | 2.185 | 0.151 | 0.243 | 4.348 |

| Platform | Engine | Minified JS | Native payload | Combined gzip |
| --- | --- | ---: | ---: | ---: |
| Linux x64 | node-sqlite | 112,134 B | 0 B | 31,738 B |
| Linux x64 | better-sqlite3 | 127,528 B | 2,226,168 B | 1,164,708 B |
| macOS arm64 | node-sqlite | 112,134 B | 0 B | 31,738 B |
| macOS arm64 | better-sqlite3 | 127,528 B | 1,980,736 B | 1,029,375 B |
| Windows x64 | node-sqlite | 112,134 B | 0 B | 31,738 B |
| Windows x64 | better-sqlite3 | 127,528 B | 1,989,632 B | 1,104,087 B |

| Platform | ASAR | Unpacked native addon | Signing |
| --- | ---: | ---: | --- |
| Linux x64 | 294,050 B | 2,226,168 B | unsigned fixture |
| macOS arm64 | 294,050 B | 1,980,736 B | ad-hoc app and SEA verified; no notarization claim |
| Windows x64 | 293,205 B | 1,989,632 B | unsigned fixture |

Across all three CI platforms, Node/SEA used Node 24.22.1 (module ABI 137)
and Electron 44.9.3 embedded Node 24.22.0 (ABI 149). N-API was 10 and SQLite
was 3.53.4 for both engines in every mode. The platform N-API prebuild needed
no Electron rebuild. Built-in SQLite needed no native unpacking, extraction or
signing changes. Foom’s existing production unpack list does not include
better-sqlite3; promoting the fallback would require an explicit unpack/signing
policy. The dedicated fixture supplies that unpack rule without changing Foom.

Windows requires parent-owned deletion of the SEA native extraction after child
exit. Linux and macOS also use that deterministic cleanup order. macOS app and
SEA signatures were verified ad-hoc; Developer ID/notarization and signed Windows
distribution remain outside this proof. Node.js and Electron are MIT-licensed;
production notices must be updated when dependencies are promoted in phase C.

### Installation and cleanup findings

The first Windows CI attempt exposed pnpm invoking an implicit node-gyp lifecycle
build despite better-sqlite3's `gypfile: false`. Its binding.gyp no-op prebuild
target still required Visual Studio discovery and failed on the runner's VS 18.
The spike explicitly disables that unnecessary lifecycle build and loads the
shipped prebuild in every runtime fixture. Production build policy is unchanged.

The next Windows attempt completed both engines' Node and SEA measurements,
then exposed the loaded-DLL lifetime rule: the SEA cannot delete its extracted
native addon before exiting. Extraction cleanup is therefore parent-owned and
runs only after child exit. The subsequent Windows run passed all four modes.
No retry or deadline change was needed. Postject reported the copied Node vendor
signature as invalid during Windows injection; the SEA is an unsigned fixture,
not proof of a signed Windows distribution.
