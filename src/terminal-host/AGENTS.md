# Terminal host

Read [Terminals](../../docs/areas/terminals.md), [Shell lifecycle](../../docs/areas/shells.md), plus the affected surface’s links in
[the file map](../../docs/map.md), before changing this area.

- Main owns terminal capabilities and brokers IPC; the utility-process host owns a PTY plus a headless xterm per terminal, identified by ID. The renderer only displays terminals. Never pause a terminal because no view is attached. Parser backpressure is independent of attached-view throttling.
