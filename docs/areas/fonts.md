# Fonts

Decided font enumeration and terminal application rules. User choices: [settings behavior](../behavior/settings.md). Owners: [file map](../map.md).

### Terminal font selection (#363)

Main enumerates installed monospace families with fixed `execFile` arguments:
Fontconfig `fc-list` spacing 100 on Linux, AppKit fixed-pitch fonts through a fixed
JXA script on macOS, and WPF glyph advance widths through a fixed PowerShell script
on Windows. Commands accept no renderer data, have bounded output and a ten-second
deadline. Main caches successful lists for the app session and shares one in-flight
enumeration. Failures preserve the last successful list (or return an empty list)
and remain retryable. `setup:terminal-fonts` checks the trusted top frame and accepts
only an optional boolean refresh flag; preload exposes only the family list.
Settings reads the cache first, then requests a background refresh and updates changed
families. Successful enumerations limit refreshes to once every thirty seconds.
No font permission, sandbox, context isolation or CSP changes are needed.

`terminalFont` defaults to `Hack Nerd Font Mono` and uses the shared config settings
validation for IPC and disk. Family names are 1–128 Unicode letters/numbers, spaces,
dots, underscores, parentheses, plus signs or hyphens, beginning with a letter or
number and without leading/trailing whitespace. Main validates enumeration output;
the renderer revalidates lists and settings before constructing a quoted stack.
Every stack retains the bundled Hack Nerd Font Mono, Geist Mono and `monospace`
fallbacks. Uninstalled families remain saved and degrade silently. Controllers
apply family and size together through their existing settings subscription,
refitting visible attachments and deferring hidden grids until attachment. Settings
uses the same stack for its preview.
