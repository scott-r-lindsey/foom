# Control Elevation

### Elevation (#303)

Roles are no longer fixed at launch. Every agent launch gets an ordinary grant; the
session menu's **Make orchestrator…** asks through the trusted dialog, then main
replaces that grant's principal with an orchestrator principal for the same token
and generation, reserves the repository's slot and binds it to the running session.
Nothing is relaunched or re-attached. When another orchestrator is active, the same
dialog names it; accepting revokes it first and its children stay with the human.
Children that the human has not taken over cannot be elevated. **Revoke
orchestrator** swaps the principal back and retires the parent exactly as exit does:
in-flight operations end as `revoked` or `indeterminate`, confirmations close, and
the panel keeps the history. Elevating the same session again continues that
history. Automatic restore re-grants an orchestrator that was active at quit under
the [restore rules](control-identity.md#identity-and-capability-model), without a launch prompt.

MCP protocol sessions are keyed by grant generation, so they survive the swap, and
the next request sees the new role. Foom sends no tool-list notification and lists every orchestration tool to every agent from startup. Client refresh evidence: [#303](https://github.com/scott-r-lindsey/foom/issues/303).
Each orchestration tool's description begins "Orchestrator only: the human grants
this role, and whoami shows whether you hold it"; a call without the role returns
an error naming `whoami`. Server instructions and Antigravity's fallback CLI guidance
describe both roles. Codex's TUI asked to approve an MCP tool without
annotations, so the tools keep accurate `readOnlyHint` and `destructiveHint`.
