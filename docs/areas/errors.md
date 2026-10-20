# Errors

Decided implementation and security rules. User-visible behavior: [errors](../behavior/errors.md). Read the [file map](../map.md) for related owners.

## Coded capability errors

The window IPC router catches synchronous and asynchronous capability failures after
validating the sender; feature handlers validate payloads. Workspace IPC also
sanitizes failures when attached directly.
Only `ApplicationError` can select a code from the closed shared declaration in
`shared/application-error.d.ts`; other exceptions become `operation-failed`.
The rejection carries only `foom-error:<code>`. The renderer recognizes the exact
code, with at most Electron's standard invocation wrapper, and maps it to a fixed
sentence. Unknown or malformed errors get an operation-specific fixed fallback.
No runtime import was added to the sandboxed preload.

`error-presentation.tsx` owns presentation: an in-board `<dialog>` for user actions
and operation-keyed background marks. The dialog initially focuses itself, never
a fix button, and restores the previous connected focus target on dismissal.
Background publication mounts no dialog and makes no focus request. Each success
clears only its operation's mark. The trusted confirmation renderer is separate.

Pruning uses the [worktree safety contract](worktrees.md#pruning-stale-worktrees).
