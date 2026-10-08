# Product

Foom is a desktop workspace for running many coding agents at once, each in its own git worktree and terminal. Its job is to route your attention. Terminals can stay hidden or share the workspace in tiles; Foom tells you which one needs you.

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
- **Color is the evaluator's verdict.** It changes only when the evaluator decides something.

| State | Light | Meaning |
|---|---|---|
| Working | Brand violet, brightness follows output | Output is arriving |
| Checking | Brand violet, slow breathing | Output stopped; the evaluator is running |
| Needs you | Amber, steady, with a halo | Waiting for input or approval |
| Done | Green | Finished successfully |
| Failed | Magenta, square | Exited with an error or gave up |
| Quiet | Dim neutral | Quiet but fine (dev server, long install) |

- Done and Failed dim once the user has looked at them.
- Needs you clears when the user replies or dismisses it. Screen-based attention also clears when output resumes; permission-hook attention stays until a reply or dismissal. Opening the terminal doesn't clear it.
- Failed uses a square light, so the state never depends on color alone.
- Every verdict carries a one-line reason and the signal that produced it, for example `Wants to edit src/main/main.ts · pattern: (y/n)`.

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

Session rows show a light, letter agent badge, name, wait and reason. Double-click the name
to edit it; Enter or blur commits, Escape cancels, and an empty value restores the default.
Rows launched with a known bypass argument also show a neutral ◇ Bypass label.
This records launch flags, not inferred global agent policy; changing defaults does not
change existing rows.
Names persist as local UI metadata keyed by terminal ID. Terminal sessions themselves still
live only as long as Foom; restoring agent conversations is tracked separately in #115.
Hover or focus a session to peek without switching the pane. Click or press Enter to show
its terminal and focus input, using the placement rules below. Needs you remains; Done and Failed dim once seen.

Each row has an actions menu that opens to the right, over the pane, outside the scrolling
tree. Arrow keys, Home/End, Enter and Escape operate it; outside clicks and tree scrolling
close it. Repository and worktree selection show breadcrumbs and location launch buttons.
Repository launchers use the main checkout. Worktree launchers use the selected checkout,
including worktrees created outside Foom and detached checkouts. Launchers name the user's shell and show only
installed, enabled agents. New worktree opens the existing branch/agent dialog. A running
session offers Stop; an exited session offers Close, plus Restart shell for shells. Close
removes only the session, never the checkout. Worktree removal is available for linked checkouts created by any tool. It requires
confirmation, validates repository membership and worktree identity, and rechecks dirty
files before deletion. The branch is kept; the main checkout cannot be removed. Repository removal forgets its
registration, retains files and refuses while it has sessions or Foom-owned worktrees.

Below 720 CSS pixels, once sessions exist, the tree becomes a flat column with one light per session and accessible
names. ⌘⇧B on macOS or Ctrl+Shift+B elsewhere focuses the sidebar; arrow keys navigate.
⌘⇧N or Ctrl+Shift+N reveals and opens the session that has waited longest for you, clearing
its filter and expanding its ancestors. Other terminal keys, including Escape, remain input.
Settings and the six tile preset icons stay at the bottom of the sidebar. Launch actions live in repository and checkout menus. An empty sidebar labels its starting action **Add repository**.

## Confirmations

Repository removal, clean worktree removal and stopping a session use click-again
in the actions menu. The first click changes the item to **Click again to remove**
or **Click again to stop**, in solid ink with a hairline draining over three seconds.
A second click after at least 300 ms confirms; a double-click does not. Moving away,
changing focus, Escape, closing the menu or expiry disarms it. Files stay untouched
when removing a repository. Removing a worktree keeps its branch.

Launching an agent in a checkout with another running agent changes the launcher
to **Click again for two agents here**. Shell launches need no sharing confirmation.
The first hooked Codex launch also requires **Click again to replace notifier**
when the notifier replacement has not already been acknowledged. The New worktree
form keeps its existing disclosure checkbox.

Decisions with content use a separate trusted Foom window. Removing a dirty
worktree lists the exact uncommitted status from Git and offers **Cancel** and
**Discard N changes and remove**. Quitting with live terminals lists each session,
its status light and location, then **Cancel** and **Stop all and quit**. Cancel is
focused initially; Escape cancels, Tab stays within the dialog and Enter activates
the focused button. The window covers the board with a theme-based backdrop and returns focus on dismissal.
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
Location text shrinks first. Split right, Split down, Maximize, Hide session and
Close tile controls appear on hover or focus. Empty tiles are dashed outlines with
a transparent title bar showing the tile number and Split right, Split down and
Close tile controls on hover or focus. Their bodies have no copy or launch buttons;
Maximize and Hide session are omitted. Focus uses a violet border and brighter
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
are unchanged. The board command list is shared by shortcut handling; application
menu integration is tracked in #135.

Plain terminal control keys remain terminal input. The split tree, ratios, leaf
identities, focus and assigned session IDs persist as local view preferences.
Maximize is temporary. On restart, unavailable sessions leave empty tiles; terminal
sessions themselves are not restored. Drag-and-drop placement and rearrangement
are deferred to #133; pop-out windows and WebGL are separate future work.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code hooks and Codex `notify`, attached per launch. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](agents.md).
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
foundation; orchestration and agent tool attachment remain planned. Current agent
launches receive a private credential for their own identity, with no mutation
capabilities. Agents launched by Foom will receive read-only access to session metadata in their own
repository. **Launch as Foom orchestrator** in a repository's menu will grant one
agent permission to create worktrees and run up to four children in that repository.
Children cannot orchestrate through Foom. Their sessions and actions remain visible;
you can stop them or take over. Agents launched outside Foom receive no automatic
access. Agent configuration is attached per launch, never installed globally or
written into the repository.

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

1. **Agents** (T-4): detect the supported CLIs on PATH and show each one's attention signal. One setting controls whether Foom attaches hooks per launch.
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

The rail also holds **Appearance**: System, Light or Dark, and the interface size (80–150%; the window grows and shrinks with it while the screen has room, around the pointer when you click + or − or scroll over the percentage, so what you pointed at stays under it; also ⌘ +/−/0 on macOS or Ctrl+Shift+=/− and Ctrl+0 elsewhere). Terminal font size is separate and lives in Settings → Terminal. A model source is used only after it passes Run check. Launch opens the board. The board starts empty. A repository’s **New worktree** action launches an agent or shell in a managed worktree; checkout menus launch sessions in an existing checkout. Sample sessions are available only in an explicit development build. After first run, **Settings** on the board edits the saved choices.

## Settings

Open **Settings** from the board, or press ⌘, on macOS and Ctrl+, elsewhere.
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

Every theme keeps amber for Needs you, magenta for Failed, and violet for activity.
Needs you retains its halo, Failed its square light, and all states their labels.
High Contrast provides at least 7:1 text contrast and stronger borders.

Settings → Sound offers a separate recording picker and preview for Working, Done,
Needs you and Refusal. Built-in and user files appear together, named from their
filenames. Working is off at 15% by default; its loop follows total terminal output
with the existing capped logarithmic mix, and quiet terminals are silent. Alerts
cover Done, Needs you and Refusal and default to on at 50%. Each decoded recording
gets bounded loudness normalization so volume choices remain useful across files.

Needs you repeats every two minutes until replied to or dismissed. The terminal in
the focused tile of the focused window does not alert; Settings and preflight hide
that terminal and allow its alerts again. Completion observed while muted is not
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

## Quitting

Closing the window quits Foom on every platform, including macOS. The close button,
⌘W and ⌘Q on macOS, and Alt+F4 and Ctrl+Q elsewhere use the same quit path.
If any terminal is running, Foom asks for confirmation; Cancel keeps everything running.
Quitting stops every PTY before the app exits. Terminals live exactly as long as the app.

## Mockups

Clickable mockups live in [`docs/mockups/`](mockups/README.md): the [board](mockups/board.html), [first run](mockups/first-run.html), and [brand](mockups/brand.html). The board and first-run mockups predate the brand; take their layout and behavior, and take color and type from [brand.md](brand.md). The mockups README lists what else they get wrong.

Shell status currently follows command start and completion in Bash 4.4+: an initial
prompt is Quiet (“Shell is ready”), a command is Working, and return to the prompt is
Done or Failed according to its exit code. Editing the next command preserves that
result until execution starts. Other shells use output patterns and process exit.
Checking appears for evaluations lasting longer than 150 ms. Rules-only mode keeps
ambiguous output Working; it cannot determine arbitrary agent completion from silence.
