# Product

Foom is a desktop workspace for running many coding agents at once, each in its own git worktree and terminal. Its job is to route your attention. Terminals stay hidden, and Foom tells you which one needs you.

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

The sidebar is a repository → worktree → session tree beside the terminal pane.
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
Names persist as local UI metadata keyed by terminal ID. Terminal sessions themselves still
live only as long as Foom; restoring agent conversations is tracked separately in #115.
Hover or focus a session to peek without switching the pane. Click or press Enter to show
its terminal and focus input. Needs you remains; Done and Failed dim once seen.

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

Below 720 CSS pixels the tree becomes a flat column with one light per session and accessible
names. ⌘⇧B on macOS or Ctrl+Shift+B elsewhere focuses the sidebar; arrow keys navigate.
⌘⇧N or Ctrl+Shift+N reveals and opens the session that has waited longest for you, clearing
its filter and expanding its ancestors. Other terminal keys, including Escape, remain input.
Preflight and Settings stay at the bottom of the sidebar. Preflight preserves the selected terminal.

## The evaluator

Checks run from cheapest and most certain to least:

1. **Agent signals**: Claude Code hooks and Codex `notify`, attached per launch. These report specific events, not necessarily task completion; a finished response can still ask a question. See [agent research](agents.md).
2. **Process facts**: exit code, the shell prompt returning, echo changes only with corroborating prompt context (agent TUIs also disable echo during ordinary operation; this may not be detectable on Windows).
3. **Text patterns** in the tail: `(y/n)`, `Password:`, `Press Enter`.
4. **A model** for what's still ambiguous, such as a question asked in plain prose.

"Quiet" is not "done". A process can be silent while it works. The debounce adapts: it's short when the tail ends in a question and longer mid-stream.

Every verdict and the user's next action (replied, dismissed, ignored) go into a local log. Dismissing an alert counts as feedback. The log becomes the test set for improving the evaluator.

### Inference sources

The model tier uses one of these sources:

- **An agent the user already has**: a one-shot headless call through `claude -p` or `codex exec`, using the user's existing login. No key is stored. Not available yet: Foom can't yet enforce that such a call sees only the terminal tail (see [architecture](architecture.md#evaluator-pipeline)). Preflight shows it as unavailable.
- **An API key**: Anthropic, OpenAI, or Google. The key is stored with Electron `safeStorage`.
- **A local model**: any OpenAI-compatible endpoint, such as Ollama.
- **Rules only**: no model. Ambiguous terminals stay neutral.

The evaluator sends only the last 40 lines of a quiet terminal, with likely secrets redacted. It never sends files, diffs, or keystrokes.

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

The rail also holds **Appearance**: System, Light or Dark, and the interface size (80–150%; the window grows and shrinks with it while the screen has room, around the pointer when you click + or − or scroll over the percentage, so what you pointed at stays under it; also ⌘ +/−/0 on macOS or Ctrl+Shift+=/− and Ctrl+0 elsewhere). Terminal font size is separate and lives in Settings → Terminal. A model source is used only after it passes Run check. Launch opens the board. The board starts empty. **New worktree** launches an agent or shell in a managed worktree, and **Local shell** starts a standalone shell. Sample sessions are available only in an explicit development build. **Preflight** on the board runs setup again with the saved choices; Esc returns to the board.

## Settings

Open **Settings** from the board, or press ⌘, on macOS and Ctrl+, elsewhere.
It replaces the terminal pane beside the persistent sidebar in the same window.
Esc returns to the selected terminal and restores the same focused sidebar row.
Selecting a terminal in the sidebar also leaves Settings; terminals keep running throughout.

Agents and hooks, Repositories, Worktrees, and Evaluator use the same controls as
preflight. Changes apply immediately and persist. A repository scan in Settings
starts with the already-added repositories checked; toggling a selection saves it
at once and reports any refusal. A model source still requires a successful Run check.
Appearance shares the preflight rail's System/Light/Dark and interface-size controls.
Changing either view is reflected in the other without restarting.

Terminal font size applies to every terminal view: 10–32 pixels, 14 by default,
independent of interface size. The Terminal section previews text size, all 16 ANSI colors, bold, dim and selection.
Terminal colors default to Follow interface, with Foom Light/Dark, Solarized Light/Dark
and Dracula built in. Changes apply live to visible and detached terminals and board peek.
Settings → Themes offers System, Eclipse Light, Eclipse Dark, High Contrast,
Deep Field and Moonlight, with a live preview of all six terminal statuses.
System follows the operating system's light/dark appearance. The other themes have
a fixed light or dark base. Changes apply immediately and persist. The preflight
and Appearance System/Light/Dark controls return to the corresponding Eclipse
appearance; changing interface size keeps the selected theme. Terminal color
schemes remain independent; Follow interface uses the light/dark base.

Every theme keeps amber for Needs you, magenta for Failed, and violet for activity.
Needs you retains its halo, Failed its square light, and all states their labels.
High Contrast provides at least 7:1 text contrast and stronger borders. Sound remains
a placeholder for later work.

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
