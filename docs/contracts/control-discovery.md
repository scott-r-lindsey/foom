# Control Discovery

### MCP discovery and wording (#526)

Call `whoami` first. Its `grantedAt` is an ISO 8601 UTC timestamp for the
current role, set when the launch binds and refreshed on elevation or revocation.
Repeating the same role does not reset it. A restored launch receives a new time;
this is not persisted role history. Paired CLI identities also have a grant time.

`capabilities` remains the list of callable method names. `tools` lists the same
methods as `{ name, cli }`, for example `{ "name": "read_handoff", "cli": "foom read-handoff" }`.
These are command names; supply the command's required arguments. `list_previews`
maps to `foom previews`; other names use hyphens instead of underscores. Only
currently granted tools appear, including `handoff` for a live owned child.
After elevation, this includes `read_handoff` even if the client cached its old
MCP tool list. Use the inherited session credentials for CLI fallbacks.
Listing a tool never grants authority; every call still checks the current role.

Some clients defer tools behind search and omit server instructions from model
context. The essential workflow therefore lives in tool descriptions too. The
following text is pinned against live MCP initialization and listing in unit tests.
Child input wording follows #629: owned children accept prompts and keys without
per-message human review, including permission, credential and provider dialogs.
Hook-based notification of a mid-session role change (item 4) is excluded pending
the user's decision. No hooks or notification behavior change here.

The [exact server/tool wording](../orchestration.md#pinned-server-and-tool-wording) is retained at its tested source path.
