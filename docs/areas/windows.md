# Windows

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/windows.md).

## Multiple windows

Main constructs one workspace, terminal host client, hook receiver, session store,
control runtime and evaluator route for the app. Window creation is serialized.
`window-ipc.ts` routes invoke channels by registered WebContents and validates the
top frame and exact app page before dispatch; each capability retains its payload
validation. Unknown windows and confirmation renderers cannot use board channels.
Closing a board unregisters only its own routes and disposes its trusted dialog,
setup IPC and menu listeners. It never disposes the workspace or terminal host.

`terminal-views.ts` holds app-wide view reservations. ID-only `windows:sync` reserves
up to 256 known sessions for one window and returns accepted IDs. Another window's
reservation cannot be replaced. Removing a reservation detaches that window's old
host stream before another window can attach. Settings may detach a stream while
retaining its reservation. `windows:select` focuses an existing foreign view;
`windows:popout` requires a reservation in the requesting window. Main transfers
that reservation and detaches the old stream before opening the new view. A failed
window load releases its reservations; the terminal remains available in sidebars.
Terminal input, resize, acknowledgements and detach cannot act on another window's
attached stream. Host generations continue to reject delayed output acknowledgements.

`window-placement.ts` validates and atomically persists the window set in private
`windows.json`. Each record has a stable random ID, display ID, normal bounds,
and maximized flag. Legacy interface scales are read only for migration. Restore clamps geometry to a connected display,
falling back to the primary. The preload receives only its window ID and optional
pop-out terminal ID as main-generated arguments; it receives no profile paths.
Each window uses its ID to namespace validated localStorage tile metadata, including the sidebar collapse choice and expanded width. New windows start expanded at 300px; the narrow rail override and temporary overlay do not change that choice. The
legacy size file remains a fallback for the first window. Global settings retain
one writer, including one app-wide interface scale. Every window applies the shared scale with its own remembered 100% size; only the requesting window uses the pointer anchor. The shared setting wins on migration, falling back to the first saved window’s scale. Setup scans and confirmations stay local to their requesting window. Classification uses the shared local rules.

`window-audio.ts` elects one board to play app sounds. Validated view IDs describe
focus; main combines them with native focus and publishes suppression to the audio
owner. Closing the owner elects another board. Refusal requests reach that owner.
Attention badges derive from the shared workspace once, including when macOS has
no board windows. Dock selection locates the existing view or opens a new window.

Tile layout records use `version: 2`. Each leaf is `{ kind: "tile", id,
content: null | { kind: "terminal", session } | { kind: "preview", preview } }`.
Restore accepts version 1 and converts its `session` field to terminal content;
saves write only version 2. The existing `foom.tiles.v1` storage key and its window
namespaces are retained for discovery of older layouts. IDs are bounded and unique
within each content kind; invalid preview content becomes empty space. IDs grant
no capability. After the first main inventory arrives, `pruneContent` removes
unknown terminal and preview IDs while retaining geometry. Every occupied tile is
numbered in tree order. Terminal attachment and window reservations only use
terminal content. Main's sidebar inventory supplies typed preview display facts
(ID, repository, worktree, relative path and Markdown/HTML kind). Renderer components read these through the board
source and never resolve preview paths or own a preview registry.

Existing single-window tile layouts migrate once from `foom.tiles.v1` into the
first window’s namespace. Subsequent windows start with independent layouts.
With no macOS windows, an app-only native menu retains New Window and Quit
accelerators and has no callbacks into a destroyed board. Windows taskbar
overlays use the same app-level count on every live window so none retain stale
attention after focus changes.

Quit is app-scoped, inventories all running PTYs, and parents its trusted dialog
to the focused board. It flushes every live renderer, stops PTYs, drains workspace
persistence, and disposes the terminal host before exiting. Cancellation and failed
shutdown retain sessions and windows. macOS activation recreates a board after the
last one closes; Windows/Linux route the last close through confirmed quit.

## Cross-window moves (#950)

`window-moves.ts` keeps the active 15-second, one-use drag token in main, bound to
its source board and terminal/preview identity. Only the opaque token is published
to other registered boards. The source registers local sidebar/title gestures and
revokes on end or Escape; no DataTransfer contents are read. Drops send only the
token and tile/edge placement. Main consumes the token before awaiting placement,
rechecks source ownership and both registrations, and serializes moves involving
either board. Closing a source revokes its gesture. Forged, stale, expired and
replayed tokens and archived sessions without a host screen refuse without changing
layouts.

`windows:list` returns other live boards with stable lifetime labels, Window N.
`windows:move` uses the same transaction as a drop with ordinary default placement.
The destination stages geometry without learning the item's identity, replies to
a bounded five-second placement request, and holds its tree until commit or abort.
Inventory closes remain reflected during the reservation; concurrent agent preview
arrivals report sidebar placement. The board applies the transferred identity only
on commit, clearing any stale local assignment of that same identity. Invalid or full drop geometry
refuses before ownership changes. Terminal moves share `TerminalViews.transfer`
with pop-out: detach the source stream before changing its reservation. Preview
moves call the same `PreviewHost.moveTo` transaction as `preview:popout`, preserving
identity/attribution and live reload, resetting network to Off. Their existing
placement round trip refreshes preview inventory before staged geometry commits.
Both paths explicitly report the synchronous ownership commit. A later persistence
or notification error still finishes destination placement and rejects to the
requesting renderer for its action error; only failures before ownership changes
abort staged geometry.
All channels use
the registered-board sender/frame/page validation in `window-ipc.ts` and validate
payloads at runtime; unknown windows and confirmation/preview contents have no
move capability.
