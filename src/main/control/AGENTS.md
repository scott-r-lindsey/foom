# Control plane

Read [Control foundation](../../../docs/areas/control.md), [Orchestration](../../../docs/areas/orchestration.md), [Child authority/input](../../../docs/areas/child-authority.md), [Handoffs](../../../docs/areas/handoffs.md), plus the affected surface’s links in
[the file map](../../../docs/map.md), before changing this area.

- Policy and role checks stay in the service.
- Unknown methods, role/force flags and unknown fields fail closed.
- Every request checks the live grant and app-instance ID, including after receiving its bounded body.
- Recovery never restores authority or replays actions.
