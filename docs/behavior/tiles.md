# Tiles

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Terminal tiles

The layout is a binary split tree. Each leaf is a tile with a stable identity and
at most one terminal or preview; each split has a horizontal or vertical direction and a ratio.
Split right and Split down add empty space, keep focus in the original tile,
and make the newest space the landing spot. Hide and exited-session Close leave
empty space in place, with sibling geometry unchanged, and make it the landing spot.
Hide keeps the session running; Close closes it through the sidebar command.
Tile chrome never stops a running process. Reclaim space with Grow, gutters
(including Home/End), or Tidy tiles.

Clicking a visible session focuses its tile. Clicking a hidden session or launching
one fills the landing spot, then the first empty space in tree order. A full board
adds a column at the far right. Columns are the children of the root's horizontal
split chain; any other root is one column. With N columns, existing widths scale
by N/(N+1), the new column gets 1/(N+1), and nested row ratios stay unchanged.
If any resulting column would have fewer than about 60 terminal cells at the
current font size, replace the least recently focused non-Needs-you tile, excluding
the focused tile. If none qualifies, use the oldest-focused non-Needs-you tile,
even if focused. Its session keeps running hidden. If all tiles need attention,
add the column despite the minimum width. Tree resource limits still apply.
Full tiles produce no refusal shake or sound.

A single empty tile is a blank window: on first placement it becomes K equal
columns, where K is the number of 100-terminal-cell widths that fit, clamped to
1–3. The session fills the leftmost column. An arranged tree is never re-split.
Restart replaces its own tile. The longest-waiting shortcut explicitly replaces
the focused tile and hides its previous occupant. If the waiting session was in
another tile, that tile empties.

Terminal title bars show the state light, agent badge, location and session name, followed by
an always-visible tile number with a chevron ("Tile N menu"). Maximize/Restore and
Hide (running) or Close (exited) appear on hover, focus, or the focused tile.
Child terminals also show the sidebar’s robot mark, named Worker, including after takeover.
Double-clicking the title bar toggles maximize. Right-click opens the same tile
panel at the pointer. The panel matches the sidebar panels: commands on the left,
state and reason, live columns × rows, location and agent facts on the right.
Commands are Split right/down, Grow sideways/vertically, Maximize/Restore, Move to
new window when available, and Hide/Close. Grow absorbs the other side of the
nearest split on its axis only if it contains no occupied tiles. Disabled reasons are
"Next to an occupied tile" or "Already full width" / "Already full height". The first
enabled command receives focus; arrow keys navigate enabled commands; Escape
returns focus to the tile menu button.

Empty space is a dashed outline with no title bar, number or focus, hidden from
accessibility navigation. Empty spaces have no landing marking at rest. While a tile
or sidebar row is dragged over the board, a dashed, labelled drop preview marks
the target; leaving the board, ending the drag or cancelling clears it. Sidebar placement
fills it and focuses the terminal; dropping onto any empty space fills that space.
Focus uses the highlight border and brighter occupied title bar; Needs you uses an
amber border that takes precedence and a labelled, haloed light.

Terminals and previews are numbered, in tree order, including sidebar numbers and number
shortcuts. The focused tile's number is highlighted. Tile presets are unavailable;
Split right/down, Grow, gutters and Tidy arrange the layout.

Preview title bars show a document glyph, MD or HTML badge, relative path, tile menu,
Maximize/Restore and Close. The tile menu offers Allow network… when off, and Block network when on; its facts show Network Off or On, and the title bar marks enabled network. Allow network asks in the trusted confirmation window: "This page can send files from this worktree to the internet". Permission belongs to that preview, permits HTTPS and secure WebSockets, and resets on restart or when moved to another window. A move resets network to Off because permission was granted in the original window’s trusted dialog context. Plain HTTP stays blocked. External link requests always ask in the trusted window, showing the full URL, even when page script requested them without a click. Only HTTPS, HTTP and mailto links are eligible. Each preview has at most one pending confirmation; requests received while one is pending are dropped. Declining opens nothing.

A preview has no running process to hide. Replacement closes previews that no longer fit. Split, Grow, drag, Tidy and focus
shortcuts treat previews as occupied tiles. Opening or reloading a preview never
moves focus; a click or explicit focus command does. While panels, trusted
confirmation scrims or drag previews cover previews, they show a frozen image
of the page beneath the board UI and resume afterwards. During maximize/restore
motion, live previews follow the tile bounds without a cover.
Previews do not intercept board drags. Foom shortcuts remain available when a
preview has keyboard focus.

Markdown previews show headings, tables, task lists and syntax-highlighted code.
Raw HTML is displayed as text; Mermaid fences remain code. Relative Markdown
links open within the same tile and external links carry an arrow. Document
colors follow the light/dark Appearance setting.

Agent-opened previews fill the landing spot or first empty space. With a full board,
they use the same far-right column growth and minimum-width fallback as new
terminals, preserving the focused tile and keyboard focus. Reopening an existing
sidebar preview places it on the board; reopening a tiled preview leaves it in place. Foom draws their kind badge, worktree-relative path and
“opened by” agent badge outside the page; accessible names identify the agent and
session. A newly filled tile flares twice in the accent, never amber, then keeps
its tint and edge until hover or focus. Reduced motion keeps the tint and edge
without animation. The highlight is local view state; attribution remains textual.
A human close sticks: the same agent reopening the same file gets only a sidebar
row. Showing that row follows the same placement as a human open.

Double-click a gutter, or press Enter while it is focused, to give every member
of its run a share proportional to its column count along the run's axis (rows
for a vertical run). Same-axis splits add their sides' counts; perpendicular
splits use the larger side's count; a tile counts as one. A run follows consecutive
splits on the same axis; perpendicular subtrees keep their nested ratios. Thus a
three-column row block beside two single columns receives 3/5 of the width, and
each single column receives 1/5. Evened ratios can exceed the usual ratio limits.

**Tidy tiles** removes every empty space, collapses single-child splits and evens
every run using the same column or row weights. Tile order, content assignments,
focus and surviving leaf identities stay unchanged. An all-empty layout keeps one empty space. Tidy restores any
maximized tile first and uses the existing tile resize motion (immediate with
reduced motion). It applies only to the focused window, from View → Tidy tiles or its shortcut.

When resizing between two occupied sides, gutters stay between 15% and 85%.
An all-space side has no minimum. Below 8% (or above 92% for the second side),
space previews collapse and is removed on release. Focus a gutter and use its
axis's arrow keys to resize by five percentage points; Home/End select the limits
and collapse an empty side. Keyboard changes commit immediately. Maximize expands
one tile from its own position while the others fade and stay mounted and attached.
Restoring returns to the saved split geometry. Reduced motion disables tile movement.

Use Ctrl on Linux/Windows, or ⌘ on macOS:

| Shortcut | Action |
|---|---|
| ⌘ + 1–9 (macOS); leader, then 1–9 (Windows/Linux) | Focus tile by number |
| ⌘ + Alt + Shift + T (macOS); leader, then T (Windows/Linux) | Tidy tiles |
| Ctrl/⌘ + Shift + Enter | Toggle focused tile maximize |
| Ctrl/⌘ + Shift + N | Replace focused tile with the longest-waiting session |
| ⌘ + Alt + Shift + arrow (macOS); leader, then arrow (Windows/Linux) | Focus the nearest tile in that direction |
| ⌘ + Alt + Shift + R / D (macOS); leader, then R / D (Windows/Linux) | Split right / down |
| ⌘ + Alt + Shift + W / H (macOS); leader, then W / H (Windows/Linux) | Close tile / hide session |

On Windows/Linux the tile leader is Ctrl+Shift+Space. Release the modifiers, then
press the second key within two seconds. Escape cancels it; an unmatched key
cancels and reaches the terminal. Window blur also cancels. These bindings avoid
Ctrl+Alt (AltGr) and GNOME's Ctrl+Alt+Shift+arrow workspace commands. Plain Ctrl+1–9
now remain terminal input, including Ctrl+2–8 terminal encodings. macOS bindings
are unchanged. The main-process command list drives menus and shortcut handling.

Plain terminal control keys remain terminal input. The split tree, ratios, leaf
identities, focus and assigned session IDs persist as local view preferences.
Maximize is temporary. On restart, exited or unavailable sessions leave empty space and keep their sidebar rows. Eligible running sessions keep their tile positions while fresh PTYs are created; a skeleton with the agent glyph and session name stays until the new attachment renders its first frame. Host or attachment failure clears the skeleton and keeps the failure status available; hiding and reshowing a healthy session does not restart the skeleton. Restore failures and roles that cannot be restored leave empty space and retain their sidebar error state. Screens and scrollback are not restored. Visible terminals use WebGL within a per-page budget, with DOM fallback; see [terminal rendering](../areas/terminal-rendering.md#webgl-renderer-620).

Drag a sidebar session onto a tile center to replace its session (the previous
session keeps running hidden), or onto one of its four edges to split it in half.
Drag a title bar onto another tile center to swap whole tiles, or onto an edge to
move that tile there, collapsing its old parent. Tile moves and swaps preserve
terminal views and attachments. A labelled, outlined preview shows the destination;
a live region announces it. Escape cancels the drag.

Swap with the nearest tile using Command+Alt+arrow on macOS, or the tile leader
then Shift+arrow on Windows/Linux. The View menu exposes the same four commands.
Focus follows the moved tile.
