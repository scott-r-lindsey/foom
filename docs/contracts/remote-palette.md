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
and neither reconnect nor hub restart sends a theme replacement after open.
Snapshots replay the retained defaults and application-set overrides. Explicit
connected theme updates still replace defaults and reset overrides, as locally.

New daemons advertise `startupTheme: 1` in `hello`. For a fresh launch against a
compatible different build, the hub requires this capability and otherwise
returns the existing `remote_host_facts_unavailable` needs-update reason before
sending open. Exact-build peers support it implicitly. Reattachment, cleanup and
management remain available without it; a busy older daemon and its sessions
are preserved. The existing idle daemon upgrade can install the verified build
once its sessions and outstanding work have ended.

See [terminal ownership and reconnection](../areas/terminals.md#remote-shell-spike-754).
