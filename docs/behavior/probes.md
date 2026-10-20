# Probes

Decided user-visible behavior. Implementation owners and security rules: [file map](../map.md).

## Config agent probe terminals (#591)

A config session can start and drive one probe at a time with its own bundled
`foom agent probe` CLI capability. A probe runs an installed agent, or a validated
v2 manifest supplied with `--manifest`, in a fresh temporary Git repository made
by Foom. It never uses a managed repository or worktree. User default arguments
are not applied, and known bypass arguments and environment variables are refused.
The probe receives the login-shell environment without inherited Foom credentials or repository MCP
grants. It receives isolated hook and ping-only MCP verification credentials. This is a working-directory boundary, not an OS sandbox: the real CLI
runs on the user's account, can access files and network as that account, and may
use credits. Enter is allowed, including at approval prompts.

The probe appears under Foom config with normal terminal input and Stop. Its tile
header quietly names its driver: **Probe · <config session name>**, following the
session's editable name. The probe's own prompts never show Needs you or Not
attention and never chime. The config agent answers its probe's prompts.
If the probe stays blocked without input for about 60 seconds, its config session
shows **Probe waiting**. An existing question or permission prompt on that session
keeps its own reason. Probe input, resumed progress, Stop or dismissal clears the
reminder; dismissal settles the current blocked episode. The person can still type
into or Stop the probe. Before each probe, the config agent explains its plan,
that it answers trust/approval prompts itself, and that the person can Stop it;
afterward it summarizes the result. The first probe of each agent ID has a terse, one-time inline note:
“Runs the real CLI on your account. May use credits.” No dialog is shown.
Probes are never restored. They stop after ten minutes, when their owning config
session exits, or when Foom quits; Foom removes the scratch repository after the
process stops.

Foom sends no terminal content to models or network services, with one exception:
a config session can request the current visible screen and OSC title of a probe
it started. That output enters the config agent's context and may go to its model
provider. No scrollback is exposed. Other sessions, including other config
sessions' probes, remain unreadable through this capability. Probe IDs are random
and bound to the calling config session's private credential.

The CLI provides `start <agent> [--manifest <path>] [--resume <conversationId>]`,
`send <probe> <text>` (text followed by Enter),
`keys <probe> <esc|ctrl-c|enter|up|down|tab>`,
`wait <probe> --quiet <seconds>` or `--timeout <seconds>`, `screen <probe>`,
`state <probe>`, `events <probe>`, and `stop <probe>`, below `foom agent probe`. Screen and state
results are JSON. Quiet waits reset on output; timeout waits wait the requested
elapsed time. Both are bounded by the probe's remaining lifetime.

Probe screens can be saved with `screen <probe> --save working|blocked|idle|other` and replayed with `foom config test-rules <agentId> [--json]`. These are raw attention-rule labels, not completion; `done` is rejected. Captures remain private and local. See [capture/replay rules](../contracts/agent-report.md#saved-screen-rule-regressions-592). Guide automation remains separate (#594).

`events` reports bounded hook field paths and mapping facts without payload values,
and whether its isolated MCP endpoint was connected, listed or pinged. Probe-only
preparation enables disabled verification facts while preserving version/help gates;
normal launches retain them. `state` reflects accepted hook actions. The probe MCP
endpoint exposes only ping and cannot access repository or orchestration tools.
See [the verification contract](../contracts/agent-report.md#probe-hook-and-mcp-verification-593).
