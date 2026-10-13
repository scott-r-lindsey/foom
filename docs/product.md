# Product

Foom is a desktop workspace for running many coding agents at once, in git worktrees with one terminal per session. Its job is to route your attention. Terminals can stay hidden or share the workspace in tiles; Foom tells you which one needs you.

The target is about 10 concurrent agents. Supported agents are Claude Code (`claude`), Codex (`codex`), and Antigravity (`agy`). Any other CLI runs as a plain terminal, watched by the evaluator.

## Terms

- **Repository**: a git repo the user has added.
- **Worktree**: a `git worktree` for one branch, created by Foom or another tool. Every checkout can run multiple shells and agents. Shells need no sharing confirmation. Starting an agent while another agent is still running in that checkout requires confirmation because they can edit the same files. Exited agents do not trigger the warning.
- **Terminal**: one PTY session inside a worktree. It may run an agent, a dev server, or a shell.
- **Light**: the indicator that represents a hidden terminal.
- **Evaluator**: the local rules pipeline that decides what a terminal's state is when its output stops.

## The light

The light carries two separate signals.

- **Motion is activity.** Working agents and running shells glow with output: a logarithmic level makes 200 B/s visible and reaches full strength around 4 KB/s. Brightness rises in about 120 ms and falls in about 700 ms; rate targets change no faster than 3 Hz. The light grows up to 1.3× and casts a halo in its own color. Sidebar rows also show an eight-second trace sampled four times a second; tile title bars have glow only. Reduced motion removes scaling and transitions and updates brightness in four steps, and the trace, once a second. Other states hold still.
- **Color is execution and attention state.** Agent lifecycle signals establish Working; the evaluator classifies attention and results.

| State | Light | Meaning |
|---|---|---|
| Working | Brand violet, brightness follows output | Agent is executing |
| Needs you | Amber, steady, with a halo | Waiting for input or approval |
| Done | Green | Finished successfully |
| Failed | Magenta, square | Exited with an error or gave up |
| Quiet | Dim neutral | Quiet but fine (dev server, long install) |

- Done and Failed dim once the user has looked at them.
- Agent Needs you clears when supported evidence shows execution resumed, or when the user dismisses attention. Typing and terminal output alone do not prove resumed execution. Shell attention retains reply/output behavior. Opening a terminal never clears attention.
- Failed uses a square light, so the state never depends on color alone.
- A solid light means the process is running. Exited sessions have a hollow ring (square outline for Failed), green after Done, magenta after Failed and muted otherwise. Their name and badge dim, a muted `exited` follows the name, and the accessible name includes Exited.
- Every verdict carries a one-line reason and the signal that produced it, for example `Wants to edit src/main/main.ts · pattern: (y/n)`.

With Claude hooks attached, an idle title stops working audio but stays Quiet until
Stop confirms completion. This keeps Esc interruptions from producing a Done chime.
Permission approval resumes Working after fresh supported progress evidence; typing
or dismissing attention alone does not resume it.

## Terminal sidebar

The sidebar is a repository → worktree → session tree beside the terminal tiles.
The header shows the wordmark, needs-you and working counts, a filter and Add repository.
Its panel-toggle button collapses the sidebar to a 64px rail at any width; Expand sidebar
returns to the tree. View → Collapse sidebar / Expand sidebar and ⌘B on macOS or
Ctrl+Shift+B on Windows/Linux do the same. Plain Ctrl+B stays with the terminal.
The choice saves with each window’s tile layout; new windows start expanded.
The rail keeps every session’s light and badge, repository dividers, a textual
needs-you count (including held config changes, absent at zero), and the config gear.
Session panels open beside the rail and retain keyboard navigation and location names.
Below 720px the rail is forced. Open sidebar shows the tree over the tiles without
reflow; Close sidebar, Escape, a click outside or the shortcut closes it. Widening
restores the saved choice. Width changes take 160 ms (no animation with reduced
motion), and terminals refit once afterward. Focus in sidebar content moves to its
toggle; terminal input focus stays in the terminal.
Pinned repositories appear in pin order, followed by repositories with sessions A–Z,
then idle repositories A–Z. Thin rules separate nonempty sections; one repository has no sections.

The case-insensitive filter matches repository names, branches, session names and reasons,
highlights matching text and expands ancestors. A banner counts filtered-out sessions that
need you; Show clears the filter. Collapsed repository rows show their worktree count and
most urgent state; collapsed worktrees show the same roll-up. Urgency is Needs you, Failed,
Working, Done, then Quiet. The main checkout is labeled **Main checkout**, with its branch on a secondary line and a folder icon.
Session breadcrumbs also call it **Main checkout**. Other worktrees
have a branch icon. Pins and repository/worktree expansion choices persist.
Repositories with running sessions start expanded; idle repositories start collapsed.
With one repository, everything starts expanded.
Clicking or pressing Enter on a repository, main-checkout or worktree name opens its panel
and leaves the terminal tiles unchanged; again closes it. Chevrons expand or collapse.
There is no separate launcher page.

External Git worktree and branch changes refresh the sidebar automatically and when
the window gains focus. Sessions in a removed checkout stay alive and show a neutral
**⊘ Worktree removed** label. New launches and restarts there are unavailable; Stop
and Close still work. The checkout row disappears when its last session closes.

Session rows show a light, neutral CC / CX / AG badge (or `>_` for shells), name,
wait and reason for agents. Shells have no reason line or state colors: a neutral light while running, a muted ring after exit, and amber only for Needs you, with its wait time. After Shell, muted monospace text shows the foreground program name (never arguments or paths), empty at the prompt. Linux and macOS use the host’s foreground process name; Windows shows plain Shell because ConPTY does not expose it. Shell attention detection and exclusion from attention counts except Needs you are unchanged. Unknown identities use `?`. Badges share a 20px-high slot with a
16px visual target; no vendor artwork is bundled. The full agent name or detected
shell name remains in the accessible row name and session panel after renaming.
Double-click the name
to edit it; Enter or blur commits, Escape cancels, and an empty value restores the default.
Rows launched with a known bypass argument also show a neutral ◇ Bypass label.
This records launch flags, not inferred global agent policy; changing defaults does not
change existing rows.
Names persist as local UI metadata keyed by terminal ID. Session rows and recorded
conversation IDs survive Foom restarts. Sessions running at quit restart when Restore sessions on launch is on; exited sessions stay exited. Terminal screens and scrollback are never persisted.
Hover and keyboard focus do not preview terminal output or switch the pane. Click or press Enter to show
its terminal and focus input, using the placement rules below. Needs you remains; Done and Failed dim once seen.

Previews appear beneath their worktree with a document glyph and no light or attention state.
Their rows show the worktree-relative path and shared tile number; clicking focuses the preview.
Closing a preview tile closes the preview. Preview inventory and display facts belong to main.

Each row opens a labelled panel to the right of the sidebar, over the tiles.
Hover intent takes 400 ms, or 120 ms when switching from another open panel;
leaving both row and panel closes a hover panel after 250 ms. The ⋯ button,
right-click and Shift+F10 pin it and move focus to its commands. Escape, an
outside click or tree scrolling closes it and returns focus to the row. Hover
cannot replace a pinned panel; dragging suppresses panels.

Panels have a title band, a 248 px command column and facts beside it, up to
720 px wide and contained within the window. Commands retain their existing
confirmations. Arrow keys, Home/End and Enter operate commands; copyable paths
and conversation IDs are buttons. Clicking a session title renames it with the
same Enter/blur, Escape and empty-name behavior as sidebar double-click rename.

The home shell row (`>_ shell ~`) sits above repositories. Its name and **New
shell** command launch in the main-owned home directory. Shells group beneath
it and restart in home when they were running at quit and Restore sessions on launch is on. Its panel shows home, executable, version
and running count. Repository panels show path, remote, default branch, last
fetch status, worktree/creation/eligible-merged counts and session states; they
offer New worktree, pinning, Delete merged worktrees and **Remove from Foom…**
(with “keeps files”). Launchers belong to checkout panels. Beside them, **Resume conversation…** opens an inline
field with no dialog or helper copy. Paste `claude --resume <id>` (or `-r <id>`),
`codex resume <id>` or `agy --conversation <id>`, or a bare ID and choose a detected,
enabled agent (CC / CX / AG). Enter launches; Escape cancels. Invalid entries mark
the field without prose. Checkout facts show
branch, path, changes, upstream counts and last commit; linked worktrees also
show merged state and creation origin. Detached rows show a short hash with a
detached glyph, and panels say “Detached at <hash>”. **Delete worktree…** names
the existing folder-removal action and is unavailable while a session runs there.

The sidebar footer holds the tile presets, Tidy and a **Foom config** gear the
size of a preset button. The gear replaces the Settings text button and opens a
pinned panel to the right, bottom-aligned and pointing at the gear. **Settings**
is its first command, with its shortcut; ⌘, / Ctrl+, and the app menu still open
Settings directly. Then come the agent launchers and Shell (run in the config
folder), **Open Foom config settings** and **Open folder**. A launcher for the
running session says “running”; launching again focuses it.

A dock above the footer bar appears only while a config change is held, files
are rejected or a config session exists. Its small gear and **Foom config** name
open the same panel, beside **Needs you** and **N rejected** chips as applicable.
The session row beneath it focuses its tile and retains the normal light, ring
and panel behavior, including after exit. The tree has no config row or group;
repositories follow the home shell directly. Filtering the tree leaves the dock
reachable. In the rail the dock hides; config sessions join the compact session list. The gear repeats held changes with an amber dot, otherwise
rejections with a magenta square dot; its accessible name includes these statuses.
Held config changes count in “N need you” and the app badge.

The panel shows the folder path (copyable), working tree (Clean or N uncommitted),
last applied change, Approval with **Needs you**, Rejected and Sessions. Only one
config session runs at a time. No worktree is created, and the session's `PATH`
includes the bundled `foom` CLI.

Session panels show location, discovered agent version, state and reason,
waiting time, recorded launch flags (BYPASS when applicable), start time or exit
code, tile and conversation ID. A running session offers Stop. An exited agent
offers **Resume conversation** with a short ID hint when a validated Claude Code,
Codex or Antigravity conversation ID was recorded, **New conversation here**, **Copy session
ID** when an ID exists, then a separator and **Close**.

Git facts load lazily, locally and with bounded calls; unavailable facts say
Unknown. Opening a panel never fetches from the network. Merge facts use the
merge checker's last fetch and the eligible count uses its exact cleanup rules.

Resume starts the same agent in the same checkout and row, with fresh per-launch hooks
and current launch defaults. New conversation uses that row and checkout without a
resume ID. Failed launches retain the saved conversation for retry. Copy uses the full ID.
Pasted IDs create a new row with the ID already recorded, using the same hooks,
launch defaults and shared-checkout confirmation as Resume. A conversation already
running in Foom is focused instead. Exit the conversation's other process first
when bringing it from outside Foom: Foom cannot detect that process. Foom never reads
agent transcripts or runtime files to locate or check conversations. CLI errors
(such as an unknown ID or a different project directory) remain in the terminal;
the exited row retains its ID for copying and retrying in the right checkout.
Antigravity captures IDs through its opt-in lifecycle plugin. Without supported
hooks, IDs must be pasted to make Resume and Copy session ID available.
An exited shell’s sidebar panel offers **Restart shell**, a separator and **Close**;
the terminal pane has no restart button. Close removes the
session and its stored record, never the checkout or the agent's own conversation files.
With **Restore sessions on launch** on (the default), agents running at quit resume their recorded conversations in the same rows and tiles. Agents without a conversation ID stay exited and offer New conversation here; Foom never substitutes a new conversation. If no ID was pasted and no supported hook/notify event
arrived before exit (including hooks-disabled launches), no conversation ID is available.

Worktree removal is available for linked checkouts created by any tool. It requires
confirmation, validates repository membership and worktree identity, and rechecks dirty
files before deletion. The branch is kept; the main checkout cannot be removed. Repository removal forgets its
registration, retains all checkout files and refuses while it has sessions or pending operations.

Below 720 CSS pixels the tree becomes a compact rail with each session’s light, badge and accessible
name. ⌘⇧B on macOS or Ctrl+Shift+Space, then B elsewhere focuses the sidebar; arrow keys navigate.
⌘⇧N or Ctrl+Shift+N reveals and opens the session that has waited longest for you, clearing
its filter and expanding its ancestors. Other terminal keys, including Escape, remain input.
Settings, the six tile preset icons and Tidy tiles stay at the bottom of the sidebar. Launch actions live in repository and checkout menus. An empty sidebar labels its starting action **Add repository**.

### Delete merged worktrees

The repository menu offers **Delete merged worktrees…** below Remove repository
when at least one linked worktree is eligible, regardless of which tool created it. Foom fetches the remote
(`origin`, or the sole remote) and resolves its advertised default branch. A
branch is merged when `git merge-tree --write-tree <default> <branch>` produces
the default branch's tree: merging it would change nothing. This works for merge,
squash and rebase merges without GitHub access. A failed fetch refuses cleanup;
Foom never falls back to a stale default branch. Local inventory returns immediately;
background cleanup eligibility is cached for up to one minute and published when
ready. A plan less than one minute old fills the dialog immediately without fetching.
An older plan opens the dialog immediately in a checking state with Delete disabled.
Approving Delete always fetches afresh.

The trusted dialog lists candidate branches, then skipped checkouts with short
reasons, and offers **Delete** and **Cancel**. During cleanup it becomes a live
checklist with a count, progress bar, **Stop** and **Hide**. Stop finishes the
in-flight removals and starts no more; Hide and Escape close only the window.
There is one run per repository, and the repository panel reopens its checklist.
Finished runs offer **Done**. The sidebar shows the same count and queued, removing,
removed, kept or error tags; a completion status reports the result when hidden.
Removing uses the highlight, errors use failure ink, and reduced motion disables
sweep and fold animations. Main checkouts, locked,
prunable or detached worktrees, running sessions, dirty/untracked files and
exited resumable Claude/Codex/Antigravity conversations are retained. After confirmation,
Foom fetches again, revalidates each candidate before and after stopping its
exited terminal resources, then uses the existing safe removal path with at most
four candidates in flight. The sidebar refreshes after every candidate. Changed
worktrees are skipped and reported while others continue. The local branch is
also removed only if it still points to the exact checked commit. Branch deletions
share one checked-ref transaction after removals. Moved or checked-out branches
are kept and reported; a concurrent ref race aborts the transaction safely.

## Application menu and attention badge

Foom owns its menu and shortcuts. Click the sidebar's **foom** wordmark on any
platform, or press Alt alone or F10 on Windows and Linux, to open the application
menu below it. A chevron beside the wordmark turns while the menu is open. The
menu is the same everywhere and lists app-wide commands, the sidebar toggle and the whole-layout Tidy action:

- New window, New worktree…, Add repository… (orchestration is granted from a
  session's menu, #303)
- **Settings ›**, a submenu of routes: Via Claude Code, Via Codex and Via
  Antigravity (#84: each starts that agent in `~/.foom/config` in the Foom
  config dock), then Via Settings UI, which opens the Settings screen. Agent routes
  are enabled for installed, enabled agents after preflight, including while
  Settings is open. A new config session starts with a fixed greeting describing
  what it can change and asking what the user wants; resuming a conversation adds
  no greeting. Antigravity releases without interactive prompt support open
  without the greeting. An existing config session is focused in its owning window.
- **View › Collapse sidebar / Expand sidebar**, plus **Tidy tiles**, which removes empty spaces and evens every run in the focused window
- **Size − 100% +**, one row that steps the interface size and stays open
- Action log (#157), Keyboard shortcuts, About Foom, Third-party licenses
- Reload, Force reload and Developer tools, in development builds only
- Quit Foom

Items whose issue hasn't landed are present but disabled, with no explanation.
Arrows, Home/End, Enter and Escape navigate the menu; disabled items are skipped.
Right or Enter on Settings opens its submenu and focuses the first enabled
route; Left or Escape returns to Settings, and hovering opens it without moving
focus. The submenu flips left when the window has no room on its right. Up and
Down treat the Size row as one stop; Left and Right move between − and +.
Escape at the top level returns focus to the wordmark. The menu uses the same
surface and motion as row actions, with a scrollable list on short windows. The
native menu bar is absent on Windows and Linux, including after Alt.

Individual tile, focus, swap and preset commands, Focus sidebar, Longest waiting, Maximize,
Copy, Paste, Close Window and Foom on GitHub are not in the wordmark menu. Their
shortcuts still work; presets stay in the sidebar footer. Third-party licenses
keeps its own item until the About screen (#96); its dialog links to the source
repository. About uses the native About panel.

**Keyboard shortcuts** (Command+/ or Ctrl+Shift+/) opens a sheet of the current
platform's bindings in three columns, App, Board and Tiles, generated from the
same registry as the shortcuts themselves. On Windows and Linux the Tiles heading
names the Ctrl+Shift+Space leader once. Escape or a click outside closes it and
returns focus.

On macOS, the native menu bar keeps every command: Foom (About, Settings, Hide,
Hide Others, Quit), File (New Window, New Worktree, Add Repository, Close Window),
standard Edit roles, View (tile actions and presets, interface size, sidebar and
longest waiting), Window (Minimize, Zoom, Bring All to Front and windows), and
Help (Keyboard Shortcuts, licenses and GitHub). New Window uses Command+N on macOS
and Ctrl+Shift+O on Windows/Linux.

Foom commands use Command on macOS or Ctrl+Shift on Windows/Linux; plain Ctrl
letters remain terminal input. Settings is Command+, or Ctrl+Shift+,; Quit is
Command+Q or Ctrl+Shift+Q; New Worktree is Command+T or Ctrl+Shift+T. Alt+F4 and
Command+W use the existing quit confirmation. Interface actual size uses
Command+0 or Ctrl+Shift+0. Edit roles retain native macOS text-field behavior.
Reload, Force Reload and Toggle Developer Tools exist only in development builds.
Packaged windows disable DevTools and provide no reload/developer commands or shortcuts.

The app icon counts only sessions that **need you**, including hidden sessions,
and clears at zero. macOS uses the Dock badge; Windows uses a taskbar overlay
with an accessible count description (the compact image caps at 99); Linux uses
the desktop badge API where supported. The macOS Dock menu lists waiting sessions;
clicking one reveals it in the focused tile without clearing its attention state.

## Confirmations

Repository removal, clean worktree removal and stopping a session use click-again
in the actions menu. The first click changes the item to **Click again to remove**
or **Click again to stop**, in solid ink with a hairline draining over three seconds.
A second click after at least 300 ms confirms; a double-click does not. Moving away,
changing focus, Escape, closing the menu or expiry disarms it. Files stay untouched
when removing a repository. Removing a worktree keeps its branch.

Launching an agent in a checkout with another running agent changes the launcher
to **Click again for multiple agents here**. Shell launches need no sharing confirmation.
A Codex launch using the notifier fallback also requires **Click again to replace notifier**
when the notifier replacement has not already been acknowledged. Application-menu
config launches use a trusted dialog with the same disclosure because that menu
closes on selection. After trusted lifecycle
hooks have been observed working, later launches keep the user's notifier and omit
that disclosure. Setup shows hook health and directs review to Codex's own `/hooks` screen. Creating a
worktree launches nothing, so the disclosure stays with the launchers.

Decisions with content use a separate trusted Foom window. Removing a dirty
worktree lists the exact uncommitted status from Git and offers **Cancel** and
**Discard N changes and remove**. Quitting with live terminals lists each session,
its status light and location, then **Cancel** and **Stop all and quit**. Cancel is
focused initially; Escape cancels, Tab stays within the dialog and Enter activates
the focused button. The card-sized window follows Interface scale and stays centered on the board’s content.
The board stays visible under a translucent scrim and regains focus on dismissal.
It remains usable if the board renderer crashes or hangs. Confirmation buttons
use solid ink; amber and magenta retain their status meanings.

Folder pickers stay native. The New worktree branch field collects input and does not
grant destructive approval.

### New worktree

**New worktree** in a repository panel puts an empty branch field beside it, over the
panel's facts; the panel stays open. Right Arrow on the item also opens it. Command+T or
Ctrl+Shift+T and the app menu open the focused tile's repository panel with the field
focused, else the top repository in the sidebar; with no repositories they add one.
Spaces become `-`, and the field has no placeholder or helper copy. A ghost completion
follows the cursor and Tab accepts it; Up and Down cycle candidates: the repository's own
prefixes (`codex/`, `docs/`…), most used first (only when it has none, `feat/ fix/ chore/
docs/ refactor/ test/ ci/`), then branches starting with the text, then branches
containing it, shown right-aligned. One status line says what Enter does with exactly
what is typed: `new, from <head>`, `existing` (a local branch not checked out), `from
origin` (only on the remote), `open in <worktree>` (already checked out), or the Git ref
rule the name breaks, in the failure color with a matching border. Main validates again.
Enter does nothing for an invalid name or a bare prefix. Esc, or Left Arrow on an empty
field, returns to New worktree; Esc again closes the panel.

Enter disables the field and shows `Creating from <head>…` or `Checking out…`; a failure
shows Git's message there and re-enables the field. Creating starts nothing: the panel
closes and focus moves to the new worktree's row, whose own panel offers the launchers.
A branch already checked out creates nothing; its row arrives instead. A branch only on
the repository's remote (origin, or its only remote) is checked out tracking it; other new
branches start from the repository's HEAD. Branch data comes from refs already present;
opening the field never fetches. The arriving row grows into its slot, a highlight sweeps
across it once and it flares twice in the accent (never amber: nothing needs you yet),
then keeps a tint and accent edge until hovered or focus leaves it. With reduced motion
it shows the tint and edge without animating. The arrival is view state: it does not
survive a reload or appear in other windows.

## Terminal tiles

The layout is a binary split tree. Each leaf is a tile with a stable identity and
at most one terminal or preview; each split has a horizontal or vertical direction and a ratio.
Split right and Split down add empty space, keep focus in the original tile,
and make the newest space the landing spot. Hide and exited-session Close leave
empty space in place, with sibling geometry unchanged, and make it the landing spot.
Hide keeps the session running; Close closes it through the sidebar command.
Tile chrome never stops a running process. Reclaim space with Grow, gutters
(including Home/End), or presets. Presets leave hidden sessions running.

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
accessibility navigation. The landing spot has a faint highlight. Sidebar placement
fills it and focuses the terminal; dropping onto any empty space fills that space.
Focus uses the highlight border and brighter occupied title bar; Needs you uses an
amber border that takes precedence and a labelled, haloed light.

Terminals and previews are numbered, in tree order, including sidebar numbers and number
shortcuts. The focused tile's number is highlighted. Presets are One, Two side by side, Two
stacked, Two by two, One and two, and One and three. They keep the focused content
first, then other occupied leaves in tree order, then empty leaves. Existing leaves keep
their views; additional leaves start empty, and sessions that no longer fit hide.

Preview title bars show a document glyph, MD or HTML badge, relative path, tile menu,
Maximize/Restore and Close. A preview has no running process to hide. Presets and
replacement close previews that no longer fit. Split, Grow, drag, Tidy and focus
shortcuts treat previews as occupied tiles. Opening or reloading a preview never
moves focus; a click or explicit focus command does.

Double-click a gutter, or press Enter while it is focused, to give every member
of its run an equal share. A run follows consecutive splits on the same axis;
perpendicular subtrees and their nested ratios stay unchanged. Equal shares of
runs longer than two members can exceed the usual ratio limits.

**Tidy tiles** removes every empty space, collapses single-child splits and evens
every run. Tile order, content assignments, focus and surviving leaf identities
stay unchanged. An all-empty layout keeps one empty space. Tidy restores any
maximized tile first and uses the existing tile resize motion (immediate with
reduced motion). It applies only to the focused window, from the sidebar footer
icon after the six presets, View → Tidy tiles, or its shortcut.

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
Maximize is temporary. On restart, unavailable sessions leave empty tiles; terminal
PTYs are recreated for eligible running sessions; screens and scrollback are not restored. WebGL remains separate future work.

Drag a sidebar session onto a tile center to replace its session (the previous
session keeps running hidden), or onto one of its four edges to split it in half.
Drag a title bar onto another tile center to swap whole tiles, or onto an edge to
move that tile there, collapsing its old parent. Tile moves and swaps preserve
terminal views and attachments. A labelled, outlined preview shows the destination;
a live region announces it. Escape cancels the drag.

Swap with the nearest tile using Command+Alt+arrow on macOS, or the tile leader
then Shift+arrow on Windows/Linux. The View menu exposes the same four commands.
Focus follows the moved tile.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code and trusted Codex lifecycle hooks, with Codex `notify` as the fallback, attached per launch, plus the explicitly installed Antigravity observer plugin. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](agents.md).
2. **Local agent UI signals**: capture-backed terminal title and screen rules. Idle is evidence for classification, never Done by itself. Process exit remains final and permission hooks take precedence.
3. **Process facts**: exit code, the shell prompt returning, echo changes only with corroborating prompt context (agent TUIs also disable echo during ordinary operation; this may not be detectable on Windows).
4. **Text patterns** in the tail: `(y/n)`, `Password:`, `Press Enter`.

There is no model tier: local signals cover the useful verdicts without sending terminal content to a provider. Ambiguous terminals retain the neutral rules verdict.

"Quiet" is not "done". A process can be silent while it works. The debounce adapts: it's short when the tail ends in a question and longer mid-stream.

Every verdict and the user's next action (replied, dismissed, ignored) go into a local log. Dismissing an alert counts as feedback. The log becomes the test set for improving the evaluator.

## Orchestration and privacy

The [control-plane design](orchestration.md) has an authentication and HTTP
foundation, read-only MCP tools, a packaged console CLI and repository
orchestrators. Ordinary agent launches receive a private credential for their own
identity, with no mutation capabilities. Claude Code 2.1.293+ and Codex 0.161.0+ stable releases with their per-launch MCP
help flag receive read-only MCP access to session metadata in their own repository,
independently of hooks. These tested releases are the version floors. Older or
unparseable versions, missing flags and Antigravity do not attach MCP; managed client policy may deny attachment. These tools
never return terminal output. **Make orchestrator…** in a running Claude Code, Codex or
Antigravity session's menu grants that session permission to create worktrees and run up to
the concurrent child limit set in Settings → General (default 4, integer 1–16),
without restarting it; **Revoke orchestrator** takes it back.
One session per repository holds the role: making another the orchestrator asks once and
revokes the first. The session keeps its own launch flags, including bypass. Every
agent sees the orchestration tools from launch, refused until you grant the role; tell
the agent when you do.
Children cannot orchestrate through Foom and never inherit your launch flags. The orchestrator's panel lists its
actions and their outcomes. Each attached session panel shows MCP Connecting…,
Connected after the first successful authenticated request, or Not connected after
30 seconds. Only the orchestrator uses magenta for this failure; ordinary sessions
record it without alerting. A later request clears the failure. Settings → Agents
shows MCP available or unavailable from the version and capability gate.
You can stop a child or take it over, which ends the orchestrator's access to it. Agents launched outside Foom receive no automatic
access. Agent configuration is attached per launch, never installed globally or
written into the repository.

The packaged `foom` console can inspect session metadata and, for sessions you
made orchestrator, create worktrees, launch and stop children, request worktree
removal, and read bounded tails or wait for child state. Every orchestrator gets
the CLI on its process-local PATH, including when MCP is unavailable. Antigravity
orchestrates through the CLI alone. Agents launched by Foom
use only their inherited repository scope. Humans and scripts request pairing with
`--repository PATH`: compare the code in the CLI and Foom's trusted dialog, then
grant read-only access for ten minutes. Pairing expires after 60 seconds and never
grants terminal output, typing or mutation access. Credentials remain in memory.
Optional `--install-cli` / `--uninstall-cli` commands manage only Foom-owned PATH
setup; absolute-path use needs no installation. See [console usage](orchestration.md#console-helper-and-local-pairing-154).

An orchestrator can request at most the last 40 lines of each child's terminal,
with likely secrets redacted and each response capped at 16 KiB. These results may
be sent to the orchestrator agent's model provider, under that agent's own provider settings. Repeated reads can collect more output over time. Foom does
not read files, diffs, transcripts or keystrokes for this API; a terminal may print
file contents, diffs or echoed input, and redaction cannot catch every secret.
The Make orchestrator dialog discloses this data path. The agent's own tools and provider
settings continue to govern its other data access.

Permission and credential prompts always stay with you. With the current agent
interfaces, proposed answers to prose questions also require review in Foom;
unattended replies need a verified question-specific routing mechanism first.
Take over cancels pending replies. Worktree removal asks you and rechecks its
identity and changed files. Settings → Repositories can allow an orchestrator to auto-remove its own clean, fully merged
worktrees with no running sessions; this option is off by default. The app menu’s
**Action log** opens searchable local history with actor/parent,
repository/worktree, action, target/result IDs, outcomes and redacted reply proposals.
Search and Action/Outcome filters apply to retained history, with 100 events per page.
Pending confirmation, refused operations and indeterminate delivery are explicit.
**Clear history…** asks for a second click and preserves live operation deduplication.
History stays private and is retained for 30 days in at most five 10 MiB files.
Children appear under their own checkout with a small, dim child glyph and an
independent light. Their tooltip names the parent orchestrator. Hovering, focusing
or selecting a parent highlights its children across checkouts; hovering or
focusing a child highlights its parent. Exited and revoked parents retain their context; close child rows before
closing an exited parent. Children with an unavailable parent remain in their own
checkout. Take over is shown on the child’s panel.
A local action log records who acted, targets and
outcomes, plus redacted reply proposals; it omits terminal tails, credentials and
initial prompts. It retains at most 30 days and five 10 MiB files and can be cleared.

## First run

Setup is a preflight countdown:

1. **Agents** (T-3): detect the supported CLIs on PATH and show each one's attention signal. One setting controls whether Foom supplies hooks and credentials per launch. Antigravity’s row shows Hooks with an active plugin and Screen rules otherwise. It offers Install plugin, Update plugin or Enable plugin inline; Remove plugin lives in Plugin details. Install and update open a trusted confirmation disclosing location, behavior and removal, with no disclosure paragraphs in the step.
2. **Repositories** (T-2): "Where do you keep your code?" Foom suggests common code folders that hold repositories, with a count for each, or you choose one. It scans that folder and lists its Git repositories, with the ones worked on in the last 30 days checked.
3. **Worktrees** (T-1): choose where new worktrees live: Foom's folder (`~/.foom/worktrees`, the default) or next to each repository.
4. **Go / no-go** (T-0): each item shows GO or NO-GO with a link back to its step. Launch needs every item GO: at least one agent ready and one repository added.

On wide windows the steps use the extra width: agents as a grid and the worktree choices side by side.

Preflight derives a shared enlargement from the actual space left beside or below the
rail, then checks the rendered content, including wrapping and the fixed footer. It
never enlarges content into overflow or shrinks it below the user's chosen interface
size. The scale stays between 100% and 200%; larger steps can lower the shared ceiling,
but only a window resize or interface-size change lets it grow again. Long lists,
expanded details and small windows scroll at normal size, with navigation still visible.
Short steps center vertically. Content changes
re-center over 180 milliseconds (immediately with reduced motion). Back, Continue and
Launch stay in a footer at the bottom of the window, outside the scrolling content.

The rail also holds **Appearance**: System, Light or Dark, and the interface size (80–300%, so a presenter can zoom Foom alone without changing OS scaling; the window grows and shrinks with it while the screen has room, around the pointer when you click + or − or scroll over the percentage, so what you pointed at stays under it; also ⌘ +/−/0 on macOS or Ctrl+Shift+=/−/0 elsewhere). Terminal font size is separate and lives in Settings → Terminal. Launch opens the board. The board starts empty. A repository’s **New worktree** action creates a Git worktree for the branch, or focuses the checkout that already has it regardless of which tool created it, and launches nothing; checkout panels launch sessions. Sample sessions are available only in an explicit development build. After first run, **Settings** on the board edits the saved choices.

## Settings

Open **Settings** from the board, or press ⌘, on macOS and Ctrl+Shift+, elsewhere.
It replaces the terminal tiles beside the persistent sidebar in the same window.
Esc returns to the tiles and restores the same focused sidebar row.
Selecting a terminal in the sidebar also leaves Settings; terminals keep running throughout.

General offers **Restore sessions on launch**, on by default. Turning it on through agent-edited config requires Allow because it also permits restoring orchestrator control.

Agents and hooks, Repositories, and Worktrees use the same controls as
preflight. Changes apply immediately and persist. A repository scan in Settings
starts with the already-added repositories checked; toggling a selection saves it
at once and reports any refusal.
When agy is detected without its plugin and the user has never answered the offer,
Settings → Agents and hooks shows a neutral **Plugin available** marker. There is no
launch modal or toast. Answering the install confirmation, including **Not now**,
persists the answer and clears the marker; the inline action stays available.
Without agy on PATH, no plugin controls or marker appear.

Settings → Agents and hooks also provides default launch arguments for each supported
agent, one argument per line, with an explicit Save default arguments action. Put flag
values on separate lines. Spaces and quotes are literal, with no shell parsing or
splitting. LF and CRLF are accepted; trailing blank lines are ignored. Errors name
the agent and line. An empty editor uses the existing launch behavior. The user's agent policy
is their global config plus Foom defaults; Foom appends its own display and attention
flags and never edits global config. Defaults affect future user launches only.

Main validates at most 64 arguments per agent, each 1–4096 characters with no control
characters. Foom reserves Claude `--settings`, `--safe-mode` and `--bare`,
`--no-alt-screen`, Codex `-c`/`--config` overrides of `notify` or `hooks`, and the `--` terminator so
these defaults cannot displace its attention flags. Saving a known bypass argument
requires a main-owned trusted dialog once per agent, with Cancel focused by default: a worktree is not a sandbox, and
the agent can act as the user anywhere on the machine. Cancelling leaves settings
unchanged. Codex `danger-full-access` sandbox flags and `sandbox_mode` overrides
also count as bypass, even with approvals enabled. Known bypass detection is a
fixed table, not an effective-policy audit. On load, an invalid agent's stored
argument list is dropped without resetting other settings or other agents' lists.

Conversation selectors are reserved for Foom's session actions: Claude resume,
continue, session-ID and fork-session flags; Codex `resume`/`fork` commands and
`--last`/`--fork`; Antigravity conversation/continue flags. This prevents launch
defaults from redirecting Resume or turning New conversation into a continuation.
Other agent arguments retain the existing validation and literal argv behavior.

Settings → Environment sets environment variables for **All sessions** (every
shell and agent) and for each agent, edited in place: a name, a value and a
**Secret** toggle per row, and a blank row to add one. A valid row saves when focus
leaves it and applies to new sessions; running sessions keep theirs. Agent rows
override All sessions for that agent. `PATH` only prepends directories. A proxy URL
with credentials is always secret. Secrets are stored with the system keychain, shown
masked with **Replace**, and never shown again. Main refuses reserved names (`FOOM_*`,
`CLAUDECODE`, `TERM`, `COLORTERM`, `TERM_PROGRAM`) and names that load code, with the
reason beside the row. With any proxy set, Foom appends `localhost,127.0.0.1,::1` to
`NO_PROXY` so its own endpoints stay direct. **Import from login shell** offers only
proxy and certificate variables and adds only the ones picked. A session's panel
lists the names Foom set, never values. The config folder cannot set environment
variables. See [the launch environment](architecture.md#launch-environment-215).

Settings → Appearance also offers **Panel color: Vivid / Subtle / Plain**,
with Vivid as the default. It scales header, mark, command-column, chip-fill and
glow decoration only. Status text and outlines retain color and words. High
Contrast and `prefers-contrast: more` force Plain and full-strength chip outlines.
Decoration uses highlight; Working continues to use accent.

Appearance shares the preflight rail's System/Light/Dark and interface-size controls.
Changing either view is reflected in the other without restarting.

Terminal font size applies to every terminal view: 10–32 pixels, 14 by default,
independent of interface size. The Terminal section previews text size, all 16 ANSI colors, bold, dim and selection.
Terminal colors default to Follow interface, with Foom Light/Dark, Solarized Light/Dark
and Dracula built in. Changes apply live to visible and detached terminals.
Settings → Themes offers System, Eclipse Light, Eclipse Dark, High Contrast,
Deep Field, Moonlight, Graphite and Midnight Indigo, with a live preview of all six terminal statuses.
System follows the operating system's light/dark appearance. The other themes have
a fixed light or dark base. Changes apply immediately and persist. The preflight
and Appearance System/Light/Dark controls return to the corresponding Eclipse
appearance; changing interface size keeps the selected theme. Terminal color
schemes remain independent; Follow interface uses the light/dark base.

Appearance and Terminal list custom themes after the built-ins and offer **Open
themes folder**. Add interface JSON files to `~/.foom/config/themes/` and terminal
JSON files to `~/.foom/config/terminal-themes/`. New files and valid edits apply live,
without restarting. Rejected files appear below the picker with a filename, JSON
path and reason in failure styling. An invalid edit retains that theme's last good
colors for the current session. A missing or invalid saved choice at startup uses
Follow while retaining the choice; fixing its file restores the selection. Custom
names matching a built-in receive “(custom)”. See the [file formats and limits](architecture.md#custom-theme-files-205).

Every interface theme keeps amber for Needs you, magenta for Failed, and violet for activity.
Needs you retains its halo, Failed its square light, and all states their labels.
High Contrast provides at least 7:1 text contrast and stronger borders.

Settings → Sound offers a separate recording picker and preview for Working, Done,
Needs you and Refusal. Built-in and user files appear together, named from their
filenames. Working is off at 15% by default. One steady loop plays at the selected
volume while at least one agent is executing, including silent thinking and tool use.
More agents do not increase its volume. Completion of one agent leaves the loop
running for others. Plain shells produce no automatic sounds, including command completion and attention alerts.
Starting, idle, blocked and exited agents are silent. Unsupported agent versions stay
neutral until Foom receives supported lifecycle evidence. Alerts
cover Done, Needs you and Refusal and default to on at 50%. Each decoded recording
gets bounded loudness normalization so volume choices remain useful across files.

Needs you repeats every two minutes until the agent resumes or attention is dismissed.
Typing alone does not prove an agent has resumed. Shell replies still clear attention. Needs you is muted in
the focused tile of the focused window; Settings and preflight hide
that terminal and allow attention alerts again. Done plays once per completed agent
turn, including in the focused tile. Initial readiness is not a completion. Completion observed while muted is not
replayed. Attention reminders resume after two minutes away or after unmuting.
Verdicts settle for one second before sounding. Simultaneous alerts play once, with
Needs you taking precedence; verdict alerts are at least two seconds apart.
Full tile placement does not play Refusal. Visual status always stays on.

**Open sounds folder** opens `~/.foom/config/sounds/` in the file manager. Add files
to `working/`, `done/`, `needs-you/` or `refusal/`, then reopen Settings → Sound to
refresh. There is no import dialog. Supported files are OGG, Opus, WAV, FLAC and MP3;
only direct regular files with valid headers are accepted. Working files are at most
8 MB and 1–30 seconds; other files are at most 2 MB, with Done/Needs you up to 1.5
seconds and Refusal up to 0.3 seconds. Each folder lists at most 100 eligible files.
Hidden files, subfolders, names over 100 characters and links outside their kind
folder are rejected.

Choices persist as a source and filename, never a path. Missing or invalid choices
fall back to the built-in default with a reason beside the picker, without replacing
the saved choice; restoring the file and reopening Sound restores playback. Needs
you cannot select the same source/filename as Done or Refusal. Old soundscape settings
migrate while preserving switches and volumes. Previews use the selected volume even
when switched off; Working previews stop after five seconds. Sound credits are in
Settings → Sound and packaged third-party notices, ready for the future About screen
(#96). The 17 built-in CC0 recordings include drive chatter, teletype, typewriter,
projector, bells, percussion and short refusal sounds.

### Foom config

User themes may apply with brand warnings, shown in Foom config and by the CLI; file changes that make needs-you hard to distinguish wait for approval.

Settings → Foom config shows the config folder (`~/.foom/config`) with **Open
folder**. Agents configure Foom by editing that folder: `settings.json`, theme
files and terminal themes. Each valid change applies live and is committed to the
folder's git repository; an invalid file is rejected whole and the previous
version stays in effect. Changes that would make Foom less able to say something
needs you (turning alerts off, alert volume 0, hooks off, or turning an agent off)
wait in an amber banner, such as "An agent wants to turn off the needs-you sound",
with **Allow** and **Keep it on**. Keep it on restores the file.

`agentArguments` in settings.json contains literal lists for `claude`, `codex` and
`agy`. Every file-originated argument change waits for Allow, including removing
arguments. Allow opens the trusted dialog with each changed agent's before and
after lists, one argument per line, and names known bypass flags. Accepting also
records bypass acknowledgement. Settings edits write the same file directly and
retain their existing bypass disclosure. Running sessions keep their arguments;
new, resumed and restored launches use the approved defaults.

**Recent changes** lists each change with its time, summary, file and state:
Applied with a short hash and **Revert**, Rejected with its reason, or Pending.
Revert restores the previous version of that change's files; a revert that would
weaken attention asks for approval too. Changes made in Settings are written to the
same file and appear in the list. See the [architecture](architecture.md#foom-config-environment-84).

## Windows and quitting

New Window opens another full sidebar and an independent tile layout. A tile's
**Move to new window** control moves that session into a new window. Each terminal
belongs to the app and can occupy only one tile across all windows. A neutral ▣
marker labels sessions shown in another window; selecting one brings that window
forward and focuses its tile. Sidebar tile numbers always refer to the current
window. The longest-waiting shortcut starts from the current window and focuses
another window when that session is already shown there.

Closing a window hides its sessions without stopping their PTYs. On macOS, closing
the last window leaves Foom running; Dock activation opens another window. On
Windows and Linux, closing the last window requests quit. Quit from any window
stops the entire app and uses the focused window's trusted confirmation. Other
trusted dialogs attach to the window that requested them.

Each window saves its display, normal bounds, maximized state, interface size and
tile tree and sidebar collapse choice. At launch Foom restores those windows. Missing displays fall back to the
primary display and bounds are clamped to its work area. After showing all windows, Foom restarts sessions that were running at quit (or their last known state before a crash), up to three launches at a time. Shells use their saved checkout or home; agents resume only with a saved conversation ID. Missing checkouts keep exited rows with the Worktree removed label. Failed launches retain their conversations for retry. If Codex needs new consent to replace its notifier, the row stays exited for manual Resume. Restores use current defaults, fresh credentials and reserved conversation selectors, and skip the shared-checkout warning. Turning Restore sessions on launch off restores every row exited. Closing a window removes it from the saved
window set. Interface size is independent per window; other settings are shared.
The attention badge counts sessions once for the app. One window plays app sounds,
with attention suppression following the focused terminal in any window.

If any terminal is running, quit asks for confirmation; Cancel keeps everything
running. Quitting stops every PTY before the app exits. Terminals live exactly as
long as the app.

## Mockups

Clickable mockups live in [`docs/mockups/`](mockups/README.md): the [board](mockups/board.html), [first run](mockups/first-run.html), and [brand](mockups/brand.html). The board and first-run mockups predate the brand; take their layout and behavior, and take color and type from [brand.md](brand.md). The mockups README lists what else they get wrong.

Shell status currently follows command start and completion in Bash 4.4+: an initial
prompt is Quiet (“Shell is ready”), a command is Working, and return to the prompt is
Done or Failed according to its exit code. Editing the next command preserves that
result until execution starts. Other shells use output patterns and process exit.
The quiet debounce preserves the current state; there is no separate Checking state. Agent Working follows
lifecycle evidence, never silence or output volume. A supported turn-end signal
stops Working immediately; classification determines the result.
