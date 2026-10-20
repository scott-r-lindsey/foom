# Menus

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Application menu and attention badge

Foom owns its menu and shortcuts. Click the sidebar's **foom** wordmark on any
platform, or press Alt alone or F10 on Windows and Linux, to open the application
menu below it. A chevron beside the wordmark turns while the menu is open. The
menu is the same everywhere and lists app-wide commands, the sidebar toggle and the whole-layout Tidy action:

- New window, New worktree…, Add repository… (orchestration is granted from a
  session's menu, #303)
- **Settings ›**, a submenu of routes from the live provider registry, including
  config providers (#84: each starts that agent in `~/.foom/config` in the Foom
  config dock), then Via Settings UI, which opens the Settings screen. Agent routes
  are enabled for installed, enabled agents after preflight, including while
  Settings is open. A new config session starts with a fixed greeting describing
  what it can change and asking what the user wants; resuming a conversation adds
  no greeting. Antigravity releases without interactive prompt support open
  without the greeting. Each launch opens a new config session in the current window.
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

Individual tile, focus and swap commands, Focus sidebar, Longest waiting, Maximize,
Copy, Paste, Close Window and Foom on GitHub are not in the wordmark menu. Their
shortcuts still work. Third-party licenses
keeps its own item until the About screen (#96); its dialog links to the source
repository. About uses the native About panel.

**Keyboard shortcuts** (Command+/ or Ctrl+Shift+/) opens a sheet of the current
platform's bindings in three columns, App, Board and Tiles, generated from the
same registry as the shortcuts themselves. On Windows and Linux the Tiles heading
names the Ctrl+Shift+Space leader once. Escape or a click outside closes it and
returns focus.

On macOS, the native menu bar keeps every command: Foom (About, Settings, Hide,
Hide Others, Quit), File (New Window, New Worktree, Add Repository, Close Window),
standard Edit roles, View (tile actions, interface size, sidebar and
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
