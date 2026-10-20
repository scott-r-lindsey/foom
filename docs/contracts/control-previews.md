# Control Previews

### Agent previews (#297)

Every Foom-launched agent, including an orchestrator, can show Markdown or HTML
files from its own launch-bound worktree. These tools are listed from startup,
including across #303 role changes, and callable by both agent roles. Paired human
CLI grants cannot use them. They never take focus or need a trusted dialog.

| Tool | Parameters | Result |
|---|---|---|
| `open_preview` | `path` (≤1024 UTF-8 bytes; relative, or absolute inside own worktree) | `{ previewId, path, kind, placement, reused }` |
| `list_previews` | none | `{ previews: [{ previewId, path, kind, visible }] }`, owned generation only |
| `close_preview` | `previewId` | `{ previewId, closed: true }`; foreign and unknown IDs both `not_found` |

Console equivalents are `foom open-preview PATH [--json]`, `foom previews
[--json]`, and `foom close-preview PREVIEW_ID [--json]`, with existing exit codes
(0 success, 2 schema/usage, 3 authentication/scope, 4 capacity/not found/unavailable).
Antigravity's process-local guidance names `open-preview`. Server instructions
name `open_preview` so clients can discover the view action.

No idempotency key is needed. Canonical-path reuse returns the same ID. A tiled preview stays in place; an existing sidebar preview is placed unless human-dismissed. New opens fill the landing spot, then empty space, then use far-right column growth or minimum-width replacement while preserving the focused tile and keyboard focus. Capacity/board limits can leave a preview in the sidebar. See [preview actions](../areas/preview-actions.md#agent-preview-view-actions-297). Limits are four previews per agent, twelve per
instance, and six opens in a burst then one every ten seconds, including reuse.
Human close is sticky for that generation/path. Exit, takeover and revocation
return ownership to the human; later grants inherit nothing. Worktree removal
closes previews. Fixed audit metadata precedes results; audit failure refuses.
`list_previews` is read-only; open/close change presentation. All three have
non-destructive, idempotent and closed-world MCP annotations.
