# Mcp

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Mcp

**Read-only MCP implemented in #153.** `POST /mcp` uses the same authentication,
body/header/connection limits and service authorization as the versioned endpoint.
It negotiates MCP 2025-03-26, 2025-06-18 or 2025-11-25, returns JSON responses and
binds one random protocol session to each live grant generation, so it survives a
role change. Reinitializing replaces that grant's old protocol session; DELETE terminates it. GET authenticates and
validates the session before returning 405 (no SSE stream). Revocation is rechecked
at dispatch. Ordinary agents can call `whoami`, `sessions`, `session_state`, `manual` and the three preview view actions.
Because clients fetch tools once (#303), MCP lists the orchestration tools to every
agent; calls without the role are refused with a message naming `whoami`, here and
by direct invocation.

The service reads a main-owned workspace snapshot, never a terminal tail. Sessions
are repository-scoped, paginated by the preceding terminal ID and limited to 100
rows. Foreign/missing IDs and cursors return the same not-found response. Names are
redacted before a 160-character bound; oversized names are suppressed. Locations
are opaque path hashes rather than raw paths. Results carry fixed state reasons,
opaque revisions derived from launch, execution and verdict state, and conservative
`unknown` attention provenance for Needs you. Current execution overrides stale
evaluator verdicts, as on the board. Display names are branch/worktree labels, not
renderer-only custom names.
Whoami returns the same opaque location identities and bounded worktree label.

Agent discovery reports MCP support independently of hooks, using stable version
floors (Claude Code 2.1.293, Codex 0.161.0) and the corresponding help flag
(`--mcp-config` or `-c`). Supported releases receive a random server name: Claude gets a private temporary MCP JSON file
with environment expansion, Codex gets an additive `-c` server table referencing the
bearer environment variable.
Claude Code launches with MCP pre-approve every registered Foom tool on that
random per-launch server using exact `mcp__<server>__<tool>` names in `--allowedTools`.
The server registry supplies the tool names, filtered by the manifest’s reviewed
list; a test requires every registered tool to be classified and included.
User default allow rules are merged and deduplicated, including the `--allowed-tools`
alias, equals forms and variadic/comma-separated lists. Managed policy and deny
rules still win. Orchestration tools remain refused server-side until the human
grants the role. `remove_worktree` still needs human confirmation in
Foom (apart from the existing opt-in merged-clean removal policy). No other MCP
server or non-Foom tool is granted; no global config is edited. Launches
without MCP retain their default arguments unchanged. See the
[per-launch disclosure](../contracts/mcp-attachment.md#claude-code).
Tokens never enter argv or files. Exit, early exit,
spawn/attachment failure and shutdown dispose attachments and revoke credentials.
Managed policy may refuse attachment in the client; no settings are weakened. The control
service tracks attachment per principal after terminal binding: Connecting for up
to 30 seconds, Connected after a successful authenticated MCP request, or Not
connected at the deadline with recovery on later traffic. CLI and rejected MCP
requests do not count. Timers are cancelled on success, revocation and shutdown.
Main publishes the transient state through workspace snapshots; session panels
show it neutrally except for an orchestrator's magenta Not connected failure.
See the [real-client probe record](../contracts/mcp-validation.md#read-only-mcp-implementation-verification-153).

MCP protocol metadata such as `_meta.progressToken` is accepted by the adapter without being passed to the control service.

## Bundled manual (#699)

Every session already launched with Foom MCP, including ordinary children and
the orchestrator, can call the read-only `manual` tool. No arguments returns
section IDs, titles and one-line summaries. `section` selects an exact known ID
(maximum 200 characters); unknown IDs return a validation error listing valid IDs.
`page` is a zero-based integer used only with a section; follow `nextPage` until
it is absent. Each page holds at most 2048 Unicode code points (4096 UTF-16 units),
and a complete section response remains below 64 KiB even with JSON escaping.
The bounded section list is limited to 100 entries, 200-character IDs/titles and
160-character summaries. Unknown fields and invalid page values fail closed.

The authority-independent reader serves only the fixed bundled
`build/manual/sections.json`, emitted by the same `sectionIndex` extraction as
manual search. Main reads its native ASAR path with Electron fs, including on
Windows; no URL conversion or caller path is involved. There are no network or
write capabilities. Tool text identifies the manual as reference documentation
about Foom, not instructions for the current task. Server instructions say
“For questions about using Foom, call manual.” Manual content is fetched only
on demand, never included in startup instructions.

Config sessions receive a separate manual-only attachment (#704) when their
provider supports per-launch MCP. It registers exactly `manual`; every other
tool name is refused as unknown. Its dedicated loopback listener and random
credential are independent of control grants, pairing and orchestration. It
uses the same private per-launch client files/arguments and random server name;
Claude pre-approval includes only `manual` on that server. No global agent
configuration is written. Session exit (including early exit), failed launch
and shutdown revoke the credential, close the listener and dispose launch files.
The reader requires no repository/session authority; this attachment carries none.
