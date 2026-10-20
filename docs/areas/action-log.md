# Action Log

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Action Log

**Sidebar nesting and action log implemented in #157.** The board source exposes
main-owned relationships and the private audit API. Children retain their own checkout rows, independent lights and keyboard access with a child glyph and parent tooltip. Hovering, focusing or selecting a parent highlights its children; hovering or focusing a child highlights its parent. Filtering preserves parent context; orphans retain their checkout with an unavailable-parent label.
Exited and revoked parents stay visible, and an exited parent cannot be closed
until its child rows are closed. Takeover remains explicit and ends API authority.
The compact rail shows each session once in a flat list. Reveal expands the selected child’s own checkout. Nesting does not attach a view or change terminal
execution or activity subscriptions.

The app menu's Action log opens a searchable, paginated view of actor/parent,
repository/worktree, operation and target/result IDs, action, outcome, fixed reason,
and hashed child input. Reads and clears are board-only validated IPC routes;
components use the source interface. The log refreshes on main's audit notifications.
Only allowlisted redacted metadata crosses IPC. Initial prompts, raw request payloads,
terminal tails, credentials and deduplication fingerprints never enter the audit UI.
Refused API operations and human Make/Revoke/Transfer orchestrator and Take over
commands are logged; authority changes wait for persisted intent. Clearing the
serialized audit history preserves live deduplication records. Private history is
bounded to five 10 MiB files and 30 days, with pruning on reads and writes. Recovery
records indeterminate outcomes for unfinished operations without replaying them.
Read, storage and clearing failures remain visible without blocking human input.
