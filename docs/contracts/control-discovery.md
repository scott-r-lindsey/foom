# Control Discovery

### MCP discovery and wording (#526)

Call `whoami` first. Its `grantedAt` is an ISO 8601 UTC timestamp for the
current role, set when the launch binds and refreshed on elevation or revocation.
Repeating the same role does not reset it. A restored launch receives a new time;
this is not persisted role history. Paired CLI identities also have a grant time.

`capabilities` remains the list of callable method names. `tools` lists the same
methods as `{ name, cli }` when a CLI fallback exists, for example `{ "name": "read_handoff", "cli": "foom read-handoff" }`.
The MCP-only `manual` entry is `{ name: "manual" }`, with no invented CLI
fallback. These are command names; supply the command's required arguments. `list_previews`
maps to `foom previews`; other names use hyphens instead of underscores. Only
currently granted tools appear, including `handoff` for a live owned child.
After elevation, this includes `read_handoff` even if the client cached its old
MCP tool list. Use the inherited session credentials for CLI fallbacks.
Listing a tool never grants authority; every call still checks the current role.

Initialize-time server instructions are selected from the authenticated principal:
ordinary agent, child (a principal with a parent), or orchestrator. Children receive
the same handoff and CI guidance as the launch prefix, without orchestrator workflow
or elevation guidance. All roles point to `manual` for Foom details.

`whoami.guidance` returns short orientation for the current role, including the
handoff rule for children. Call it after a grant, revoke, resume or context
compaction: initialize-time instructions may be stale. Guidance grants no authority;
live service checks remain decisive. Restricted remote children receive the same
child guidance in initialization and public identity results; no hub identity is added.

Some clients defer tools behind search and omit server instructions from model
context. The essential workflow therefore lives in tool descriptions too. The
following text is pinned against live MCP initialization and listing in unit tests.
Child input wording follows #629: owned children accept prompts and keys without
per-message human review, including permission, credential and provider dialogs.
Hook-based notification of a mid-session role change (item 4) is excluded pending
the user's decision. No hooks or notification behavior change here.

The [exact server/tool wording](../orchestration.md#pinned-server-and-tool-wording) is retained at its tested source path.
