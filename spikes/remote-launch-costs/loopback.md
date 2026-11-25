# Loopback SSH launch costs (#1098)

On dozer, a first upload took 2,612.3 ms to reach open acknowledgement.
Six cached opens took a median of 1,097.4 ms (1,082.7–1,107.9 ms).
These launches used OpenSSH TCP connections and public-key authentication on
127.0.0.1. **Loopback measures real SSH connection setup and authentication
but does not measure cross-machine network latency.** The remote artifact,
daemon, and SSH client ran on the same machine, so the numbers also reflect
dozer's local storage, CPU scheduling and loopback transfer throughput.

## Reproduce

On Linux, install the repository's pinned dependencies with Node 24. The
profile requires existing OpenSSH client and server binaries, bubblewrap with
unprivileged mount namespaces, an account eligible for public-key
authentication with PAM disabled, and permission to bind and connect to a
loopback high port. Run the two commands from the repository root.

```sh
node spikes/remote-launch-costs/run.mjs --loopback
node spikes/remote-launch-costs/summarize.mjs test-results/1098-loopback/measurements.json
```

The runner builds one instrumented SEA with the current deferred connector
initialization and reuses the production artifact selection and bootstrap
commands. It starts its own daemon in a private temporary HOME and warms local
artifact verification as enrollment would. It starts a private sshd on
127.0.0.1:41398 (override with `FOOM_COST_SSH_PORT` if occupied). The private
sshd configuration, throwaway client and host keys, and the client's
pinned known_hosts file live under ignored `test-results/1098-loopback/`.
A mount namespace gives the server an empty account home before the account
shell starts. The fixed command wrapper sets that same private HOME for the
remote process, and discovery uses the fixture login shell. The client uses the
generated configuration via `-F`. Agent forwarding and connection reuse are
disabled. The daemon's socket and all launched PTYs belong to the profile.

Each launch opens, attaches and kills a fixture Claude PTY. There is no
synthetic load, real agent startup, login, or model request in this profile.
The one first upload starts with an empty executable cache and a listening
daemon. Six later opens reuse the installed executable while retaining the
normal per-launch verification. The runner stops its daemon and listener and
deletes the temporary home and keys, including on SIGINT or SIGTERM. After the
published run, the sshd PID was gone,
port 41398 had no listener, and the throwaway keys were absent.

## Samples

Dozer, Linux x64, Node 24.22.1, OpenSSH 9.6p1 Ubuntu-3ubuntu13.20. Source
`29d1db127fda766988085c8dc63d38a5ba8ed4cb`, instrumented executable
127,864,000 bytes, gzip 48,717,800 bytes. Collected on 2026-11-24 local time.
The first-upload column is the single sample and therefore also its median
and both range endpoints. A dash indicates the stage did not run.
An initial attempt reached the PTY but was discarded when the adapter passed
intentional SSH teardown diagnostics into the timing parser. The seven samples
below come from the complete rerun after correcting that capture.

| Stage (ms) | First upload | Cached 1 | Cached 2 | Cached 3 | Cached 4 | Cached 5 | Cached 6 | Cached median (range) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Open total | 2612.3 | 1095.1 | 1099.6 | 1085.4 | 1082.7 | 1100.3 | 1107.9 | 1097.4 (1082.7–1107.9) |
| Attached PTY output total | 2622.7 | 1097.3 | 1105.3 | 1087.2 | 1085.3 | 1102.6 | 1111.0 | 1099.9 (1085.3–1111.0) |
| Platform preflight total | 288.6 | 280.9 | 274.3 | 273.0 | 284.4 | 269.8 | 272.4 | 273.7 (269.8–284.4) |
| Preflight SSH process start to public-key authentication | 188.4 | 187.7 | 180.2 | 179.9 | 186.8 | 178.2 | 179.0 | 180.1 (178.2–187.7) |
| Bootstrap SSH process start to public-key authentication | 179.7 | 181.8 | 181.3 | 180.0 | 182.0 | 179.3 | 179.0 | 180.7 (179.0–182.0) |
| Bootstrap authentication to first marker | 55.4 | 355.5 | 355.3 | 354.5 | 353.5 | 356.0 | 368.6 | 355.4 (353.5–368.6) |
| Open acknowledgement to attached PTY marker | 10.4 | 2.2 | 5.7 | 1.8 | 2.6 | 2.3 | 3.0 | 2.5 (1.8–5.7) |
| Local artifact read | 25.3 | 25.3 | 23.7 | 23.6 | 23.7 | 26.7 | 23.2 | 23.7 (23.2–26.7) |
| Local content-key hash | 113.1 | 125.6 | 141.7 | 125.3 | 110.4 | 135.7 | 142.2 | 130.6 (110.4–142.2) |
| Local artifact verification total | 140.5 | 151.7 | 166.1 | 149.8 | 134.6 | 163.2 | 166.3 | 157.5 (134.6–166.3) |
| Bootstrap wrapper spawn to first marker | 268.6 | 568.6 | 568.0 | 564.9 | 566.2 | 567.2 | 578.9 | 567.6 (564.9–578.9) |
| Upload, inflate, verify and install | 1773.0 | — | — | — | — | — | — | — |
| Remote executable SHA-256 | 311.4 | 300.2 | 299.4 | 301.1 | 299.1 | 300.6 | 312.4 | 300.4 (299.1–312.4) |
| Bootstrap ready to daemon hello | 74.7 | 60.9 | 61.5 | 63.1 | 65.4 | 71.6 | 62.7 | 62.9 (60.9–71.6) |
| SEA bundle entry to host entry | 9.1 | 8.9 | 9.9 | 8.5 | 10.1 | 9.8 | 9.5 | 9.7 (8.5–10.1) |
| Bootstrap ready to host entry | 65.5 | 53.6 | 56.9 | 58.0 | 60.8 | 64.2 | 58.4 | 58.2 (53.6–64.2) |
| Connector self hash | — | — | — | — | — | — | — | — |
| Unix socket connect | 1.0 | 0.9 | 0.9 | 0.9 | 0.9 | 0.9 | 0.9 | 0.9 (0.9–0.9) |
| Connected socket to desktop hello reply | 6.1 | 2.1 | 2.1 | 2.4 | 2.2 | 1.9 | 1.8 | 2.1 (1.8–2.4) |
| Fixture CLI discovery | 9.4 | 7.0 | 6.4 | 9.1 | 6.6 | 6.4 | 6.0 | 6.5 (6.0–9.1) |
| Hello reply to open acknowledgement | 53.9 | 24.3 | 21.0 | 25.0 | 23.2 | 19.6 | 18.4 | 22.1 (18.4–25.0) |

Open total starts at artifact selection and ends at validated open
acknowledgement. The PTY totals end when both the open reply and the fixture's
attached output marker have arrived. SSH intervals start immediately before
spawning the actual client and end when the adapter receives OpenSSH's
verbose public-key authentication line. These intervals include process
startup, connection, key exchange, and authentication. They include local
observation overhead and sit inside the preflight and first-marker intervals.

The published authentication-to-marker row shows elapsed time between two
local observations on dozer. The adapter timestamps the authentication line
from SSH stderr, and the runner timestamps the first marker from stdout.
The independent streams can be observed out of order, so even positive values
cannot establish the exact time from authentication to marker emission.
The summarizer reports an inverted interval as unavailable (`null` in the
sample row) and counts unavailable cached samples alongside the count used
for the cached statistics.

On a cache hit, the remote cache hash completes before the first marker,
`FOOM-READY`. On a first upload the first marker is `FOOM-UPLOAD`, and the
hash is part of upload through `FOOM-READY`.
Local reads and content-key hashing sit inside local verification. Connector
startup includes the transition from the ready marker to the SEA entry
point, so it also includes SSH delivery and timestamp instrumentation.
Module initialization, connector startup and socket/hello intervals are
subsets of the handshake. The connector did not self hash. The daemon's
one-time self hash took 340.3 ms within 429.3 ms of daemon startup through
socket readiness (including polling), before the first measured launch.
Fixture discovery is a subset of open preparation. Compare intervals
individually because their endpoints and overlaps differ.

## Sandboxed CLI startup timings

The separate manual run attempted the installed CLIs with a private empty
home, network disabled, ignored stdin, a five-second timeout per command, and
no login. It exited 127 on the first row, Claude `--version`, because the
approved timing script could not find `awk` inside the namespace. The timer
reported no elapsed duration or CLI exit status. No later samples ran, so
there are no recorded timings, medians, or ranges for Claude, Codex, or
Antigravity. The approved environment and scripts were left as reviewed.

Foom's `hostDiscovery` resolves executable names against a login-shell PATH
and then invokes `--version` and `--help` sequentially for the selected
executable. A successful manual sample would cover the standalone CLI
invocation for those flags. It would omit Foom's login-shell startup, PATH
lookup, executable validation, environment preparation, management
parallelism and login/plugin checks. Those costs and installed-agent PTY
readiness remain unmeasured. The fixture discovery and PTY rows above use
fixture Claude and cannot fill those gaps.
