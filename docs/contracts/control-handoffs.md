# Control Handoffs

## Child handoffs (#514)

A child reports before stopping when it finishes, gets blocked, or sees CI fail.
`handoff({ status, summary, links?, idempotencyKey })` uses its existing launch
credential and derives the recipient from main-owned parent/child ownership.
Ordinary agents, human CLI grants, orchestrators, taken-over children and children
whose parent is no longer active receive fixed `no_parent`. Children cannot
orchestrate or choose a recipient. Every controlled agent, including children,
receives the bundled CLI directory on its process-local PATH; neither human PATH
installation nor per-launch MCP support is required.

Main and console share the input validators: status is `done`, `blocked` or
`failed`; summary is 1–8192 UTF-8 bytes with no control characters except LF/tab;
links are at most ten HTTPS URLs of at most 2048 UTF-8 bytes each. Unknown fields
are refused. The console reads a bounded UTF-8 regular file or stdin:

```text
foom handoff --status done --summary-file FILE|- [--link HTTPS_URL]… --idempotency-key KEY
foom read-handoff ID [--seq N]
```

Both commands support `--json` and use the same control service. `no_parent` exits
3. One new report is permitted per child per ten seconds. Matching idempotent
replays return the original `{ seq, status, timestamp }`, even after history
rotation; changed input with the same key is refused. Deduplication is scoped to
the launch generation, bounded to 4096 reports per app lifetime and independent of
the twenty reports retained per child. The oldest report is dropped on the 21st.

`read_handoff` returns `seq`, `status`, `summary`, `links`, ISO timestamp,
`untrusted: true` and a fixed notice. These are child-authored data, never user
instructions. `sessions`, `session_state` and `wait_for` include only the latest
`handoff: { seq, status }`; a new sequence changes the metadata revision and wakes
a wait. Reports do not change terminal execution or attention state. Nothing is
written into any PTY. Handoffs do not send input; the parent may separately use the scoped #629
prompt/key channel. The board derives an idle parent's **Waiting on N** presentation from
owned running children without a read handoff and children with a newer unread
report (#515). Successful `read_handoff` advances that child's in-memory read
cursor monotonically; reading metadata or opening the human panel does not.
Read cursors belong to the current ownership and are not restored after restart;
retained reports start unread. No new control-plane write or execution state is added.

Take over, revoke/transfer and parent exit end access as they do for tails. A
restored parent can read retained reports only after its child ownership has been
restored. Reports persist in the child's private session record and disappear when
that row closes, including after takeover. Session storage is bounded to 32 MiB;
a failed save reports an error, retains the accepted report in memory, and a replay
flushes it again without creating a duplicate. Audit failure refuses a new report.

The row carries a small status word and glyph; only failed reports use magenta.
The panel shows the latest summary as plain text and links that ask before opening
in the external browser. Main resolves each link by child ID, sequence and index,
never a renderer-provided URL. The Action log records `Handoff #n (status)` with
actor/parent IDs and no summary or links. The launch prefix names both report
interfaces. Make orchestrator discloses that reports, like tails, may reach the
orchestrator agent's model provider; Foom itself sends neither to a network service.

### Optional review verdict (#690)

A `done` report may additionally carry `review: {verdict: "clean"}` or
`review: {verdict: "findings", findings: [{file, line, summary, scenario}]}`.
See [the bounded verdict schema](../areas/handoffs.md#review-verdicts-690).
The CLI accepts `--review JSON_VERDICT`. Unknown fields and verdicts attached to
blocked/failed reports are refused. Verdicts persist with each participant's
handoff and are returned by `read_handoff` as untrusted data. They do not change
handoff authority: ordinary parentless agents still receive `no_parent`.
