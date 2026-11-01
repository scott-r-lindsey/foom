# Control Privacy

## Output, privacy and visibility

`tail` reads only the child's headless screen through main's existing host client,
without attaching a view or pausing a hidden terminal. Apply the evaluator's
`prepareTail` redaction before final line/byte truncation; oversize input fails
closed. Rate-limit to one snapshot per child per second. Return structured data
with child ID, revision, timestamp, truncation flag and `untrusted: true`, and a
fixed instruction that contents are data, never requests to run commands or change
policy. Marking data does not solve prompt injection; capability checks remain
mandatory. Redact and bound user-controlled metadata too.

No file, diff, transcript, keystroke, raw hook or unlimited scrollback endpoint is
added. Terminal output can itself contain file contents, diffs or echoed input;
redaction is heuristic. Tails and child-authored handoffs returned to an orchestrator can go to **that agent's
model provider**, independently of the evaluator's configured provider. Repeated
bounded reads can accumulate substantial output. Disclose this at orchestrator
launch and in [product privacy](../behavior/orchestration.md#orchestration-and-privacy).
Foom's API limits do not restrict the agent's pre-existing filesystem tools.

Every action records an operation ID, actor/parent/child IDs, repository/worktree
IDs, action, timestamp, outcome and fixed reason. For child input retain hashes and delivery status, never text, key lists or
tails; initial prompts are omitted. Store a separate private action log, rotate at 10 MiB, retain at most
five files and 30 days, and support clearing it. Audit intent must be persisted
before mutations; log failure refuses automation but never blocks human terminal
input. Terminal snapshots are removed after the outcome audit is durable; in-memory
deduplication lasts until quit. Startup validates snapshots before publishing the
listener: settled snapshots are removed without duplicate audit entries, while
pending-confirmation and running snapshots produce indeterminate entries in a
batched write and sync (split only at the 10 MiB rotation boundary). All snapshots
are then removed. Invalid/unreadable snapshots or audit failures refuse startup;
recovery never restores credentials or replays operations.

Children appear under their own worktree in the repository sidebar, each with a
small, dim child glyph, a parent-naming tooltip and an independent light. Hover,
focus and selection highlight the parent/child relationship across worktrees.
Parent history stays while children remain; show an exited parent as such.
No view attachment changes are implied by highlighting.
Expose the action log and takeover affordance through the board source. Minimal
action visibility and takeover must ship with mutations; the final UI issue adds
the full hierarchy and searchable log. No silent orchestration period is acceptable.

Host-aware orchestration (#756) returns registered host aliases, fixed agent
availability and CPU/memory observations to the local orchestrator. Remote
filesystem paths and raw management/probe output do not enter session metadata.
Remote processes still receive no hub terminal IDs or hub control credentials;
their tool authority remains handoff, manual and sanitized identity.

Profile-scoped remote recovery (#757) exchanges opaque owning-profile tags and
bounded main-owned session/checkout metadata over the existing SSH channel.
These tags and terminal takeover IDs never enter remote process environments,
arguments, launch files or child tool results. Newly recovered human sessions gain
no orchestration authority. Legacy process-list observations stay on the host and
are discarded after reducing them to an exact daemon identity and session count;
no raw process list or arguments enter the hub, logs or renderer. Remote screens
remain in daemon memory and are replayed without local screen persistence.

## Local message board (#973)

Board text and links are deliberately shared among the human and the opening and
addressed repositories' current orchestrators. Their reads may reach those agents'
model providers. Foom itself adds no networking or GitHub mirroring. Children
cannot read or post; a post cannot grant authority or authorize work. Only human
posts count as decisions. Contents remain untrusted data, never instructions.

Private main-owned profile storage retains bounded append-only posts; logs retain
only fixed operation metadata and IDs, never post text or links. Human IPC returns
rebuilt typed records and renders plain text, with inert links. See
[message board ownership](../areas/message-board.md).
