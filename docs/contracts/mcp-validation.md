# Mcp Validation

### Read-only MCP implementation verification (#153)

`node scripts/probe-mcp.mjs` exercises the real CLI clients against Foom's production
HTTP adapter and a synthetic loopback model endpoint. It uses temporary profiles,
synthetic identity only, and no provider credentials or external model requests.
Set `FOOM_CLAUDE_EXECUTABLE` / `FOOM_CODEX_EXECUTABLE` to select an installed binary.
The script requires Linux and `bwrap`; administrator refusal is tested with private
mounts at the clients' system-policy locations, never edits to the host's `/etc`.

For #299, the probe now uses the production Claude launch arguments, including the
registry-derived grant, instead of constructing its own allow rules. It still
checks managed-policy refusal with that grant present. This is a print-mode probe:
`execFile` closes stdin and provides pipes, with no PTY or TUI login/onboarding
harness. It cannot assert the absence of an interactive permission prompt: print
mode refuses permissions instead of displaying that prompt, and an unauthenticated
TUI can stop at login/onboarding before any tool runs. No interactive-mode or auto
permission-mode result is claimed from it. The earlier isolated TUI spike in
[agent-previews §5](../agent-previews.md#5-client-reality) remains the interactive
evidence; the orchestrator will record real-model discovery after merge.

These tested releases establish the minimum supported stable versions: Claude Code
2.1.293 with `--mcp-config` in help, and Codex 0.161.0 with `-c` in help. Later stable
versions with the flag are available too; malformed and prerelease versions, older
versions and missing flags remain unavailable through those CLI attachment flags.
Antigravity's opt-in plugin is measured separately in
[the agy 1.4.2 evidence](../agents.md#antigravity-plugin-mcp-agy-142-855), not by this
Claude/Codex probe. The probe exercises any supplied binary without an exact-release assertion.

The **Real CLI MCP probe** CI job (#254) runs nightly even when main is unchanged,
and on manual CI dispatch. Optional `claude_version` and `codex_version` inputs
accept stable x.y.z releases (default `latest`) to reproduce a regression. It installs
both packages into temporary prefixes and logs the validated CLI versions. The
existing temporary homes, loopback model and `bwrap` policy mounts remain in use;
no provider credentials or global agent configuration are used. Child output is
captured privately and discarded. Reports contain only validated versions and
fixed assertion names. A failure fails this independent job and opens or updates
one issue labeled `mcp-probe`; a later green run comments on the same issue.
Closed issues are reopened on regression. The job serializes issue updates, has
issues write and contents read only, and neither publishes nor blocks nightly
packages. Setup/API failures remain job failures; no raw logs are uploaded.

### Deferred-tool probe correction (#259)

Claude Code 2.1.304 enabled tool search by default behind `ANTHROPIC_BASE_URL`
gateways. The synthetic endpoint previously expected Foom definitions in the first
model request and returned completion when none appeared. With 2.1.306, a local
credential-free reproduction authenticated initialization and listing, but that
first request contained `ToolSearch` and `DeferredToolPlaceholder` instead of Foom
definitions, so no `tools/call` followed. This was a synthetic-model limitation,
not evidence of an authentication, protocol, tool-prefix or approval regression.
The earlier 2.1.296 initialize failure recorded on #259 was a deliberate acceptance
test failure, followed by recovery; it is not the same regression.

The synthetic responder now requests a bounded Foom tool search when definitions
are deferred, then calls the discovered per-launch `whoami` and `open_preview`.
It stops after an empty search so administrator refusal cannot cause a search
loop. Upfront definitions remain supported. All authenticated initialize/list/call,
identity, preview, existing-server coexistence, configuration preservation and
managed-policy refusal assertions remain required. No production MCP authentication,
tokens, launch configuration or permission grants change, and tool search stays at
the client's default. Fixture tests cover deferred discovery, upfront definitions
and empty discovery without executing real CLIs.

Sources: [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21304),
[gateway tool search](https://code.claude.com/docs/en/mcp#tool-search-through-an-llm-gateway).
To verify in CI, manually run **Actions → CI → Run workflow** on the PR branch with
`claude_version=2.1.306` (or `latest`) and `codex_version=latest`, leaving publishing
disabled. The Real CLI MCP probe should pass both clients; PR CI alone does not run
that independent nightly/manual probe.

For each attached launch, main waits up to 30 seconds after binding the terminal
for its first successful authenticated MCP request. The session panel shows
**Connecting…**, then **Connected**, or **Not connected** after the deadline.
Not connected is a magenta failure only for orchestrators; ordinary session panels
record it neutrally, without an alert. A later successful MCP request changes it to
Connected. CLI requests and rejected MCP requests do not count. The observation is
bound to the live launch principal and cleared on revocation or shutdown; it is
not a continuous liveness check and is never persisted. Managed policy is still enforced by the client and
can deny an otherwise supported attachment; Foom does not override that policy.
Windows/macOS real-client policy probes remain unverified. The packaged CLI fallback is available; see [console contract](console.md).


Dated real-client results: [#153](https://github.com/scott-r-lindsey/foom/issues/153), [#252](https://github.com/scott-r-lindsey/foom/issues/252), [#299](https://github.com/scott-r-lindsey/foom/issues/299).
