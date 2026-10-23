# Settings

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/settings.md).

## Settings and setup

### Agent-editable settings format (#206)

`~/.foom/config/settings.json` is a JSON object with `"kind": "settings"` and any
subset of the following keys. Unknown keys are rejected, including nested sound
and agent fields. Main reads and writes these keys through this file (see
[Foom config environment](config.md#foom-config-environment-84)); every other setting stays
in the profile. Validation alone grants no approval.

| Allowed key | Value |
| --- | --- |
| `colorMode` | `system`, `light`, `dark` |
| `panelColor` | `vivid`, `subtle`, `plain` |
| `interfaceTheme`, `terminalTheme` | `follow`, a corresponding built-in ID, or `user:<filename>.json`; no inline palette objects |
| `interfaceScale` | 80–150 in steps of 10, then 175, 200, 250 and 300 |
| `terminalFont` | Validated family name, default Hack Nerd Font Mono |
| `terminalFontSize` | Integer 10–32 |
| `sound` | Exact current `shared/sounds.ts` settings format |
| `agents` | Boolean provider-ID map, at most 100 entries; `claude`, `codex`, `agy` are required |
| `agentArguments` | Literal argument lists keyed by valid provider IDs, at most 100 entries; `claude`, `codex`, `agy` are required; validated by `parseAgentDefaults`; every file change requires Allow |
| `hooks` | Boolean |
| `showNewChildren` | Boolean, default `true`; display-only, no Allow required |
| `restoreSessions` | Boolean, default `true`; enabling through the file requires Allow |
| `concurrentChildren` | Integer 1–16, default 4 |
| `recentRepositoryDays` | Integer 1–365, default 30 |

`shared/config-settings.ts` supplies the same value validation to main's settings
patch parser and the file parser; theme files use `shared/theme-files.ts` directly.
Theme IDs are checked syntactically, without opening any other file or profile.

| Excluded key | Reason |
| --- | --- |
| `agentBypassAcknowledged` | Records human consent to bypass mode |
| `setupComplete` | Records human setup progress |
| `codeFolder`, `worktreeLocation` | Select filesystem paths or placement |
| `environment` | Variables reach every agent launch, like `agentArguments`, and may hold secrets; set only through Settings (#215) |

Excluded keys report `unknown-key` at their fixed `$.<key>` path. Arbitrary unknown
property names are never echoed. The allowlist applies even when an excluded value
is null, false or otherwise harmless in isolation.


**Today:** First run is the preflight countdown from [product](../behavior/setup.md#first-run). `src/main/setup/settings.ts` stores versioned `settings.json` in user data: profile settings and consent records plus approved config digests. The config service stores hooks, enabled agents, launch arguments, appearance and sound choices in the config folder. Writes are atomic (private temporary file, then rename) and serialized; a failed write leaves the settings unchanged. Missing, corrupt or unsupported files start from defaults, so preflight runs again. Every patch, from IPC or disk, is validated field by field and unknown fields are rejected.

`src/main/setup/setup.ts` applies the settings to the running app at startup and on each save, and coordinates repository scanning. Legacy inference fields are discarded only when loading a profile; IPC patches still reject them.

Appearance lives in Settings and the preflight rail through the same `AppearanceControls` component and applies at once. `colorMode` (system, light or dark) sets `nativeTheme.themeSource` for Eclipse; fixed interface themes supply their own base. Main applies the source before the window is created at startup, so the CSS (`prefers-color-scheme`), the window background and terminals using Follow interface all follow it; changing the resolved terminal palette resets colors a program set in the terminal; fixed terminal themes ignore interface changes. `interfaceScale` (80–150% in steps of 10, then 175, 200, 250 and 300%, matching Chromium's zoom steps; `SCALES` in `src/shared/config-settings.ts` is the one list) is Chromium zoom: the window starts with it as `zoomFactor` and later changes use `setZoomFactor`. The window resizes with it in both directions (`src/main/window/window-scale.ts`): main remembers the window's size at 100% and sets the window to that size times the scale, capped to the display's usable area and moved back on screen if needed, so zooming in and back out restores the same size. A resize by the user sets a new size at 100%. On first launch, the window uses 60% of the primary display’s usable width and height. After a successful quit, main saves every window's normal bounds, display and maximized state in `windows.json` in user data and restores them on connected displays, clamped to the current work area and minimum. The legacy `window-size.json` remains a fallback for the first window. Missing or invalid saved geometry uses the first-launch size. The minimum size (900 × 640 at 100%) scales too. The scaled minimum is capped to the work area, so a large size on a small or OS-scaled display can leave less CSS space than the 100% minimum; the layout compacts instead of refusing the zoom: the page never scrolls sideways, the compact sidebar wraps its tile layouts, Settings scrolls as a whole on a short window, and dialogs (the shortcut sheet, which is portaled so the compact sidebar cannot hide it, and the trusted confirmation, which measures its natural size in fractional pixels so a capped window settles) scroll within themselves. Maximized and full-screen windows keep their size. Tiling window managers may ignore the resize; zoom still applies. Main handles the zoom keys before the terminal sees them: ⌘ =, − and 0 on macOS, and Ctrl+Shift+= / Ctrl+Shift+− and Ctrl+0 elsewhere, because plain Ctrl+− is readline's undo. All zoom controls save the shared scale and broadcast `setup:changed` to every window, so sidebar, Settings and preflight controls follow. Trusted dialogs and previews refresh immediately in every window. `terminalFontSize` is a separate validated integer setting (10–32 CSS pixels, default 14). Each mounted terminal controller reads it before its initial attachment, subscribes to `setup:changed`, and updates xterm options. Visible attachments refit and send an ID-scoped resize; hidden views use the new size on their next attachment. Disposal removes the subscription.

Interface colors are independently stored as `interfaceTheme`: `follow` (default),
a built-in ID, a `user:<filename>` ID, or a version 1 portable object with `name`, `base` and `colors`.
Follow retains existing `colorMode` preferences and uses Eclipse Light/Dark; the
Themes picker’s System choice sets both Follow and System. A `colorMode`-only save
returns to Follow, while changing zoom or terminal settings retains the theme.
Fixed themes override `colorMode` with their declared light/dark base for
`nativeTheme.themeSource`. Main uses the palette's exact background both at startup
and after saves, including switches between themes with the same base.

`shared/interface-themes.ts` validates exact keys, six-digit opaque hex colors,
brand hue and color-distance rules, contrast and the declared base. Built-in palettes
pass the same gate used for user data. The object requires the original 19 color
tokens and optionally accepts the paired
`highlight` / `highlight-deep` decoration colors, falling back to accent / accent-deep.
Fonts stay fixed and bundled. There are no CSS filenames,
imports, URLs or arbitrary CSS values in theme data. See [brand](../brand.md#interface-themes)
for the numerical invariants. [Custom theme files](themes.md) use the same gate.

`renderer/ui/interface-theme.ts` subscribes to the setup source and system media
changes, sets color tokens on the root element and removes its listeners on unmount.
It ignores stale initial reads after a newer save or disposal. CSS keeps the original
Eclipse tokens as a startup/failure fallback. Settings → Themes uses token-scoped
previews of every board status, including the halo, square failure light and labels.
It neither renders terminal output nor subscribes to activity. The CSP and preload
surface are unchanged.

Terminal colors are independently stored as `terminalTheme`: `follow` (default), a built-in ID (`foom-light`, `foom-dark`, `solarized-light`, `solarized-dark`, `dracula`), a `user:<filename>.json` ID, or a portable palette object accepted by profile/IPC validation. Config files use the named choices; custom palette files have the format in [Custom theme files](themes.md#custom-theme-files-205). The object has exactly foreground, background, cursor, selectionBackground and the 16 named ANSI colors (black through brightWhite), each a six-digit `#RRGGBB` color. Main validates every key and value; the host protocol validates palettes again. Both processes and the renderer share the same resolver. Palette replacement resets OSC overrides; OSC 104 restores the active theme's ANSI defaults. Settings previews all 16 colors, bold, dim and selection. Third-party palette licenses are bundled in the packaged notices.

The renderer shows preflight until setup is complete; subsequent configuration lives in Settings. The default worktree location applies to the New worktree flow.

Settings opens on General by default; explicitly targeted sections still open directly.
The profile-only `showNestedRepositoryNames` boolean defaults to false and displays
repository names relative to `codeFolder` when enabled. Repositories outside that
folder, or the code folder itself, retain their registered name.

Settings opens beside the persistent sidebar from the Foom config gear panel or app menu, with ⌘, on macOS or Ctrl+Shift+, elsewhere.
Main reserves the shortcut through the existing validated `board:command` channel.
Each registered window has its own trusted IPC sender and setup coordinator. The board keeps its terminal
controllers mounted but detaches and hides their views while Settings is open. Esc
restores sidebar row focus after the terminal has reattached; selecting a sidebar
terminal closes Settings. The shared setup coordinator renders the same Agents,
Repositories and Appearance controls in both paths, with guided navigation only in
preflight: Welcome → Agents (T-2) → Repositories (T-1) → Go / no-go (T-0). Worktree
location controls live only in Settings → General. The existing `worktreeLocation` schema and
root default are unchanged; completing or replaying setup never resets a saved choice.
Settings adds Terminal font and size, Themes with both interface and terminal palettes (shipped choices followed by a divider and user choices), and
Sound controls. Successful `setup:save` calls publish `setup:changed` to keep live
consumers synchronized. Repository selection changes save immediately in Settings,
with controls disabled during the write and refused selections restored to the
registered repositories. Scans in Settings start from existing registrations;
preflight continues to suggest recent repositories and save when leaving the step.

Repositories come from the user's code folder (one, saved as `codeFolder`). Main offers common folders under home (`~/code`, `~/src`, `~/projects` and similar) that hold repositories, each with a count from a quick scan (the same walk, stopped at 5,000 folders), or shows the native picker; then `src/main/setup/code-scan.ts` walks the folder breadth first with live progress: at most three levels and 20,000 folders (reporting when it stopped early), never following symbolic links, skipping hidden folders, `node_modules`, `Library`, `AppData`, `Applications` and Foom's worktree folder, stopping at each repository, and skipping `.git` files (linked worktrees and submodules). Last activity comes from the modification times of `.git/logs/HEAD`, `.git/index` and `.git/HEAD`, without running git; activity within `recentRepositoryDays` (default 30, integer 1–365) preselects a repository, as does already being added. The Repositories day count is editable inline by typing or wheel, clamped to 1–365. The renderer reclassifies the retained timestamps without rescanning and preserves all selections. The renderer may add or remove only paths from main's latest scan; leaving the step applies the selection, and a refusal (for example a repository with Foom-made worktrees) keeps the user on the step with the reason. `pnpm run start:fresh` runs the app with a throwaway profile to test first run.


### Git and forge readiness (#675)

`setup:readiness` accepts no arguments, validates the registered main-frame sender,
and returns fixed Git/forge statuses, a platform enum and DNS hostnames only.
Preload validates the response without exposing paths, versions or CLI output.
Main resolves Git on the discovered login PATH and runs bounded, shell-free
`--version` and local remote-config reads against registered repositories.
T-0 and Settings → Forges share this service and `ForgeRuntime.hostStatus`.
No forge probe runs before T-0 during first run. Git alone also guards repository
selection and setup completion; these guards never probe forge CLIs.

### Environment keychain access (#717)

Environment status reads (including opening Settings, changing tabs and scanning
agents) never probe encryption availability or access the keychain. macOS and
Windows advertise secret support without probing; Linux reports support only for
a selected keyring backend, never `basic_text` or an unknown backend. A secret
save still checks encryption availability and refuses with the existing keychain
error if unavailable. Secrets remain safeStorage ciphertext on disk and null in
renderer replies.

Loading stored secret rows checks availability once for the load, then decrypts
them in main for launch layers and redaction. Loading without secret rows makes
no encryption, decryption or availability calls. Writes check availability once
only when new or changed secret values
need encryption, including imported URL credentials. Unchanged secret ciphertext
is reused for plain edits, renames and removals. Status reads never repeat these
checks, and a failed save can be retried without caching its failed availability.
