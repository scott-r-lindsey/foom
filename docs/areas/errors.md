# Errors

Decided implementation and security rules. User-visible behavior: [errors](../behavior/errors.md). Read the [file map](../map.md) for related owners.

## Coded capability errors

The window IPC router catches synchronous and asynchronous capability failures after
validating the sender; feature handlers validate payloads. Workspace IPC also
sanitizes failures when attached directly.
Only `ApplicationError` can select a code from the closed shared declaration in
`shared/application-error.d.ts`; other exceptions become `operation-failed`.
The rejection carries only `foom-error:<code>`, or
`foom-error:session-has-children:<count>` for the existing parent-close guard.
That count must be a positive safe integer in canonical decimal form; no other
code accepts details. Busy, still-running and unreachable-remote session closes
also select fixed codes. The renderer recognizes the exact
code, with at most Electron's standard invocation wrapper, and maps it to a fixed
sentence. Unknown or malformed errors get an operation-specific fixed fallback.
No runtime import was added to the sandboxed preload.

`error-presentation.tsx` owns presentation: an in-board `<dialog>` for user actions
and operation-keyed background marks. The dialog initially focuses itself, never
a fix button, and restores the previous connected focus target on dismissal.
Background publication mounts no dialog and makes no focus request. Each success
clears only its operation's mark. The trusted confirmation renderer is separate.

Pruning uses the [worktree safety contract](worktrees.md#pruning-stale-worktrees).

Update checks (#603) are deliberately quiet: their background failure appears only
as a fixed sentence in Settings → General. An explicit Restart to update capability
failure uses the normal action error dialog.

Local packages that deliberately omit the remote-host catalog use the fixed
`remote-host-unavailable` code. Main checks sealed metadata before starting SSH,
preserves only that trusted preflight reason through transport and terminal-client
failure, and renders "Remote host artifact unavailable in this local build."
Arbitrary artifact errors and host-supplied text cannot select this code.

Error dialogs expose a `Copy error text` button on the fixed sentence. The
renderer maps that sentence to a closed catalog ID; main resolves the sentence
from that catalog. Raw exception text and arbitrary renderer strings cannot be
copied. Every fixed action-dialog sentence, including local validation failures,
needs a catalog ID when introduced. Menu execution failures use the fixed `Unable to run this command.`
sentence so dynamic menu labels never become clipboard input.
