# Workspace composition

Read [Launch/composition](../../../docs/areas/agent-launch.md), [Worktrees](../../../docs/areas/worktrees.md), [Sessions](../../../docs/areas/sessions.md), [Execution](../../../docs/areas/execution.md), [Evaluator](../../../docs/areas/evaluator.md), plus the affected surface’s links in
[the file map](../../../docs/map.md), before changing this area.

- Keep workspace composition behind the public `workspace.ts` facade. The coordinator owns shared locks, queues, owner wiring and shutdown; feature methods receive narrow capabilities.
- Owners receive capabilities rather than the coordinator object.
- Direct removal validates the same Git membership and filesystem identity as confirmed removal. Force allows dirty removal but does not override locks or target validation.
