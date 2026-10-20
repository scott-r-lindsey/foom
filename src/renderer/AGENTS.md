# Renderer

Read [Renderer](../../docs/areas/renderer.md), [Board](../../docs/areas/board.md), [Terminals](../../docs/areas/terminals.md), [Terminal rendering](../../docs/areas/terminal-rendering.md), plus the affected surface’s links in
[the file map](../../docs/map.md), before changing this area.

- Follow `docs/areas/renderer.md`: components use React 19 and TSX with plain token-based CSS. Keep board data behind the source interface; components hold view state only. Subscribe to activity outside React state and dispose subscriptions on unmount. Preserve the imperative terminal controller’s attachment ordering and create one xterm per mounted shell.
