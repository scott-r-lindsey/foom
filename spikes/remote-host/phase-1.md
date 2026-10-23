# Remote shell transport spike (#754)

The implementation lives in `src/terminal-host/remote/`, with SSH/bootstrap in
`src/main/terminals/remote-{bootstrap,transport}.ts`. The current contract and
limitations are in [Terminals](../../docs/areas/terminals.md#remote-shell-spike-754).

Node 24 SEA reuses the existing TypeScript PTY manager, headless xterm, serializer,
color/query ownership and backpressure. It embeds the pinned node-pty N-API addon,
extracts it into a private directory and checks its exact bytes before loading.
No Electron, display, remote Node installation or new package is needed. The
existing pinned esbuild and postject dependencies build it; no toolchain is
installed system-wide.

The tradeoff is a full Node runtime in every executable and relay process. A
native helper can have a much smaller executable and lower startup overhead,
but needs a separately maintained PTY/screen parser and protocol implementation,
plus OS/architecture builds and portability testing. A native relay alone would
not replace the headless-screen owner. SEA still needs one build on each target
OS/architecture and matching node-pty prebuilds; this spike supports Linux/macOS
hosts and accepts an explicitly selected matching artifact on the hub. It neither
cross-compiles nor downloads an artifact. Windows remains a hub, not a Unix-socket
host. Packaging/distribution and a host inventory are outside phase 1.

`tests/electron/remote-host.test.js` builds the SEA and uses only a fixture `ssh`
on a controlled PATH with a private temporary remote HOME. The fixture executes
the actual quoted bootstrap script locally, uploads and hashes the SEA, and runs
its stdio relay. A separately owned fixture daemon allows process-audit cleanup.
The test opens a shell in the real sandboxed board, records a shell variable and
PID, kills the SSH fixture, and verifies that replay and a later command retain
both. A replay larger than the view high-water mark verifies that reset bytes
are counted by the PTY owner and the first replay acknowledgment releases output
pressure. Hub quit leaves the daemon and PTY alive; teardown explicitly stops the
fixture daemon. No real host, user SSH files/agent or user shell startup file is
used. Unit tests cover framing, option injection, hash mismatch, filesystem
permissions, negotiation, ID scoping, reconnect failures and dispatch.

Run the focused integration test under the shared validation lock and Xvfb on
Linux, then the full required validation list. It writes local measurements to
ignored `test-results/remote-host-measurements.json`; the PR records the measured
size/startup and distinguishes them from native-helper estimates. A real VM
checklist belongs in the PR for the user to run later, not in automated tests.

## Local Linux measurement

On 2026-10-23, Node 24.17.0, Linux x64, the SEA was 123,997,376 bytes
(118.25 MiB). The first fixture daemon socket became ready in 360 ms, including
spawn and the test's filesystem polling. Ten warm-cache invocations of the SEA's
usage-error path had a median of 142.5 ms (139.1–147.9 ms). That path includes
Node startup, the bundled code/native addon and hashing the executable.

For a clearly limited native comparison, compile `native-startup.c` with the
already available system `cc -Os -s`: its empty executable was 14,336 bytes and
ten process invocations had a median of 0.73 ms (0.63–1.23 ms), measured through
the same Node `spawnSync` parent. This is a lower bound only: the C program does
not implement PTYs, screen replay, sockets or validation, and is not an alternate
host implementation. It establishes the runtime-size/startup cost we accepted,
not an equivalent native host performance claim. The local raw measurements stay
in ignored `test-results/remote-{host-measurements,startup-baseline}.json`.

| Choice | Startup / size evidence | Build and maintenance cost |
| --- | --- | --- |
| Node SEA (chosen) | Actual shell daemon: socket ready ~360 ms, 118.25 MiB; warm usage path ~142.5 ms | Existing Node 24, esbuild, postject, node-pty and xterm; native builds on Linux/macOS per architecture; macOS ad-hoc codesign; no remote Node/Electron |
| Native helper | Empty C lower bound: ~0.73 ms, 14 KiB; equivalent host unimplemented | New PTY, terminal-state/parser, backpressure and protocol code; platform/architecture builds, compiler/cross-compilation and compatibility testing |

The spike accepts SEA's size/startup cost to prove transport without maintaining
two terminal implementations. The relay currently loads the same runtime as the
daemon, so this is not evidence of fleet-scale memory/CPU efficiency. A production
bootstrap artifact selection/distribution contract and a lighter relay can be
considered in later phases without weakening the wire/security contract.
