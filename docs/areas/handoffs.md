# Handoffs

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Handoffs

**Child handoffs implemented in #514.** `control/handoffs.ts` holds serialized,
bounded child reports and generation-scoped deduplication. The orchestration broker
checks the live parent and child ownership before and after asynchronous audit work;
the service also rechecks the exact launch principal. Shared Node validators serve
MCP/main and the console's bounded file/stdin reader. `read_handoff` uses existing
owned-child checks; report sequence/status participate in session revisions and
`wait_for`. Child input (#629) does not require a question revision or freshness
gate; authorization comes from the live role and exact child ownership.

Reports persist with the child session record (twenty maximum; aggregate session
storage capped at 32 MiB). The renderer receives the latest report as inert text,
while control session metadata and the private Action log omit report contents.
Link actions carry a terminal ID, report sequence and index through validated board
IPC; main reads the stored HTTPS URL, asks through the trusted dialog and rechecks
the record before opening it. No terminal input capability is involved. See
[handoff contracts and lifecycle](../contracts/control-handoffs.md#child-handoffs-514).
