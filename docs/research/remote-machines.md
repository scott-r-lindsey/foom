# Remote machines over SSH (#518)

**Proposed, not decided.** Research dated 2026-10-15. This is this Foom driving
terminals on another machine, not #67's remote mirror of an existing Foom UI.
No runtime, capability, provider manifest, settings or CI change ships here.

Recommend **B: a Foom-owned persistent host**, initially Linux x64/glibc. Both
candidates can multiplex three terminals and a control relay over one SSH stdio
connection. B retains Foom's xterm state and authorization boundaries. A provides
an effective persistent terminal engine and much cheaper screen updates, but adds
another terminal model, lifecycle policy, version contract and translation layer.
Neither prototype is a production implementation or a security certification.

Reproduction, exact versions, raw results and measurement definitions are in
[`spikes/remote-host/`](../../spikes/remote-host/README.md). All processes used
synthetic fixture agents. SSH connected only to a disposable container on
127.0.0.1, with temporary keys and pinned temporary known_hosts. No real agent,
provider, user SSH credential, running herdr instance or global agent configuration
was used. The reference source was read from the main checkout's ignored
`inspiration/herdr` because this worktree has no inspiration directory. Runtime
herdr came from a checksum-pinned release installed into the disposable prefix.

## A versus B

| Question | A: herdr adapter | B: Foom host |
| --- | --- | --- |
| One SSH session | Proven with our small ID-framing adapter around three `terminal session control` subprocesses and the local socket API; not three SSH connections | Proven with ID-framed requests, output and relay messages on a daemon socket carried by one SSH stdio process |
| Terminal representation | Ghostty-backed server emits ANSI screen frames; a redraw may omit millions of intermediate output bytes | node-pty, headless xterm 6, Foom's existing snapshot helper; raw PTY output currently traverses the link |
| Echo and bulk workload | Higher echo latency in this fixture, much less wire-facing terminal data and faster final screen for `seq`; not a lossless throughput win | Lower echo latency here; full output incurs both remote parsing and local replay |
| Persistence | Scratch herdr server and panes survive killing the SSH/client transport; adapter daemon retains controllers | Detached Node daemon owns PTYs and headless screens independently of SSH and local client lifetime |
| Catch-up | A new terminal-control subscription supplies a full ANSI screen | Parser barrier plus serialized xterm snapshot; same terminal identity/PID after reconnect |
| Hooks / MCP | Per-launch environment reaches a fixture in a herdr pane; our relay works. Herdr detection does not replace Foom authentication or approval | Per-launch stdio MCP bridge and hook POST relay reach the local fixture validator; no remote authorizer |
| Packaging | Pinned third-party executable plus Foom's bridge; source build needs Rust and Zig | Measured Linux x64 Node SEA with embedded/extracted addon; larger binary, direct ownership of dependencies |
| Version exposure | API and terminal stream capabilities plus server/client compatibility; 0.9.x behavior changes matter | Exact app/host build and protocol match; explicit refusal demonstrated |
| Git | Keep Foom's validation/confirmation policy; avoid delegating to herdr worktree policy | Typed remote execution backend for WorktreeService; main retains policy |

## 1. Transport and measurement interpretation

Use `ssh -T`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, no agent forwarding,
no port forwarding and no SSH PTY. Binary/JSON framing runs on stdout; diagnostics
stay on stderr. SSH provides encryption, server authentication and the remote
account boundary; it does not validate terminal IDs, payloads or control requests.
One session can carry independently tagged terminal output, input, resize,
snapshot responses and request/response relay frames in both directions.

The experiment wraps herdr's public CLI JSON stream rather than implementing its
internal binary client protocol. It uses the JSON socket for `workspace.create`
and launch environment and `terminal session control` for input/output. Its three
controller subprocesses remain remote. The same SEA hosts the experimental
adapter and fixture for A and B; it is not a minimum-size A client or B release.

The recorded table in the README includes 50 sequential keystroke-to-visible-cell
samples per configuration, a three-terminal routing assertion, final-screen time
for `seq 1 2000000`, decoded terminal bytes received, and fresh-connection catch-up.
This is one Linux host and loopback Docker networking, not a WAN benchmark. Echo
observation polls at 5 ms; small differences within that resolution are noise.
Startup is excluded from echo and included in reconnect. No latency/loss/network
shaping or host sysctl/ulimit change was made.

A's ANSI projection skips intermediate scrolling output: its received byte count
is orders of magnitude smaller than B's 16,888,917 bytes. Compare time to visible
completion and link-facing volume, **not** bytes/second as though both deliver the
same data. B's attached-view backpressure was necessary: an initial bounded queue
refused a slow consumer. The final probe pauses for parser backlog or an attached
consumer backlog and resumes after drain. Disconnection removes view pressure;
parsing continues without a view. Production needs per-stream quotas, fairness,
reserved control-plane capacity, acknowledgments and slow-view resnapshotting so
a bulk terminal cannot starve a hook or human input. JSON/base64 overhead and SSH
cipher overhead are not included in the decoded byte counts.

## 2. Persistence and screen fidelity

For B, launch a daemon using an argument-array process spawn with `detached: true`
(setsid semantics on Unix), private cwd/HOME/socket and stdin/stdout/stderr detached
from SSH. Connect subsequent short-lived stdio transport processes to its 0600
Unix socket inside a 0700 directory. The probe starts the daemon from the SSH
process, kills that transport, lets a fixture print while disconnected, then
reconnects using a new client and verifies the same daemon and retained screen.
The local transport parent is killed too. No user service, linger, login settings
or system settings are changed.

This demonstrates connection/parent-process survival, not persistence through
host reboot, daemon crash, account logout policy or a real Electron quit path.
Production must distinguish remote disconnect from the current local quit behavior
(which stops local PTYs). Show retained remote sessions and explicit stop actions;
do not replay input on reconnect. A host that kills user processes at logout can
still kill a detached daemon. An optional user service is a separately disclosed
installation decision, not a silent dependency or something this spike tested.

B uses the existing `terminalSnapshot` helper, including its alternate-buffer and
cursor/margin handling, after a headless parser barrier. The probe compares cells,
widths, foreground/background modes and values, bold/italic/underline, active
buffer and cursor after restore. A separate sandboxed Electron browser loads
xterm.js and checks the same data under Xvfb. This is buffer/render-input fidelity,
not a pixel/font or exhaustive terminal conformance test. The fixture exercises
normal/alternate buffers, SGR, wide/combining characters and cursor movement;
not every mode, hyperlink, palette, resize race, graphics or pending-wrap case.
A's ANSI projection is measured separately; it must not be assumed to preserve
xterm's inactive buffer/history and mode semantics just because it displays text.

Production reconnect needs daemon generation, terminal ID, last received sequence,
attachment generation and dimensions. Atomically cut a snapshot at sequence N,
then deliver N+1 onward under a bounded queue; reject stale acknowledgments and
input. Resize is ID-scoped, ordered and bounded. Detect dead daemons and report
lost sessions rather than silently recreating a process under an old ID. A fresh
client may inspect existing sessions only after host identity and ownership are
re-established. Credentials, pending approvals and unattended grants are not
restored merely because the remote PTY survived.

## 3. Control-plane relay and agent attachment

The measured path is:

```text
remote fixture agent
  -> foom-host mcp-bridge (NDJSON stdio)
  -> private Unix socket, mode 0600
  -> persistent remote daemon (routing only)
  -> same SSH stdio connection
  -> local fixture validator
  <- response along the same path
```

The fixture actually spawns the stdio bridge in a PTY and sends MCP initialize,
whoami and an unauthorized launch request with `approved: true`. The original
per-launch token crosses the relay unchanged. Valid identity requests pass;
the attempted approval/launch does not. A separate hook token authenticates a
remote loopback HTTP POST through the same relay. A bad hook token and a control
token in the hook slot fail; valid hook data is observation only even with an
`approved` field. Revoking the local grant denies subsequent MCP and hook requests.
The script asserts these outcomes, not just arrival, and records no token values.
Both paths also run from a fixture launched in a herdr pane using `workspace.create`
with per-launch environment. No global integration install or real CLI is involved.

**Limit:** this uses a deliberately small local fixture validator, not Foom's
production MCP server, hook receiver, managed-policy UI or an actual provider's
per-launch settings parser. It proves the transport and location of the decision,
not compatibility with real CLI approval or discovery. A provider must support an
invocation-scoped stdio MCP configuration (or a separately reviewed bridge) before
remote attachment is available. Existing HTTP-only manifest assumptions must be
reviewed; do not claim the current v2 engine already supports this remote design.
Herdr's screen/hook state detection is optional observation, never a replacement
for Foom's tokens, principal generations, child ownership or human confirmations.

Production should terminate the relay in a main-owned adapter to the **same local
service validators** used by local MCP/hooks. No arbitrary URL/port forwarding,
remote-selected local endpoint, raw API capability or remote-approved flag. Route
by fixed operation kind and host/launch generation, with separate control and hook
tokens, constant-time digest authentication, explicit schemas, size limits and
concurrency/time budgets. Preserve MCP request IDs only within a bounded session;
they are correlation, not identity. Do not log raw bodies/tokens. Stdio cannot
carry an HTTP Authorization header, so the bridge reads the token from its launch
environment and puts it in a private transport envelope, outside MCP tool arguments.

Disconnect fails control requests closed. Hooks may become unavailable; do not
infer Done, permission or authority from silence. Pending mutations become
indeterminate on lost acknowledgment, with persisted main-owned intent/idempotency
and explicit reconciliation; never auto-resend with a new key. On local shutdown,
revoke grants even if PTYs remain alive. Reconnection requires a fresh approved
binding/generation and credential delivery to supported agent runtimes; otherwise
those surviving agents keep terminal access but their old Foom capabilities fail.
Credential rotation in an already running agent is a real implementation question,
not solved by reconnecting SSH. The spike reuses synthetic tokens to isolate the
transport measurement; it does not implement this production reauthorization UX.

## 4. Packaging and proposed v1 targets

The Linux x64 build bundles node-pty JavaScript, headless xterm, serialization and
the experiment into Node **24.17.0**, injects a SEA blob with pinned postject, embeds
`pty.node`, extracts it into a private hash-named cache on first use, checks its
hash/type/owner/mode and loads it with `process.dlopen`. It successfully spawns
PTYs in a container with **no installed Node or node_modules**. A build-time shim
replaces node-pty's relative native-module lookup; installed dependencies are not
modified. The measured binary and gzip-9 sizes are in the README and raw results.
These include fixture/A-adapter code and an unstripped Node executable; they are
neither a release size promise nor a measured upload time.

Node's [24.17.0 SEA documentation](https://nodejs.org/download/release/v24.17.0/docs/api/single-executable-applications.html)
requires extracting native assets and loading them explicitly; the blob and base
executable must use the same Node version. Keep code cache/snapshot disabled for
target builds. Do not adopt newer Node 26 VFS/SEA instructions into this Node 24
build. Ship Node, node-pty, xterm and other bundled dependency notices.

| Target | Proposed delivery gate |
| --- | --- |
| `linux-x64`, glibc | First v1 target. Native build and SEA smoke on Ubuntu 24.04; separately test the declared oldest glibc/libstdc++ baseline. Only this architecture was measured |
| `linux-arm64`, glibc | Subsequent v1 target, gated on native `ubuntu-24.04-arm`: pinned Node arm64, same lockfile, matching node-pty addon or native node-gyp build, SEA injection, no-system-Node PTY/SSH/snapshot/cleanup tests |
| `darwin-arm64` | Subsequent v1 target, gated on native `macos-15`: Xcode tools, matching Node/addon, embed node-pty's `spawn-helper` as well, executable extraction permissions, remove base signature before injection and re-sign after; strict verification, PTY/reconnect/permissions tests |
| musl / Alpine, Windows remote, Intel macOS | Not proposed for v1. Do not relabel a glibc binary as portable; each needs a separately supported runtime/native build and lifecycle proof |

The experiment ran on glibc 2.39 and did not test a minimum libc. The official
[Node 24 build matrix](https://github.com/nodejs/node/blob/v24.17.0/BUILDING.md)
is the starting point, not proof for the combined addon artifact. Inspect ELF
interpreter/symbol requirements for **both** Node and the addon and execute on the
oldest supported image. A glibc-linked SEA cannot simply run on musl. A custom
musl Node/addon build would be a new supported artifact, not an install-time fix.
No cross-target CI jobs are added by this research.

Upload design: main selects a packaged artifact by validated OS/architecture/libc
and pins its SHA-256 from the app's trusted manifest. After explicit host trust,
upload bytes over SSH stdin to a fixed bootstrap receiver, with length/digest
limits, a unique 0600 temporary file in a 0700 versioned Foom directory, no path
from agent output and no shell interpolation. Verify the hash remotely, then
chmod/atomic rename to an immutable build-hash path and handshake before use.
Never execute a partial download. A reported digest from a compromised host proves
nothing about that host's honesty; it detects transport/staging mistakes under
the trusted-host assumption. TLS/download trust for shipped artifacts and SSH
host-key trust remain separate. Preserve an old running version; upgrading a
binary must not silently stop its terminals. The spike mounts the SEA into the
container; **upload and atomic installation are design-only**, not measured.

Production extraction also needs exclusive temporary staging, no-follow checks
on every parent, ownership verification, atomic publication under a lock, readonly
final assets and a defined noexec-cache error. The probe's hash/file checks are not
a complete defense against a hostile same-user process or parent-directory swap.

## 5. Versioning and herdr dependency surface

B's first frame should be a bounded hello containing protocol major, exact app
build ID, host build ID, native ABI/platform, xterm/serializer versions, daemon
instance ID and a connection nonce. Main checks all required fields before any
terminal or relay operation. Unknown capabilities and mismatched builds refuse;
there is no downgrade to raw PTY input. The prototype implements only the exact
`spike-1` match and asserts rejection of a wrong version. Full schema/digest
negotiation is design work. A nonce correlates a connection; SSH and private
socket permissions, not the nonce, authenticate it.

For A the required public surface is `workspace.create` with cwd/env and stable
pane/terminal IDs; `terminal session control` JSON input/resize/release plus ANSI
frames (`seq`, dimensions, full/delta, bytes); full-screen reattachment; lifecycle
inventory and exit; API metadata/schema and server identity; and private socket
selection. Event subscriptions need explicit loss detection/resnapshotting.
Foom would also need proven launch command-array support (the schema has
`LayoutPane.command: Vec<String>`), resize ownership, bounded output and exit
cleanup. This probe supplies a fixed fixture shell, **not arbitrary real-provider
launch argv through that layout API**. Avoid `pane run` shell strings, herdr
`agent prompt` as follow-up authorization, global integration installation, and
herdr's remote SSH defaults where they disagree with Foom policy.

The read-only reference is commit `ff83689f1512f11b762fe52fb3a0032e7373c35e`
(version 0.9.3); the measured release binary has its own recorded SHA-256. The
release history shows why “any 0.9.x” is not an adequate compatibility promise:

| Release | Dated changes relevant to an adapter |
| --- | --- |
| [0.9.0](https://github.com/herdrdev/herdr/releases/tag/v0.9.0), Sep 7 | Saved SSH machines and independent client views; endpoint-generation/capability compatibility; subscriptions begin live rather than replaying old events |
| [0.9.1](https://github.com/herdrdev/herdr/releases/tag/v0.9.1), Sep 16 | Machine CLI forwarding, remote incremental updates and stale-screen/reconnect fixes; stalled terminal observers disconnect after 30 seconds |
| [0.9.2](https://github.com/herdrdev/herdr/releases/tag/v0.9.2), Sep 29 | Removed pane graphics API; changed remote row updates/compression; subscription overflow reports `events_lost`; terminal-session mouse events added |
| [0.9.3](https://github.com/herdrdev/herdr/releases/tag/v0.9.3), Sep 29 | Escape/Alt input hotfix; this is the measured binary |
| [0.9.4](https://github.com/herdrdev/herdr/releases/tag/v0.9.4), Oct 13 | Server SIGHUP survival, typing latency and process exhaustion behavior changed |
| [0.9.5](https://github.com/herdrdev/herdr/releases/tag/v0.9.5), Oct 14 | Codex turn-hook installation removed in favor of screen detection; input and named-session detection fixes |

Six releases in roughly five weeks include transport, lifecycle and detection
semantics, not just cosmetics. Latest inspected is 0.9.5; 0.9.4/0.9.5 were not
executed. The 0.9.3 persistence result used our detached launch, not a claim that
its unwrapped shell-started server survives SIGHUP. Pin a tested range, negotiate
features and run a compatibility matrix before selecting A; no automatic server
replacement or global integration changes on a failed handshake.

## 6. Remote Git and WorktreeService (design only)

Keep local main as policy owner. Introduce a host-scoped repository identity and
a typed execution interface beneath WorktreeService; do not prepend `ssh` to
arbitrary existing shell strings. Main validates branch syntax, registered host
and repository, approved root, operation scope, expected identity/revision and
confirmation. Send only closed operations with argument arrays to the selected
host; the host repeats path/branch validation and invokes Git with execFile-style
arguments. No arbitrary executable, environment, cwd, shell, remote URL or force
flag from the renderer or agent becomes a transport command.

Resolve canonical paths, `.git`/common-dir membership, symlinks, device/inode/birth
facts and NUL-delimited status **on the remote filesystem**. Main's local realpath
cannot validate remote paths. Namespace every returned ID by pinned SSH host key,
account, host generation and repository; never treat `/repo` on two machines as
the same repository. Remote facts are untrusted observations: main can enforce
its allowlist and confirmation rules, but cannot prove them true on a compromised
host. Trusted UI must name the machine and display paths/status as text.

Preserve repository/branch locks, expected commit checks, dirty/locked/main-worktree
refusals, before/after-confirmation identity rechecks, PTY exit barriers, remote
Git timeouts, idempotency intents and indeterminate outcomes. Keep allowlisted
roots and authorization in main; a remote `approved`, clean status or success
message grants no new local privilege. Forge lookups use main-selected repository
identifiers and their existing credentials locally; no forwarding of local SSH
agents, Git credentials or arbitrary local files. A host needing Git network
access uses explicitly provisioned remote credentials. Do not implement automatic
synchronization, local path mirroring or credential copying as part of v1.

## Security model

A pinned host key identifies a remote account endpoint, not trustworthy code.
A compromised remote can read its PTYs/files and launch environments, steal all
credentials deliberately sent there, forge terminal/hook/Git evidence, drop or
reorder frames, lie about its version/hash and use its still-valid scoped Foom
capabilities. It can deny service. A 0600 socket isolates other Unix accounts,
not root or a malicious process under the same UID. Herdr is Apache-2.0 but a
third-party runtime is still part of this trust surface.

A compromised remote must **not** get local terminal input, another host's grants,
local shell execution, arbitrary network forwarding, host-key acceptance, a
higher role, approval dismissal or permission/merge authority merely by sending
messages. Main binds remote tokens to host/account/launch/repository/generation,
checks the same service policy on every request, and owns trusted confirmations.
There is no remote-to-local arbitrary command or URL proxy. Human terminal input
is a distinct capability from agent follow-up; preserve the Reply gate and
[child-follow-up](child-follow-up.md) constraints. Availability is not authority.

Bound/decode frames outside renderer authority; validate before allocation and
main dispatch; keep terminal parsers and UI in their existing process boundaries.
Never interpret output as a bootstrap script, environment override, path command,
clipboard permission or instruction. Renderer receives only typed display state
through the sandboxed bridge; no secret or SSH handle. Reject malformed/oversized
or unknown frames and stale terminal generations, limit queues and CPU, and make
failure visible without affecting unrelated local terminals. Do not trust remote
state to report a local confirmation as approved.

The terminal byte stream necessarily travels over SSH to the user's selected
machine; this is a new explicit product privacy disclosure, not sending terminal
content to a model. Existing orchestrator tail disclosures still apply. Keep
snapshots transient and logs metadata-only. Any locally persisted secret uses
safeStorage; remote capability tokens stay launch-scoped/in memory, not in config
or uploaded files. Host credentials and trust enrollment need a separate reviewed
UX; this spike's temporary key files contain test credentials only.

## Phased candidate issues

These are proposed issue scopes, not filed issues or authorization to implement.
No open implementation dependency was started by this research.

| Phase | Dependencies | Acceptance criteria |
| --- | --- | --- |
| Approve remote scope/privacy/lifecycle policy | Review this spike and current architecture/product rules | Host/account trust and key-change UX; remote quit/reconnect behavior; separate terminal/control grants; explicit unsupported platforms; docs updated in that decision PR |
| Package and harden host artifacts | Approved B choice | Linux x64 native SEA, addon/cache integrity, licenses, no-system-Node smoke, oldest libc evidence; then arm64 Linux/macOS native runners and signed artifacts; no silent install/update |
| Specify transport and implement fixture-only daemon | Policy + artifact contract | Closed bounded schemas, exact version/build check, one-writer/resize rules, fair flow control, disconnect persistence, ordered snapshots, fault injection, process cleanup and no raw-shell fallback |
| Add main remote terminal backend | Verified daemon/protocol | ID-scoped renderer bridge unchanged, parser/snapshot parity, visible disconnected/stale state, host identity binding, real Electron tests, crash/restart/quit tests without touching real remotes |
| Add remote WorktreeService backend | Host identity and transport | Path/membership validation on host, policy/confirmations in main, multi-host isolation, dirty/deletion race and lost-ack/idempotency tests, no credential forwarding |
| Relay per-launch hooks and MCP | Existing control/hook validators + reviewed remote manifest capability | Real local validators under fixture tests; separate tokens and role scopes, hostile remote fields, revoke/takeover/expiry, disconnected approvals, rate limits, reauthorization after app restart, no remote authorization |
| Verify provider/platform compatibility and expose UI | All earlier gates | Explicitly authorized human-run provider evidence; Linux/macOS target matrix; no claims from fixtures about real provider behavior; ordinary permissions preserved |

If B cannot meet the artifact or terminal-performance gates, revisit A with a
pinned herdr compatibility matrix and an independently reviewed snapshot/policy
adapter. Do not choose a weaker authorization model to avoid implementation work.
