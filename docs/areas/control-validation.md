# Control Validation

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners.

## Control validation gates

Before enabling attachment: synthetic HTTP initialize/tools-list/tool-call tests
for Claude and Codex, bearer header validation, existing user MCP coexistence,
managed-policy refusal, disabled hooks, token revocation and no config writes.
Before enabling mutations: cross-role/foreign-ID denial, simultaneous launch and
removal races, idempotency, parent exit, log failure and human confirmations. Test
operation lookup through MCP and CLI after a lost mutation response, by both ID
and idempotency key; cover pending, successful, failed and declined removal,
cancellation, indeterminate outcomes, foreign actors, revocation and record limits.
Before enabling child input: idle/working/permission fixtures, bracketed paste,
invalid payloads before any write, duplicate delivery, takeover, revocation and
audit failure. Before shipping the CLI:
packaged Linux, macOS and Windows console tests with no system Node, stale discovery,
wrong file ownership, pairing expiry and PATH installation/uninstallation.
