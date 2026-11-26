# Dispatcher (#1300)

General → Source directory accepts an existing local directory. Main commits the
canonical path under the profile settings lock. New local agents launched from
the source directory's sidebar menu start as plain sessions with the manual and
identity tools. The sidebar shows source paths on one line, with an ellipsis
when needed and the full path on hover. Existing sessions keep their launch
directory.

A source-session row offers **Elevate to dispatcher…**. The trusted dialog opens
in the requesting board window with the same layered glyph as the dispatcher's
sidebar row. It lists direct Git repositories. Select the repositories to
pre-approve. Each selected repository's running orchestrators
become addressable by the dispatcher. Their current repository authority and
child ownership carry forward. One source directory has one active dispatcher.
**Demote** releases that role while its orchestrators continue running.

Main verifies the canonical source and Git checkout identities before elevation,
on launch admission and before spawn. Repository selectors are direct directory
names. Hidden folders, nested paths, absolute paths, links and non-repositories
fail validation. The private control profile stores approval and adoption
identities. A verified same-session restart restores that scope using the provider
capabilities selected for the source launch. A concurrent refresh of the agent
report does not affect that check. Pending launches need a new request after
restart.

The dispatcher's role allows repository inventory and control of its adopted or
launched orchestrators. The UI keeps an ordinary terminal tile and displays the
dispatcher's orchestrator and repository counts on its sidebar row. Its pill
counts its own pending launch requests. Each orchestrator's decisions stay on
that orchestrator's tile and row.

When a dispatcher requests a launch outside its pre-approved repositories, Foom
opens a grant question in the decisions stepper. Main builds the title using the
agent's manifest display name and the full repository selector, including the
registered host when specified. Main supplies the three fixed choices. A request
without a matching manifest fails before a grant question is opened. The optional
agent-supplied reason is untrusted plain text.
**Allow once** authorizes the bound launch. **Allow and add to dispatcher repos**
commits the repository identity and authorizes the launch. **Don't launch**
resolves the question. Main reserves the idempotency key and durable operation
intent before acting. A rejection before the PTY spawn boundary reports failure.
An error after spawn dispatch can report an indeterminate outcome. Authorization
ends on demotion or process exit, including if the demotion save fails after exit.
If the source exits while elevation is being saved, main rolls back the scope
and releases the directory slot.

The dispatcher grant allows `repos`, `launch_orchestrator`, `prompt`, `stop`,
`read_handoff`, `session_state`, `wait_for` and `operation_status`. Human answers
are accepted only through trusted board IPC. Repository and worktree mutations,
file access, child actions and decision answers are outside this grant.

A registered-host selector prepares the repository's origin-derived checkout
with the existing Hosts service. The host verifies the origin and checkout
again before spawning. A separate per-launch relay forwards only the
repository orchestrator's approved calls. Child launches retain their existing
restricted relay. See [registered hosts](hosts.md#dispatcher-placement-1300).

Dispatcher-launched orchestrators can send pull-only handoffs as soon as main
binds their launch grants. Main clears provisional reporting authority when
launch tracking completes or fails. Remote MCP discovery reads the current
grant when listing orchestrator tools. Pi uses the relay's authenticated
capability list to expose those tools. Adopted orchestrators keep their existing
tools and grants.

A replacement launch preserves the dispatcher's access to prior orchestrators
it launched while their session rows and repository identities are retained.
The dispatcher can read their session state and bounded handoffs. Prompt and
stop still require a live orchestrator. Foom's authorization governs Foom tools. Provider file
and command permissions follow the provider's own configuration.
