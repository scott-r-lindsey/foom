# Terminals

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/tiles.md).

## Terminals

[Remote hosts #753](https://github.com/scott-r-lindsey/foom/issues/753) decides
SSH-only transport and persistent remote PTYs. The older [#518 research](../research/remote-machines.md)
is historical; the opt-in phase-1 spike is described below. There is no Hosts setting yet.

**Today:** `src/terminal-host/terminal-host.ts` runs `TerminalManager` in an Electron utility process, owning independent PTYs and headless screens by ID. `src/main/terminals/terminal-host-client.ts` brokers asynchronous operations in main over the parent port; it never imports node-pty or headless xterm. `src/main/terminals/terminal-ipc.ts` grants registered app windows access to app-owned terminals and enforces exclusive attachments. The first board opens the bundled manual after setup, with no PTY until a launch is requested. Selecting a row places its session in an available tile or focuses its existing tile; Esc remains terminal input. Hiding a tile or entering Settings detaches the stream without stopping the shell. Placing another terminal in an empty tile or returning from Settings drains pending renderer writes, resets the display, fits the visible grid, and restores a fresh host snapshot before continuing the live stream. Input and resize events are suppressed while hidden or changing attachment. The manager and ID-scoped bridge support multiple concurrent sessions; the board consumes live worktree and verdict data. Closing a window detaches its views; the last window requests quit on Windows/Linux and keeps the app alive on macOS. Running terminals require confirmation; cancellation preserves the window and sessions. Confirmed quit stops each PTY and waits for its exit before disposing sessions and closing the window. On Unix, a PTY that ignores graceful termination receives a force-kill after one second. Windows uses ConPTY termination without Unix signals; once a termination request succeeds, shutdown and retries only drain its native exit callback, because closing a ConPTY handle twice can crash the host. A throwing termination request remains retryable. Failure to exit within five seconds leaves the app open with an error so quitting can be retried. Detached sessions continue running; navigation or a renderer crash automatically detaches views. PTY termination requests retain their process handles and exit subscriptions even after a terminal is removed from the board. Confirmed quit applies the same graceful termination and force-kill deadlines to these removed processes and waits for their pending native exits before closing the window; the `will-quit` barrier remains a final safeguard against native callbacks racing Node teardown on Windows.

- Each terminal has an ID, a PTY, and a headless xterm instance (`@xterm/headless`) that always consumes output. It holds the screen and scrollback, so a hidden agent never stalls.
- A tile fully covered by a maximized sibling keeps its attachment and renderer parser live, but hides only the xterm screen after the tile's fade. Chromium skips the hidden screen's layout and paint; xterm's visibility observer defers regular refreshes and requests a complete repaint on restore. Selection/resize work may still update the backing renderer while covered. The outer fitting box retains its geometry, including during window resizing; output, acknowledgements, scrollback and selection remain owned by the same xterm. Reduced motion hides the screen immediately. Native window occlusion policy is unchanged.
- The host forwards headless xterm protocol responses to the PTY while it is alive, independent of attachment. Views suppress the corresponding device-attribute, status, mode, and status-string query handlers so each query has exactly one response owner. Keyboard, paste, and mouse input remain renderer input; attachment changes never transfer query ownership.
- Color state also belongs to the host: OSC 4 (palette) and 10/11/12 (foreground/background/cursor) queries, sets, and 104/110/111/112 resets use shared public-parser handlers. Only the host handler writes replies; the renderer handler applies colors without answering queries, including mixed set/query commands. Colors accept xterm-compatible hex and `rgb:` forms; unsupported names and malformed entries are ignored. The palette starts with xterm's 256 defaults, and foreground/background/cursor use the brand ink/bg/accent tokens. Main sends the resolved terminal palette on creation and validated, terminal-ID-scoped updates on changes. A terminal palette replacement resets application-set color overrides to the new defaults, as the existing browser theme replacement did. Parser barriers order these updates with output, and attachment snapshots include all color state, so changes while hidden appear on reattachment. Keyboard, paste, and mouse input are not filtered.
- Opening a terminal sends a serialized snapshot (`@xterm/addon-serialize`) through the data channel, then streams live output. The host and renderer both default to a blinking block cursor. The host supplements serialization with cursor blink options and DECSCUSR overrides, scrolling margins for both buffers, and restores origin mode before positioning the active cursor. Cursor overrides use a checked, pinned xterm internal representation because the public modes API and serializer omit them. Renderer control updates preserve application cursor choices; exited views hide the cursor and disable blinking. A pending right-edge wrap is recreated by replaying the cursor row with the pinned serializer after restoring margins, preserving cell styles and the current pen. Normal-buffer margins are restored before entering the alternate buffer, so leaving fullscreen mode retains normal scrolling. xterm 6 does not expose margins publicly; the snapshot helper checks its pinned internal buffer representation and rejects attachment if incompatible; pending-wrap restoration also checks the pinned addon’s internal row serializer. A headless parser barrier keeps the snapshot and live stream contiguous. Each attachment has a fresh token; acknowledgements must carry that token, so delayed callbacks cannot acknowledge a new view.
- Parser backpressure pauses a PTY above 262,144 queued UTF-16 code units and releases it below 65,536, regardless of attachment. This prevents the headless write buffer from overflowing. Separately, view backpressure uses the same watermarks for unacknowledged output while a view is attached. Both conditions must clear to resume; detaching only clears the view condition. No PTY pauses merely because it has no view.
- The activity meter and last-lines buffer read from the same stream in the host. One 100 ms timer batches changed UTF-8 bytes-per-second rates for all terminals, exponentially smoothed with a 500 ms time constant. Rates decay to zero; the timer sleeps once all meters are quiet and zero. Quiet fires once per output burst after 500 ms for a trailing question, y/n, password, or Enter prompt, otherwise after 2 seconds. New output restarts the debounce; pending parser writes prevent quiet classification. A terminal silent from launch gets its first quiet event after 2 seconds. Exit and removal cancel the meter. These are timing hints, not attention verdicts. Main exposes quiet callbacks for the evaluator and forwards activity only for live owned terminals; view attachment does not affect measurement. Terminal tails use the active screen and its scrollback, including populated rows below the cursor. They omit trailing whitespace-only rows before applying the requested line limit, preserve interior blank rows, and return an empty list for a blank buffer.

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


## Remote shell spike (#754)

Build `node scripts/build-remote-host.mjs` on Linux/macOS with Node 24, then build
Foom. The build produces `build/remote-host/foom-host` and `manifest.json`. Launch
the development app with both `--remote-shell-spike=SSH_ALIAS` and
`--remote-host-artifact=/absolute/path/to/foom-host`; these main-only argv options
route the **home shell** to that host. Worktree/config shells and agents remain
local. The selected artifact must match the remote OS/architecture; the spike does
not download or cross-compile binaries. No host, artifact, executable or environment
selection is added to IPC. Settings, inventory and hub-restart restoration are phase 4.
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
system-wide. A fixed, quoted POSIX bootstrap uses head, SHA-256, and atomic rename
to upload the exact artifact through that same stdio connection, into private
`~/.foom-host/<version>/<sha256>/foom-host`. Cached bytes are hash-checked too.
First-time upload/negotiation has a 120-second transport deadline and a 125-second
create deadline; normal terminal requests retain their 10-second deadline.
No remote text is interpolated into commands. Existing symlinks/unsafe directories
are refused. Linux requires standard coreutils; macOS uses shasum when sha256sum
is unavailable.

The wire format is a 4-byte unsigned big-endian byte count followed by UTF-8 JSON
`{version:1,message:...}`. Frames are capped at 8 MiB before allocation; invalid
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
Both peers negotiate the SHA-256 build identity before operations. The shell-only
protocol permits open, attach/replay, input, resize, theme, acknowledgement, screen,
tail, stop and close; it cannot create arbitrary commands, send hooks/MCP, or shut
down the daemon. The daemon chooses `/bin/sh -i`, its own HOME and environment.
It supports at most 32 sessions and connections, serializes operations per connection,
and rejects a backlog above 256 operations. Only the current connection can operate
on its selected ID. Taking over an ID disconnects its prior connection.

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
then live output. The PTY owner includes the reset in its counted snapshot, so
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
The phase-1 hub retains IDs only in memory: rediscovery after hub restart is phase 4.
See [measurements and fixture verification](../../spikes/remote-host/phase-1.md).
