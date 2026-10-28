# Board

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/tiles.md).

Main sidebar inventory and command dispatch live in `main/workspace/sidebar-commands.ts`; `workspace-context.ts` owns shared snapshots, refresh and owner lifecycle behind the public Workspace facade.

## Board

**Today:** The board is the home screen, with live shell and agent rows grouped by repository. The source loads `workspace:snapshot`, refreshes on `workspace:changed` (including repository additions and preflight repository changes), and overlays `terminal:state`, `terminal:exit`, and activity events received while a snapshot is pending. Rows keep their positions when verdicts change. The persistent sidebar remains beside the terminal tile area. Arrow keys move row focus; focus and hover leave terminal attachments unchanged and do not preview output; Enter or click selects and focuses the terminal. Main intercepts ⌘⇧B / Ctrl+Shift+Space, then B to focus the sidebar and ⌘B / Ctrl+Shift+B to collapse or expand it and ⌘/Ctrl+Shift+N to select the oldest waiting verdict. Esc reaches the PTY. Below 720 CSS pixels, the sidebar collapses to accessible lights rather than disappearing. Registered repositories remain in the sidebar even without terminals. Wait time begins at the verdict's main-process timestamp and survives repeated attention classifications. Opening does not clear evaluator Needs you; unread child-report reminders clear on human focus (see [product](../behavior/orchestration.md#orchestration-and-privacy)). Done/Failed dim once seen. Typing replies through terminal input; **Dismiss** records dismissal feedback through IPC and waits for main's state update. Failed feedback remains visible and can be retried. Dismiss records the reason **Dismissed**; stored legacy **Not attention** reasons remain readable. Repository rows optionally show paths relative to the code folder through the off-by-default General preference; their absolute path identity is unchanged. The populated sidebar add row reads **+ Add repo**, retaining the accessible name **Add repository**.

Each leaf of the split tree owns one persistent xterm controller. Sidebar selection
is independent of presentation. `tiles.ts` implements immutable split, close,
placement, grow, space collapse, drop-to-split, whole-leaf swap/move, geometry and restore operations. `tile-area.tsx` renders the
leaves as a flat, keyed sibling list positioned by tree rectangles, rather than
nesting React components under splits. Changing parent splits therefore never
remounts surviving leaves. Maximize changes rectangles and opacity
without changing attachments. Empty leaves render as aria-hidden spaces without
chrome or DOM focus. Split preserves terminal focus and records the newest space's
ID as the landing spot; terminal-only tree order supplies numbers and navigation.
Split offers left, up, right and down, placing the new space first for left/up,
with the existing depth and leaf limits. Two pointed 28px D-pads labelled Split
and Grow replace the four command rows. Their centers are noninteractive glyphs;
arrow keys move within each pad without adding global shortcuts. Refused arrows
remain focusable, dimmed with dashed outlines and a reason on hover/focus.
Grow walks to the nearest split on its axis where the tile is opposite the chosen
direction, skipping same-axis splits on the wrong side. It absorbs the split only
if the far side has no occupied tiles, preserving the containing subtree. Otherwise
it refuses with “Occupied tile to the left/right” or “Occupied tile above/below”.
No matching split reports “At the left/right/top/bottom edge”.
Right-clicking an empty space opens a pointer-positioned menu with only the Split
pad, New shell here and Close space. New shell here uses the validated home-shell
command (main chooses the directory), then places the returned request-specific
terminal ID in that leaf if still empty, falling back to ordinary placement if it
filled or closed. Tab moves between the pad and commands; leaving the menu dismisses it. Close space removes the empty leaf and gives its area to its sibling, as a
collapsed gutter does. Escape and outside clicks dismiss the menu. Spaces remain
unfocusable with no chrome.
Gutters clamp occupied sides to 15–85%; empty sides can reach zero and collapse
on pointer release or keyboard commit past 8%/92%. Each attached terminal retains
its own PTY size. The controller publishes fitted columns/rows with its view
snapshot for tile panel facts; terminal output and activity stay outside React.
Tile panels reuse the sidebar panel's portal, keyboard navigation and styling.
Hide clears the leaf in place and records it as the landing spot without stopping
its session; exited-only Close uses the
existing validated sidebar command and retains the view if that command fails.
Placement fills space, then grows a rightmost column with proportional existing
column widths, or selects the least recently focused non-attention tile when
columns would fall below 60 terminal cells. The board measures the available area
at the current terminal font size and tracks focus recency outside persisted data.
All-attention boards may grow below that minimum. All content uses this shared
placement, including previews, the manual and orchestrator children. Blank single-leaf windows start with 1–3 equal columns of
about 100 cells; arranged trees retain their geometry.
Drag origins come only from local sidebar/title-bar gestures; external drag payloads
are never interpreted. Drop-time inventory and tree lookups reject stale origins
and targets. Edge drops obey the same depth and leaf limits as ordinary splits;
refusal leaves the original tree intact. Whole-leaf swaps and moves preserve the
keyed controllers and their terminal attachments.

`terminal-view-source.ts` creates passive controllers (no process launch) through
the board source. Workspace subscriptions belong to `BoardSource.connect`, not an
individual tile. View operations share a serialized queue and a terminal ownership
map: transferring an already-visible session hides its old controller before its
new one opens it. Disposing a detached controller cannot detach another tile's
current attachment. Within each controller, switching still serializes detach,
drain, reset, fit and attach. Settings detaches views without destroying their
controllers. Hidden terminals keep consuming output in the host.

Versioned `foom.tiles.v1.<window-id>` localStorage metadata stores the tree, ratios, leaf IDs,
focus, optional landing-space ID and terminal assignments. Saves use version 2 content records; version 1 session records migrate on restore (see [Multiple windows](windows.md#multiple-windows)). Restore validates untrusted JSON with size, depth,
node-count and uniqueness bounds; finite ratios strictly between zero and one
persist unchanged (including automatically added columns); out-of-range ratios
clamp to 15–85%. Split construction
shares the restore limits of 256 leaves and 64 levels, so every constructed tree
can be restored. Missing sessions are
pruned only after the source's first inventory completes, so an asynchronous load
cannot erase valid assignments. This data grants no process capabilities. Maximize
is not persisted. All terminal IPC remains ID-scoped and main-validated.

The first board opens the bundled manual after setup, with no terminal running. Shells and agents launch from checkout panels; home shells use the home row; **New worktree** is a repository action. `pnpm run start:samples` explicitly builds the development sample board. Normal builds omit its data, and Forge rebuilds without the sample flag before packaging, including when invoked directly. New worktree is a branch field inside the repository panel (`branch-field.ts` holds its pure completion, status and ref-rule logic; `branch-field-view.tsx` the field). It reads `workspace:branches` and creates through `workspace:create-worktree` without a location, so main applies the configured one; it never launches. Whether a panel shows the field is part of the panel intent target, so it closes with its panel. Repository paths come from main’s registry or native directory picker; main chooses worktree destinations and executables.

Main's inventory watcher derives the common Git directory with `rev-parse`, validates
its canonical path, and watches metadata directories for `HEAD`, `packed-refs`,
`refs/heads` (including nested branch names) and linked `worktrees` metadata.
Directory watches survive Git's atomic file replacements. Events debounce for
300 ms with a one-second maximum wait, rebuild the directory subscriptions and
reuse `workspace:changed`. The maximum wait prevents continuous rename events
from deleted Windows directories from starving refresh. Rebuilds close old
handles before discovery to stop that event stream.
Repository removal and workspace shutdown close subscriptions and timers. Watch
errors close only the affected subscription and schedule a debounced refresh,
preserving healthy parent/sibling watches and pending rebuilds (Windows reports
an error when a watched directory is deleted). Errors alone do not retry watches.
Discovery/setup failures close the repository's subscriptions; window focus
refresh remains the fallback. Sidebar commands still re-read Git inventory and validate identity.
The live board source marks sessions whose checkout is absent or prunable without
changing their terminal state, capabilities or attachment.

The main-owned forge tracker also decorates checkout inventory with validated PR
number, title, state, generated GitHub URL and complete check counts. Renderer
components read these facts through BoardSource. The open-PR sidebar command
validates sender, repository and current checkout identity, then opens the tracker’s
URL through Electron shell; no renderer-supplied URL is accepted. Notification clicks
send a checkout focus event and never attach a terminal. Sleep/lock events pause the
tracker. Settings’ profile-only showPullRequests preference gates board polling;
orchestrator tracking remains independent. See the [batched forge contract](../contracts/forge-tracking.md#child-pr-and-required-checks-340)
for bounded queries, matching, cadence and required-check semantics.

Idle orchestrator waiting is derived in main from execution, attention and owned
child handoff-read cursors. `TerminalState.waitingOn` is board presentation metadata;
raw evaluator history and control session states retain their existing meaning.
The live source maps it to Waiting, with a neutral hourglass and count. Child
changes refresh snapshots; execution transitions invalidate old presentation, and
snapshots replace the same equal-timestamp verdict so a handoff read can clear Waiting
without a new evaluator verdict.

Unread child reminders subscribe to the shared main-owned child-event stream.
Workspace refresh also synchronizes their projection before broadcasting a snapshot;
read acknowledgements synchronize first so a queued notification cannot resurrect an
already-read event. Both bounded and blocking waits acknowledge at entry and on
return. Workspace disposal unsubscribes the reminder observer and cancels its timer.

## Idle rendering (#697)

A settled board schedules no recurring light, wait-label or sound polling work.
Activity wakes the DOM-only light controller; its 50 ms envelope clock stops once
rates and brightness reach zero and the eight-second trace has drained. A tiny
release remainder below 0.0001 becomes zero. Flat traces and unchanged brightness
are written only when their DOM value changes. Source changes and light remounts
wake the controller, including filtering and relaunches, without React activity
state. Unmount removes the source subscriptions, structure observer and clock.
Wait labels schedule only their next visible seconds/minutes boundary while a
mounted row needs input. Audio polls only while an alert or reminder is pending.
Active relationship waves, cleanup sweeps, output and blinking terminal cursors
still represent changing content; reduced-motion and native background-painting
policy remain unchanged. See [renderer rules](renderer.md) for that policy.

## Restored tile placement (#732)

[Sessions](sessions.md#restored-tile-placement-732) owns restore eligibility and
saved assignment lifecycle. The board keeps the assigned tile in place while a
session queues and relaunches. A neutral skeleton with the agent glyph and session
name covers it until the new attachment's snapshot has been parsed and its first
frame rendered. Loading ends on host or attachment failure so the existing failure
status remains available. Hiding and reshowing a session that already rendered
does not show the skeleton again. Live tiles retain their split geometry and
hidden-space rules.
