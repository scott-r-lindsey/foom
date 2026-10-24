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
collapsed and focuses Cancel.

Merged-worktree cleanup offers **Close when completed** to the left of its footer
buttons before deletion and while running. It starts checked on every opening and
is not saved. A checked run closes after every selected worktree is removed;
failed or refused removals stay visible for **Done**. Unchecking keeps the finished
state open. **Hide** and Escape still hide a running cleanup without stopping it,
and hidden completion follows the existing cleanup reporting behavior.
