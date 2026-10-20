# Sandboxed preload

Read [Boundaries](../../docs/areas/boundaries.md), [IPC](../../docs/areas/ipc.md), [Confirmation bridge](../../docs/areas/confirmations.md), plus the affected surface’s links in
[the file map](../../docs/map.md), before changing this area.

- The sandboxed preload may import Electron at runtime and shared declarations as types; adding another runtime dependency requires an explicit boundary and loader design change.
