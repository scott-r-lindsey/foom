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

`main/themes/library.ts` reads at most 50 eligible files per folder, at most
64 KiB per JSON file. Names are at most 100 characters, nonhidden and path-free. Reads
inspect an open descriptor, reject nonregular files and links outside the direct
folder, bound allocation, and recheck file and directory identity. A file link to
a target directly in that same folder is accepted by this library; the config
scanner and [offline validator](console.md) reject file links, including in-folder
links. Subfolders and
redirected theme directories are refused. Only eligible regular files count
toward the 50-file budget. The scan inspects up to 512 entries plus an overflow
check and refuses an over-limit folder without admitting a partial catalog. The library bounds its published catalog separately, reserving space
for retained palettes and admitting in-folder JSON aliases after regular files. Previously loaded files are considered first so added files cannot
evict their last-good versions; remaining names are sorted. Folder failures produce fixed diagnostics.
The read descriptor closes before parsing or waiting for the config approval queue,
so a queued restore never waits behind a reader holding its rename target open.
The folder watcher debounces changes for 250 ms, reloads serially and closes on
shutdown. Reloads reconnect watchers before reading the catalog. They never close
them after a read: an intervening edit may still have a pending notification on
the old watcher, and a replacement watcher need not replay it (#1215).
Parsed palettes and bounded diagnostics contain no absolute paths or
raw file contents; diagnostics have a filename, JSON path and fixed reason code.
They never echo parser exception messages or arbitrary unknown property names.

Main keeps the last good palette for a rejected edit during the current session.
A missing file disappears from the catalog. Invalid or missing selections after
restart use Default without overwriting the saved ID, and recover when a valid file
returns. Built-ins precede custom themes; colliding names gain “(custom)”.
`theme:list` and `theme:open-folder` validate the owning top frame and exact argument
counts. Open accepts only the enumerated theme kind and chooses the folder in main.
Catalog changes publish the `settings` view and retain legacy `setup:changed`
broadcasts; native backgrounds, interface tokens,
terminal views and the headless terminal host receive the resolved colors. The
sandboxed preload adds no runtime imports. The board CSP permits the narrow
[bitmap source](#decorative-bitmaps-1189).

## User interface themes version 2 (#246)

User theme files accept `{ version: 2, name, base, colors, areas?, states?, shape?, type?, images? }`
with optional `kind: "theme"`. Legacy kind-based files and version 1 remain valid;
built-ins retain their strict version 1 validation. Terminal themes are unchanged.
The global colors and optional paired highlight colors remain required as before.
Every nested object has exact keys, colors are opaque six-digit hex, files are at
most 64 KiB, and no file data becomes a selector or raw CSS.

Areas override a subset of colors: sidebar on `.sidebar-shell`, tiles on
`.tile-area` and `.terminal-tile` chrome (terminal content retains its independent
palette), panels on `.row-menu.sidebar-panel` (including tile panels), dialogs on
Settings, preflight and confirmation/dialog roots, menus on row menus/submenus and
the wordmark popup and the shared Theme/Colors menus. The transparent wordmark trigger inherits its surrounding palette. Portal roots get their own area variables. Raised colors derive
at each root from its effective palette. State colors override selected, hover,
focus and scrollbar colors; omitted values retain existing derivations. Shape
supports radius 0–12 px, panel-radius 0–16 px, border 0–2 px and shadow 0–1.
Panel radius inherits an explicit control radius when omitted. Existing
per-element radius fallbacks preserve built-in geometry; circles and
intentional zeros remain literal.

About, its note and the first-run and replay launch sequences use the built-in
Eclipse Dark palette and default typography and shapes. License and notice
dialogs use the selected theme.

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
direct Appearance selections of the exact offered version do not hold. If the
file changed since it was offered, Appearance refuses the save and asks the user
to choose again after the list refreshes. Attention distinctness includes
separation from readable ink as well as failure, accent, highlight and done.

The profile keys approval per file by a digest of the normalized colors the
attention check uses. This includes global colors, effective area overrides,
gradient stop colors and area scrollbar colors. Artwork, placement and version
changes preserve approval across restarts. Older approvals migrate when the
loaded file verifies against its recorded digest. Active selections display the
accepted palette from the first window, including while artwork decodes. A held
palette edit leaves the approved colors in use and applies the new artwork as it
becomes available. Allow verifies the proposal digest and current bytes before
recording approval. Keep it on restores the approved base and colors (including
area and state palettes) from this session and preserves other saved edits,
including artwork.
When there is no approved palette in this session, Keep it on
switches `interfaceTheme` back to the default
only if the reviewed selection is still current in the shared Settings file.

## Additional areas, typography and gradients (#1188)

Version 2 adds these fixed area keys; file data never supplies selectors:

| Key | Fixed renderer roots |
| --- | --- |
| `titlebar` | `.board-top` (the sidebar title bar; there is no separate native tab bar) |
| `tile-headers` | `.tile-title`, separately from tile bodies |
| `board` | `.board-terminal` and `.tile-area`, including the empty board |
| `badges` | `.panel-chip`, `.host-chip`, `.pull-request` |
| `wordmark` | `.wordmark` |
| `dialog-headers` | `.panel-header`, dialog headers and trusted confirmation `.dlg-head` |

Each area's colors merge with the global palette and receive the existing contrast,
derivation and attention checks. Omitted new areas inherit their enclosing area.
Area roots reset derived raised/hover tokens, including portaled panel and menu
roots. Every area can specify `scrollbar`, an opaque hex color overriding the global
scrollbar state at that root; terminal scrollbars and terminal output stay independent.
Scrollbar colors and gradient stops participate in attention-distance warnings and
the existing approval comparison. Palette roots explicitly bind text to their local
ink, including trusted confirmation headings; inheriting the body's computed text
color would bypass those tokens.

Transparent `wordmark` and `badges` roots do not paint their own bg/surface. Their
rendered inks are therefore also checked against their fixed parent contexts:
wordmarks on global, sidebar/titlebar and dialog paints; badge text on sidebar,
panel, dialog and dialog-header paints. These checks include every parent gradient
stop and 256 points per segment, even when the child itself has no gradient. A
white wordmark over a white titlebar rejects despite a readable dark global
background. Theme validation checks the wordmark area's space ink against the
theme's global hole.
Opaque area roots retain their own effective-palette checks.

Optional `type` has only `family` (`geist`, `geist-mono`, `system`, `system-mono`),
`scale` (0.85–1.25), `weight` (400–600), and `strong-weight` (500–800). These select
fixed bundled/system stacks and bounded interface text sizes/weights. Display and
voice faces stay bundled. Terminal font family/size and Chromium interface zoom are
independent. Omitted fields preserve existing typography.

Optional `gradient` belongs inside an area beside its colors and requires an
explicit opaque solid `bg` fallback. It has exactly `angle` (finite number 0–359)
and `stops` (2–4 `[opaqueHexColor, percent]` tuples, strictly increasing finite
percentages in 0–100). Only `sidebar`, `board`, `titlebar` and `dialog-headers`
accept it. Other areas, including terminal tile content, reject it with the fixed
`gradient-not-allowed` reason. Foom constructs a linear CSS gradient with explicit
`in srgb`; no CSS, URLs, file names or fonts from files are accepted. The solid
palette still derives raised, selected and hover colors.

Every stop must contrast at least 4.5:1 with each effective ink (ink, muted, accent,
highlight and the three status inks). In addition, every adjacent segment is checked
at 256 evenly spaced points, including its endpoints, with unrounded sRGB channel
interpolation and WCAG luminance. Stop checks and same-side luminance alone are
insufficient: red `#ff0000` to green `#009400` both exceed 5.2:1 on black but the
interior falls below 3:1. Such gradients, and straddling gradients, reject the whole
edit and preserve the last good theme. This corrects the original issue's guarantee.

The existing preload projections validate and copy these bounded data fields on
existing channels. No capabilities, channels, runtime imports, CSP or asset
permissions are added. Built-ins keep strict version 1 validation.

## Theme menus (#878)

Appearance owns the interface Theme menu and its folder/status/errors; Terminal
owns Colors and its folder/status/errors and terminal preview. Built-ins precede
user entries below a divider. The first-run rail shares the interface menu without
folder controls, previews or the custom-theme hint. Default uses the existing
`follow` ID: interface Default follows the OS live, terminal Default follows the
resolved interface base live. See [migration](settings.md#settings-and-setup).

While interface Default is selected, it displays its live resolved name in both
the closed picker and menu row: `Default · Eclipse Light` / `Default · Eclipse Dark`
(including first run). With a fixed interface theme selected, the row reads only
`Default`: Chromium media follows the fixed base, and Electron 44 has no independent
OS appearance API on every platform. Terminal Colors always shows
`Default · Foom Light` / `Default · Foom Dark`, resolved from the current interface base.
Both pickers read native appearance through a React external-store subscription
that rechecks after installing its listener, so an update between render and
subscription cannot leave the Default label or preview stale (#1219).
Terminal font and font size use the same labeled keyboard menu as Theme and Colors.
All four menus support arrow keys, Home/End, Escape and returning focus to the picker.
Printable keys open the menu and focus a case-insensitive prefix match, including
numeric sizes. Repeated letters cycle matches; a 700 ms pause or reopening the menu
starts a new prefix. Typing moves focus; Enter commits the choice.
The custom-theme hint sits directly beneath its picker, before folder status.
Terminal has no text-size helper line.

## Decorative bitmaps (#1189)

Version 2 theme files can include an `images` object with three slots.

| Slot | Paint region |
| --- | --- |
| `empty` | Each blank tile region, the whole empty board, and each gap between tiles |
| `sidebar` | Blank space below the repository controls in the expanded sidebar |
| `tile-header` | Each occupied tile’s title bar inside the board |

A slot takes one to eight entries in `files`. Each entry is a direct filename
or an object with `file` and optional placement overrides. The singular
`"file": "one.png"` is also accepted at slot level. For example:

```json
{
  "images": {
    "empty": {
      "opacity": 0.3,
      "fit": "cover",
      "files": [
        "stars.webp",
        { "file": "orbit.png", "fit": "none", "anchor": "bottom", "size": 25, "opacity": 0.6 }
      ]
    }
  }
}
```

Slot values are defaults for each piece. Opacity is 0.05–0.6 and defaults to
0.25. Fit defaults to `contain` and also accepts `cover`, `tile`, and `none`.
With `none`, the image stays at its natural size until it needs to shrink to
fit. The optional `size` caps both dimensions to 5–100 percent of the region’s
smaller dimension and applies only to `none`. Anchor defaults to `center` and
also accepts a side or a corner such as `top-right`. Each region or header
randomly chooses a decoded entry with its placement and keeps it through
resizes, layout changes and placement edits while the region and file contents
remain available.
Gutter artwork shows through the existing tile padding along the split, leaving
tile dimensions and borders unchanged. It moves with the tile bounds during
animated resizing and updates immediately during pointer drags or with reduced motion.

For one release, `board` and `gutter` each emit a warning and map to `empty`.
An explicit `empty` takes precedence. With both legacy slots, Foom takes up to
eight distinct entries in board-then-gutter order, each with its own placement.

Artwork applies automatically. The disposable decoder contains decoding risk,
and placement limits bound spoofing by agent-written art. All artwork ignores
pointer events. Dialogs, trusted confirmations, the approval queue, the decisions
stepper and terminal text have no art. Tile menus, window controls, status lights
and badges have opaque backings. Palette edits that weaken attention distinctness
still require **Allow / Keep it on**.

Regular bitmap files share the 50-file folder budget with regular JSON files.
Over budget, the loader omits bitmap paint. Filenames are limited to 100 ASCII
letters, digits, spaces, dots, underscores and hyphens, starting with a letter,
digit, underscore or hyphen, and ending in PNG, JPEG/JPG or WebP. Subfolders,
symlinks and hard links are refused. Main reads through the theme library’s
descriptor and identity checks, up to 4 MiB per file. The disposable
[image decoder](terminals.md#image-paste-937) sniffs and verifies PNG, JPEG and WebP,
limits dimensions to 8,192 pixels per axis and 16 million pixels per image,
and encodes the oriented first frame as a metadata-free PNG of at most 4 MiB.
Transparent PNG and WebP artwork retains its alpha.
It samples the three most prevalent alpha-weighted color buckets and reports a
warning within ΔE 40 of a relevant attention or failure color. Empty artwork
checks the global, board, tiles and tile-header palettes. Tile-header artwork
uses the tiles palette when no header palette is defined. An explicit
decoder refusal is cached for identical bytes. A timeout or premature exit can
retry on a later refresh after a one-second cooldown. The loader schedules no
automatic retry.

Foom begins decoding after the first window loads. Only the active theme or
a theme being selected is decoded. An unavailable asset stops being served.
If no usable asset remains for a slot, it uses the normal background.

Theme bitmaps add only `foom-theme://bitmap` to the board’s `img-src`. The board
keeps `data:` for decision previews. The scheme handler accepts GET requests
for opaque IDs of active PNGs. It serves memory only, with a PNG content type
and no caching or fetch API access. The renderer bridge projects bounded lists
of IDs and placement values. The confirmation partition keeps its existing
CSP and has no bitmap handler. See [theme image privacy](privacy.md#theme-bitmaps-1189).
