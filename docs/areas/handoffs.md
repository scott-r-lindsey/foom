# Handoffs

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Handoffs

**Child handoffs implemented in #514.** `control/handoffs.ts` holds serialized,
bounded child reports and generation-scoped deduplication. The orchestration broker
checks the live parent and child ownership before and after asynchronous audit work;
the service also rechecks the exact launch principal. Shared browser-safe validators serve
MCP/main and the console's bounded file/stdin reader. `read_handoff` uses existing
owned-child checks; report sequence/status participate in session revisions and
`wait_for`. Child input (#629) does not require a question revision or freshness
gate; authorization comes from the live role and exact child ownership.

Reports persist with the child session record (twenty maximum; aggregate session
storage capped at 32 MiB). The renderer receives the latest report as inert text,
while the private Action log omits report contents. Control metadata omits
report text except `review.lastVerdict` for the live owning orchestrator (#972);
ordinary agents, human CLI grants and taken-over children’s metadata omit it.
Link actions carry a terminal ID, report sequence and index through validated board
IPC; main reads the stored HTTPS URL, asks through the trusted dialog and rechecks
the record before opening it. No terminal input capability is involved. See
[handoff contracts and lifecycle](../contracts/control-handoffs.md#child-handoffs-514).

## Review verdicts (#690)

A `done` handoff may include `review: {verdict: "clean"}` or
`review: {verdict: "findings", findings: [{file, line, summary, scenario}]}`.
Main validates exact fields, 1–10 findings and an 8192-byte aggregate verdict.
File paths are relative with no parent traversal; lines are positive safe integers.
File, summary and failure scenario are limited to 512, 1024 and 2048 UTF-8 bytes,
respectively, with no control or formatting characters. Verdicts are untrusted
child-authored data. They confer no authority and persist with the handoff.
The console accepts the same object through `handoff --review JSON_VERDICT`.

The #690 loop is scoped to orchestrator-owned children. The human New-worktree
flow has no review option; parentless agents
continue to receive `no_parent` for handoffs.
