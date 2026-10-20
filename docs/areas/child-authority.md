# Child Authority

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Child Authority

Main owns one control service over the workspace, agent, evaluator and terminal-host
services. A loopback Streamable HTTP MCP adapter and a versioned HTTP CLI adapter
call it; neither adapter owns policy. A separate console executable built from
TypeScript provides `foom`, without enabling Electron's RunAsNode fuse or requiring
system Node. Per-launch Claude MCP config and Codex `-c` overrides attach the server;
Antigravity receives CLI guidance and a process-local PATH addition until per-launch
MCP support is verified. No global agent or repository configuration is written.

A separate 256-bit control token shares the hook launch's lifecycle but never its
secret or authority. Main stores a digest mapped to role, canonical repository,
terminal, parent and generation. Caller-supplied roles and MCP session IDs grant
nothing. Authenticate initialization and every subsequent request, bind protocol
sessions to grant generations, validate every payload and target at runtime, and recheck
revocation before effects. Reject browser origins and unexpected Host values; bind
only `127.0.0.1` on an ephemeral port. Never expose tokens through renderer IPC,
logs, argv or tool results. Child launches scrub inherited credentials and receive
fresh read-only tokens. Exit, failed launch and shutdown revoke grants.

Ordinary agents can use `sessions`, `session_state` and `whoami` for their
repository, without terminal contents. Only a main-granted orchestrator principal
can use `create_worktree`, `launch`, `tail`, `prompt`, `send_keys`, `stop`, `remove_worktree`,
`wait_for` and `operation_status`; listing a tool grants nothing.
Enforce authorization in the service for every call. Making a session the
orchestrator reserves one slot per repository atomically; reserve child slots up to the current General setting
(default 4, integer 1–16), including starting/stopping children. Lowering the setting
never stops existing children; it blocks new launches until below the limit.
`wait_for` accepts up to the current configured limit of IDs. Children run only in new worktrees created by
that orchestrator. No child can gain orchestration through the API. #84 config-only
roles and #67 remote access are separate capabilities, not implicit extensions.

Existing main-owned git validation, argument-array execution, launch/removal locks
and confirmations are reused. Removal asks the human unless the profile opts this
repository into the [strict merged-clean policy](../contracts/control-mutations.md#orchestrators-and-children-155);
no API force flag bypasses identity or dirty-state checks. Mutations use
idempotency keys and bounded operation records. MCP `operation_status` and CLI
`foom operation-status` query by operation ID or idempotency key within the same
actor generation and repository, including when the original response was lost.
Records distinguish pending confirmation, running, succeeded, failed, declined,
cancelled and indeterminate outcomes; lookup never replays a mutation. Retain
records and deduplication mappings for the grant's lifetime, refusing new mutations
at the storage limit. Parent exit cancels pending actions
but leaves children visible and running for human control. A replacement parent
does not inherit them. Metadata-only MCP `wait_for` is bounded to 30 seconds.
The CLI's `wait-for --until-event` form uses the same ownership checks and waits
without a transport deadline. It compares an `event` cursor over state, handoff
and PR/check facts rather than the session revision, which also moves with output.
`Orchestration.childEvents` is a shared, main-only invalidation stream reusable by
other child-event consumers; workspace execution, state, output/input, forge and
orchestration lifecycle changes publish coalesced notifications. Consumers compare
their own metadata cursors, so unrelated notifications do not end waits. Raw output
does not publish; output only reaches waiters through evaluated state changes. Each waiter holds
one subscription and a disconnect listener, with one shared optional deadline
scheduler across all subscribers. Disconnect, revocation and shutdown release
subscriptions; role changes recheck the exact principal and return an error.
CLI access
outside Foom-launched agents requires explicit, expiring in-app pairing; private
discovery files contain endpoint metadata, never a reusable human credential.
Same-OS-user processes are not isolated by these bearer capabilities or worktrees.

Agent output, hooks and names are untrusted data. `tail` authorizes
only an orchestrator's children, reads the host screen, applies evaluator redaction,
and returns at most 40 lines and 16 KiB with revision and untrusted-data metadata.
No files, diffs, transcripts, keystrokes or raw hook payloads are read for the API.
Printed content may include them; the product privacy wording describes the new
path to the orchestrator's model provider and redaction's limits.

Child input (#629) is authorized by the current orchestrator role, live principal
and generation, repository and exact child ownership. Unknown, foreign and taken-over
IDs return the same not_found result. Recheck authority after durable intent and
immediately before delivery. Exited or starting processes return conflict; idle,
done, working and attention states all permit input, including permission,
credential and provider prompts. No question-specific atomic routing guarantee is
required: the orchestrator is authorized to answer those prompts.

`prompt` accepts up to 16 KiB UTF-8 text, rejecting control characters except newline
and tab; `send_keys` validates all 1–64 logical keys against a fixed allowlist before
any bytes are written. Main uses the existing workspace input/reply path, carrying
a typed logical payload through the main-only `childInput` terminal capability
and host client. Config probes retain their separate credential-scoped broker
and raw input capability; orchestrator input rejects config sessions and probes
even if an ownership record were to name one. Both main and
the utility host validate IDs and payloads. The host uses its headless xterm's
bracketed-paste mode to wrap prompt text and appends one submit, or encodes the
validated keys in order, then uses the existing terminal write path. No renderer
attachment is required. Persist only hashed input in the orchestration audit;
never text or keys. Ambiguous delivery is indeterminate, never automatically retried.
Takeover, revocation and parent exit end access. Agent launch policies and worktree
removal confirmation are unchanged.

A separate bounded private action log records actor, target, operation and outcome,
with hashes of child input but no input text, tails, credentials or initial prompts. Persist
intent before automated mutations; audit failure refuses automation while human
terminal control remains available. Ship basic action visibility and takeover with
mutations, then nest children under their orchestrator in the board source and add
the full log view. Components retain view state only; hidden PTYs keep running.
