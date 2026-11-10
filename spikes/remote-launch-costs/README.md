# Repeated remote bootstrap and handshake (#1098)

This is a Linux fixture measurement of the production bootstrap, native host and
human machine-agent open path. It uses a private temporary HOME, an explicit tool
allowlist, fixture SSH over local pipes, the real Unix-socket daemon and fake
Claude. It makes no network/model requests, reads no user shell startup files and
never runs a real SSH or agent executable. No production instrumentation ships.

The issue also asks for an explicitly authorized real SSH host, network
connection/authentication timings and real agent discovery. **Those remain
unmeasured.** This task authorized fixtures only. These figures cannot establish
SSH/EC2 latency, remote storage performance or real-agent startup costs.

## Reproduce

From the repository root, with Node 24 and the pinned dependencies installed:

```sh
node spikes/remote-launch-costs/run.mjs
node spikes/remote-launch-costs/summarize.mjs
```

On the shared development machine, run the first command through the task's
`heavy.sh` lock; never overlap it with another heavy command in this worktree.
No display is used. Outputs are under ignored `test-results/1098/`. The runner
builds instrumented copies of the host using the production builder/native loader,
SEA options and level-1 gzip/manifest generation. Generated builders, executables
and bundles stay untracked. It restores the old unused connector hash only in the
baseline test build. Source-anchor checks refuse an obsolete instrumentation patch.

Each version starts its own daemon, warms local artifact verification as enrollment
would, then performs one first upload and six cached launches. The remote executable
cache starts empty; the daemon is already listening before either first launch.
Every open runs fake Claude discovery through the fixture login shell, waits for
open acknowledgement and the fake CLI's output marker through an attached PTY,
then kills that run-owned session. The daemon is terminated and the temporary HOME
removed before switching versions. This is a sequential shared-machine sample,
not a randomized benchmark or a fresh page-cache measurement.

## Results (Linux x64, Node 24.17.0)

Measured from source `4540a517dc5c403140199b3784bf449dc0300cbf` plus this change
on the shared development machine. Each instrumented SEA is 124,390,592 bytes.
Compressed sizes and every sample are in [the results](results-linux-x64.json).
Raw numeric event traces are retained under `test-results/1098/measurements.json`.

| Stage (ms) | Baseline first upload | Fixed first upload | Baseline cached median (range), n=6 | Fixed cached median (range), n=6 |
| --- | ---: | ---: | ---: | ---: |
| Open total | 1317.9 | 1328.0 | 345.1 (334.8–359.0) | 248.3 (227.0–264.2) |
| Output total | 1323.3 | 1335.2 | 347.8 (335.8–361.8) | 250.1 (228.0–266.1) |
| Fixture platform preflight | 28.0 | 42.8 | 33.2 (28.8–40.2) | 31.0 (28.1–36.7) |
| Local artifact verification | 39.7 | 51.5 | 43.2 (38.4–51.2) | 39.4 (36.6–42.6) |
| Spawn to first bootstrap marker | 24.4 | 25.5 | 94.6 (91.2–99.0) | 100.2 (91.6–104.9) |
| Upload/inflate/check/install | 1013.1 | 1120.7 | — | — |
| Remote executable SHA-256 (subset) | 73.0 | 67.8 | 68.7 (67.3–71.7) | 72.4 (67.7–74.4) |
| Bootstrap ready to daemon hello | 161.4 | 48.1 | 147.1 (134.5–156.2) | 45.3 (40.0–59.8) |
| SEA startup/modules to runHost (subset) | 41.9 | 42.5 | 44.4 (35.6–50.9) | 43.4 (38.1–57.2) |
| Connector self read/SHA-256 (subset) | 112.7 | absent | 96.7 (95.6–110.0) | absent |
| Unix socket connect (subset) | 0.6 | 0.7 | 0.5 (0.5–0.5) | 0.4 (0.4–0.6) |
| Connected socket to hello (subset) | 5.4 | 4.0 | 2.5 (1.9–2.8) | 1.1 (0.9–1.4) |
| Fake CLI discovery (subset of preparation) | 7.1 | 5.6 | 5.1 (4.6–5.8) | 4.8 (4.4–5.3) |
| Open preparation plus PTY creation | 33.4 | 26.3 | 15.2 (11.8–17.0) | 14.0 (11.3–16.3) |

Stages overlap as marked; do not sum medians. Cached open time decreased by
96.8 ms (28.0%) and handshake time by 101.8 ms. The directly measured unused
connector hash accounts for approximately that improvement. Remaining connector
handshake cost is mainly startup/module initialization; Unix-socket connection and
hello processing are small in this fixture. The daemon still self hashes once at
startup (100.1 ms baseline, 95.1 ms fixed; one daemon per version), outside these
launch intervals. Total daemon readiness was 163.5/173.6 ms respectively, including
the fixture's readiness polling granularity; those single samples are not an
optimization claim.

A single first-upload sample per version does not show an overall cold-launch
improvement: the 107.6 ms upload variance outweighed the shorter handshake. The
local-verification figures differ from the issue's historical baseline; this run
rereads the same-size compressed artifact under current shared-machine conditions
and is not a controlled comparison to that earlier run. No hash/trust caching
change is inferred from that difference.

## Intervals

- Open total: start of `selectHostArtifact` to the live `open-result`. It excludes
  sidebar/UI dispatch and attachment. Output total also waits for the fake CLI's
  marker in attached PTY output.
- Preflight: launch start to local artifact verification. Fixture SSH validates
  the exact alias and returns a fixed native uname response, matching the existing
  Electron fixture. It measures local process startup, not SSH authentication.
- Local verification: bounded artifact/manifest rereads and content hashing with
  the existing content-addressed expanded-buffer cache warmed.
- First marker: bootstrap SSH spawn to `FOOM-UPLOAD` or `FOOM-READY`. A cached
  first-marker interval includes the remote executable SHA-256.
- Upload: `FOOM-UPLOAD` to `FOOM-READY`, including pipe transfer, inflate, size/hash
  checks and atomic install. Remote SHA-256 is a subset, not an extra stage.
- Handshake: `FOOM-READY` to the validated daemon hello. It contains SEA startup
  and module initialization before `runHost`, optional connector self hashing,
  private-path/socket checks, Unix-socket connection and daemon hello processing.
- Discovery: the host's real `hostDiscovery` function around fixture login PATH
  resolution, executable checks, fake `--version` and fake `--help` processes.
  Discovery is a subset of open preparation/PTY creation.

Host timestamps use `performance.timeOrigin + performance.now()`; the bootstrap
hash wrapper uses the same machine's epoch clock via `date`. The wrapper adds two
small `date` processes to each measured remote hash. Test-only stderr markers add
small measurement overhead. No terminal contents, commands, credentials, whole
protocol messages or user paths appear in committed measurement data. Instrumented
artifact digests differ from release artifacts; expanded sizes remain comparable.

## Safe optimization and retained boundaries

Before this change, `runHost` read and SHA-256 hashed the entire executable for both
`--daemon` and `--connect`. Only the daemon passed the digest to `serveHost`. The
connector relays the desktop hello and daemon response unchanged and never uses
its local digest. Move that unchanged hash expression into the daemon branch.
Invalid argv also avoids the read. Unit tests assert the exact daemon digest,
refuse daemon startup on an unreadable executable, and exercise the connector
without allowing any executable read while retaining both socket checks.

This removes unused work without changing the host protocol or trust policy.
Local content verification, every bootstrap cache/upload hash, private-directory
and ownership checks, daemon self hashing, build/capability negotiation, idle
upgrade gates and live-session protection all retain their existing owners.
Existing Electron remote upload/reconnect, restart/restore and remote-agent cases
exercise these boundaries with the production host.

Further ideas such as skipping the remote cached-executable hash, trusting
metadata/timestamps, sharing SSH connections or moving/combining bootstrap and
hello messages need separate evidence and design review. They are not implemented.
