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
versions, missing flags and Antigravity remain unavailable. The probe exercises any
supplied binary without an exact-release assertion.

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
