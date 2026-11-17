# Connector module initialization follow-up (#1098)

PR #1172 removed an unused connector executable hash. Its remaining handshake
cost was mainly SEA startup and module initialization, with socket connection
and hello processing small. This follow-up measures that remaining work using
only fixture hosts, a temporary HOME, fixture SSH pipes and fake Claude. No real
SSH, network, real agent CLI or user profile is involved.

## Reproduce

With Node 24 and the pinned dependencies installed, run each profile through the
shared host's heavy-command lock when one is supplied:

```sh
node spikes/remote-launch-costs/run.mjs
node spikes/remote-launch-costs/summarize.mjs
FOOM_COST_REVERSE=1 node spikes/remote-launch-costs/run.mjs
node spikes/remote-launch-costs/summarize.mjs test-results/1098-startup-reverse/measurements.json
```

The runner builds the production native SEA with test-only timing markers. The
baseline restores the prior static imports for daemon, discovery, agent helper,
plugin staging and recipes. Both variants retain PR #1172's removal of the unused
connector hash. Deferred imports are bundled into the same executable by esbuild;
there is no external module download or runtime source-file lookup.

Each variant starts a daemon, warms local verification as enrollment would,
then measures one forced upload and six cached launches through PTY output.
The reverse run changes the variant order. These are sequential samples on a
shared machine, not controlled page-cache or real SSH latency measurements.
Outputs stay ignored under `test-results/1098-startup{,-reverse}/`.

## Results

Linux x64, Node 24.22.1, source `efe541cdfee293af2335283cdac202b63eab4dd5`
plus this change. Executables are 127,929,536 bytes. Every sample and compressed
size is committed in [forward results](results-startup-linux-x64.json) and
[reverse results](results-startup-linux-x64-reverse.json). Each column has six
cached launches; values are median (range) in milliseconds.

| Stage | Forward eager | Forward deferred | Reverse eager | Reverse deferred |
| --- | ---: | ---: | ---: | ---: |
| Open total | 258.2 (242.9–262.9) | 237.2 (223.1–253.7) | 250.9 (248.7–263.6) | 238.4 (230.8–242.6) |
| PTY output total | 260.3 (244.6–265.3) | 239.2 (224.9–255.8) | 253.7 (249.4–265.8) | 241.2 (233.0–243.5) |
| Fixture platform preflight | 33.2 (28.7–39.6) | 32.2 (29.8–37.3) | 32.5 (27.5–37.9) | 30.5 (28.5–37.2) |
| Local verification | 45.0 (39.2–50.6) | 40.9 (37.8–41.5) | 39.5 (38.5–50.6) | 48.0 (38.0–51.3) |
| Artifact read (subset) | 25.4 (20.1–31.5) | 20.8 (17.9–21.3) | 19.6 (18.8–30.8) | 27.7 (19.1–32.1) |
| Artifact content-key hash (subset) | 19.0 (18.5–19.7) | 19.6 (19.3–20.2) | 19.3 (18.9–19.7) | 19.2 (18.5–20.0) |
| Spawn to cached bootstrap ready | 98.4 (93.2–105.1) | 97.8 (90.3–101.7) | 97.5 (94.5–104.5) | 97.7 (93.0–103.2) |
| Remote executable hash (subset) | 73.0 (68.7–74.8) | 70.7 (67.4–73.0) | 69.7 (67.9–74.1) | 73.4 (69.8–74.7) |
| Bootstrap ready to hello | 48.6 (45.8–59.8) | 41.4 (35.2–47.3) | 57.2 (47.9–64.3) | 36.7 (34.2–43.4) |
| SEA startup/modules to runHost (subset) | 46.9 (44.0–57.1) | 39.7 (32.9–44.6) | 55.5 (46.1–61.8) | 34.8 (32.5–40.9) |
| Bundled module initialization (subset) | 21.0 (16.8–25.1) | 9.9 (6.2–11.6) | 25.5 (20.2–27.9) | 6.7 (6.4–14.1) |
| Socket connect (subset) | 0.5 (0.4–0.7) | 0.5 (0.4–0.7) | 0.6 (0.4–0.7) | 0.4 (0.4–0.7) |
| Connected socket to hello (subset) | 1.1 (1.0–1.5) | 1.3 (0.9–1.6) | 1.3 (0.9–1.5) | 1.1 (1.0–1.5) |
| Fake CLI discovery (subset) | 5.2 (4.7–6.2) | 4.9 (4.6–5.1) | 4.8 (4.3–4.9) | 4.6 (4.6–5.4) |
| Preparation and PTY creation | 15.0 (11.4–18.0) | 13.0 (11.4–17.0) | 14.2 (12.2–15.0) | 13.6 (12.4–16.6) |

Intervals overlap and medians must not be summed. Bundled module initialization
is measured from a test-only banner at the beginning of bundle execution to
`runHost`; it excludes runtime startup and initial parsing before that banner.
It decreased by **11.1 ms forward and 18.8 ms reverse**, supporting the narrow
module-loading change. Ready-to-hello decreased by 7.2/20.5 ms; total cached open
by 21.0/12.5 ms (8.1%/5.0%). Other stages varied in either direction on the shared
machine, so the entire open-time difference is not attributed to imports.
The earlier exploratory pass deferred the repository helper too; its preliminary
figures are superseded by these two runs of the final implementation.

First-upload open totals were 1585.5 → 1383.5 ms forward and 1312.5 → 1273.0 ms
reverse (one upload per variant per order). Upload/inflate/check/install alone
was 1360.9 → 1186.4 and 1126.8 → 1059.6 ms. These few samples and upload variance
do not establish an overall cold-launch improvement. Daemons were already running;
per-daemon startup events are retained separately in the result files.

The remaining local verification cost splits into roughly 19–28 ms reading the
compressed artifact and 19–20 ms hashing its content-addressed verification key.
The latter is still required on each call: warmed expanded-buffer reuse does not
trust paths, timestamps or file metadata. The remote cached-executable hash still
costs roughly 70–73 ms. Neither verification is removed or cached by metadata.
The remaining connector startup includes Node/SEA loading, parsing and the
repository setup helper's retained static initialization. Socket connection and
hello processing remain small; fake discovery is about 5 ms and does not predict
real-agent discovery cost.

The original issue's artifact was 124 MB under an older Node release; these runs
use a 128 MB artifact and current main. Compare eager/deferred columns within
these runs, rather than interpreting historical absolute-time differences as a
regression or a second optimization. Test timing writes and the hash wrapper add
small overhead equally; raw event traces stay under the ignored output paths.

## Change and retained boundaries

The frequent `--connect` relay no longer initializes the daemon, native PTY,
headless terminal, agent discovery and helper modules before connecting. Each
mode imports its dependencies when selected. Repository setup's shared helper
retains its existing static import. The SEA entry reports a fixed startup failure
if initialization rejects; private exception text is not printed.

All bootstrap content hashes, bounded local reads and content verification,
owner/private-directory/socket checks, daemon executable identity, protocol
negotiation, upgrade gates and live-session protection retain their existing
implementation. There is no transport, SSH option, trust policy, wire message or
area-doc rule change. Unit tests cover deferred daemon initialization, mode
dispatch, hash failures, socket validation, bounded daemon-start retries and fixed
startup failure diagnostics. Existing fixture Electron tests exercise production
SEA upload, reattachment, restoration and remote agent helpers.

The issue's original real-host authentication/network and real-agent discovery
acceptance remains unmeasured under this task's fixture-only authorization.
These results support only the module-initialization change. Skipping remote
hashes, caching trust by file metadata, sharing SSH connections or changing the
bootstrap/hello sequence would need separate evidence and review.
