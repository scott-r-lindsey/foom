# Orchestration

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Orchestration and privacy

Foom-launched agents can open Markdown and HTML previews from their own worktree
through MCP or the console. Previews never take focus, and you can close any of
them. The opener’s session panel and the local action log list “Opened preview
<path>”, including sidebar-only opens and reopens after a human close. These
records contain attribution and paths, never page contents. Preview pages have
no Foom bridge and network access is blocked by default. Agent ownership ends
on exit, revocation or takeover; the preview remains under human control.

The [control-plane design](../orchestration.md) has an authentication and HTTP
foundation, read-only MCP tools, a packaged console CLI and repository
orchestrators. Ordinary agent launches receive a private credential for their own
identity, with no process or file mutation capabilities. Claude Code 2.1.293+ and Codex 0.161.0+ stable releases with their per-launch MCP
help flag receive MCP access to read-only session metadata and scoped preview view actions in their own repository,
independently of hooks. These tested releases are the version floors. Older or
unparseable versions, missing flags and Antigravity do not attach MCP; managed client policy may deny attachment. These tools
never return terminal output. **Make orchestrator…** in a running Claude Code, Codex or
Antigravity session's menu grants that session permission to create worktrees and run up to
the concurrent child limit set in Settings → General (default 4, integer 1–16),
without restarting it; **Revoke orchestrator** takes it back.
One session per repository holds the role: making another the orchestrator asks once and
revokes the first. The session keeps its own launch flags, including bypass. Every
agent sees the existing orchestration tools from launch, refused until you grant the role; tell
the agent when you do.
Children cannot orchestrate through Foom and never inherit your launch flags. The orchestrator's panel lists its
actions and their outcomes. Each attached session panel shows MCP Connecting…,
Connected after the first successful authenticated request, or Not connected after
30 seconds. Only the orchestrator uses magenta for this failure; ordinary sessions
record it without alerting. A later request clears the failure. Settings → Agents
shows MCP available or unavailable from the version and capability gate.
You can stop a child or take it over, which ends the orchestrator's access to it. Agents launched outside Foom receive no automatic
access. Agent configuration is attached per launch, never installed globally or
written into the repository. With MCP attached, Claude Code pre-approves every tool
on Foom’s own random per-launch server, merging your default allow rules. This
covers previews, session metadata, child handoffs and orchestration; other MCP
servers and non-Foom tools receive no added grant. Managed policy and deny rules
still win. Orchestration calls are refused server-side until you grant the role.
`remove_worktree` still needs human confirmation in Foom; the existing
explicit Auto-remove merged worktrees setting remains the removal exception.
The grant applies only to that launch and never edits global agent configuration.

The packaged `foom` console can inspect session metadata and, for sessions you
made orchestrator, create worktrees, launch, prompt, send keys to and stop children, request worktree
removal, and read bounded tails or handoffs, or wait for child state. Every agent and child gets
the CLI on its process-local PATH, including when MCP is unavailable. Antigravity
orchestrates through the CLI alone. Agents launched by Foom
use only their inherited repository scope. Humans and scripts request pairing with
`--repository PATH`: compare the code in the CLI and Foom's trusted dialog, then
grant read-only access for ten minutes. Pairing expires after 60 seconds and never
grants terminal output, typing or mutation access. Credentials remain in memory.
Optional `--install-cli` / `--uninstall-cli` commands manage only Foom-owned PATH
setup; absolute-path use needs no installation. See [console usage](../contracts/console.md#console-helper-and-local-pairing-154).

Children can report `done`, `blocked` or `failed` with the child-only `handoff`
MCP tool or `foom handoff --status STATUS --summary-file FILE|- --idempotency-key KEY`.
The launch prompt asks them to report before stopping, including after CI fails.
The optional links are HTTPS URLs. Each summary is bounded to 8 KiB; at most ten
links and twenty reports per child are retained. New reports are limited to one
per ten seconds; replaying the same request returns its original result.

If a child handoff, exit or idle turn without a handoff, required-check change,
or PR merge or close goes unread for five minutes, the orchestrator shows Needs
you in its sidebar row and tile, with the steady halo and fixed reason **Child
report unread**. Settings → General offers **Unread child reminder (minutes; 0
turns off)**, an integer from 0–1440 (default 5). The oldest pending event starts
the timer; later events do not postpone it. A successful `read_handoff` or `session_state`
for that child acknowledges its pending events. A validated child-specific
`wait_for` acknowledges existing events when it starts and events it returns. Listing sessions,
reading terminal output and other agents' reads do not. Focusing the orchestrator
acknowledges all its pending child events without changing evaluator attention.
The orchestrator's own Needs you (a permission prompt or a question) keeps its
reason and verdict; the reminder only raises an otherwise quiet orchestrator.
Takeover, close, parent exit or revocation ends the reminder for those children.
Reminders are transient and restart with new observations after an app restart.

The parent pulls a report with `read_handoff` or `foom read-handoff ID [--seq N]`.
That MCP tool is listed only to orchestrators; the CLI remains available after
elevation when a client has cached its original tool list. `wait_for` wakes on a
new report and returns only its sequence and status. Foom never types reports
into a terminal, changes the child's light based on a report, or treats reports as
instructions. Take over, revoke/transfer and parent exit end access. Reports
persist with the child until its row closes; restored ownership restores access.

The child row shows a status word and glyph. Its panel shows the latest summary as
plain text and links that ask before opening in your browser. Only failed reports
use magenta. The Action log records “Handoff #n (status)” and actor/parent IDs,
without summary text or links. Child-authored summaries and links may be sent to
the orchestrator's model provider, just like terminal tails; the Make orchestrator
disclosure names both. Foom itself sends neither to a network service.

An orchestrator can request at most the last 40 lines of each child's terminal,
with likely secrets redacted and each response capped at 16 KiB. These results may
be sent to the orchestrator agent's model provider, under that agent's own provider settings. Repeated reads can collect more output over time. Foom does
not read files, diffs, transcripts or keystrokes for this API; a terminal may print
file contents, diffs or echoed input, and redaction cannot catch every secret.
The Make orchestrator dialog discloses this data path. The agent's own tools and provider
settings continue to govern its other data access.

Forge manifests now drive production tracking, adoption and merged-PR hints. The
bundled GitHub manifest preserves current PR/check behavior and adaptive polling;
config copies use the same engine. Only enabled, explicitly assigned hosts are
queried. Manifest minima can slow regular polls, while discovery binding keeps its
one-second follow-up. Optional separate display reads cannot change verified PR/check status.
Session metadata includes the validated checks meaning, persisted with observations.

The disclosure reads: “Foom uses your selected forge CLI and its existing login to
read PR or merge request and CI metadata. It sends repository/project, branch and
PR/MR identifiers in read-only status requests. Foom does not send terminal content,
store forge tokens, change CLI login/configuration, or write to the forge.”

Foom also reads PR and check status for board checkouts and orchestrator-owned child
worktrees through a main-owned forge provider. GitHub is supported through your
own `gh` CLI and existing login; Foom stores no tokens, makes no forge writes and
sends no terminal content. The CLI contacts GitHub with repository and branch/PR
identifiers to read PR and CI metadata. Unknown remotes and missing, logged-out or
unavailable CLIs leave these fields absent. Validated PR number, head SHA, state
and required-check conclusion appear in session metadata, and `wait_for` wakes on
conclusion changes. Orchestrators can also run `foom wait-for --until-event` as
a background command: it blocks until an owned child's state, handoff, PR state or
required checks change (not on terminal output), then returns metadata. An optional `--timeout SECONDS` exits 5
on timeout; role revocation returns an error. No terminal content is returned.
The mapping survives restart and a new orchestrator generation,
without transferring authority over old children. Reads recur every 20 seconds while checks run, two minutes when
settled, or ten minutes with no matching PRs; failures back off up to ten minutes.
Polling pauses during sleep and screen lock, rechecks on agent idle/exit, and stops
on shutdown.
See [the data, persistence and polling contract](../contracts/forge-tracking.md#child-pr-and-required-checks-340).

A granted orchestrator can send text plus submit (`prompt`) and validated logical
keys (`send_keys`) to its own children without per-message human approval, including
permission, credential and provider prompts. Input is available while idle, done
(after a handoff) or working; an exited process cannot receive it. Only its own
non-taken-over children in its repository are eligible. Take over, revocation and
parent exit end this access. Text is bounded to 16 KiB UTF-8 and keys to 64 per
send; every key is validated before any bytes are written. Prompt submission
honors the child's bracketed paste mode. The previous reviewed `reply` flow is
replaced. These capabilities do not isolate processes running as the same OS user.
Worktree removal asks you and rechecks its
identity and changed files. Several pending removals from the same orchestrator
share one trusted dialog with each worktree path, branch, clean/dirty state and
changed files, plus PR number and OPEN/CLOSED/MERGED state when already available
from forge tracking. Approve all, approve a selected subset, or Decline; unselected
items are declined. Dirty approvals explicitly say Discard changes and remove.
Each approved removal rechecks independently; a recheck failure preserves that worktree
and does not stop the others. A single pending removal keeps its ordinary dialog.
Settings → General offers **Auto-remove merged worktrees**, allowing an orchestrator to auto-remove its own clean, fully merged
worktrees with no running sessions across all repositories. In addition to the
existing ancestry and no-unpushed-commits check, the same locally verified PR rule
above qualifies squash and rebase merges. Both paths require a clean worktree and
are rescanned and rechecked immediately before deletion; this option is off by default. The app menu’s
**Action log** opens searchable local history with actor/parent,
repository/worktree, action, target/result IDs, outcomes and hashes of child input, never its text.
Search and Action/Outcome filters apply to retained history, with 100 events per page.
Pending confirmation, refused operations and indeterminate delivery are explicit.
**Clear history…** asks for a second click and preserves live operation deduplication.
History stays private and is retained for 30 days in at most five 10 MiB files.
Children appear under their own checkout with a small, dim child glyph and an
independent light. Their tooltip names the parent orchestrator. Hovering, focusing
or selecting a parent highlights its children across checkouts; hovering or
focusing a child highlights its parent. Exited and revoked parents retain their context; close child rows before
closing an exited parent. Children with an unavailable parent remain in their own
checkout. Take over is shown on the child’s panel.
A local action log records who acted, targets and
outcomes and hashes of child input; it omits terminal tails, credentials and
initial prompts. It retains at most 30 days and five 10 MiB files and can be cleared.

### Child board placement and close (#377)

Settings → General offers **Show new children on the board**, on by default
(`showNewChildren` in the Foom config folder). When off, new child launches send no
placement event: children appear only under their checkout in the sidebar, with
the child glyph, attention halo and reason, and remain included in attention counts.
Opening a child from the sidebar places it like any human open. Changing the
setting leaves existing tiles and restored children alone.

With the setting on, a newly orchestrator-launched child fills the board's landing spot, then an empty
space, otherwise follows sidebar placement (add a column or replace the least
recently focused non-attention tile). Placement targets the parent's board window,
or the current board if the parent is hidden, without focusing the window, tile
or terminal input. The current tile is never replaced by a background arrival;
when it is the only candidate, placement splits instead. Existing layout limits
still apply. Restored children keep their saved placement and are not placed again.

An orchestrator can `close` its own exited child with `id` and `idempotencyKey`
(`foom close ID --idempotency-key KEY`). It uses the normal exited-session close
path, removing the tile and sidebar row and leaving an empty landing space.
Closing discards the final screen; nothing is retained. Tail first if output is
needed. The worktree, branch and review state remain; worktree removal is separate.
Running and stopping children return `conflict`, taken-over children `forbidden`,
and other orchestrators' children or unknown IDs `not_found`. Close is recorded in
the action log and supports the same operations and idempotency as other mutations.

## Optional build/review loop (#690)

An orchestrator can opt a child into a Foom-run review loop when launching it.
The default is off. Opting in uses three review rounds (at most five) and Claude
as reviewer; an installed reviewer provider with resume support can be selected.
The human New-worktree flow has no review option. Ask the orchestrator to launch
a child when a loop is wanted.

The author hands off after its PR's required checks are green. Foom validates the
report, stops the author, and waits for exit before launching a reviewer in that
checkout. After a valid verdict Foom stops the reviewer and resumes the author's
conversation with quoted findings when fixes are needed. Only one step runs in a
checkout at a time.
Reviewers consume the orchestrator's existing child slots and wait if full.
New reviewer placement follows Show new children on the board; author resumes
keep their existing tile. Neither step takes keyboard focus.
The sidebar and tile show Building, Reviewing 2/3, Fixing 2/3, Review clean, or
Escalated with a fixed reason. Loop reviewers use a receiving robot with a lens,
named Reviewer, in sidebar rows and tile headers. Authors and children launched
without a loop keep the ordinary receiving mark. Every participant's handoffs remain available to
the orchestrator. Clean also raises attention: the orchestrator verifies the
result and remains the final merge gate.

A blocked author shows **Waiting on parent** until its own orchestrator sends a
`prompt`. That explicit reply resumes Building or Fixing, and the next done report
and exit proceed to review. Waiting does not spend a round. The launch option
`review.parentWaitMinutes` (console: `--review-parent-wait-minutes`) bounds the wait
to 1–1440 minutes, default three hours. Expiry escalates as Author blocked. Human
terminal input and `send_keys` do not resume the loop. The author must keep its
process running to receive the parent's prompt.

Failed author reports, blocked/failed reviewer reports, non-green or unknown checks, missing reports, reviewer
edits, the round cap and launch/resume failures stop the loop and escalate.
Stopping or taking over a participant, or stopping/revoking its orchestrator,
ends automation. After restart, saved participants stay dormant with
Escalated: restored; no review step starts silently.

Post findings to GitHub is optional and off by default. When enabled, the reviewer
is told to post its verdict and findings as a PR review comment using its own
`gh` login. Foom itself makes no forge writes and stores no tokens. Review notes
are untrusted data; Foom only quotes bounded structured findings inside its fixed
resume brief. It never types loop prompts into a running terminal.

Settings → General **Close finished agents** is on by default. Exited reviewers
close after their verdict is accepted. Exited authors and other children close
when their PR is merged or closed, once an author's review loop is clean or ended.
A session that needs you, has unread attention, or was taken over stays open.
Children without a PR stay open unless they are accepted reviewers. Closing
removes the tile and sidebar row and discards the final screen; the worktree,
branch and author's review state remain. Turn the setting off to retain them.
