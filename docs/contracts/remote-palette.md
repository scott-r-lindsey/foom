# Remote startup palette (#1075)

The SSH protocol remains version 3. `open` and `agent-open` accept optional
`dark: boolean` and `theme: TerminalTheme` fields. `theme` uses the complete,
closed terminal palette validated by `isTerminalTheme`; malformed palettes and
nonboolean `dark` values refuse before launch. The resolved palette wins over
`dark`; absent fields preserve the light default for older hubs.

The hub includes the current resolved palette with the initial open. The daemon
passes it to `TerminalManager.create`, including after the prepare/start split
for agents and for machine agents, recipes and ordinary shells. The first OSC
10/11 query therefore reads the launch palette without waiting for an open reply
or a second message. The palette is metadata, never a process argument or file.

A live session owns its current colors. Reattach ignores startup palette fields,
and reconnect or hub restart does not replace an unchanged palette after open.
The hub initializes its terminal service from the saved resolved palette before
restoring sessions. Starting from the native default and applying saved settings
after reattach would invent a theme change and erase retained overrides.
Snapshots replay the retained defaults and application-set overrides. Explicit
theme changes still replace defaults and reset overrides, as locally. The hub
retains the latest desired palette and tracks acknowledged replacements. A change
made before the initial reattach handshake or while disconnected, or sent without
a matching acknowledgement before SSH loss, is replayed after the live open reply
and before attachment, and remains pending until acknowledged. An
older acknowledgement cannot confirm a newer replacement. Reconnecting again
after confirmation sends no replacement, preserving application colors.
Restoration does not repeat a palette already sent as a theme replacement on the
current connection, even while its acknowledgement is pending. Startup fields
on a reattach open do not count as a replacement. Connection-local send tracking
is discarded on disconnect, so an unacknowledged replacement still replays on
the next connection.

Reconnect restores dimensions only after a view has reported a size. A restored
session's creation grid (80x24) is not a resize observation. If there are no missed
theme updates, reported dimensions or attachments, the live open reply completes
restoration and clears its deadline without modifying the PTY or screen.

New daemons advertise `startupTheme: 1` in `hello`. For a fresh launch against a
compatible different build, the hub requires this capability and otherwise
returns the existing `remote_host_facts_unavailable` needs-update reason before
sending open. Exact-build peers support it implicitly. Reattachment, cleanup and
management remain available without it; a busy older daemon and its sessions
are preserved. The existing idle daemon upgrade can install the verified build
once its sessions and outstanding work have ended.

See [terminal ownership and reconnection](../areas/terminals.md#remote-shell-spike-754).
