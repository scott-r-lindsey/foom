# Control Placement

### Child board placement and close (#377)

A newly orchestrator-launched child fills the board's landing spot, then an empty
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
