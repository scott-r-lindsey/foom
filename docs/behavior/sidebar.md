# Sidebar

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Terminal sidebar

The sidebar is a repository → worktree → session tree beside the terminal tiles.
The header shows the wordmark, needs-you and working counts, and a filter.
A quiet **+** row after the last repository group adds a repository, in keyboard
list order. Its accessible name is **Add repository**; with no repositories this
is also its visible label. The row is hidden while filtering and in the compact rail.
Its panel-toggle button collapses the sidebar to a 64px rail at any width; Expand sidebar
returns to the tree. View → Collapse sidebar / Expand sidebar and ⌘B on macOS or
Ctrl+Shift+B on Windows/Linux do the same. Plain Ctrl+B stays with the terminal.
The choice saves with each window’s tile layout; new windows start expanded.
Drag the expanded sidebar’s border to resize it live, from 240px to 40% of the
window (300px by default). A thin highlight and resize cursor mark the border on
hover or drag. Double-click resets it. The focusable separator reports its width;
Left/Right resize by 10px and Home/End select the limits. Width saves with each
window’s tile layout; new windows use the default. Collapsing preserves the width.
A smaller window clamps the displayed width without changing the saved value.
The rail and narrow-window overlay have no resize handle. Dragging has no width
animation; terminals refit once at the end.
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

An unavailable repository shows **Unavailable** and a background failure mark.
Its sessions and previously displayed locations stay visible while other
repositories keep updating. Recovery clears that inventory mark without changing
focus. Unavailable membership does not label a session's checkout as removed.

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
conversation IDs survive Foom restarts. Sessions running at quit restart when Restore sessions on launch is on; exited sessions stay exited in the sidebar without board tiles. Resume or New conversation places their new terminal normally. Terminal screens and scrollback are never persisted.
Hover and keyboard focus do not preview terminal output or switch the pane. Click or press Enter to show
its terminal and focus input, using the [tile placement rules](tiles.md). Saved exited rows have no screen to show until resumed. Needs you remains; Done and Failed dim once seen.

Previews appear beneath their worktree with a document glyph and no light or attention state.
Their rows show the worktree-relative path and shared tile number. Agent-opened previews nest beneath the opener’s session and name that agent. Clicking a visible row focuses its preview; showing a sidebar-only preview uses human placement.
Checkout panels offer **Preview file…**. The file picker starts in that checkout and accepts
Markdown (`.md`, `.markdown`) and HTML (`.html`, `.htm`). Main validates the selection;
files outside the checkout, hidden files and unsupported types are refused.
Opening fills the landing spot, then empty space, and follows human session placement
when the board is full. Opening keeps focus where it was. Previews and their v2 tile
content survive restart. Removing a worktree closes its previews and leaves empty space.
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

The sidebar footer holds a compact −/value/+ zoom stepper, an always-visible
master volume slider with a speaker mute button, and the **Foom config** gear.
Zoom is one app-wide setting shared by every window, Settings and the app menu; clicking its
value resets to 100%. The speaker shape shows muted (also at zero), low or high
volume. Moving the slider unmutes; releasing it plays a short sample. The rail
keeps only the gear. The gear opens a
pinned panel to the right, bottom-aligned and pointing at the gear. **Settings**
is its first command, with its shortcut; ⌘, on macOS, Ctrl+Shift+, on
Windows/Linux and the app menu still open Settings directly. Then come the agent launchers and Shell (run in the config
folder), then **Open folder**. Each launcher action starts a new session.

A dock above the footer bar appears only while a config change is held, files
are rejected or a config session exists. Its small gear and **Foom config** name
open the same panel, beside **Needs you** and **N rejected** chips as applicable.
Each session row beneath it focuses its tile and retains the normal light, ring
and panel behavior, including after exit. The tree has no config row or group;
repositories follow the home shell directly. Filtering the tree leaves the dock
reachable. In the rail the dock hides; config sessions join the compact session list. The gear repeats held changes with an amber dot, otherwise
rejections with a magenta square dot; its accessible name includes these statuses.
Held config changes count in “N need you” and the app badge.

The panel shows the folder path (copyable), Approval with **Needs you** and its
**Allow / Keep it on** decision, Rejected
and Sessions. Multiple config sessions can run at a time. No worktree is created, and the session's `PATH`
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
Zoom, master volume and the Foom config gear stay at the bottom of the sidebar. Launch actions live in repository and checkout menus. An empty sidebar labels its starting action **Add repository**; a populated sidebar shows **+ Add repo** with the same accessible name. General’s optional relative-path preference shows nested repository names beneath the code folder; outside repositories keep their names.
