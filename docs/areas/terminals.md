# Terminals

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/tiles.md).

## Terminals

On macOS, the board window sets `acceptFirstMouse: true`: the activating click
reaches the page and focuses the clicked terminal. It is ordinary mouse input,
including delivery to terminal applications with mouse reporting enabled; there
is no focus-only mouse-report guard. The trusted-dialog child accepts activating
clicks too, subject to the existing [confirmation guards](confirmations.md).
Linux and Windows behavior is unchanged.

[Remote hosts #753](https://github.com/scott-r-lindsey/foom/issues/753) decides
SSH-only transport and persistent remote PTYs. The older [#518 research](../research/remote-machines.md)
is historical; the opt-in phase-1 spike is described below. Settings → Hosts owns registered-host enrollment; see [Hosts](hosts.md).

**Today:** `src/terminal-host/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/main/terminals/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/main/terminals/terminal-ipc.ts` grants registered app windows access to app-owned terminals and enforces exclusive attachments. The first board opens the bundled manual after setup, with no PTY until a launch is requested. Selecting a row places its session in an available tile or focuses its existing tile; Esc remains terminal input. Hiding a tile or entering Settings detaches the stream without stopping the shell. Placing another terminal in an empty tile or returning from Settings drains pending renderer writes, resets the display, fits the visible grid, and restores a fresh host snapshot before continuing the live stream. Input and resize events are suppressed while hidden or changing attachment. The manager and ID-scoped bridge support multiple concurrent sessions; the board consumes live worktree and verdict data. Closing a window detaches its views; the last window requests quit on Windows/Linux and keeps the app alive on macOS. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals; once a termination request succeeds, shutdown and retries only drain its native exit callback, because closing a ConPTY handle twice can crash the host. A throwing termination request remains retryable. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their process handles and exit subscriptions even after a terminal is removed from the board. Confirmed quit applies the same graceful termination and force-kill deadlines to these removed processes and waits for their pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- A tile fully covered by a maximized sibling keeps its attachment and renderer parser live, but hides only the xterm screen after the tile's fade. Chromium skips the hidden screen's layout and paint; xterm's visibility observer defers regular refreshes and requests a complete repaint on restore. Selection/resize work may still update the backing renderer while covered. The outer fitting box retains its geometry, including during window resizing; output, acknowledgements, scrollback and selection remain owned by the same xterm. Reduced motion hides the screen immediately. Native window occlusion policy is unchanged.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Color state also belongs to the host: OSC 4 (palette) and 10/11/12 (foreground/background/cursor) queries, sets, and 104/110/111/112 resets use shared public-parser handlers. Only the host handler writes replies; the renderer handler applies colors without answering queries, including mixed set/query commands. Colors accept xterm-compatible hex and `rgb:` forms; unsupported names and malformed entries are ignored. The palette starts with xterm's 256 defaults, and foreground/background/cursor use the brand ink/bg/accent tokens. Main sends the resolved terminal palette on creation and validated, terminal-ID-scoped updates on changes. A terminal palette replacement resets application-set color overrides to the new defaults, as the existing browser theme replacement did. Parser barriers order these updates with output, and attachment snapshots include all color state, so changes while hidden appear on reattachment. Keyboard, paste, and mouse input are not filtered.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. The host and renderer both default to a blinking block cursor. The host supplements serialization with cursor blink options and DECSCUSR overrides, scrolling margins for both buffers, and restores origin mode before positioning the active cursor. Cursor overrides use a checked, pinned xterm internal representation because the public modes API and serializer omit them. Renderer control updates preserve application cursor choices; exited views hide the cursor and disable blinking. A pending right-edge wrap is recreated by replaying the cursor row with the pinned serializer after restoring margins, preserving cell styles and the current pen. Normal-buffer margins are restored before entering the alternate buffer, so leaving fullscreen mode retains normal scrolling. xterm 6 does not expose margins publicly; the snapshot helper checks its pinned internal buffer representation and rejects attachment if incompatible; pending-wrap restoration also checks the pinned addon’s internal row serializer. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The activity meter and last-lines buffer read from the same stream in the host. One 100 ms timer batches changed UTF-8 bytes-per-second rates for all terminals, exponentially smoothed with a 500 ms time constant. Rates decay to zero; the timer sleeps once all meters are quiet and zero. Quiet fires once per output burst after 500 ms for a trailing question, y/n, password, or Enter prompt, otherwise after 2 seconds. New output restarts the debounce; pending parser writes prevent quiet classification. Prompt detection reads the parsed tail once after 500 ms of silence and caches the result until new output, so output delivery never scans trailing blank scrollback. A terminal silent from launch gets its first quiet event after 2 seconds. Exit and removal cancel the meter. These are timing hints, not attention verdicts. Main exposes quiet callbacks for the evaluator and forwards activity only for live owned terminals; view attachment does not affect measurement. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

`node-pty` is pinned to `1.2.0-beta.15` to include the upstream
[ConPTY handle-table synchronization fix](https://github.com/microsoft/node-pty/pull/922).
The stable 1.1.0 release can race native exit watchers against other exits, creation,
resize and termination, crashing the utility host during multi-terminal shutdown.
Replace this prerelease pin with the next stable release containing the fix when it ships.
The exact prerelease pin avoids a local native patch; Electron tests exercise
concurrent terminal exits and shutdown, and all three platforms validate packaging.

The host uses Electron's `utilityProcess.fork`, not a Node child-process fork, so RunAsNode stays disabled. The native node-pty module remains unpacked from ASAR; Windows continues using the ConPTY DLL to avoid its Node helper path. After the native rebuild, packaging restores `conpty.dll` and `OpenConsole.exe` beside the rebuilt addon from node-pty’s matching architecture prebuild; node-gyp clears these postinstall files during rebuild. The three-platform CI matrix runs the packaged executable and tests its PTYs and detached snapshots with the disabled fuse verified.

The stop response includes a validated boolean acknowledging whether the host
signaled a running process; an already exited PTY returns false. Main-owned
review automation uses this acknowledgement to distinguish expected stop exits
from natural failures.

Host requests and responses are validated at runtime and carry terminal IDs; request/reply pairs also carry a monotonic request number. Each attach has a main-generated view generation so late output from a previous view is ignored. Creation IDs are allocated in main. Unknown and duplicate IDs are rejected by the host. Renderer payloads cannot choose executables or working directories. A host exit or 10-second request timeout rejects pending operations, marks live terminals failed (`terminal:exit` code -1), and removes views. Exited terminals are not reclassified. A later create starts a fresh host; old IDs cannot address new sessions. The board displays terminal failures and offers Restart shell for its local shell. Confirmed quit requests native PTY shutdown in the host and reports failures without closing the window, allowing a retry. Shutdown RPC has a 15-second deadline to accommodate the native exit barriers. Final disposal waits for the utility process to exit, with a 12-second fallback for an unresponsive host. Main records abnormal utility exits with exit code and PID plus Electron’s `child-process-gone` reason and native exit code, correlated by a unique service name per host. Electron's utility exit event does not expose a signal. Host failures include the last 8 KiB of the utility process’s own stderr; PTY output, snapshots and tails are never included. Abnormal exit records also appear in Electron test diagnostics/JUnit, including crash details delivered after the utility exit event. An unexpected zero exit still rejects pending operations and is logged; successful final disposal logs neither an exit record nor buffered stderr. App event listeners are released on host replacement or final disposal.

The current main-only launch contract is `TerminalSpec` in [shared/terminal-host.d.ts](../../src/shared/terminal-host.d.ts); renderer callers cannot select executables, cwd or environment. Main authorizes checkout identity before creating the host session.

The base environment removes `npm_*` and `ELECTRON_*` variables. When launching an agent directly, Foom resolves the user's `PATH` from their login shell, because GUI apps on macOS start with a minimal `PATH`.

Wheel input in an alternate buffer without mouse tracking is translated to Up/Down by the
renderer using xterm's public custom wheel handler. Application cursor mode selects SS3
(`ESC O A/B`); otherwise it uses CSI (`ESC [ A/B`). Pixel deltas accumulate into line steps;
line/page deltas are normalized, direction changes and attachment changes reset the remainder,
and one event sends at most 100 arrows. Normal-buffer scrolling, mouse reporting and Ctrl-wheel
retain xterm's handling. Input still passes through the selected terminal's ID-scoped bridge.

The [visible-streaming investigation](terminal-rendering.md#visible-streaming-investigation-711)
profiles parser/render work and records repeated CPU, frame and echo measurements.
Frame-coalesced writes, row containment, compositor promotion and alternative
unfocused dimming were rejected because they did not provide a reliable combined
CPU/latency benefit. The visible write path, token-scoped parse acknowledgements
and backpressure remain unchanged. Prototype tests cover byte-identical mixed-
chunk normal/alternate buffers, delayed ACKs, watermarks and ordered resize stages.


## Terminal context menu (#936)

Right-clicking a terminal opens a pointer-positioned menu: Copy (disabled without
an xterm selection), Paste, Select all and Clear, then a separator and the tile's
existing Split/Grow pads. Clear removes the visible view's scrollback with xterm's
clear operation; it does not send a command to the shell. Copy and Paste focus the clicked terminal, independently of Copy on select.
Copy uses the native clipboard command; Paste shares the explicit main-owned
operation with keyboard paste, preserving xterm's bracketed-paste handling.
Commands are discarded if their view has changed sessions or detached.

With mouse tracking enabled, plain right-click belongs to the running program;
Shift+right-click opens Foom's menu. Without tracking, plain right-click opens it.
On macOS Ctrl+click follows the same rule. Menu-owned presses are captured before
xterm can clear the selection or report them to the program. The menu remains open across xterm
scroll events from focus changes or output. There is no helper copy. Escape and outside clicks dismiss; shared menu focus restoration returns
to the originating terminal, preserving a newer outside focus choice (#903).
The [board rules](board.md) own the unchanged directional controls.

## Image paste (#937)

Keyboard paste and context-menu Paste capture the clipboard only on that explicit
action. Nonempty plain text, including whitespace, wins. With no text, one PNG,
JPEG, WebP or GIF image is normalized to a metadata-free PNG by a disposable
main-owned decoder process; animation contributes its first frame only. No renderer
receives image bytes or arbitrary file access. File lists and unsupported data refuse.
Chromium performs an initial browser-process image decode before these limits;
see the [accepted clipboard residual](privacy.md#image-paste-937). Foom adds no
main-process image conversion and sends encoded bytes straight to its worker.
Limits after clipboard acquisition are 4 MiB encoded and normalized bytes, 8,192 pixels on an axis, 16 million
pixels and 16 retained files / 32 MiB per session. Paste operations are serialized per session, with at most 16 queued gestures;
overflow refuses with a fixed result. Each gesture captures its own snapshot.

Only hand-checked bundled Claude, Codex and Pi launches receive image references.
Shells, other agents and config providers show “Image paste is not supported for
this session.” Text paste is unchanged. Foom inserts exactly one
`[pasted image '<absolute path>'] ` reference with recipient quoting and a trailing
space, using xterm paste and no Enter. It never rewrites or submits the message.
User input is ordered behind a pending paste, so Enter cannot overtake clipboard
preparation; Foom never adds Enter. Failed/cancelled paste discards buffered input
rather than replaying it. The input buffer is bounded to 65,536 UTF-16 units.
Switching/detaching/closing a view invalidates delivery and aborts pending work.

Local PNGs live outside checkouts in a private account/profile temp root with a
random directory per launch. Directories are 0700 and files 0600 on POSIX; Windows
uses current-user-only protected ACLs. Startup purges owned leftovers. Closing the
session deletes its files; hiding a tile does not. There is no age expiry.
Remote images use the existing SSH management path, protocol 3, a rotated
connection-owner capability and a daemon-chosen per-session `.foom-host/images/`
directory. One upload per host is bounded to 60 seconds after negotiation, under
#947's separate bootstrap/operation budgets and abort signals. The daemon checks
canonical base64, PNG dimensions, size and SHA-256; remote paths are never opened
on the hub. SSH loss leaves a live remote session's completed images intact;
actual exit/close and daemon startup own cleanup. See [privacy](privacy.md#image-paste-937)
and the [design and hand checks](../design/937-image-paste.md).

## Remote shell spike (#754)

Every CI/release package carries a same-commit catalog for `linux-x64`, `linux-arm64`,
`darwin-x64` and `darwin-arm64` (#825). Each target has `foom-host.gz` and a
manifest containing app version, protocol, source revision, expanded size/SHA-256
and gzip size/SHA-256. Packaging refuses a partial, mixed-revision, incompatible
or corrupt catalog. Both builders derive the full checkout commit with Git;
packaging requires every included source to equal the app checkout, even outside CI.
Local packages may warn and omit the entire catalog when any entry fails validation
(#848); sealed metadata marks the omission and remote shells refuse with
"Remote host artifact unavailable in this local build." unless a verified explicit
artifact is supplied. The sealed-omission preflight runs before any SSH process;
its fixed application error code survives the transport/client launch path and IPC.
Remote output can never select that diagnostic.
See [local and strict packaging](../validation.md#bundled-remote-host-artifacts-825).
`development` is never a packaged source revision. There are no runtime artifact downloads.

Darwin catalog signing assembles the SEA from verified same-run build inputs
(#851). The node-pty addon and spawn helper are signed before embedding, with the
same identity as the host. Developer ID hosts grant only allow-jit and enforce
library validation; only ad-hoc signatures retain the exception. Extraction keeps
its owner/mode/hash checks. The check and path-based load are still separate
filesystem operations: Developer ID library validation rejects unsigned/other-team
substitutions, while Linux/ad-hoc builds retain that same-UID race. See
[artifact and validation details](../validation.md#bundled-remote-host-artifacts-825).

Launch with `--remote-shell-spike=SSH_ALIAS` to route the **home shell** to that
host. A bounded SSH `uname -s; uname -m` probe accepts only Linux/x86_64,
Linux/aarch64, Darwin/x86_64 and Darwin/arm64. Only those fixed mappings select
catalog paths. The selected manifest must match the app source revision, version, protocol and
remote platform. The expected revision comes from trusted `build/build-metadata.json`
inside ASAR, independently of the unpacked catalog; missing or malformed revisions
are refused. Both compressed and expanded hashes and sizes are checked before
upload. Missing or mismatched artifacts fail closed. Bootstrap rechecks uname on
every connection, including reconnects, before touching the cache or uploading.

For native development, `node scripts/build-remote-host.mjs` with Node 24 on
Linux/macOS produces `build/remote-host/foom-host`, `foom-host.gz` and
`manifest.json`. The optional main-only `--remote-host-artifact=/absolute/path/to/foom-host`
override still requires a valid full source commit and checks version, protocol,
hash and remote platform, but explicitly permits a different commit from the app. Build the app
before building this developer artifact because app builds clear `build/`.
Worktree/config shells and agents remain local. No host, artifact, executable or
environment selection is added to IPC. Settings and host inventory are phase 4.

Darwin hosts use ad-hoc signatures in native, PR and development builds.
#844 amends #825's option C decision because Apple inspects compressed hosts
inside the notarized desktop app. The existing main-only Release signing pass
unpacks and Developer ID signs both Darwin hosts with hardened runtime, secure
timestamps and the dedicated Node remote-host entitlements before sealing the app. It regenerates
and verifies compressed and expanded sizes/hashes, preserving version, protocol
and the source revision pinned inside ASAR. PR CI exercises this pass ad-hoc;
fixture Apple tools test both identities without credentials. No Release
configuration changes. SSH uploads have no download quarantine; bootstrap integrity
still comes from the manifest hashes, including expanded SHA-256 after upload
and on cache reuse. See [signing validation](../validation.md#bundled-remote-host-artifacts-825).

The home row still describes the local home location in this developer-only spike;
the command in quit confirmation identifies `ssh SSH_ALIAS`. Do not infer remote
filesystem membership from the local home row.

System SSH is spawned with an executable plus argument array (`shell: false`),
the streaming equivalent of execFile; unlike execFile it retains no lifetime output
buffer. Host aliases/user@host accept only a narrow ASCII grammar, cannot start
with `-`, and are bounded. SSH uses BatchMode and clears configured forwarding;
the user's own SSH config, keys and agent handle trust. CI and all development
verification use fixture SSH, a controlled PATH and temporary HOME; they never use
real SSH material or hosts. Nothing edits SSH configuration or installs software
system-wide. A fixed, quoted POSIX bootstrap uses head, gzip, SHA-256, and atomic rename
to upload the gzip level-1 artifact through that same stdio connection, into private
`~/.foom-host/<version>/<sha256>/foom-host`. The exact gzip byte count is read before protocol traffic, decompressed into a
private temporary file, checked against the expanded size and SHA-256, then
atomically installed. Failed/truncated uploads are removed. Cached bytes are
hash-checked too.
First-time upload/negotiation has a 120-second transport deadline and a 125-second
shell-create deadline; remote agent creation adds its separate 120-second
preparation/authorization budget to the outer create deadline. Normal terminal
requests retain their 10-second deadline.
No remote text is interpolated into commands. Existing symlinks/unsafe directories
are refused. Linux requires gzip and standard coreutils; macOS uses shasum when sha256sum
is unavailable.

The wire format is a 4-byte unsigned big-endian byte count followed by UTF-8 JSON
`{version:2,message:...}`. Frames are capped at 8 MiB before allocation; invalid
lengths, UTF-8, JSON, envelope versions, payloads and foreign IDs close the channel.
Responses above 65,536 UTF-16 units are transmitted as ordered fragments, each
with terminal ID, offset and total. The client permits one contiguous response
at a time, requires fixed-size chunks except the final chunk, bounds the total
to 32 Mi UTF-16 units (64 MiB of string storage), and validates the reassembled
response before publishing it. Malformed, interleaved or excessive responses
close the channel. The 8 MiB per-frame cap remains unchanged. The daemon writes
one frame at a time, queues live output behind replay, and finishes replay before
acknowledging attach or processing another attachment.
Replay budgets include the complete JSON-encoded response, reset and color state.
If retained history exceeds the message cap, replay falls back to the visible
normal/alternate buffers, cursor and modes, omitting scrollback from that replay.
Blank visible cells retain their background colors in both buffers, including
trailing blank rows omitted by the pinned serializer. The daemon's retained
history is not erased and remains available to tail requests.
Both peers negotiate the SHA-256 build identity before operations. Shell sessions
permit open, attach/replay, input, resize, theme, acknowledgement, screen,
tail, stop and close; they cannot create arbitrary commands or shut down the
daemon. Version 2 also supports the separately authorized [phase-2 agent launch](agent-launch.md#remote-agent-phase-2-755): prepare/start/activate, reduced hooks, typed control calls/replies and validated child input for agent sessions only. Review-enabled remote launches are not supported in phase 2 and fail with
`remote_review_unsupported`: local HEAD/dirty snapshots and forge observations
cannot establish what a different remote checkout reviewed. Host-aware review
snapshots and forge evidence remain future work. Host-aware placement (#756)
does not enable remote review. Every ordinary
remote child launch captures its authenticated parent generation and launch
operation, then synchronously rechecks both immediately before `agent-start`.
Parent exit, revocation, replacement or a non-current operation aborts preparation
and revokes the prepared endpoint/files. Human remote resume likewise retains
only the exact live parent generation.

The daemon chooses its own HOME and environment, and starts an
interactive login shell (`-i -l`): its own `SHELL` if it is an absolute path to an
existing executable regular file, otherwise the account shell from
`os.userInfo().shell` under the same validation, finally `/bin/sh` if neither is
valid (including unavailable account lookup). Neither hub nor protocol selects it.
It supports at most 32 full sessions plus a separate reserve of four pending
connections for negotiation, cleanup and takeover, with at most 36 sockets total.
Pending connections have a ten-second deadline from acceptance, including after
`hello`; only acquiring a live session releases the reserve slot and cancels
that deadline. Cleanup and missing/exited-session queries retain the deadline.
The reserve cannot create a 33rd session. Operations are serialized per connection,
and a backlog above 256 operations is rejected. Only the current connection can operate
on its selected ID. An `open` with an existing ID transfers the session and
disconnects its prior connection; its only protection is the 0600 socket plus an
unguessable terminal ID, so IDs must never be exposed to remote processes through
environment, arguments or files. Phase-2 agents preserve this with separate
per-launch hook/control credentials and sanitized child identities.

The detached per-user daemon owns PTYs, headless screens and independent parser
backpressure. It listens only on a 0600 Unix socket `~/.foom-host/host.sock` under
a 0700 owner-checked directory. HOME must be canonical, owned, nonlinked and not
group/world writable. Socket paths above 100 bytes are refused. No TCP listener
exists. A pre-existing socket is never unlinked during startup; an incompatible
build is refused, including with live sessions. A stale socket after SIGKILL needs
manual removal after confirming the daemon is gone. A new build never kills or
replaces a daemon. SIGTERM/SIGINT stop its PTYs and remove the socket.

Disconnect detaches only the view, so hidden/disconnected shells keep consuming
output. After an established SSH stream drops, the hub makes up to five reconnect
attempts, opening the same terminal ID and replaying a fresh screen with reset,
then live output. Every `open` requires a runtime-validated boolean `reattach`:
first creation sends false, restoration sends true. Its typed `open-result`
reports `live`, `exited` (with the real exit code), or `gone`. A reattach never
creates a shell: a missing or currently removing ID returns `gone`. The hub ends
the tile through its normal terminal-exit path (fixed code -1 for `gone`), without
replaying/resetting its last displayed screen, counting a transport failure or
retrying. An exited tombstone supplies its real exit code instead. No fresh shell
can silently replace a disconnected tile. The PTY owner includes the reset in its counted snapshot, so
renderer acknowledgments account for exactly the bytes it delivered, including
large replay above the view high-water mark. It restores dimensions/theme and
gives the view a fresh token. Only successful completion of all restoration
operations, including the attach result after the complete replay, resets the
retry allowance. An open acknowledgement followed by a replay disconnect still
consumes an attempt; five such attempts terminate the transport and fail the tile.
The 120-second connection deadline remains active throughout reconnect negotiation,
open, state restoration and replay, and is cleared only after all restoration
acknowledgements arrive. An unanswered internal request kills that SSH stream and
consumes an attempt; partial progress does not extend the deadline. All connection
retirement (deadline, protocol/stream/process errors, exit/close and disposal)
invalidates the connection before signalling SSH. Buffered responses cannot finish
restoration or renew the retry allowance. Retirement consumes an attempt once and
schedules retry or terminal failure without waiting for process close. A retired
SSH process receives SIGTERM, then SIGKILL after a one-second grace if it has not
exited; its remaining stdio is released after that grace. Late process events
cannot consume another attempt or affect the replacement connection. Disposal
uses the same bounded cleanup without reconnecting.
Input interrupted by disconnect is failed rather than replayed. Slow output above
1 MiB of queued live updates or socket writes disconnects the view; headless parsing continues.
Quit/dispose disconnects remote shells; explicit Stop or Close terminates them.
Workspace restore already reuses each saved home-shell terminal ID, so after a hub
restart a restored remote tile reopens its live daemon session with screen replay
(verified on a real host). Discovering sessions the hub did not save is phase 4.
To bound unreachable shells, a session with no connected owner
is stopped, its PTY disposed and its slot released after a fixed **24-hour**
grace period (`DETACHED_SESSION_GRACE_MS`). This comfortably exceeds the whole
reconnect window (five 120-second attempts plus one-second retry delays, under
11 minutes) and preserves shells across overnight disconnections. This is a
phase-1 bound only: phase 4 (#757) replaces timeout reaping with hub-driven
reconciliation of known IDs. Reattaching a live session within the grace period
cancels reaping; a later disconnect starts a fresh grace period. Hiding a view alone does
not start the timer while its connection remains. Exited sessions retain their
screen while connected. Once disconnected, their PTY/headless screen is disposed
and only a small exit-code tombstone plus expiry timer is retained. Tombstones do
not consume the 32 full-session slots; at most 64 are kept, with the oldest exit
record dropped first. Their expiry remains the original 24-hour detach deadline,
including when the shell exits later during that period; querying a tombstone
does not renew it. Once dropped or expired, reattach returns `gone`. Output that
was never delivered before a disconnected exit cannot be recovered from an
exit-code-only tombstone; the hub retains its last received display.
Expiry follows explicit kill's stop/disposal path, including forced cleanup if
graceful stop fails; shutdown cancels pending reap timers.
See [measurements and fixture verification](../../spikes/remote-host/phase-1.md).


## Middle-click selection paste (#856)

Linux retains native primary-selection paste. Mouse-reporting applications own
middle clicks; Shift forces paste. macOS optionally emulates this through xterm's
`paste` path (including bracketed paste and newline normalization), enabled
by the profile-only `middleClickPaste` boolean, off by default. Settings → Terminal
shows its single checkbox on macOS. Windows has no
emulation or checkbox.

Each board renderer keeps its own last nonempty terminal selection, shared by
that window's terminals only. Selections over 65,536 UTF-16 code units are rejected
whole, preserving the previous buffer. Deselection, hiding a terminal and closing
its tile do not erase it. Disabling the option clears it; window close or reload
also drops it. Re-enabling starts empty. Preview/dialog and other-app selections
never enter this buffer. The buffer stays in renderer memory and is never copied to the clipboard or
disk, or synchronized across windows. Pasting sends ordinary terminal input
through the existing terminal-ID-scoped bridge. Paste is accepted only by a live,
visible, attached terminal that is ready for input.

## Copy on select (#872)

The profile-only `copyOnSelect` boolean is off by default on every platform.
Settings → Terminal places **Copy on select** directly below the macOS-only
middle-click checkbox, without helper copy. xterm's public `onSelectionChange`
reports completed mouse selections rather than intermediate drag paints. A terminal-only
mouse-up fallback handles repeated selections whose coordinates xterm considers
unchanged, including a release outside the tile. Intermediate drags never copy; keyboard
and programmatic selection changes settle for 100 ms before copying. Empty and
oversized selections (over the shared 65,536 UTF-16 code-unit bound) never write,
and oversized selections are rejected whole. Deselection never clears the clipboard.
Only attached terminal controllers participate; Settings previews, dialogs and
other apps do not. Mouse-reporting applications produce no xterm selection unless
Shift forces selection. Linux primary selection behavior remains unchanged.

The renderer calls only the narrow write-only `copyTerminalSelection(id, text)`
preload capability. Main validates the registered board main-frame sender, owned
terminal ID, attachment to that sender and bounded nonempty string, then checks
the current preference before writing the system clipboard. Foom never reads the
clipboard through this capability. The middle-click buffer remains separate and
never supplies clipboard writes. Selection text is never persisted.


## Remote child cleanup after restart (#755)

Explicit Close of a remote child uses its saved placement host alias, including
for a dormant row after hub restart. A fresh bounded SSH connection negotiates
the existing build identity and sends `agent-close {id, request}`. This operation
accepts only an agent session, stops and disposes its PTY, revokes its independent
credentials and removes its private launch directory before acknowledging success.
It never attaches a view or creates a process. A missing ID succeeds idempotently;
a shell ID or foreign operation is refused. The ID retains the existing private
socket/unguessable-ID protection and never enters the agent's environment or argv.
If connection or cleanup fails, Close retains the row and reports
`remote_host_unreachable`; session state carries that reason until cleanup succeeds.
The 24-hour detached reaper remains the unreachable-host backstop.

Agent preparation/start failures return only validated `agent-failed {id, reason}`
frames using the fixed [launch reason enum](../contracts/control-mutations.md#launch-failure-reasons).
No host output or stderr enters the diagnostic channel.
