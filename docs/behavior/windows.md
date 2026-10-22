# Windows

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Windows and quitting

New Window opens another full sidebar and an independent tile layout. A tile's
**Move to new window** control moves that session or HTML/Markdown preview into a new window. Moving a preview removes it from the original board and preserves its live reload watch and opener attribution, with network reset to Off. If placement stalls for five seconds, the preview appears
in a default landing area. Closing the new window before its preview has appeared
returns it to the original window; if that window has closed or filled up, Foom
opens a replacement board for the preview. Each terminal
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

Each window saves its display, normal bounds, maximized state, tile tree and sidebar collapse choice. Interface size is saved once for the app. At launch Foom restores those windows. Missing displays fall back to the
primary display and bounds are clamped to its work area. After showing all windows, Foom restarts sessions that were running at quit (or their last known state before a crash), up to three launches at a time. Shells use their saved checkout or home; agents resume only with a saved conversation ID. Missing checkouts keep exited rows with the Worktree removed label. Failed launches retain their conversations for retry. Codex restore attaches its notifier fallback without confirmation. Restores use current defaults, fresh credentials and reserved conversation selectors, and skip the shared-checkout warning. Turning Restore sessions on launch off restores every row exited. Closing a window removes it from the saved
window set. Interface size is shared app-wide; each window retains its own remembered size at 100%.
The attention badge counts sessions once for the app. One window plays app sounds,
with attention suppression following the focused terminal in any window.

If any terminal is running, quit asks for confirmation; Cancel keeps everything
running. Quitting stops every PTY before the app exits. Terminals live exactly as
long as the app.
