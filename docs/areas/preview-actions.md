# Preview Actions

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Preview Actions

### Agent preview view actions (#297)

View actions change only Foom's presentation and need no trusted confirmation.
`open_preview`, `list_previews` and `close_preview` are listed and granted to
ordinary agents and orchestrators, never paired `cli` principals, through both
MCP and `/control/v1`. Main's instance-wide broker resolves documents in the
principal's launch-bound worktree using the contained-file protocol. Only Markdown
and HTML documents are allowed; unknown fields and caller-supplied roots are refused.

Ownership follows the grant generation. Canonical-path reuse returns `existing`
and leaves a tiled preview in place; an existing sidebar preview is placed on the
board unless that canonical path was human-dismissed. Exit, takeover and orchestrator revocation hand existing
previews to the human; worktree removal closes them. Opening fills the landing
spot, then the first empty tile in tree order. On a full board it reuses terminal
`placeContent` placement: add a far-right column with proportional shrinkage, or
use the minimum-width replacement fallback, excluding the focused tile. Keyboard
focus and the focused tile stay unchanged. Placement reports `column` or `replace`
for overflow; layout resource limits and unavailable boards can still return `sidebar`.
Sidebar entries create no view until shown; they do not restore after quitting.
[Renderer rules](renderer.md) govern agent attribution and arrival visibility.

Limits refuse with `capacity`, never evict: four per agent, twelve per instance,
and six opens in a burst with one token refilled every ten seconds (reuse costs
one). A human close makes future opens of that canonical path sidebar-only for
that generation. Fixed session/action/preview/relative-path/outcome audit metadata
is written before creation or closure; storage failure refuses the action. Grants
are rechecked after asynchronous work. View actions have no operation record or
idempotency key; recover a lost result with `list_previews` or canonical-path reuse.
