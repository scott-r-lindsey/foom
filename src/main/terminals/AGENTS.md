# Terminal capabilities

Read [Terminals](../../../docs/areas/terminals.md), [Shell lifecycle](../../../docs/areas/shells.md), plus the affected surface’s links in
[the file map](../../../docs/map.md), before changing this area.

- `terminal-ipc.ts` grants renderer capabilities; it does not own PTYs.
- Creation IDs are allocated in main. Renderer payloads cannot choose executables or working directories.
