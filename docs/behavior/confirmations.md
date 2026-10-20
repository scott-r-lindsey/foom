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
