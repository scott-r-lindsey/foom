# Confirmations

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Confirmations

Repository removal, clean worktree removal and stopping a session use click-again
in the actions menu. The first click changes the item to **Click again to remove**
or **Click again to stop**, in solid ink with a hairline draining over three seconds.
A second click after at least 300 ms confirms; a double-click does not. Moving away,
changing focus, Escape, closing the menu or expiry disarms it. Files stay untouched
when removing a repository. Removing a worktree keeps its branch.

Launching an agent in a checkout with another running agent changes the launcher
to **Click again for multiple agents here**. Shell launches need no sharing confirmation.
Foom attaches Codex's notifier fallback per launch without a warning or confirmation.
After trusted lifecycle hooks have been observed working, later launches keep the
user's notifier. Setup shows hook health and directs review to Codex's own `/hooks`
screen.

User-action decisions with content use a separate trusted Foom window. Agent and
background approvals instead use the shared queue described below. Removing a dirty
worktree lists the exact uncommitted status from Git and offers **Cancel** and
**Discard N changes and remove**. Quitting with live terminals lists each session,
its status light and location, then **Cancel** and **Stop all and quit**. Cancel is
focused initially. On macOS, clicking an inactive trusted dialog activates it and
delivers that same click to the control under the pointer. The board accepts
activating clicks too; while blocked by a trusted dialog, its clicks only recover
the dialog as before. Click-again confirmations still require at least 300 ms.
Escape cancels, Tab stays within the dialog and Enter activates
the focused button. The card-sized window follows Interface scale and stays centered on the board’s content.
The board stays visible under a translucent scrim and regains focus on dismissal.
It remains usable if the board renderer crashes or hangs.
After a user-started confirmation is shown and checked, switching to another app
leaves it pending without taking focus back. Returning to Foom brings the dialog
forward again; confirming still requires it to be focused and fully on screen.
Agent and background approvals stay pending in the queue while Foom is inactive.
User-action preview and workspace confirmations retain their existing availability checks.
Confirmation buttons use solid ink; amber and magenta retain their status meanings.

Folder pickers stay native. The New worktree branch field collects input and does not
grant destructive approval.

Plugin setup keeps the action disclosure, detail paragraph and instructions/removal
visible. Executable/fixed arguments, installation/state, status/ownership checks
and staged files start collapsed with main-computed summaries. The executable
summary shows its basename and fixed arguments on one line, shortened in the middle
when long, with the full absolute executable path and fixed arguments in its tooltip and
accessible name. Installation
summarizes the agent ID, ~/ install location and state. Staged files show the file
count and total UTF-8 byte size, then one line per file: name, first 12 SHA-256 hex
characters and byte size. Full hashes remain in each line's tooltip and the
accessible summary name, and selectable with the file's bytes when expanded.
Expanding preserves every original disclosure byte, including the complete
executable, fixed argv, state conditions, status/ownership JSON and JSON-escaped
file bytes in individually capped scrolling boxes. The dialog is capped at 800
CSS pixels (and the available window height), with a scrolling content region
and an always-visible action footer. Tab reaches the native disclosure summaries
and expanded byte boxes; Enter or Space toggles summaries. A new request starts
collapsed. User-action dialogs focus Cancel; queue rows never move focus on arrival.

Merged-worktree cleanup offers **Close when completed** to the left of its footer
buttons before deletion and while running. It starts checked on every opening and
is not saved. A checked run closes after every selected worktree is removed;
failed or refused removals stay visible for **Done**. Unchecking keeps the finished
state open. **Hide** and Escape still hide a running cleanup without stopping it,
and hidden completion follows the existing cleanup reporting behavior.

Agent and background requests share one approval window across all boards (#1105).
Every row names its source (agent and tile/session identity when present, or
background/no tile), repository or global settings scope, target and complete
consequences. Each has its own Approve and Decline. The queue opens only through
**N approvals waiting**, shown in amber with a text label in each board sidebar.
Arrivals never focus it or capture Enter from a terminal. Hide, Escape and native
close/minimize keep pending rows; they do not decline them. Switching apps leaves
them pending. The board remains usable without a scrim.

Rows append at the end with stable identities and both decisions disabled for
900 ms after presentation. Repeated identical requests merge into one row; each
caller's cancellation remains independent. A withdrawn, expired or externally
resolved request is replaced by a non-interactive “Request ended” placeholder
for 900 ms. Reclaiming that space cannot immediately activate a different row:
buttons that move are disabled for another 900 ms. Moving or resizing controls,
including by scrolling or expanding details, restarts this reading interval.
Moving or resizing the native approval window also disables decisions for 900 ms,
including when it recenters after its board moves or resizes.
Removing a focused decision moves focus to Hide. Empty queues close.
The window grows down from a fixed top edge to 720 CSS pixels, then scrolls within
the available board/display area. Its title and the sidebar show the live count.

Worktree removal rows show the path once as a wrapping title with a copy control.
One line names the state, branch retention and requester. Rows with changes
show the number of distinct Git paths in an amber summary beside **Discard N files
and remove** (or **Discard 1 file and remove**). The file list is in a bounded,
keyboard-focusable scroll box above the buttons. The summary and action must both
be fully visible and the decision must be ready.

**Approve all clean removals (N)** counts every pending, ready removal with no
tracked changes or untracked files, including off-screen rows (#1293). The primary
pointer press or initial Enter/Space key-down captures those IDs. Release approves
only captured rows that are still pending, ready and clean. Main rechecks each
checkout before removal. Synthetic clicks and keyboard events never make a
decision in any trusted confirmation.
Authority, plugin trust, host trust and credential grants always require individual
approval. Full plugin disclosures and progress remain in their own row. User-started
link-open, tile-close, quit and merged-cleanup confirmations retain their existing
local action flow; checking/fetching still grants no deletion consent.

Plugin setup keeps the same dialog after Install, Reinstall, Update, Enable or
Remove. Fixed steps use symbols and labels for pending, running, done and failed.
Close is disabled until setup finishes; Escape and native close also wait. The
receipt shows the resulting observer version, enabled state, installation location
and each mutation command's exit status and duration. CLI output is never shown.
Done returns to Settings, where Scan again and the available plugin actions remain.

When an agent removal finishes while its review is visible or waiting, that item
leaves the review automatically. Other pending items still need approval. If none
remain, the dialog closes and the board becomes usable without an extra click.

SSH host-key trust shows only the registered host, parsed key type and fingerprint
from OpenSSH’s unknown-host question. **Trust host key** relays yes to OpenSSH;
**Cancel**, Escape and close relay no or end the run. Cancel is focused by default.
Foom never displays raw askpass text or asks for a password or passphrase.

Host-removal confirmations list the dormant/exited sessions whose saved metadata
will be forgotten. A neutral hollow ring and **Dormant** label describe the local
row, without claiming that a remote process has stopped.
