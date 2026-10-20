# Control Visibility

### Sidebar nesting and action log (#157)

The board source now supplies main-owned child relationships and read/clear access
to the private action history. Sidebar children keep their checkout identity,
independent lights and keyboard row access in their own worktrees, with a child
glyph and parent tooltip. Hovering, focusing or selecting a parent highlights its
children; hovering or focusing a child highlights its parent. Running, exited and
revoked parents retain this context; the compact rail shows each session once.
Filters retain parent context; orphans remain visible in their checkout.
An exited parent remains until its children are closed. No relationship highlight
changes xterm ownership, attachment ordering, hidden execution or activity delivery.

Action log in the app menu exposes search, action/outcome filters, pagination,
actor/parent and target/result identities, fixed reasons and hashes of child input. Pending confirmations, refusals, indeterminate delivery and human
Make/Revoke/Transfer orchestrator and Take over actions are visible. Audit intent
precedes authority changes; failure refuses that command. Serialized private
reads, writes and clearing enforce five 10 MiB files and 30 days. Clearing retains
live deduplication. Only allowlisted redacted fields leave main; raw prompts,
tails, request payloads, credentials and fingerprints are excluded. Tests cover
filters, orphan/exited/revoked context, keyboard access, storage failure and
permissions, retention/clearing, IPC payload/sender boundaries and real-app axe.
