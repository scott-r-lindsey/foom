# Remote host research (#518)

The phase-1 implementation for #754 is documented in [phase-1.md](phase-1.md).

Research only, **2026-10-15**, Linux x64. No shipped application code or settings.
The recommendation in [remote-machines.md](../../docs/research/remote-machines.md)
is **proposed, not decided**. This is remote terminal hosting, not #67 UI mirroring.

## Reproduce

Requirements: Linux x64, Node 24.17.0, Docker access, an **already present**
`ubuntu:24.04` image, OpenSSH client/keygen, `gh` release download access, and Xvfb
for the optional browser fidelity probe. No host package or service installation
is performed. `run.mjs` refuses a missing base image; it creates no images. It
installs openssh-server only inside its disposable container, then removes that
container. The base-image ID and installed sshd version are recorded in results;
Ubuntu repository packages can change on a later run.

From the repository root:

```sh
export PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH
corepack enable
pnpm install --frozen-lockfile
node spikes/remote-host/run.mjs /tmp/remote-results.json
xvfb-run -a node_modules/.bin/electron spikes/remote-host/fidelity.cjs /tmp/remote-results.json.ssh-screen.json
xvfb-run -a node_modules/.bin/electron spikes/remote-host/fidelity.cjs /tmp/remote-results.json.ssh-herdr-screen.json
```

The runner downloads **herdr v0.9.3** directly with `gh release download`, never
runs the global `herdr`, and checks SHA-256
`18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`.
To reuse an already downloaded release, set `SPIKE_HERDR_ARCHIVE` to its absolute
path; the same checksum check applies. Do not substitute a user's active herdr
binary/config/socket. The measured reference source was read-only commit
`ff83689f1512f11b762fe52fb3a0032e7373c35e` in the main checkout's
`inspiration/herdr`. No inspiration tree was changed or included in tests/builds.
The isolated HOME pattern also follows the read-only
`inspiration/theam-shepherdr/Tests/AgentTools/herdr-live.sh` example.

`build.mjs` can run separately with a fresh prefix from
`mktemp -d /tmp/foom-remote.XXXXXX`. It bundles the probe, injects the Node SEA and
prints binary/gzip-9 sizes. `run.mjs` does this automatically, mounts only its
scratch prefix into the container, and uses that same binary for the local baseline.
The container has no Node installation, node_modules, repository mount or real
agent CLIs. All agent behavior comes from the embedded `fixture` mode. Git and
agent discovery are not exercised. Ordinary build/download commands may access
the network; every **SSH connection** is to the throwaway loopback container.

Temporary Ed25519 host/client keys and authorized_keys live only under the random
0700 prefix. known_hosts is generated from the freshly created host public key,
not TOFU or keyscan. SSH receives a clean environment without SSH_AUTH_SOCK,
`-F /dev/null`, dedicated known_hosts, strict host-key checking, batch mode,
IdentityAgent=none, no agent forwarding, no TCP forwarding, no control master and
no SSH PTY. sshd also disables forwarding and user rc and forces the single fixed
probe entrypoint; it cannot execute a caller-selected shell command. The remote
fixture account has the host caller's UID only to own this temporary bind mount;
this is not a production account-enrollment design.

The local baseline also receives a clean environment, scratch HOME/config/socket
and a fixed fixture shell. No `~/.ssh`, `~/.claude`, `~/.codex`, `~/.gemini`, user's
herdr server, global agent config, real agent executable, host sysctl, ulimit,
package or service is changed. Cleanup stops the scratch processes and removes
the container/prefix. JSON results and four synthetic screen captures remain at
the explicitly requested output path. They contain no credentials or real
terminal content. No executable, native addon or private key is committed.

## Observed results

[Raw run](results-linux-x64.json): Node 24.17.0; node-pty 1.2.0-beta.15;
headless/browser xterm 6.0.0; serialize addon 0.14.0; postject 1.0.0-alpha.6;
herdr 0.9.3; OpenSSH 9.6p1 Ubuntu-3ubuntu13.20; host Linux
6.8.0-107-generic, glibc 2.39. Browser fidelity used Electron 44.4.5 under Xvfb,
sandbox on, context isolation on, Node integration off. The browser probe is a
standalone fixture window, not the Foom application or its production IPC.

| Adapter / path | Echo median / p95 (ms) | `seq` final screen (ms) | Decoded terminal bytes | Reconnect + catch-up (ms) |
| --- | ---: | ---: | ---: | ---: |
| B, local Unix socket | 5.90 / 6.16 | 1,615 | 16,888,917 | 41.48 |
| B, loopback SSH | 5.42 / 6.45 | 1,855 | 16,888,917 | 209.66 |
| A, local Unix socket | 15.99 / 20.84 | 670 | 15,383 | 287.22 |
| A, loopback SSH | 16.31 / 21.33 | 443 | 10,590 | 464.41 |

Each row uses three concurrent terminal IDs, asserts independent routing, then
measures 50 sequential printable keystrokes into terminal 1, `seq 1 2000000` in
terminal 2, and fixture MCP/hook calls in terminal 3. Echo means an acknowledged
write followed by the expected accumulated text in the receiving xterm buffer;
it includes the transport and parser, not a physical keyboard or screen refresh.
The observation loop polls at 5 ms, so sub-5-ms differences cannot be resolved.
Each bulk/reconnect entry is one sample, not a statistical comparison. In
particular A SSH being faster than A local is run variance, not negative SSH cost.

The sequence emits 14,888,896 LF-delimited source bytes; PTY CRLF conversion and
the completion marker bring B's received count to 16,888,917. Herdr sends screen
redraws, **not the complete sequence**. A's much smaller count is therefore not
lossless throughput and does not establish an audit/tail history equivalent to B.
For B, observed delivered-stream throughput is approximately 9.97 MiB/s local and
8.68 MiB/s over loopback SSH. A's comparable metric is time to final visible
screen, not the rate of original output delivered. JSON and SSH overhead are not
in the terminal byte column. No compression or network shaping was enabled.

Catch-up kills the SSH/local transport process, lets a fixture print a marker
after one second without a client, starts a fresh client, and checks retained
progress and the same daemon PID. The 1.2-second disconnected interval is excluded
from catch-up; SSH authentication and new transport startup are included. A opens
a fresh controller to request its full frame; B requests its headless snapshot.
This models the transport parent quitting. It does not exercise the actual Foom
quit handler, machine reboot, daemon crash, network loss/latency or logind logout.

## Relay and fidelity assertions

All four rows passed:

- Separate per-launch control/hook tokens survive the remote route. MCP stdio
  initialize and whoami pass; a launch request with a forged `approved` field is
  denied by the **local fixture validator**. The remote side only forwards.
- Hook POST with the right hook token is observation, not authority; wrong-token
  and control-token-as-hook attempts fail. Revocation in the local validator
  denies all six later MCP/hook requests. The Unix bridge socket is checked 0600.
- Three terminals share one SSH transport; the daemon continues headless work
  after transport exit. A's per-launch pane environment carries the same fixtures.
- B refuses a mismatched `spike-1` handshake before operations.

The 48 relay records are fixed outcomes without tokens or request bodies. This is
**not** a test of Foom's production authorization service or real providers.
The synthetic MCP subset covers initialize and tools/call, not complete MCP
negotiation, notifications, cancellation, elicitation or managed-policy behavior.
No remote side was given code that grants authority; a compromised remote could
still steal every token intentionally provisioned to that machine. Main must
scope them to that host and enforce normal policy in the real implementation.

B's headless snapshot exactly matched the local receiving xterm buffer for the
fixture's active cells, widths, colors, selected attributes, cursor and buffer.
The sandboxed browser xterm replay also matched the recorded SSH snapshot.
The fixture writes normal-buffer wide/combining characters and enters an alternate
screen with colored/bold cells and cursor movement. This is a finite fixture,
not exhaustive graphics, font, color-palette, hidden-buffer or resize coverage.

A preserved the fixture cursor but did **not** produce byte-for-byte cell
representation/buffer identity: its rendered ANSI projection uses the normal buffer
for the fixture's alternate screen. Replaying its received ANSI stream in browser
xterm matched its receiving headless xterm. That validates render-input replay,
not equivalence between Ghostty's internal state and Foom's xterm state. The cell
differences were materialized spaces instead of empty cells and 256-color palette encoding instead of 16-color encoding for the same blue index (4); they
do not establish visible color corruption. The inactive buffer, modes and
historical output require a separately reviewed adapter.

## SEA packaging

The measured Linux x64 executable is **123,931,840 bytes (118.19 MiB)** raw and
**43,865,328 bytes (41.83 MiB)** gzip level 9; embedded `pty.node` is 75,976 bytes.
The raw-result SHA is for this experimental build, not a stable release artifact.
The script uses the project's existing pinned dependencies and introduces no
package or lockfile change. It reuses the production snapshot helper read-only;
the rest is disposable harness code under this spike.

The native addon is extracted on first PTY creation into a private hash-named
cache and loaded with `process.dlopen`; subsequent launches reuse verified bytes.
Both local and container probes ran the SEA without Node module lookup at runtime.
The artifact includes fixture, relay and A-adapter code, and the unstripped Node
runtime. It is not a minimum production B binary. An installer/upload timing was
not measured: the container receives a bind-mounted artifact. Upload/hash staging,
linux-arm64, darwin-arm64, signatures and libc boundaries are design findings in
the research document, not results from this Linux run.

## Limits and failed attempts

An initial local B bulk-output run exceeded the 8 MiB bounded subscriber queue and
closed the stream. The final prototype adds attached-view drain pressure alongside
parser pressure; detached parsing remains independent. This is evidence that a
production transport needs explicit flow control. It is not a stress proof for
multiple slow clients or hostile frames. The measurement fixture intentionally
allows only three IDs and fixed commands; do not ship it as a daemon.

Setup iterations also caught container file ownership and a wrong assumption about
herdr's `workspace.create` response (`root_pane.pane_id`, not top-level `pane_id`).
Those runs are not included in the table. Scratch processes/container from the
initial parser exception were explicitly identified and removed; later failures
used registered cleanup. Final cleanup was checked for remaining scratch
containers and processes. No user process was terminated.

Unmeasured: real remote/WAN behavior, exhaustive terminal fidelity, concurrent
human/agent input arbitration, actual Electron quit/restart, daemon restart/reboot,
oldest libc, musl, arm64/macOS, native extraction races/noexec, artifact upload,
production MCP/hook validation, real agent settings/approval behavior, and
compatibility of herdr versions other than the tested 0.9.3. The proposed plan
keeps these as acceptance gates rather than presenting them as established facts.
