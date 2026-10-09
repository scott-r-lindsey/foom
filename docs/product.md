# Product

Foom is a desktop workspace for running many coding agents at once, in git worktrees with one terminal per session. Its job is to route your attention. Terminals can stay hidden or share the workspace in tiles; Foom tells you which one needs you.

The target is about 10 concurrent agents. Supported agents are Claude Code (`claude`), Codex (`codex`), and Antigravity (`agy`). Any other CLI runs as a plain terminal, watched by the evaluator.

## Terms

- **Repository**: a git repo the user has added.
- **Worktree**: a `git worktree` for one branch, created by Foom or another tool. Every checkout can run multiple shells and agents. Shells need no sharing confirmation. Starting an agent while another agent is still running in that checkout requires confirmation because they can edit the same files. Exited agents do not trigger the warning.
- **Terminal**: one PTY session inside a worktree. It may run an agent, a dev server, or a shell.
- **Light**: the indicator that represents a hidden terminal.
- **Evaluator**: the pipeline that decides what a terminal's state is when its output stops.

## The light

The light carries two separate signals.

- **Motion is activity.** Brightness follows the terminal's real output rate. It pulses, but it never strobes: keep it under 3 Hz and respect reduced-motion settings.
- **Color is execution and attention state.** Agent lifecycle signals establish Working; the evaluator classifies attention and results.

| State | Light | Meaning |
|---|---|---|
| Working | Brand violet, brightness follows output | Agent is executing, or a shell command is running |
| Checking | Brand violet, slow breathing | Output stopped; the evaluator is running |
| Needs you | Amber, steady, with a halo | Waiting for input or approval |
| Done | Green | Finished successfully |
| Failed | Magenta, square | Exited with an error or gave up |
| Quiet | Dim neutral | Quiet but fine (dev server, long install) |

- Done and Failed dim once the user has looked at them.
- Agent Needs you clears when supported evidence shows execution resumed, or when the user dismisses attention. Typing and terminal output alone do not prove resumed execution. Shell attention retains reply/output behavior. Opening a terminal never clears attention.
- Failed uses a square light, so the state never depends on color alone.
- Every verdict carries a one-line reason and the signal that produced it, for example `Wants to edit src/main/main.ts · pattern: (y/n)`.

With Claude hooks attached, an idle title stops working audio but stays Quiet until
Stop confirms completion. This keeps Esc interruptions from producing a Done chime.
Permission approval resumes Working after fresh supported progress evidence; typing
or dismissing attention alone does not resume it.

## Terminal sidebar

The sidebar is a repository → worktree → session tree beside the terminal tiles.
The header shows the wordmark, needs-you and working counts, a filter and Add repository.
Pinned repositories appear in pin order, followed by repositories with sessions A–Z,
then idle repositories A–Z. Thin rules separate nonempty sections; one repository has no sections.

The case-insensitive filter matches repository names, branches, session names and reasons,
highlights matching text and expands ancestors. A banner counts filtered-out sessions that
need you; Show clears the filter. Collapsed repository rows show their worktree count and
most urgent state; collapsed worktrees show the same roll-up. Urgency is Needs you, Failed,
Working/Checking, Done, then Quiet. The main checkout is labeled **Main checkout**, with its branch on a secondary line and a folder icon.
Location and session breadcrumbs also call it **Main checkout**. Other worktrees
have a branch icon. Pins and repository/worktree expansion choices persist.
Repositories with running sessions start expanded; idle repositories start collapsed.
With one repository, everything starts expanded.

External Git worktree and branch changes refresh the sidebar automatically and when
the window gains focus. Sessions in a removed checkout stay alive and show a neutral
**⊘ Worktree removed** label. New launches and restarts there are unavailable; Stop
and Close still work. The checkout row disappears when its last session closes.

Session rows show a light, neutral CC / CX / AG badge (or `>_` for shells), name,
wait and reason. Unknown identities use `?`. Badges share a 20px-high slot with a
16px visual target; no vendor artwork is bundled. The full agent name or detected
shell name remains in the accessible row name and hover/focus preview after renaming.
Double-click the name
to edit it; Enter or blur commits, Escape cancels, and an empty value restores the default.
Rows launched with a known bypass argument also show a neutral ◇ Bypass label.
This records launch flags, not inferred global agent policy; changing defaults does not
change existing rows.
Names persist as local UI metadata keyed by terminal ID. Session rows and recorded
conversation IDs survive Foom restarts as exited sessions; PTYs and screens do not.
Hover or focus a session to peek without switching the pane. Click or press Enter to show
its terminal and focus input, using the placement rules below. Needs you remains; Done and Failed dim once seen.

Each row opens a labelled panel to the right of the sidebar, over the tiles.
Hover intent takes 400 ms, or 120 ms when switching from another open panel;
leaving both row and panel closes a hover panel after 250 ms. The ⋯ button,
right-click and Shift+F10 pin it and move focus to its commands. Escape, an
outside click or tree scrolling closes it and returns focus to the row. Hover
cannot replace a pinned panel; dragging suppresses panels.

Panels have a title band, a 248 px command column and facts beside it, up to
720 px wide and contained within the window. Commands retain their existing
confirmations. Arrow keys, Home/End and Enter operate commands; copyable paths
and conversation IDs are buttons. Clicking a session title renames it with the
same Enter/blur, Escape and empty-name behavior as sidebar double-click rename.

The home shell row (`>_ shell ~`) sits above repositories. Its name and **New
shell** command launch in the main-owned home directory. Shells group beneath
it and restore as exited sessions. Its panel shows home, executable, version
and running count. Repository panels show path, remote, default branch, last
fetch status, worktree/creation/eligible-merged counts and session states; they
offer New worktree, pinning, Delete merged worktrees and **Remove from Foom…**
(with “keeps files”). Launchers belong to checkout panels. Checkout facts show
branch, path, changes, upstream counts and last commit; linked worktrees also
show merged state and creation origin. Detached rows show a short hash with a
detached glyph, and panels say “Detached at <hash>”. **Delete worktree…** names
the existing folder-removal action.

Session panels show location, discovered agent version, state and reason,
waiting time, recorded launch flags (BYPASS when applicable), start time or exit
code, tile and conversation ID. A running session offers Stop. An exited agent
offers **Resume conversation** with a short ID hint when a validated Claude Code
or Codex conversation ID was recorded, **New conversation here**, **Copy session
ID** when an ID exists, then a separator and **Close**.

Git facts load lazily, locally and with bounded calls; unavailable facts say
Unknown. Opening a panel never fetches from the network. Merge facts use the
merge checker's last fetch and the eligible count uses its exact cleanup rules.

Resume starts the same agent in the same checkout and row, with fresh per-launch hooks
and current launch defaults. New conversation uses that row and checkout without a
resume ID. Failed launches retain the saved conversation for retry. Copy uses the full ID.
Antigravity conversation IDs are pinned for hook validation but not retained for resumption,
so Resume remains unavailable for it.
An exited shell offers **Restart shell**, a separator and **Close**. Close removes the
session and its stored record, never the checkout or the agent's own conversation files.
Sessions restore without automatically launching agents. If no supported hook/notify event
arrived before exit (including hooks-disabled launches), no conversation ID is available.

Worktree removal is available for linked checkouts created by any tool. It requires
confirmation, validates repository membership and worktree identity, and rechecks dirty
files before deletion. The branch is kept; the main checkout cannot be removed. Repository removal forgets its
registration, retains all checkout files and refuses while it has sessions or pending operations.

Below 720 CSS pixels, once sessions exist, the tree becomes a flat column with one light per session and accessible
names. ⌘⇧B on macOS or Ctrl+Shift+B elsewhere focuses the sidebar; arrow keys navigate.
⌘⇧N or Ctrl+Shift+N reveals and opens the session that has waited longest for you, clearing
its filter and expanding its ancestors. Other terminal keys, including Escape, remain input.
Settings and the six tile preset icons stay at the bottom of the sidebar. Launch actions live in repository and checkout menus. An empty sidebar labels its starting action **Add repository**.

### Delete merged worktrees

The repository menu offers **Delete merged worktrees…** below Remove repository
when at least one linked worktree is eligible, regardless of which tool created it. Foom fetches the remote
(`origin`, or the sole remote) and resolves its advertised default branch. A
branch is merged when `git merge-tree --write-tree <default> <branch>` produces
the default branch's tree: merging it would change nothing. This works for merge,
squash and rebase merges without GitHub access. A failed fetch refuses cleanup;
Foom never falls back to a stale default branch. Local inventory returns immediately;
background cleanup eligibility is cached for up to one minute and published when
ready. The action always fetches afresh.

The trusted dialog lists candidate branches, then skipped checkouts with short
reasons, and offers **Delete** and **Cancel**. Main checkouts, locked,
prunable or detached worktrees, running sessions, dirty/untracked files and
exited resumable Claude/Codex conversations are retained. After confirmation,
Foom fetches again, revalidates each candidate before and after stopping its
exited terminal resources, then uses the existing safe removal path. Changed
worktrees are skipped and reported while others continue. The local branch is
also removed only if it still points to the exact checked commit.

## Application menu and attention badge

Foom owns its menu and shortcuts. On Windows and Linux, click the sidebar's
**foom** wordmark, press Alt alone, or press F10 to open the application menu
below the wordmark. Arrows, Home/End, Enter and Escape navigate it; disabled
items are skipped and Escape returns focus to the wordmark. The native menu bar
is absent, including after Alt. The menu uses the same surface and motion as
row actions, with a scrollable list on short windows.

On macOS, the native menu bar contains Foom (About, Settings, Hide, Hide Others,
Quit), File (New Window, New Worktree, Close Window), standard Edit roles, View
(tile actions and presets, interface size, sidebar and longest waiting), Window
(Minimize, Zoom, Bring All to Front and windows), and Help (licenses and GitHub).
Windows/Linux flatten the applicable sections into the wordmark menu. New Window
uses Command+N on macOS and Ctrl+Shift+O on Windows/Linux. About uses the native About panel;
Licenses links to the source; the consolidated license screen remains #96.

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

## Confirmations

Repository removal, clean worktree removal and stopping a session use click-again
in the actions menu. The first click changes the item to **Click again to remove**
or **Click again to stop**, in solid ink with a hairline draining over three seconds.
A second click after at least 300 ms confirms; a double-click does not. Moving away,
changing focus, Escape, closing the menu or expiry disarms it. Files stay untouched
when removing a repository. Removing a worktree keeps its branch.

Launching an agent in a checkout with another running agent changes the launcher
to **Click again for two agents here**. Shell launches need no sharing confirmation.
A Codex launch using the notifier fallback also requires **Click again to replace notifier**
when the notifier replacement has not already been acknowledged. After trusted lifecycle
hooks have been observed working, later launches keep the user's notifier and omit
that disclosure. Setup shows hook health and directs review to Codex's own `/hooks` screen. The New worktree
form keeps its existing disclosure checkbox.

Decisions with content use a separate trusted Foom window. Removing a dirty
worktree lists the exact uncommitted status from Git and offers **Cancel** and
**Discard N changes and remove**. Quitting with live terminals lists each session,
its status light and location, then **Cancel** and **Stop all and quit**. Cancel is
focused initially; Escape cancels, Tab stays within the dialog and Enter activates
the focused button. The card-sized window follows Interface scale and stays centered on the board’s content.
The board stays visible under a translucent scrim and regains focus on dismissal.
It remains usable if the board renderer crashes or hangs. Confirmation buttons
use solid ink; amber and magenta retain their status meanings.

Folder pickers stay native. The New worktree form remains a renderer `<dialog>`;
it collects input and does not grant destructive approval.

## Terminal tiles

The layout is a binary split tree. Each leaf is a tile with a stable identity and
at most one session; each split has a horizontal or vertical direction and a ratio.
Split right and Split down add an empty tile. Close tile gives its sibling the
space and focuses the first tile in that sibling. Hide session empties the tile.
These actions, including applying a preset, never stop a terminal. Hidden sessions keep running and retain their sidebar lights.

Clicking a visible session focuses its tile. A hidden session fills the focused
tile if empty, otherwise the first empty tile in tree order. When all tiles are
full, nothing is replaced: the sidebar row briefly shakes (disabled with reduced
motion). Refusal plays immediately on each refused click when Alerts is enabled.

Launching a session fills the focused empty tile, then the first empty tile, or
replaces the focused tile when all tiles are full. Its previous session becomes
hidden and keeps running. Restart replaces the focused tile. The longest-waiting
shortcut places that session in the focused tile and hides
its previous occupant. If the waiting session was in another tile, that tile empties.

Title bars show the state light, agent badge, location, session name and tile number.
Location text shrinks first. Split right, Split down, Maximize, Move to new window, Hide session and
Close tile controls appear on hover or focus. Empty tiles are dashed outlines with
a transparent title bar showing the tile number and Split right, Split down and
Close tile controls on hover or focus. Their bodies have no copy or launch buttons;
Maximize, Move to new window and Hide session are omitted. Focus uses a violet border and brighter
occupied title bar; Needs you uses an amber border that takes
precedence, with a labelled, haloed light as a second state cue.

Tiles are numbered in tree order and share their numbers with the sidebar. The
focused tile's number is highlighted. Presets are One, Two side by side, Two
stacked, Two by two, One and two, and One and three. They keep the focused session
first, then other occupied leaves in tree order, then empty leaves. Existing leaves keep
their views; additional leaves start empty, and sessions that no longer fit hide.

Gutters drag between 15% and 85%. Focus a gutter and use its axis's arrow keys to
resize by five percentage points; Home and End select the limits. Maximize expands
one tile from its own position while the others fade and stay mounted and attached.
Restoring returns to the saved split geometry. Reduced motion disables movement
and refusal animation.

Use Ctrl on Linux/Windows, or ⌘ on macOS:

| Shortcut | Action |
|---|---|
| ⌘ + 1–9 (macOS); leader, then 1–9 (Windows/Linux) | Focus tile by number |
| Ctrl/⌘ + Shift + Enter | Toggle focused tile maximize |
| Ctrl/⌘ + Shift + N | Replace focused tile with the longest-waiting session |
| ⌘ + Alt + Shift + arrow (macOS); leader, then arrow (Windows/Linux) | Focus the nearest tile in that direction |
| ⌘ + Alt + Shift + R / D (macOS); leader, then R / D (Windows/Linux) | Split right / down |
| ⌘ + Alt + Shift + W / H (macOS); leader, then W / H (Windows/Linux) | Close tile / hide session |

On Windows/Linux the tile leader is Ctrl+Shift+Space. Release the modifiers, then
press the second key within two seconds. Escape cancels it; an unmatched key
cancels and reaches the terminal. Window blur also cancels. These bindings avoid
Ctrl+Alt (AltGr) and GNOME's Ctrl+Alt+Shift+arrow workspace commands. Plain Ctrl+1–9
now remain terminal input, including Ctrl+2–8 terminal encodings. macOS bindings
are unchanged. The main-process command list drives menus and shortcut handling.

Plain terminal control keys remain terminal input. The split tree, ratios, leaf
identities, focus and assigned session IDs persist as local view preferences.
Maximize is temporary. On restart, unavailable sessions leave empty tiles; terminal
PTYs and screens are not restored. WebGL remains separate future work.

Drag a sidebar session onto a tile center to replace its session (the previous
session keeps running hidden), or onto one of its four edges to split it in half.
Drag a title bar onto another tile center to swap whole tiles, or onto an edge to
move that tile there, collapsing its old parent. Tile moves and swaps preserve
terminal views and attachments. A labelled, outlined preview shows the destination;
a live region announces it. Escape cancels the drag.

Swap with the nearest tile using Command+Alt+arrow on macOS, or the tile leader
then Shift+arrow on Windows/Linux. The View menu exposes the same four commands.
Focus follows the moved tile.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code and trusted Codex lifecycle hooks, with Codex `notify` as the fallback, attached per launch, plus the explicitly installed Antigravity observer plugin. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](agents.md).
2. **Local agent UI signals**: capture-backed terminal title and screen rules. Idle is evidence for classification, never Done by itself. Process exit remains final and permission hooks take precedence.
3. **Process facts**: exit code, the shell prompt returning, echo changes only with corroborating prompt context (agent TUIs also disable echo during ordinary operation; this may not be detectable on Windows).
4. **Text patterns** in the tail: `(y/n)`, `Password:`, `Press Enter`.
5. **A model** for what's still ambiguous, such as a question asked in plain prose.

"Quiet" is not "done". A process can be silent while it works. The debounce adapts: it's short when the tail ends in a question and longer mid-stream.

Every verdict and the user's next action (replied, dismissed, ignored) go into a local log. Dismissing an alert counts as feedback. The log becomes the test set for improving the evaluator.

### Inference sources

The model tier uses one of these sources:

- **An agent the user already has**: a one-shot headless call through `claude -p` or `codex exec`, using the user's existing login. No key is stored. Not available yet: Foom can't yet enforce that such a call sees only the terminal tail (see [architecture](architecture.md#evaluator-pipeline)). Preflight shows it as unavailable.
- **An API key**: Anthropic, OpenAI, or Google. The key is stored with Electron `safeStorage`.
- **A local model**: any OpenAI-compatible endpoint, such as Ollama.
- **Rules only**: no model. Ambiguous terminals stay neutral.

The evaluator sends only the last 40 lines of a quiet terminal, with likely secrets redacted. It never sends files, diffs, or keystrokes.

## Orchestration and privacy (planned)

The [control-plane design](orchestration.md) has an authentication and HTTP
foundation, read-only MCP tools and a packaged console CLI; orchestration remains planned. Current agent
launches receive a private credential for their own identity, with no mutation
capabilities. Verified Claude Code and Codex releases launched by Foom receive read-only MCP access
to session metadata in their own repository, independently of hooks. Unverified versions
and Antigravity do not attach MCP; managed client policy may deny attachment. These tools
never return terminal output. **Launch as Foom orchestrator** in a repository's menu will grant one
agent permission to create worktrees and run up to four children in that repository.
Children cannot orchestrate through Foom. Their sessions and actions remain visible;
you can stop them or take over. Agents launched outside Foom receive no automatic
access. Agent configuration is attached per launch, never installed globally or
written into the repository.

The packaged `foom` console can inspect session metadata. Agents launched by Foom
use only their inherited repository scope. Humans and scripts request pairing with
`--repository PATH`: compare the code in the CLI and Foom's trusted dialog, then
grant read-only access for ten minutes. Pairing expires after 60 seconds and never
grants terminal output, typing or mutation access. Credentials remain in memory.
Optional `--install-cli` / `--uninstall-cli` commands manage only Foom-owned PATH
setup; absolute-path use needs no installation. See [console usage](orchestration.md#console-helper-and-local-pairing-154).

An orchestrator can request at most the last 40 lines of each child's terminal,
with likely secrets redacted and each response capped at 16 KiB. These results may
be sent to the orchestrator agent's model provider, which can differ from your
evaluator provider. Repeated reads can collect more output over time. Foom does
not read files, diffs, transcripts or keystrokes for this API; a terminal may print
file contents, diffs or echoed input, and redaction cannot catch every secret.
The launch flow will disclose this data path. The agent's own tools and provider
settings continue to govern its other data access.

Permission and credential prompts always stay with you. With the current agent
interfaces, proposed answers to prose questions also require review in Foom;
unattended replies need a verified question-specific routing mechanism first.
Take over cancels pending replies. Worktree removal always asks you and rechecks
its identity and changed files. A local action log records who acted, targets and
outcomes, plus redacted reply proposals; it omits terminal tails, credentials and
initial prompts. It retains at most 30 days and five 10 MiB files and can be cleared.

## First run

Setup is a preflight countdown:

1. **Agents** (T-4): detect the supported CLIs on PATH and show each one's attention signal. One setting controls whether Foom supplies hooks and credentials per launch. Antigravity also offers an explicit plugin install with its location, behavior and removal disclosed; Settings shows installed, outdated or disabled status and offers update, enable and removal.
2. **Repositories** (T-3): "Where do you keep your code?" Foom suggests common code folders that hold repositories, with a count for each, or you choose one. It scans that folder and lists its Git repositories, with the ones worked on in the last 30 days checked.
3. **Worktrees** (T-2): choose where new worktrees live: Foom's folder (`~/.foom/worktrees`, the default) or next to each repository.
4. **Evaluator** (T-1): pick an inference source and test it on a sample.
5. **Go / no-go** (T-0): each item shows GO or NO-GO with a link back to its step. Launch needs every item GO: at least one agent ready and one repository added.

On wide windows the steps use the extra width: agents as a grid, the worktree choices side by side, and the Evaluator's live check beside its options.

Preflight derives a shared enlargement from the actual space left beside or below the
rail, then checks the rendered content, including wrapping and the fixed footer. It
never enlarges content into overflow or shrinks it below the user's chosen interface
size. The scale stays between 100% and 200%; larger steps can lower the shared ceiling,
but only a window resize or interface-size change lets it grow again. Long lists,
expanded details and small windows scroll at normal size, with navigation still visible.
Short steps center vertically. Content changes
re-center over 180 milliseconds (immediately with reduced motion). Back, Continue and
Launch stay in a footer at the bottom of the window, outside the scrolling content.

The rail also holds **Appearance**: System, Light or Dark, and the interface size (80–150%; the window grows and shrinks with it while the screen has room, around the pointer when you click + or − or scroll over the percentage, so what you pointed at stays under it; also ⌘ +/−/0 on macOS or Ctrl+Shift+=/−/0 elsewhere). Terminal font size is separate and lives in Settings → Terminal. A model source is used only after it passes Run check. Launch opens the board. The board starts empty. A repository’s **New worktree** action creates or reuses a Git worktree for the branch, regardless of which tool created it, and launches an agent or shell; checkout menus launch sessions in an existing checkout. Sample sessions are available only in an explicit development build. After first run, **Settings** on the board edits the saved choices.

## Settings

Open **Settings** from the board, or press ⌘, on macOS and Ctrl+Shift+, elsewhere.
It replaces the terminal tiles beside the persistent sidebar in the same window.
Esc returns to the tiles and restores the same focused sidebar row.
Selecting a terminal in the sidebar also leaves Settings; terminals keep running throughout.

Agents and hooks, Repositories, Worktrees, and Evaluator use the same controls as
preflight. Changes apply immediately and persist. A repository scan in Settings
starts with the already-added repositories checked; toggling a selection saves it
at once and reports any refusal. A model source still requires a successful Run check.
Settings → Agents and hooks also provides default launch arguments for each supported
agent, one argument per line, with an explicit Save default arguments action. Put flag
values on separate lines. Spaces and quotes are literal, with no shell parsing or
splitting. LF and CRLF are accepted; trailing blank lines are ignored. Errors name
the agent and line. An empty editor uses the existing launch behavior. The user's agent policy
is their global config plus Foom defaults; Foom appends its own display and attention
flags and never edits global config. Defaults affect future user launches only.

Main validates at most 64 arguments per agent, each 1–4096 characters with no control
characters. Foom reserves Claude `--settings`, `--safe-mode` and `--bare`,
`--no-alt-screen`, Codex `-c`/`--config` overrides of `notify` or `hooks`, and the `--` terminator so
these defaults cannot displace its attention flags. Saving a known bypass argument
requires a main-owned trusted dialog once per agent, with Cancel focused by default: a worktree is not a sandbox, and
the agent can act as the user anywhere on the machine. Cancelling leaves settings
unchanged. Codex `danger-full-access` sandbox flags and `sandbox_mode` overrides
also count as bypass, even with approvals enabled. Known bypass detection is a
fixed table, not an effective-policy audit. On load, an invalid agent's stored
argument list is dropped without resetting other settings or other agents' lists.

Conversation selectors are reserved for Foom's session actions: Claude resume,
continue, session-ID and fork-session flags; Codex `resume`/`fork` commands and
`--last`/`--fork`; Antigravity conversation/continue flags. This prevents launch
defaults from redirecting Resume or turning New conversation into a continuation.
Other agent arguments retain the existing validation and literal argv behavior.

Settings → Appearance also offers **Panel color: Vivid / Subtle / Plain**,
with Vivid as the default. It scales header, mark, command-column, chip-fill and
glow decoration only. Status text and outlines retain color and words. High
Contrast and `prefers-contrast: more` force Plain and full-strength chip outlines.
Decoration uses highlight; Working continues to use accent.

Appearance shares the preflight rail's System/Light/Dark and interface-size controls.
Changing either view is reflected in the other without restarting.

Terminal font size applies to every terminal view: 10–32 pixels, 14 by default,
independent of interface size. The Terminal section previews text size, all 16 ANSI colors, bold, dim and selection.
Terminal colors default to Follow interface, with Foom Light/Dark, Solarized Light/Dark
and Dracula built in. Changes apply live to visible and detached terminals and board peek.
Settings → Themes offers System, Eclipse Light, Eclipse Dark, High Contrast,
Deep Field, Moonlight, Graphite and Midnight Indigo, with a live preview of all six terminal statuses.
System follows the operating system's light/dark appearance. The other themes have
a fixed light or dark base. Changes apply immediately and persist. The preflight
and Appearance System/Light/Dark controls return to the corresponding Eclipse
appearance; changing interface size keeps the selected theme. Terminal color
schemes remain independent; Follow interface uses the light/dark base.

Appearance and Terminal list custom themes after the built-ins and offer **Open
themes folder**. Add interface JSON files to `~/.foom/config/themes/` and terminal
JSON files to `~/.foom/config/terminal-themes/`. New files and valid edits apply live,
without restarting. Rejected files appear below the picker with a filename, JSON
path and reason in failure styling. An invalid edit retains that theme's last good
colors for the current session. A missing or invalid saved choice at startup uses
Follow while retaining the choice; fixing its file restores the selection. Custom
names matching a built-in receive “(custom)”. See the [file formats and limits](architecture.md#custom-theme-files-205).

Every interface theme keeps amber for Needs you, magenta for Failed, and violet for activity.
Needs you retains its halo, Failed its square light, and all states their labels.
High Contrast provides at least 7:1 text contrast and stronger borders.

Settings → Sound offers a separate recording picker and preview for Working, Done,
Needs you and Refusal. Built-in and user files appear together, named from their
filenames. Working is off at 15% by default. One steady loop plays at the selected
volume while at least one agent is executing, including silent thinking and tool use.
More agents do not increase its volume. Completion of one agent leaves the loop
running for others. Plain shells produce no automatic sounds, including command completion and attention alerts.
Starting, idle, blocked and exited agents are silent. Unsupported agent versions stay
neutral until Foom receives supported lifecycle evidence. Alerts
cover Done, Needs you and Refusal and default to on at 50%. Each decoded recording
gets bounded loudness normalization so volume choices remain useful across files.

Needs you repeats every two minutes until the agent resumes or attention is dismissed.
Typing alone does not prove an agent has resumed. Shell replies still clear attention. Needs you is muted in
the focused tile of the focused window; Settings and preflight hide
that terminal and allow attention alerts again. Done plays once per completed agent
turn, including in the focused tile. Initial readiness is not a completion. Completion observed while muted is not
replayed. Attention reminders resume after two minutes away or after unmuting.
Verdicts settle for one second before sounding. Simultaneous alerts play once, with
Needs you taking precedence; verdict alerts are at least two seconds apart.
Refusal plays immediately on each refused placement, independently of that debounce.
Reduced motion disables the refusal shake, not its sound. Visual status always stays on.

**Open sounds folder** opens `~/.foom/config/sounds/` in the file manager. Add files
to `working/`, `done/`, `needs-you/` or `refusal/`, then reopen Settings → Sound to
refresh. There is no import dialog. Supported files are OGG, Opus, WAV, FLAC and MP3;
only direct regular files with valid headers are accepted. Working files are at most
8 MB and 1–30 seconds; other files are at most 2 MB, with Done/Needs you up to 1.5
seconds and Refusal up to 0.3 seconds. Each folder lists at most 100 eligible files.
Hidden files, subfolders, names over 100 characters and links outside their kind
folder are rejected.

Choices persist as a source and filename, never a path. Missing or invalid choices
fall back to the built-in default with a reason beside the picker, without replacing
the saved choice; restoring the file and reopening Sound restores playback. Needs
you cannot select the same source/filename as Done or Refusal. Old soundscape settings
migrate while preserving switches and volumes. Previews use the selected volume even
when switched off; Working previews stop after five seconds. Sound credits are in
Settings → Sound and packaged third-party notices, ready for the future About screen
(#96). The 17 built-in CC0 recordings include drive chatter, teletype, typewriter,
projector, bells, percussion and short refusal sounds.

## Windows and quitting

New Window opens another full sidebar and an independent tile layout. A tile's
**Move to new window** control moves that session into a new window. Each terminal
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

Each window saves its display, normal bounds, maximized state, interface size and
tile tree. At launch Foom restores those windows. Missing displays fall back to the
primary display and bounds are clamped to its work area. Sessions restore as exited
rows and never restart automatically. Closing a window removes it from the saved
window set. Interface size is independent per window; other settings are shared.
The attention badge counts sessions once for the app. One window plays app sounds,
with attention suppression following the focused terminal in any window.

If any terminal is running, quit asks for confirmation; Cancel keeps everything
running. Quitting stops every PTY before the app exits. Terminals live exactly as
long as the app.

## Mockups

Clickable mockups live in [`docs/mockups/`](mockups/README.md): the [board](mockups/board.html), [first run](mockups/first-run.html), and [brand](mockups/brand.html). The board and first-run mockups predate the brand; take their layout and behavior, and take color and type from [brand.md](brand.md). The mockups README lists what else they get wrong.

Shell status currently follows command start and completion in Bash 4.4+: an initial
prompt is Quiet (“Shell is ready”), a command is Working, and return to the prompt is
Done or Failed according to its exit code. Editing the next command preserves that
result until execution starts. Other shells use output patterns and process exit.
Shell evaluations lasting longer than 150 ms show Checking. Agent Working follows
lifecycle evidence, never silence or output volume. A supported turn-end signal
stops Working immediately; classification determines the result.
