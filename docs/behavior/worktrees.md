# Worktrees

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

### Delete merged worktrees

The repository menu offers **Delete merged worktrees…** below Remove repository
when at least one linked worktree is eligible, regardless of which tool created it. Foom fetches the remote
(`origin`, or the sole remote) and resolves its advertised default branch. A
branch is merged when `git merge-tree --write-tree <default> <branch>` produces
the default branch's tree: merging it would change nothing. This works for merge,
squash and rebase merges without GitHub access. Alternatively, a same-repository
PR reported MERGED qualifies only when its reported head exactly matches the local
worktree HEAD and its validated merge commit is locally verified as an ancestor of
the fetched default with `git merge-base --is-ancestor`. Forge data is only a hint;
missing or malformed evidence never qualifies. This also recognizes squash and
rebase merges after the default branch changes the same lines. A failed fetch refuses cleanup;
Foom never falls back to a stale default branch. Local inventory returns immediately;
background cleanup eligibility is cached for up to one minute and published when
ready. A plan less than one minute old fills the dialog immediately without fetching.
An older plan opens the dialog immediately in a checking state with Delete disabled.
Approving Delete always fetches afresh.

The trusted dialog lists candidate branches, then skipped checkouts with short
reasons, and offers **Delete** and **Cancel**. During cleanup it becomes a live
checklist with a count, progress bar, **Stop** and **Hide**. Stop finishes the
in-flight removals and starts no more; Hide and Escape close only the window.
There is one run per repository, and the repository panel reopens its checklist.
Finished runs offer **Done**. The sidebar shows the same count and queued, removing,
removed, kept or error tags; a completion status reports the result when hidden.
Removing uses the highlight, errors use failure ink, and reduced motion disables
sweep and fold animations. Main checkouts, locked,
prunable or detached worktrees, running sessions, dirty/untracked files and
exited resumable Claude/Codex/Antigravity conversations are retained. After confirmation,
Foom fetches again, revalidates each candidate before and after stopping its
exited terminal resources, then uses the existing safe removal path with at most
four candidates in flight. The sidebar refreshes after every candidate. Changed
worktrees are skipped and reported while others continue. The local branch is
also removed only if it still points to the exact checked commit. Branch deletions
share one checked-ref transaction after removals. Moved or checked-out branches
are kept and reported; a concurrent ref race aborts the transaction safely.

Worktree rows show a matched GitHub PR as **#N** or GitLab MR as **!N** and a check glyph with a status
label in its accessible name and its plain-text title in the tooltip. Running checks are neutral, passed checks
green, failed checks magenta; merged/closed PRs are muted without a check mark.
Click the number to open the PR in the default browser. The checkout panel shows
its plain-text title, state and passed/failed/running counts, plus the relevant
conclusion labelled Required checks, Head pipeline or Commit status. Optional bad
or unavailable title/URL data leaves the PR and check status intact; a missing URL
disables the number's link. Forks and the default
branch never match, and ambiguous matches remain absent.

When observed checks finish, Foom raises a desktop notification with the PR number
and failure count. A pass notifies only if no agent in that checkout is working.
Clicking focuses the checkout in the sidebar. The existing Sound alert switch and
mute preference suppress these notifications; notifications are silent. Missing or
logged-out `gh` or `glab`, unknown remotes and unavailable results show no board error.

### New worktree

**New worktree** in a repository panel puts an empty branch field beside it, over the
panel's facts; the panel stays open. Right Arrow on the item also opens it. Command+T or
Ctrl+Shift+T and the app menu open the focused tile's repository panel with the field
focused, else the top repository in the sidebar; with no repositories they add one.
Spaces become `-`, and the field has no placeholder or helper copy. A ghost completion
follows the cursor and Tab accepts it; Up and Down cycle candidates: the repository's own
prefixes (`codex/`, `docs/`…), most used first (only when it has none, `feat/ fix/ chore/
docs/ refactor/ test/ ci/`), then branches starting with the text, then branches
containing it, shown right-aligned. One status line says what Enter does with exactly
what is typed: `new, from <head>`, `existing` (a local branch not checked out), `from
origin` (only on the remote), `open in <worktree>` (already checked out), or the Git ref
rule the name breaks, in the failure color with a matching border. Main validates again.
Enter does nothing for an invalid name or a bare prefix. Esc, or Left Arrow on an empty
field, returns to New worktree; Esc again closes the panel.

Enter disables the field and shows `Creating from <head>…` or `Checking out…`; a failure
shows Git's message there and re-enables the field. Creating starts nothing: the panel
closes and focus moves to the new worktree's row, whose own panel offers the launchers.
A branch already checked out creates nothing; its row arrives instead. A branch only on
the repository's remote (origin, or its only remote) is checked out tracking it; other new
branches start from the repository's HEAD. Branch data comes from refs already present;
opening the field never fetches. The arriving row grows into its slot, a highlight sweeps
across it once and it flares twice in the accent (never amber: nothing needs you yet),
then keeps a tint and accent edge until hovered or focus leaves it. With reduced motion
it shows the tint and edge without animating. The arrival is view state: it does not
survive a reload or appear in other windows.
