# Herdr terminal backend spike (#159)

## Decision and scope

Route A is viable for **independently sized tiles spanning different Herdr
workspaces**. One Foom utility process can own several CLI control children; each
child owns one terminal's real PTY size. Herdr's TUI does not override that size
while the control stream owns it. The stream is an ordered **screen repaint**
protocol, not a PTY transcript. Foom must replace its scrollback and input-mode
assumptions, not just substitute a process for `node-pty`.

Recommend **Herdr 0.9.3 as the initial supported minimum**, with matching client and
server, protocol 22, plus startup capability and command probes. This is a tested
baseline, not a claim that every earlier version fails. The 0.9.2 release added
`terminal.mouse`; 0.9.3 fixes Escape-key sequences. Production adoption needs the
follow-ups below, especially input modes, hidden activity, reconnection and
cross-platform verification. This research does not change the architecture
currently specified in `product.md` and `architecture.md`.

Measured on 2026-10-05 on Linux x64, Node 24.17.0, Electron 44.4.5, xterm.js 6.0.0, Intel
Core i7-14700KF. Installed `~/.local/bin/herdr --version`: `herdr 0.9.3`.
Its SHA-256 matches the published Linux x64 release:
`18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7`.
Source review used the read-only checkout at
`/var/www/html/scott/foom/inspiration/herdr`, commit
`ff83689f1512f11b762fe52fb3a0032e7373c35e`.

All live probes used **`--session foom-spike` with a fresh private
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` under `/tmp/foom-herdr-*`**, its own
configuration, API socket and client socket. Inherited `HERDR_*` context was
removed before launch. Test shells ran Bash without profiles or rc files. No
user-session pane was inspected or controlled; no global Herdr, agent or shell
configuration was edited; no integration installer or updater was run. TUI probes
used a synthetic PTY, and Electron ran under Xvfb with its sandbox enabled.

The [prototype README](../spikes/herdr/README.md) gives exact commands. Committed
[research evidence](../spikes/herdr/results/research.json) contains request results,
base64 frames and decoded ANSI; [sizing evidence](../spikes/herdr/results/sizing.json)
contains real `stty size` observations. These are synthetic terminal contents,
not user-session captures. Distinguish **observed** results below from
**source-reviewed** behavior and **unverified** deployment claims.

## 1. Frames, history and wheel routing

Observed CLI contract:

```text
herdr --session foom-spike terminal session control w1:p1 --cols 80 --rows 24
herdr --session foom-spike terminal session observe w1:p1 --cols 80 --rows 24
```

Stdout is NDJSON. A frame contains `type: "terminal.frame"`, integer `seq`,
`encoding: "ansi"`, `width`, `height`, `full`, and base64 `bytes`. Closure is
`{"type":"terminal.closed","reason":"..."}`. Stdin accepts one JSON command
per line; releasing stdin also detaches. Error diagnostics can be on stderr.
A rejected controller can exit **zero** after emitting `terminal.closed`:
process exit status alone is not successful attachment.

First frame and size changes were full repaints. Ordinary edits and scrolling
were incremental, cursor-addressed cell diffs. Example decoded fixture fragment:

```text
ESC[?2026h ESC[?25l ESC]8;;ESC\ ESC[1;1H
ESC[0;39;49m FIDELITY ESC[0;38;2;18;52;86;49m TRUECOLOR
ESC[0;39;49m 界 ... é ...
ESC]8;;https://example.invalid/foom ESC\ LINK ESC]8;;ESC\
ESC[0m ESC[3;1H ESC[5 q ESC[?25h ESC[?2026l
```

Spaces above separate sequences for readability; exact bytes are in the evidence.
This is regenerated ANSI: synchronized output, cursor moves, SGR, text and OSC 8,
not the application's original writes. The encoder remembers its last frame.
**Do not drop intermediate frames** or overwrite a pending delta with a newer
one. A full repaint is not necessarily an erase-display sequence. Resize xterm
and apply that frame in the same ordered write queue; resizing it ahead of older
writes produced visible stale/wrapped rows during prototype development.

xterm's local scrollback is not real history: absolute-position repaints do not
replay the terminal's output stream. The prototype uses `scrollback: 0`, prevents
native wheel scrolling and sends:

```json
{"type":"terminal.scroll","direction":"up","lines":15,"source":"wheel","column":4,"row":3,"modifiers":0}
```

After printing 100 numbered lines, this exposed older Herdr history (60–86 in the
91×27 CLI probe). `pane read --source recent-unwrapped --lines 40` is a distinct
history API, not a source for reconstructing the visible frame stream. The
renderer should keep selection/copy of visible cells but retire local history
navigation and the existing alternate-screen wheel heuristic. Herdr routes the
wheel to host history, application mouse reporting, or alternate-screen cursor
keys based on its own terminal modes. `source: "page_key"` supports page-key
routing; it is source-reviewed, not independently exercised here.

Source: [CLI wire format](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/client/terminal_sessions.rs),
[ANSI diff encoder](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/protocol/render_ansi.rs),
[input and scroll routing](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/server/pane_input.rs).

## 2. Fidelity and input

| Feature | Evidence and integration consequence |
|---|---|
| Truecolor | Observed `38;2;18;52;86` in generated frames; xterm parsed the fixture text. Exact rendered color was not pixel-sampled. |
| Wide and combining text | `界` and `e` + U+0301 survive generated frames and the xterm buffer. Font-specific emoji/complex grapheme widths were not exhaustively tested. |
| Alternate screen | Fixture entered 1049 and restored the shell on exit; view displayed it, but xterm's buffer stayed `normal`. Herdr owns the alternate screen; do not infer application state from the display xterm. |
| Mouse | Explicit zero-based `{action:"down"/"up",button:"left",column:4,row:3}` reached the fixture as SGR `ESC[<0;5;4M` / `...m`. Browser clicks also reached it. xterm reports `mouseTrackingMode: "none"`; forward logical mouse events to Herdr. Drag/motion and modifiers have protocol support but were not exhaustively tested. |
| Bracketed paste | Application's `?2004h` is not forwarded; xterm reports false. Sending a complete `ESC[200~pasteESC[201~` input record reaches the enabled fixture correctly. The prototype intercepts paste and sends that complete record; Herdr recognizes it and uses its mode-aware paste path. Plain `onData` alone would lose paste semantics. OS clipboard/IME and disabled-mode/multiline paste need further tests. |
| Cursor | Shape `CSI 5 SP q`, final position and visibility are encoded. The CLI fixture also explicitly hides the cursor; scrolled history hides it. Cursor appearance was not checked across OS/font combinations. |
| OSC 0/2 title | Original OSC is absent from frames. `pane get` supplies `terminal_title` / stripped title; do not rely on xterm's title callback. |
| OSC 9;4 progress | Original sequence is absent from frames. Source retains title/progress as detection evidence. Public `PaneInfo` has no numeric progress field; do not promise a percent-complete UI from this stream. |
| OSC 8 hyperlinks | URL and linked text survive the frame encoder. Opening a link was deliberately not implemented; production must validate schemes and require user action before external navigation. |
| Keyboard modes | ASCII typing/Enter work. Application cursor/keypad, enhanced keyboard protocols, focus reporting, IME and modifier combinations are **not verified**. Frames do not advertise those modes; direct input otherwise passes bytes through. This needs an explicit input contract before shipping arbitrary agents. |
| Graphics/clipboard | The NDJSON client ignores `ServerMessage::Graphics`. Kitty graphics, image paste and OSC 52 are not verified features of route A. Do not install arbitrary OSC handlers in the renderer. |

Source: [OSC metadata tracker](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/pane/osc.rs),
[public pane schema](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/api/schema/panes.rs).

## 3. Performance

Final sequential runs at a 900×640 content viewport:

| Run | Browser frames / ~10 s | RAF p95 / max | Long tasks | Echo p95 | Stream frames on flooded panes |
|---|---:|---:|---:|---:|---:|
| PR #138 baseline | 601 | 16.7 / 16.8 ms | 0 | 47.01 ms (10/10) | Not reported |
| Six workspaces, two repeating floods | 601 | 16.7 / 16.8 ms | 0 | 48.0 ms (10/10) | 6 / 6 |
| One repeating flood, probes in that pane | 601 | 16.7 / 16.8 ms | 0 | 48.5 ms (8/10; two misses) | 18 |
| Six workspaces, two numbered floods | 601 | 16.7 / 16.8 ms | 0 | 48.2 ms (10/10) | 499 / 503 (~50/s each) |

The original flood completed about 4.65 MB per pane over 12 seconds (about
388 kB/s). Numbered floods completed about 4.24 MB per pane (about 354 kB/s).
The numbered case emitted 62,992 / 61,503 decoded ANSI bytes during the sampled
window. Idle tiles emitted zero frames unless typed into. Results show the
prototype kept up with these loads; they do not establish packaged-app parity.
See `results/six.json`, `results/one.json`, and `results/six-vary.json` for all
samples, frame counts, decoded byte totals and flood completion counts.

The baseline is [PR #138](https://github.com/scott-r-lindsey/foom/pull/138): packaged
Foom, six tiles, two floods for 12 seconds at approximately 388 kB/s each, a ten
second sample, 900×640 viewport on this CPU. It recorded 601 browser frames,
16.7 ms p95 / 16.8 ms maximum animation interval, zero long tasks, and 47.01 ms
p95 input-to-render over ten probes.

The prototype uses the same checked-in `tests/electron/tile-flood.js` workload,
six separate workspaces and one controller per tile. Its quiet input target is
tile three. It uses xterm's default DOM renderer, no WebGL addon, plus a local Node
HTTP/SSE broker and sandboxed Electron; it is **not packaged Foom** and lacks its
React board, evaluator and utility IPC. Latency ends at a browser animation frame
after xterm's parsed buffer contains the echo, whereas #138 polled DOM text.
These are informative observations, not statistically equivalent benchmarks.

Identical flood lines mostly leave the screen unchanged, so Herdr suppresses
most frames despite high PTY throughput. The additional `six-vary` workload uses
numbered lines at 100 lines / 20 ms to force cell changes. Browser RAF rate and
Herdr stream frame rate are separate measurements. For `one`, probes target the
flooding pane itself: a missed 400 ms echo can have been overwritten before any
sampled screen exposed it. Report misses, not an invented latency for them.
The p95 in that file is conditional on successful observations, not an overall
keypress latency guarantee. The bounded workloads do not test slow-reader queue
exhaustion, remote latency, CPU saturation or long-running memory growth.

## 4. Ownership and independently sized mixed-workspace tiles

**Observed:** one parent Node process held concurrent controller children for
`w1:p1`, `w2:p1`, and `w3:p1`, all in different workspaces. Each ran a synthetic
redrawing application which executes `stty size` inside its own PTY at startup
and on `SIGWINCH`. Dimensions below are columns × rows (`stty` prints rows first).

| Step | Workspace 1 | Workspace 2 | Workspace 3 |
|---|---:|---:|---:|
| Controls attached and individually resized | 100×30 | 61×17 | 133×41 |
| Resize only workspace 2 | 100×30 | 72×19 | 133×41 |
| TUI attaches, focuses each workspace/tab, shrinks from 120×40 to 60×20 | 100×30 | 72×19 | 133×41 |
| Foom resize while TUI remains attached | 88×23 | 72×19 | 133×41 |
| Release workspace 3 control while its tab is focused | 88×23 | 72×19 | **59×18** |

Only actual Foom resizes generated `SIGWINCH` before release. The TUI's own focus
and resize did not change controlled PTYs or trigger application reflow. Releasing
workspace 3 restored the TUI's tab geometry and generated `SIGWINCH`; the fixture
redrew at 59×18. This is observed PTY/application behavior, **not a real Claude or
Codex reflow test**. Agents normally responding to `SIGWINCH` should behave
similarly; their rendering and retained history still need verification. The
TUI may display a differently sized/cropped projection while Foom owns geometry;
we did not conduct a visual usability review of that projection.

The [sizing harness](../spikes/herdr/sizing.cjs.txt) asserts all three sizes and
absence of unrelated resize signals. Its [raw result](../spikes/herdr/results/sizing.json)
records the TUI resize and every `stty` observation. A separate CLI probe attached
an observer alongside a controller and a TUI: the writable controller retained
91×27, including after the TUI resized. The observer kept an 80×24 view while the controller owned a 91×27 PTY;
observation does not acquire a size lease.

A second control request without `--takeover` received:

```json
{"type":"terminal.closed","reason":"terminal attach failed: terminal ... already has an attached client; retry with --takeover"}
```

A replacement using `--takeover` closed the original with `terminal attach taken
over`. `terminal.release` yielded `detached`; an ordinary fresh control then
succeeded. Foom can detect loss, disable input immediately and offer an explicit
reclaim action. Never run an automatic takeover loop against a user's TUI or
another Foom window. Normal TUI viewing/focusing is not a direct-control takeover;
TUI input is also not an access-control boundary around the pane.

**Recommended size policy:** Foom's layout stays entirely independent of Herdr's
tab layout. A dedicated Foom workspace/tab per pane is not needed to isolate
size: the direct-control lock belongs to the terminal. Map each tile to a server-qualified terminal and maintain one size
lease through its control child. Measure actual xterm cell dimensions, coalesce
resize requests per tile, and send final `terminal.resize` to that child. Accept
the resulting frame dimensions and resize/write xterm in frame order. Other
visible tiles, even in other workspaces, keep their own leases. Read-only peeks
use `observe` and never resize the PTY. Maximize keeps the child and intentionally
resizes only that terminal. On hide/close, release the view, not the terminal;
a TUI may then resize it, so hidden size is not guaranteed. If Foom later requires
retaining hidden geometry, that is a separate lease-lifetime/product decision.

Source establishes why this works: direct attach inserts the terminal into
`direct_attach_resize_locks` and resizes its runtime; UI layout skips locked
terminals. On detach, Herdr removes the lock and restores shell-tab geometry.
See [ownership implementation](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/server/headless.rs)
and [tab layout size guards](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/ui/panes.rs).

## 5. Lifecycle, workspace mapping and capability discovery

Observed workspace creation, worktree creation and pane splitting used an empty
Git repository created only inside the private test directory:

```text
herdr --session foom-spike workspace create --cwd <repo> --label "Foom spike" --no-focus
herdr --session foom-spike worktree create --workspace <returned-id> --branch spike-child --path <private-path> --no-focus
herdr --session foom-spike pane split <returned-pane-id> --direction right --cwd <repo> --no-focus
```

Use returned IDs, never infer them. Worktree responses include `repo_key`,
`repo_root`, `checkout_path`, linked-worktree identity and the associated workspace.
Map Foom repository → canonical repository identity; checkout → Herdr workspace;
terminal → server identity + terminal ID, with current workspace/tab/pane handles
as mutable topology. Herdr pane moves can change public pane IDs. Foom's tile
layout must not be stored as a Herdr tab layout. Reconcile existing and external
worktrees; retain Foom's destructive-action confirmation and dirty checks.

`agent start <name> --kind codex --pane <id> -- <native-args...>` requires an
available shell and waits for detection/readiness; it does not create a pane.
Agent names are live, server-local identities. **Source-reviewed only:** no real
coding agent was launched or prompted in this spike, so agent readiness, hook
coexistence, per-launch configuration and resume are follow-up tests. Foom should
call Herdr using `execFile`/spawn argument arrays and validate paths/branches before
use; never make a shell command from untrusted agent output or an event payload.
Do not use `integration install` as part of preflight.

Observed socket requests are newline-delimited JSON:

```json
{"id":"spike","method":"ping","params":{}}
{"id":"events","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.created"},{"type":"worktree.created"}]}}
```

`ping` reported version `0.9.3`, protocol `22`, and capabilities `live_handoff`,
`surface_interest`, `health_check`, `ssh_agent_registration`,
`endpoint_protocol_generation: 1`. `detached_server_daemon` was false initially,
true after handoff. These are **not** a complete feature list for NDJSON terminal
controls; also probe command availability/attachment and runtime-validate frames.
Do not infer server version from `herdr --version` alone.

Subscription acknowledgement and pane/worktree-created events arrived while
control streams remained open. Subscription selector names use dots, while
observed event names use underscores. Source documents an `events_lost` error for
a reader that falls behind. Subscribe before obtaining/reconciling the inventory,
then apply queued events; on loss or disconnect, fetch a new snapshot. Validate
IDs, revisions and payload bounds. Agent status subscriptions are pane-scoped;
add/remove them as topology changes. Status delivery under a real agent workload
was not tested.

| Event | Observed stream result | Required Foom behavior |
|---|---|---|
| Normal release | `terminal.closed`, reason `detached` | Dispose local view; leave terminal running. |
| Graceful server stop | `terminal.closed`, reason `server is shutting down`, exit 0 | Disconnect all views; do not treat as agent success. |
| Same-version `server.live_handoff` | API returned `ok`; streams closed with `live update in progress; reconnect after handoff completes`; fresh observe worked | Suspend input, poll readiness with backoff, refresh inventory, attach a fresh baseline. Do not replay unacknowledged input. |
| Stop and restart | Workspaces/worktree topology restored | Re-resolve live terminal IDs/processes; restored layout does not prove process continuity. |
| SIGKILL of harness-owned server | Stream EOF, exit 0, **no `terminal.closed`** | EOF itself is loss of service. Never wait exclusively for a close record. |

The handoff used the same installed executable and private server API, **not
`herdr update --handoff`**, which can enumerate multiple running sessions. The
record confirms the same shell PID (148653) before/after handoff. Cross-version migration,
rollback, power failure, agent conversation restoration and recovery of a
partially delivered command were not verified. Ordinary restart kills/recreates
terminal processes; persistent sessions survive front-end detach, not arbitrary
server death with identical process continuity.

## 6. Preflight installation and updates

A remote installer script is unnecessary. The
[published manifest](https://herdr.dev/latest.json) and
[v0.9.3 release assets](https://github.com/herdrdev/herdr/releases/tag/v0.9.3)
provide Linux/macOS x86_64 and aarch64 binaries and a Windows x86_64 ZIP, with
SHA-256 digests. GitHub's release API also reports the same digests. The existing
Linux binary matched; this spike did not install/replace any binary. No detached
signature asset was present in that release listing. A checksum from the same
HTTPS distribution is integrity evidence, not independent publisher authentication.

Proposed preflight: prefer an existing compatible absolute executable; otherwise
download a pinned platform asset to a private staging directory, require the
published digest, check it before execution, validate extraction paths on Windows,
then atomically place it in a user-writable location. Use `~/.local/bin/herdr` on
Linux as one supported choice; on macOS either a user-managed binary or Homebrew;
on Windows a versioned user application directory. Preserve installation ownership:
if Homebrew owns it, offer `brew install herdr` / `brew upgrade herdr` instead of
overwriting the Cellar. Preflight must explicitly add the selected directory to
**Foom child-process PATH**, or invoke its absolute path; GUI PATH need not include
shell startup additions. Do not modify shell rc files or global PATH automatically.

Source-reviewed `herdr update` downloads a release selected from its manifest,
checks SHA-256, and atomically replaces a writable Unix executable; existing
servers keep their old image unless separately restarted/handed off. It gives
restart guidance, detects Homebrew ownership, and uses a Windows-specific install
flow. Foom must compare client and server again after an update. Never silently
restart or upgrade someone else's session. This spike verified same-version
handoff only, not updater behavior or platform installation.

Although the issue calls Windows beta, the current [Windows support page](https://herdr.dev/docs/windows-beta/)
now calls native Windows generally available. It explicitly lists **live handoff,
direct `terminal attach`, Unix foreground process groups, a local Herdr clipboard
image bridge, and signed/SmartScreen-friendly binaries as unsupported**. CJK IME,
cursor behavior and live cwd discovery are partial. This does not establish whether
NDJSON `terminal session control` has the same restriction as direct attach: its
CLI path is distinct, and we did not test it on Windows.

The documented Windows installer puts versioned releases under
`%USERPROFILE%\.herdr\packages\standalone\releases` and keeps
`%LOCALAPPDATA%\Programs\Herdr\bin` as a compatibility alias. It updates PATH for
future processes; Foom must still select the executable explicitly. The release
has no Windows ARM64 asset. ConPTY, named-pipe ACLs, resize, input, agent launch and
recovery require native tests; Linux `stty` and socket tests do not cover them.
macOS binaries and Homebrew are likewise source/metadata-reviewed, not exercised
here.

Source: [updater](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/update.rs),
[Windows beta guidance](https://herdr.dev/docs/windows-beta/).

## 7. Trust and pane environment

Herdr's Unix sockets are owner-only (0600), but any process running as that user
can request input, close panes, read history or compete for control. Foom's
per-window IPC checks still protect its renderer, but they do **not** make Herdr
terminals exclusively accessible to that window or to Foom. A renderer must never
receive a raw socket, executable/path selector, arbitrary API method, or global
Herdr credential/capability. Main resolves authorized terminal IDs and a narrow
operation allowlist; the utility broker talks to a fixed server identity. Treat
frames, metadata, agent status, links, titles and subscription records as
untrusted data. Bound JSON/ANSI and queued writes; reject malformed dimensions,
encoding and identity; dispose a desynchronized stream and reattach for a fresh
baseline instead of dropping deltas. Do not turn titles/status reasons into
instructions or HTML.

The socket also provides an SSH-agent proxy. Observed `SSH_AUTH_SOCK` in a pane
points to `<private-session>/herdr.sock.agent`, replacing the inherited socket.
It is a forwarding capability, not a copy of a key. Remote registration lifetime
and disconnect behavior require dedicated tests; this spike did not exercise SSH
or authenticate to any remote machine.

The complete **Herdr-owned base environment mutations found in source** are:

| Action | Variables |
|---|---|
| Set terminal identity | `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=herdr`, `TERM_PROGRAM_VERSION=0.9.3` |
| Set pane context | `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` |
| Replace on Unix | `SSH_AUTH_SOCK` with the server agent-proxy socket when available |
| Set selected shell for Unix login mode | `SHELL` to the resolved shell; other modes inherit it, and shell startup can separately modify its environment |
| Remove outer-terminal identity | `ITERM_SESSION_ID`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `WT_SESSION`, `TMUX`, `TMUX_PANE`, `STY`, `ZELLIJ`, `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID` |
| Remove outer-agent identity | `CODEX_THREAD_ID`, `OMPCODE`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN` |
| Windows Git Bash marker | `HERDR_PANE_RUNTIME_ID` (source-reviewed; not set on Linux) |

`HERDR_SESSION=foom-spike` and the private `HERDR_CONFIG_PATH` are also inherited
by the observed panes; the harness supplied private XDG paths. User-specified
launch `--env KEY=VALUE` entries are applied as well; these can deliberately
restore agent identity after the default removal. Base context/managed pane IDs
are then set by Herdr. General environment values, including unrelated credentials,
are otherwise inherited; this is not an environment sandbox. Per-agent integration
launch additions and arbitrary user shell startup effects are outside this base
list and remain unverified. The committed probe prints only an allowlist of
non-secret values, never the full inherited environment.

Source: [pane environment](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/pane.rs),
[base integration environment](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/integration/env.rs),
[socket permissions and selection](https://github.com/herdrdev/herdr/blob/ff83689f1512f11b762fe52fb3a0032e7373c35e/src/server/socket_paths.rs).

## 8. What moves to Herdr, and what Foom keeps

| Area | Proposed responsibility after the architecture PR |
|---|---|
| Utility PTY host | Retire local PTY creation, canonical headless xterm, parser backpressure and terminal history ownership. Keep a utility-process broker for CLI children, ordered frame delivery, bounded queues and disconnect handling. Herdr keeps terminals running without attached views. |
| Terminal IPC | Keep typed, runtime-validated, terminal-ID-scoped preload/main authorization. Replace raw PTY stream/resize/history internals with control/observe operations. Avoid exposing generic Herdr API access to the renderer. |
| Attachment/throttling | Keep one mounted display xterm and its imperative ordering. Replace Foom host attachment tokens with local generations around Herdr leases. Never pause a PTY for a hidden view. View backpressure must preserve deltas or reconnect. |
| #115 resume | Delegate persistent terminal sessions, layout restoration and supported native-agent resume mechanics to Herdr. Keep Foom UI placement and metadata reconciliation. Agent resume after restart is not yet verified here. |
| #119 control plane | Delegate pane/workspace/agent topology and runtime control. Keep Foom's user intent, window authorization and explicit takeover/stop UX. Re-scope the issue around the adapter rather than build a competing terminal control plane. |
| #67 remote | Delegate transport, remote servers, terminal persistence and agent detection to Herdr. Keep Foom machine-qualified identity and connection UX. No live remote route-A test was performed. |
| Worktrees | Use Herdr's worktree operations and repository metadata; retain Foom's repository registration, path validation, dirty checks and removal confirmation. Avoid two competing worktree registries. |
| Evaluator | Keep attention reasons, failures vs successful completion, ambiguous-tail classification, redaction, secret storage, dismissal/reply semantics and feedback log. Herdr's status is evidence, not a Foom verdict. |
| Product UI | Keep the independent mixed-workspace tile tree, sidebar, windows, attention routing, themes and sound. Herdr workspace/tab focus must not rearrange Foom tiles. |

Herdr statuses are `idle`, `working`, `blocked`, `done`, `unknown`; seen/focus state
can distinguish idle from done differently across clients. `blocked` can be an
approval/question, but `done` is not proof that the task succeeded, and `unknown`
is not completion. Foom still needs its own reason and failure classification.
Its evaluator must read only the last 40 quiet lines through a bounded Herdr read,
redact before any model call, and preserve the existing no-files/no-keystrokes rule.
Avoid an alternate-screen history read that scrolls an agent UI just to evaluate it.

**Unsettled contract:** route A supplies frames only while attached, and repaint
bytes do not measure true output volume. The examined subscription schema does
not provide a generic raw-output byte-rate/quiet signal equivalent to Foom's host
activity feed. Do not derive hidden-terminal quietness or sound brightness from
visible repaint counts. Negotiate a Herdr activity/revision/tail interface, or
measure and specify bounded polling, before retiring the current activity path.

## Follow-up tickets to create/re-scope

These are proposed tickets, not claims that new GitHub issues were opened:

1. **Architecture and identity migration:** update product/architecture docs in a
   dedicated PR; server-qualified IDs, repository/worktree mapping, existing
   sessions and the threat-model change. Re-scope #115, #119 and #67.
2. **Terminal view broker:** ordered bounded NDJSON, fresh-baseline reconnect,
   one lease per terminal, cross-workspace sizing, explicit takeover, observe,
   hide/release and multi-window arbitration. Retain renderer IPC security tests.
3. **Input/fidelity contract with Herdr:** modes/semantic keys, bracketed paste,
   IME, alternate-screen wheel, drag/motion/modifiers, cursor/Unicode and safe
   links; state graphics limitations. Validate real Claude/Codex/Antigravity reflow.
4. **Activity and evaluator bridge:** hidden output/quiet signal, bounded
   non-mutating tails, agent state subscriptions, `events_lost` reconciliation,
   failure evidence and per-launch hook coexistence without global integration.
5. **Preflight installer/update policy:** pinned assets/checksum requirement,
   absolute executable/PATH, Homebrew ownership, client/server compatibility,
   explicit update ownership and no automatic global/session mutation.
6. **Lifecycle and platform matrix:** Linux/macOS/Windows, supported agents,
   cross-version handoff and rollback, real server crash/restart, SSH forwarding,
   remote controls and agent resume. Test backpressure/memory over longer runs.
7. **Packaged Foom benchmark after integration:** repeat #138 with identical
   geometry, renderer and input observation; include changing content, hidden
   sessions, slow consumers and remote links before making a WebGL decision.


## Local validation and delivery boundary

- `npm ci` with Node 24.17.0; no dependency or lockfile changes.
- `npm run format`, `npm run lint:fix`, and `npm run check`: passed;
  911 unit tests passed, 3 skipped, plus 6 CI-selection tests.
- `npm run test:coverage`: passed per-file gates; 99.41% lines, 99.11%
  statements, 98.36% functions, 96.9% branches.
- `xvfb-run -a npm run test:electron`: all 41 passed, with sandboxing enabled.
- `npm run make`: passed, Linux x64 development ZIP created.
- Fixture syntax checks, live research/sizing/browser probes and `git diff --check`:
  passed. All test-session API sockets were unreachable after cleanup.

The first sandboxed `npm run check` failed because loopback listeners were denied
with `EPERM`; the complete run outside that filesystem/process sandbox passed.
Electron's own sandbox stayed enabled throughout. Only this document and
`spikes/herdr/` are delivered; `src/` and existing build/lint/coverage settings are
unchanged. These are local results, not a claim of remote CI or cross-platform
Herdr verification. See the PR checks for remote status.
