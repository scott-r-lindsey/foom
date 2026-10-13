# Text editing (research spike, #223)

Findings from the spike on whether Foom should edit text. The prototype lives in [`spikes/editing/`](../spikes/editing/README.md). It is throwaway code; nothing under `src/` changed. This document is research, not a decision. The follow-up tickets below decide each part. When one lands, that PR updates `architecture.md` and `product.md`.

**Recommendation:** build **A, Open in editor**, first: a main-owned command that hands a worktree file, with an optional line and column, to the user's own editor through a fixed per-editor argument array. Then build **B, a scratch pad**, as a plain `<textarea>` tile backed by a few small files in the profile. Do **not** build **C, a worktree file editor**: the safest save the spike could build still silently loses an agent write that lands between the conflict check and the rename, and every editor good enough to replace the user's own costs more bundle and accessibility work than the use case justifies.

## How this was measured

Linux (Linux Mint 22, Ubuntu 24.04 base, kernel 6.8), Node 24.17.0, Electron 44.4.5 under `xvfb-run -a`, using the repo's own esbuild 0.28.2, Playwright, axe-core and node-pty. Every run works in a `mkdtemp` fixture repository (created through `tests/helpers/git.js`) and a disposable profile, and deletes both. The scratch-pad window uses Foom's exact renderer CSP, a sandboxed preload, `contextIsolation`, no Node integration, denied permissions, a request filter limited to its own scheme, and sender-validated IPC. JSON output is committed in `spikes/editing/results/`.

| Run | Command (from the repo root) | Result file |
|---|---|---|
| Bundle sizes | `node spikes/editing/build.mjs` | `bundles.json` |
| Conflict, encoding, containment, scratch and launch tests | `node --test spikes/editing/research.test.cjs` (8 pass) | `conflicts.json` |
| Editor detection | `node spikes/editing/detect.cjs` | `detection.json` |
| Editor component in a sandboxed window | `xvfb-run -a node spikes/editing/verify-ui.cjs` | `ui.json`, `textarea.png`, `codemirror.png`, `monaco.png` |
| Hand-off to VS Code and nvim | `xvfb-run -a node spikes/editing/verify-handoff.cjs` | `handoff.json` |

The first spike agent produced these files. This PR re-ran every command. Bundles, conflicts and detection reproduced unchanged. Three things changed:

- **Worker test.** The earlier worker variants (`none` and `self`) were the same policy, because Foom's CSP has no `worker-src` and falls back to `script-src 'self'`. They are now `foom` (Foom's exact CSP) and `blocked` (adds `worker-src 'none'`). The worker probe now reports CSP violations instead of timing out.
- **CodeMirror theme.** It failed axe `color-contrast` (1.03:1) because the default light highlight style was drawn on a dark background. It now uses a Foom-token highlight style and passes. See §2.
- **Detection output.** `detection.json` no longer records the machine's full Flatpak application list.

**Not verified:** anything on macOS or Windows. Every macOS and Windows entry in §4 comes from vendor documentation and is marked as such. Real-world conflict frequency is not measured either: no telemetry exists, and the workload in §1 is synthetic.

## 1. Concurrency (option C)

`model.cjs` implements the best portable save the spike could find. **Open:** read through a validated relative path (§3), refuse anything that isn't strict UTF-8, and keep the SHA-256 of the bytes. **Save:** re-read and compare the hash; write a sibling temporary file `wx` with the original mode; `fsync`; re-check the hash; then `rename` over the original.

| Case | Result |
|---|---|
| External write with the same size and a restored mtime | **Conflict detected.** The hash catches what an mtime/size check misses. The save returns the disk text and the draft, and the disk file is untouched |
| Clean buffer, agent writes | Reload shows the agent's text |
| Dirty buffer, agent writes | Conflict |
| File deleted while open | Save refused (`ENOENT`) |
| File deleted and recreated | Conflict |
| UTF-8 BOM + CRLF, mode `0640` | Bytes round-trip exactly, and the mode is kept |
| Directory `fs.watch` across the atomic save | Still delivers `note.txt` after the rename (plus three events for the temporary name, which a watcher must filter) |
| NUL byte, UTF-16 BOM, invalid UTF-8, 1 MiB + 1 | Refused (binary, binary, encoding, size) |
| **Agent writes between the final check and `rename`** (fault-injected) | **`saved`, and the agent's write is lost silently** |

The last row is the deciding result. Hash plus rename is not a compare-and-swap. Node has no portable primitive that closes the gap: no `renameat2(RENAME_EXCHANGE)`, and no mandatory locks agents would honor. The window is short, but agents write in bursts, and a lost agent write is invisible to both the user and the agent.

**Two simulated agents** (`writer.cjs`, forked processes overwriting the file while a user buffer is open, 20 trials per row):

| Scheduled overlap | Conflicts detected |
|---|---|
| 0% | 0 / 20 |
| 25% | 5 / 20 |
| 100% | 20 / 20 |

This shows that detection is exact for writes that land before the check. It says nothing about how often overlap happens in practice. That isn't measurable without field data. The product already treats two agents in one checkout as an exception, with a confirmation (`product.md`, Terms). The common case for C is different: the user editing a file in the worktree its own agent is changing. That is exactly when the race matters.

**What the user would see on conflict:** the prototype returns `{ disk, draft }` and writes nothing. A real tile would need a diff or a choice between keeping each version. That is the start of an IDE merge UI, which the issue warns against.

## 2. Editor component

Built with esbuild, minified, the JavaScript language only, in a sandboxed window with Foom's renderer CSP. For scale, Foom's own `renderer.js` is 765,436 bytes (220,942 gzip).

| | Textarea | CodeMirror 6 (`basicSetup` + JS) | Monaco 0.57 (JS only) |
|---|---|---|---|
| Bundle | 221 B (182 gzip) | 504,061 B (169,550 gzip), **+77% gzip** | 3,161,391 B (836,097 gzip), **+378% gzip**: editor 2.76 MB, worker 307 KB, CSS 91 KB |
| Foom CSP unchanged (`script-src 'self'`, no `eval`) | Works | Works, 0 violations | Works, 0 violations. Its worker loads, because `worker-src` falls back to `script-src 'self'` |
| `worker-src 'none'` | n/a | n/a | Worker blocked (one console error). Monaco falls back to the main thread, and editing still worked |
| Foom tokens | Plain CSS | `EditorView.theme` + `HighlightStyle` with `var(--…)` | Hex colors in `defineTheme`; needs regeneration on theme change |
| axe serious/critical | None | None, after the token highlight style. The default style failed `color-contrast` at 1.03:1 on the dark background | None |
| Tab from the editor | Moves focus to the next control | Moves focus (`basicSetup` has no `indentWithTab`) | **Trapped**: focus stays in `native-edit-context`. Escaping needs Ctrl+M |
| Foom shortcut while focused (the spike's stand-in, Ctrl+Shift+B, handled in main's `before-input-event`) | Reached main | Reached main | Reached main |
| Bridge reach | `require`, `process`, `desktop` undefined; out-of-range pad ID and 64 KiB + 1 draft rejected by main | Same | Same |
| Draft persisted across reload | Yes | Yes | Yes |

**Syntax colors and brand rules.** Amber and magenta are reserved for status (`brand.md`), so highlighting may use only accent, ink, muted and type style (italic or bold). The prototype's style (`runtime/codemirror.mjs`) is legible and passes axe (`results/codemirror.png`), but it is deliberately sparse. Any editor that wants rich highlighting would conflict with the brand rules.

**Keyboard.** Main's single `before-input-event` dispatcher owns board shortcuts, so they win over any editor binding. That was verified for all three editors. The reverse cost is real: CodeMirror's `basicSetup` binds dozens of keys (Mod-d, Mod-Shift-k, Alt-arrows, Mod-f), and each would need checking against Foom's table on three platforms. A textarea has only the platform's own text-editing keys.

**Scope, if an editor were ever built:** syntax highlighting and in-file search. **Explicitly out:** LSP, completion, multi-file search, git UI, minimap, multiple cursors and Monaco.

## 3. Security

**Worktree files (A, and C if it were built).** The renderer never names a path to open. It sends a worktree identity from the inventory plus a relative path that main gave it (a preview tile's `relativePath`, or a main-owned file picker). Main validates both with the contained file rules already in `src/main/previews/` (#289). `model.cjs` re-tests them for writing:

- 10 malformed names are refused: `../outside`, `/abs`, `C:/file`, `a\b`, `a:ads`, `.git/config`, `CON.txt`, `a.`, `a ` and `a//b`. The Windows forms are a syntactic Linux test only.
- A final-component symlink and a parent-directory symlink are both refused. A FIFO is refused rather than blocking.
- Reads are capped at 1 MiB, and saves re-check the size.

**Launching an editor (A).** `launchPlan` builds `execFile` arrays only. A file named `- spaced $(touch SHOULD_NOT_EXIST).txt` stayed literal: it reached VS Code as one argument and became the window title, and no file was created. The executable and file path must be absolute; line and column are bounded integers; control characters are refused. A path is always absolute, so it can't be read as an option. Never fall back to `shell.openPath` or `xdg-open` for a worktree file. The OS handler for `.bat`, `.cmd`, `.ps1`, `.desktop`, `.command` or `.js` can *run* the file instead of opening it (documented Windows/macOS/Linux behavior, not tested here).

**Scratch pad (B).** Files live in `<profile>/scratch/`, a 0700 directory that is never in a worktree or the git-tracked Foom config folder. The prototype limits are 16 pads (`pad-0`…`pad-15`) of 64 KiB each. Files are mode 0600 and written to a `wx` temporary file, then renamed. Symlinked pad files and symlinked directories are refused, and invalid UTF-8 is refused on read. The test confirmed that the fixture worktree stayed exactly `['.git']`. Scratch text is user content, like settings: Foom never sends it to a model or the network. It is not a secret store; `safeStorage` is for secrets Foom keeps, and this isn't one.

## 4. Editor detection (option A)

**V** = verified on this Linux machine; **D** = from vendor documentation, not run. Nothing else was installed here: Cursor, Zed, JetBrains, Sublime, nano and Snap were absent, and Flatpak 1.14.6 had none of the six editor IDs checked.

| Editor | Linux | macOS (all D) | Windows (all D) | Line and column |
|---|---|---|---|---|
| VS Code | **V**: `/usr/bin/code` → `/usr/share/code/bin/code` (deb, 1.138.0). Launching the app binary `/usr/share/code/code` with `--goto <file>:42:3` and an isolated profile opened the file at **Ln 42, Col 3**. D: Snap `/snap/bin/code`; Flatpak `com.visualstudio.code` via `flatpak run` | `/Applications/Visual Studio Code.app` (bundle ID `com.microsoft.VSCode`); CLI script at `Contents/Resources/app/bin/code`. `code` is on `PATH` only after the user installs it | `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` (user install) or `%ProgramFiles%\Microsoft VS Code\Code.exe`; `bin\code.cmd` on `PATH` | `--goto file:line:col` (V) |
| Cursor | D: AppImage, no fixed path; `cursor` CLI only if the user installed it | `/Applications/Cursor.app`, CLI `Contents/Resources/app/bin/cursor` | `%LOCALAPPDATA%\Programs\cursor\Cursor.exe` | `--goto` (VS Code fork) |
| Zed | D: `~/.local/bin/zed` from the install script; distro packages ship `zeditor`; Flatpak `dev.zed.Zed` | `/Applications/Zed.app`, CLI `Contents/MacOS/cli` | Recent; treat as unsupported until verified | `file:line:col` |
| JetBrains | D: Toolbox scripts (`idea`, `pycharm`, `webstorm`, …) in `~/.local/share/JetBrains/Toolbox/scripts`; Snap `intellij-idea-*` | Toolbox scripts in `~/Library/Application Support/JetBrains/Toolbox/scripts`; `/Applications/*.app` | Toolbox `.cmd` scripts in `%LOCALAPPDATA%\JetBrains\Toolbox\scripts`; `bin\idea64.exe` in the install | `--line L --column C file` |
| Sublime Text | D: `/usr/bin/subl` (apt), Snap `subl` | `/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl` | `%ProgramFiles%\Sublime Text\subl.exe` | `file:line:col` |
| nvim / vim | **V**: `/usr/bin/nvim` 0.9.5, `/usr/bin/vim` 9.1. `+42` put the cursor on line 42, headless for both. nvim in a real PTY showed `line 42` and quit cleanly (exit 0) | Homebrew `/opt/homebrew/bin` or `/usr/local/bin`: needs the login `PATH` | `nvim.exe` (winget, Scoop); vim installs `.bat` wrappers | `+line -- file`; column needs `+call cursor(l,c)` |
| `$VISUAL` / `$EDITOR` | **V** only that `EDITOR` was set and `VISUAL` was not in this environment | Apps started from the Dock don't inherit shell variables; read them from the login shell | Rarely set | Depends on the program |

**What this means for the design:**

- **Detect by a fixed adapter table**, never by running arbitrary programs. Each adapter lists candidate absolute paths and names, resolved on Foom's login `PATH` (#215 already captures it), and the argument form. Detection runs once in main, bounded like other probes, and is cached.
- **Windows `.cmd` and `.bat` files can't be launched safely.** Since the April 2024 security releases (CVE-2024-27980), Node refuses to spawn them without `shell: true`. On Linux the app binary took `--goto` directly; Windows should use `Code.exe`, `Cursor.exe`, `subl.exe` or `idea64.exe` the same way, never the `.cmd` wrapper. This is unverified until Windows CI runs it.
- **macOS:** resolve app bundles at the documented locations, then run the bundle's own CLI. `open -b` can't pass a line to an already-running app.
- **Snap** commands are ordinary executables on `PATH`. **Flatpak** needs `flatpak run <id> <args>`, and the app's filesystem permissions decide whether it can see the worktree. Offer Flatpak only when the ID is installed, and treat a sandbox refusal as a launch failure.
- **`$VISUAL`/`$EDITOR`** values like `code --wait` or `emacsclient -t` must be split without a shell. Accept only words with no quotes, `$`, backticks or other metacharacters, and resolve the first word on the login `PATH`. A known basename gets that adapter's line syntax; anything else opens the file with no line.
- **Terminal editors** (vim, nvim, nano, emacs -nw, helix, or any `$EDITOR` that isn't a known GUI) run in a new terminal tile in the worktree, through the main-owned PTY path, with the same argument array. The prototype's `--clean` and `-u NONE` were for isolation only; the product must load the user's own configuration.
- **A Settings choice** lists what was detected plus "Ask each time", with no default when nothing is found. If no editor is detected, the command offers Copy path; it never offers an OS handler (§3).

## 5. Recommendation

**Build, in order:**

1. **A. Open in editor.** It is the smallest useful thing. The user's own editor already handles conflicts, encodings, large files and every language. Foom contributes only path validation and the launch array, both prototyped here and verified on Linux.
2. **B. Scratch pad.** A `<textarea>` tile adds 221 bytes and needs no theme, keyboard or accessibility adaptation. By construction it has no shared-file conflicts. Its value is drafting a prompt or reply with more room than an agent's input line. Build it after A, and only if that need is real in daily use. It is cheap enough that it doesn't need to wait for evidence.

**Not built:**

- **C, a worktree file editor tile.** The race in §1 cannot be closed portably, conflict UI is a merge tool, and the user already has a better editor one command away. Revisit only if daily use shows real demand for small in-place fixes. A future C would use CodeMirror 6 with the conflict model and limits above, and would document the race.
- **Monaco**, in any option: 836 KB gzip, a Tab trap and a worker.
- **LSP, completion, multi-file search, git UI, diff/merge** and syntax highlighting in the scratch pad.
- **Writing to any editor's settings**, installing editor CLIs, or registering URL handlers.

## Follow-up implementation tickets

Drafted in the roadmap style. **Not filed**; whoever files them replaces "(ticket N)" with issue numbers.

### 1. Open in editor: detection and launch in main

Main finds the user's editors and opens a worktree file in one at a line. See `docs/editing.md` §3 and §4.

**Scope**

- A fixed adapter table for VS Code, Cursor, Zed, JetBrains (Toolbox scripts and app binaries), Sublime Text, nvim, vim and nano. Each entry has candidate paths per platform, the resolved-executable rules (never `.cmd`/`.bat`), and its line/column argument form.
- Detection in main on the login `PATH` (#215), bounded and cached. Also detect app bundles on macOS, Snap commands, and installed Flatpak IDs (launched with `flatpak run`).
- `$VISUAL`/`$EDITOR` read from the login shell using the existing fixed `-ilc` program (extended by two names) and split without a shell. Refuse metacharacters and quotes.
- `editor:open` IPC: a worktree identity from the inventory, a relative path, and an optional line and column. Validate the sender, then the payload, then containment with `src/main/previews/` rules. Launch with `execFile` and an argument array, detached, with Shells-layer environment. No `shell.openPath` fallback.
- Terminal editors open in a new terminal tile in that worktree through the main-owned PTY launch path, placed like a shell launch.
- Settings → General: **Editor** picker listing what was detected, plus Ask each time. Edit in place, with no helper copy.

**Acceptance**

- [ ] Unit tests cover every adapter's arguments, including a path with spaces, `$(…)`, a leading `-` segment and non-ASCII characters; `$EDITOR` parsing; and refusals (relative executable, control characters, out-of-range line, `.cmd` on Windows).
- [ ] An Electron test, on Linux CI under Xvfb, opens a fixture file through a stub editor executable that records its argv. The argv is exact and the worktree is unchanged.
- [ ] An Electron test opens a terminal editor (a stub) in a new tile at the right cwd.
- [ ] The Windows and macOS CI jobs run the adapter resolution unit tests against fake install trees for those platforms.
- [ ] `architecture.md` and `product.md` describe detection, the IPC message and the Settings choice.

**Dependencies:** none. Blocks: ticket 2.

### 2. Open in editor: commands where files appear

**Scope**

- **Open in editor** on preview tiles (tile menu and title-bar context menu), opening the preview's file.
- **Open file in editor…** in the worktree panel, using a main-owned picker rooted at the worktree (the same picker as #296).
- A board command with a shortcut that opens the focused preview's file. Its binding must be checked against the shortcut table on all three platforms.
- When no editor is configured, the command offers **Copy path** instead (it reuses the main clipboard capability).

**Acceptance**

- [ ] Electron tests cover each entry point with the stub editor, and a refusal for a worktree removed while the menu was open.
- [ ] Matches the tile-menu and sidebar-panel mockups. `product.md` is updated.

**Dependencies:** ticket 1; #291 (preview host) and #296 (preview from the worktree panel) for the preview entry points.

### 3. Scratch pad tile

A profile-owned plain-text tile for drafting prompts and replies. See `docs/editing.md` §2, §3 and §5.

**Scope**

- A new tile content kind, `{ kind: "scratch"; pad: string }`, in layout v2 (#290). Up to 16 pads, numbered in tree order like other tiles. A pad belongs to no repository; the mockup decides where the sidebar lists it.
- Storage in main: `<profile>/scratch/pad-N.txt`, a 0700 directory, 0600 files, at most 64 KiB, strict UTF-8, written to a `wx` temporary file and renamed, with symlinks refused. Save on input after a debounce, and on blur and quit. There is no Save button.
- IPC `scratch:read`/`scratch:write` with sender and payload validation. The renderer never sees a path.
- A `<textarea>` with Foom tokens, `spellcheck` off, an accessible name, and Tab moving focus. Board shortcuts stay with main's dispatcher.
- Closing the tile keeps the text, and reopening the pad restores it. A **Clear** command empties it.

**Acceptance**

- [ ] Unit tests cover IDs, size, encoding, the symlink refusal and atomic writes.
- [ ] An Electron test types, restarts Foom and sees the text. It checks file modes on POSIX, and that no worktree changed.
- [ ] Tile shortcuts and focus-by-number work with a focused pad. axe reports no serious or critical violations.
- [ ] Needs a mockup first. `product.md` and `architecture.md` are updated.

**Dependencies:** #290 (tile content kinds).

### 4. Later, optional: Paste scratch pad into a terminal

Send a pad's text to a chosen terminal as one bracketed paste, so the user doesn't have to copy and paste by hand. Decide after ticket 3 is in daily use. It must use the existing terminal-input path and never send the text anywhere else.

**Dependencies:** ticket 3.
