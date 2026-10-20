# Errors

Decided user-visible rules. Implementation: [error presentation and coded IPC](../areas/errors.md).

## Error presentation

Failures of actions the user starts (menus, sidebar commands and Settings actions)
open an in-board error dialog. It shows a failure square, one fixed short sentence
chosen by error code, Dismiss and a fix button when available. It never displays
exception text or Electron's transport wrapper. Unknown codes use a fixed sentence
for the operation. No button is selected on opening; Escape dismisses without
acting and restores focus. Trusted confirmation windows remain reserved for
confirmations. Settings field validation stays beside its field.

Background failures, including layout and preference saves, never open a dialog
or move focus. The affected sidebar row shows a failure square and reveals its
message on hover or selection. Failures without a row put a square beside the
Foom config gear; clicking it reveals the message. Dismiss or the next successful
attempt of the same operation clears the mark. Failure marks and text use failure
ink, never amber.

Removing a prunable worktree offers Prune in the error dialog. Prune cleans Git's
stale worktree records in that repository and keeps branches. A leftover folder
is deleted only at Git's recorded path, strictly under Foom's managed worktree
root, with no symlink in any path component, no `.git` entry and no main checkout.
Unsafe folders are refused.
