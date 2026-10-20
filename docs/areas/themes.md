# Themes

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Custom theme files (#205)

Main creates `~/.foom/config/themes/` for interface themes and
`~/.foom/config/terminal-themes/` for terminal palettes, alongside sounds.
`shared/theme-files.ts` is the platform-neutral parser for main and the offline
`foom config validate` command. Interface files contain exactly
`{ "kind": "theme", "name": "…", "base": "light" | "dark", "colors": { … } }`.
Colors require the original 19 interface tokens; `highlight` and `highlight-deep`
are optional only as a pair. Contrast remains mandatory. User themes report
brand-policy deviations as warnings; version 2 extensions and approval rules are
defined below. Built-in themes retain their strict validation.

Terminal files contain exactly `{ "kind": "terminal-theme", "name": "…",
"background": "#rrggbb", "foreground": "#rrggbb", "cursor": "#rrggbb",
"ansi": [16 colors] }`. ANSI order is black through white, then bright black
through bright white. Selection uses ANSI bright black. Like built-in terminal
palettes, arbitrary ANSI colors are permitted; interface status hue and contrast
rules do not apply to terminal output. Every color in either format is an opaque
six-digit hex value. Names are 1–40 letters, numbers, spaces, dots, underscores
or hyphens, with at least one nonspace character. Unknown keys, including `id`,
reject the whole file; files cannot choose or replace a built-in ID.

`main/themes/library.ts` reads at most 50 eligible JSON files per folder, at most
64 KiB each. Names are at most 100 characters, nonhidden and path-free. Reads
inspect an open descriptor, reject nonregular files and links outside the direct
folder, bound allocation, and recheck file and directory identity. Subfolders and
redirected theme directories are refused. Invalid names and nonfiles do not consume
the file budget. Previously loaded files are considered first so added files cannot
evict their last-good versions; remaining names are sorted. Folder failures produce fixed diagnostics.
The read descriptor closes before parsing or waiting for the config approval queue,
so a queued restore never waits behind a reader holding its rename target open.
The folder watcher debounces changes for 250 ms, reloads serially and closes on
shutdown. Parsed palettes and bounded diagnostics contain no absolute paths or
raw file contents; diagnostics have a filename, JSON path and fixed reason code.
They never echo parser exception messages or arbitrary unknown property names.

Main keeps the last good palette for a rejected edit during the current session.
A missing file disappears from the catalog. Invalid or missing selections after
restart use Follow without overwriting the saved ID, and recover when a valid file
returns. Built-ins precede custom themes; colliding names gain “(custom)”.
`theme:list` and `theme:open-folder` validate the owning top frame and exact argument
counts. Open accepts only the enumerated theme kind and chooses the folder in main.
Updates travel through `setup:changed`; native backgrounds, interface tokens,
terminal views and the headless terminal host receive the resolved colors. The
sandboxed preload adds no runtime imports and CSP remains unchanged.

## User interface themes version 2 (#246)

User theme files accept `{ version: 2, name, base, colors, areas?, states?, shape? }`
with optional `kind: "theme"`. Legacy kind-based files and version 1 remain valid;
built-ins retain their strict version 1 validation. Terminal themes are unchanged.
The global colors and optional paired highlight colors remain required as before.
Every nested object has exact keys, colors are opaque six-digit hex, files are at
most 64 KiB, and no file data becomes a selector or raw CSS.

Areas override a subset of colors: sidebar on `.sidebar-shell`, tiles on
`.tile-area` and `.terminal-tile` chrome (terminal content retains its independent
palette), panels on `.row-menu.sidebar-panel` (including tile panels), dialogs on
Settings, preflight and confirmation/dialog roots, menus on row menus/submenus and
the wordmark menu. Portal roots get their own area variables. Raised colors derive
at each root from its effective palette. State colors override selected, hover,
focus and scrollbar colors; omitted values retain existing derivations. Shape
supports radius 0–12 px, panel-radius 0–16 px, border 0–2 px and shadow 0–1.
Panel radius inherits an explicit control radius when omitted. Existing
per-element radius fallbacks preserve built-in geometry; circles and
intentional zeros remain literal.

Contrast below 4.5:1 rejects the whole file, retaining the last good theme. It is
checked globally and against every area's effective bg/surface for ink, muted,
accent, highlight and status inks, plus badge and space-ink pairs. Brand hue,
reserved-color, color-distance, base-luminance and hole deviations are warnings.
Warnings contain a filename, fixed JSON path, fixed reason and warning severity;
Settings lists Applied · N warnings and the CLI prints them with exit status 0.
Parser exceptions and file contents never travel to the renderer.

Both the config scanner and theme library pass through a serialized main-owned
approval gate. An edit to the active theme's file holds the palette when it adds
an attention conflict: a color pair within ΔE 40 of attention, globally or in an
area, that the approved version lacks. Pairs are compared individually, so an
approved pair never approves a new one on the same color. Selecting a warned
theme through settings.json also holds. Inactive themes, hue-only warnings and
direct Appearance selections do not hold. Attention distinctness includes
separation from readable ink as well as failure, accent, highlight and done.

The approved version is the one this profile last applied, recorded as a
per-file digest in the profile like the settings baseline. After a restart the
file counts as approved only if its digest matches. Allow verifies the proposal
digest and current bytes and records the new digest. Keep it on restores the
approved version applied in this session; when there is none it switches
`interfaceTheme` back to the default and leaves the file in place.
