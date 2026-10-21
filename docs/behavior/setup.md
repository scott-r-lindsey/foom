# Setup

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## First run

Setup starts with Welcome, then a preflight countdown. The welcome illustration uses the current tile headers: a state light, neutral agent badge, repository and branch, and compact tile controls. Ten active terminals fold into rows with state words; Needs you has a steady amber halo. Reduced motion starts with the settled rows.

1. **Agents** (T-2): detect the supported CLIs on PATH and show each one's attention signal. One setting controls whether Foom supplies hooks and credentials per launch. Antigravity’s row shows Hooks with an active plugin and Screen rules otherwise. It offers Install plugin, Update plugin or Enable plugin inline; Remove plugin is inline. Install and update open a trusted confirmation disclosing location, behavior and removal, with no disclosure paragraphs in the step.
2. **Repositories** (T-1): "Where do you keep your code?" Foom suggests common code folders that hold repositories, with a count for each, or you choose one. It scans that folder and lists its Git repositories, with the ones worked on in the last 30 days checked by default. The day count edits in place (integer 1–365); typing or scrolling over it changes the saved window and regroups existing results without rescanning or clearing selections.
3. **Go / no-go** (T-0): each item shows GO or NO-GO with a link back to its step. Launch needs every item GO: at least one agent ready and one repository added.

New profiles use Foom’s worktree folder (`~/.foom/worktrees`) without a location prompt.
Saved location choices are preserved, including when setup is incomplete.

Preflight derives a shared enlargement from the actual space left beside or below the
rail, then checks the rendered content, including wrapping and the fixed footer. It
never enlarges content into overflow or shrinks it below the user's chosen interface
size. The scale stays between 100% and 200%; larger steps can lower the shared ceiling,
but only a window resize or interface-size change lets it grow again. Long lists,
expanded details and small windows scroll at normal size, with navigation still visible.
Short steps center vertically. Content changes
re-center over 180 milliseconds (immediately with reduced motion). Back, Continue and
Launch stay in a footer at the bottom of the window, outside the scrolling content.

The rail also holds **Appearance**: System, Light or Dark, and the interface size (80–300%, so a presenter can zoom Foom alone without changing OS scaling; the window grows and shrinks with it while the screen has room, around the pointer when you click + or − or scroll over the percentage, so what you pointed at stays under it; also ⌘ +/−/0 on macOS or Ctrl+Shift+=/−/0 elsewhere). Interface size applies immediately to all windows, their confirmations and previews. Each window grows and shrinks from its own remembered 100% size; only the window where you changed zoom follows the pointer. Terminal font size is separate and lives in Settings → Terminal. Launch opens the board. The board starts empty. A repository’s **New worktree** action creates a Git worktree for the branch, or focuses the checkout that already has it regardless of which tool created it, and launches nothing; checkout panels launch sessions. Sample sessions are available only in an explicit development build. After first run, **Settings** on the board edits the saved choices.

### Flight-path launch

After All stations go, the deep-space overlay counts 3, 2, 1 at 0, 700 and
1400 ms. Ignition at 1 adds white/violet flame and vapor. Liftoff at 2100 ms
rolls the rocket along the flat-then-vertical brand curve, leaving a glowing
trail past the black Eclipse hole and exiting through the top. Stars radiate
from the hole toward the viewer, accelerating over about 1.5 seconds and
remaining fast beneath the top-left wordmark and “Takeoff was faster than
expected.” The overlay finishes at 4300 ms. Escape, Enter, Space or a click
skips it; “Press Esc to skip” remains visible. Reduced motion instead holds
one final still frame, with trail, rocket near the top, short static streaks
and title, for 1200 ms. Art uses hole, space-ink, accent and accent-deep tokens.
