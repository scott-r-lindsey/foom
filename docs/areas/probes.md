# Probes

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/probes.md).

`main/workspace/sidebar-commands.ts` owns config-session launch and credential handling; `workspace-context.ts` wires the probe broker and shared lifecycle. Probe execution and ownership policy remain in the agent probe modules.

## Config-owned probe capability (#591)

Main issues a fresh 256-bit `FOOM_CONFIG_TOKEN` and loopback `FOOM_CONFIG_URL` per
config launch, including shells and resumed sessions. These are independent of
repository control tokens. They are delivered only in that process's environment,
never via renderer IPC, profile persistence, discovery files, pairing or MCP.
The bundled CLI validates commands before sending bounded JSON to `/probe/v1`.
The separate main listener requires a bearer credential, loopback peer, exact Host,
POST, JSON and no Origin. Main validates the payload again, rejects unknown keys,
and accepts only named control keys, bounded prompt text (LF and TAB allowed), validated
agent/conversation IDs, and finite positive wait durations of at most 600 seconds.

`AgentProbes` reserves one slot per credential before asynchronous preparation.
Its random 256-bit probe ID resolves only within that credential's slot, never
through the general terminal inventory. Foreign, unknown and stopped IDs produce
the same `not_found` refusal. Every read rechecks ownership after awaiting the
terminal host. Exit revokes the config credential and stops its probe. The hard
10-minute timer covers preparation as well as interactive use; failed preparation,
stop, exit and quit release processes, launch files and scratch repositories.
Probes use the regular terminal host's process teardown and process audit.

Main creates the scratch directory and runs Git with fixed argument arrays,
all inherited `GIT_*` variables removed, global/system config disabled, and an
empty init template directory. Agent discovery and launches also use argument
arrays. A supplied manifest is descriptor-bounded to 64 KiB, rejects final links
and nonregular files, uses the strict v2 parser and must name the requested agent.
It is captured immutably for that probe and never installed in the registry.
The launch uses no user defaults or repository control grant. Known
manifest bypass arguments and environment conditions are refused before PTY
creation. Hooks and MCP use isolated probe-owned verification capabilities (#593).

The fixed login-shell environment query uses `readLoginShell` with ignored stdin,
a detached Unix session, bounded output and a deadline. Scratch Git initialization
and fixed CLI metadata reads use the same isolation and process-group cleanup,
so none can acquire the launching terminal or stop Foom through shell job control.
The interactive CLI gets its own PTY through the ordinary terminal host. The
probe's inspected environment strips Foom/Electron/parent-agent variables and
inherited Git overrides. `replaceEnvironment` is a main-only terminal spec option:
the utility host passes the complete supplied environment instead of merging its
own inherited environment back into it. Shared fixed PTY metadata (`TERM`,
`COLORTERM`, `TERM_PROGRAM`) is included in main’s bypass inspection and used by
the host from the same constants. Renderer requests cannot select this
option. The scratch repository is not a filesystem, account or network sandbox;
Enter at approval prompts is deliberately permitted. Agent output, screens,
manifest content and model responses remain untrusted data.

A validated host `screen` request carries a terminal ID. The utility process flushes
its headless parser and reads exactly the active viewport at `baseY`, including
alternate screens, plus the bounded OSC title and actual terminal columns/rows. It does not return scrollback.
Only main's probe broker exposes this result to the config CLI. The renderer keeps
its existing typed terminal capabilities and attachment ordering.

Probe rows live under Foom config with a text Probe mark and the usual Stop/input
controls. Main publishes only the driver's terminal ID as `probeOwner`; the
renderer resolves its current editable session name for a quiet **Probe · driver**
header label. Probe screen/title evidence bypasses normal terminal attention
publication; prompt classification remains available to the owning config CLI.
The sound controller excludes probe rows.

`ProbeAttention` uses the named `PROBE_WAITING_MS` (60 seconds), an injected clock
and cancellable timers. A continuously blocked screen starts one budget; repeated
output/classification cannot postpone it. Input resets the budget; resumed screen
progress and Stop cancel it. Stale screen reads after input/output/revocation are
ignored. Expiry projects a fixed `Probe waiting` reminder onto the owning config
session, preserving its own real question/permission attention. This is main-owned
presentation, not an evaluator verdict or execution transition. Dismissal (or a
fresh driver working transition) settles that blocked episode until probe input or
resumed progress. No probe prompt becomes a human permission request. The renderer
honors this projection across execution events and drops it when main clears it.
The fixture harness may inject a shorter delay; no config setting or renderer IPC
can change it. A profile-only list of agent IDs records the terse first-probe credit
note; it contains no terminal content or credential. Session persistence excludes
probe rows. [Capture persistence and replay](../contracts/agent-report.md#saved-screen-rule-regressions-592) compare raw rule states through the live matcher; idle does not imply Done. The config guide walks through capture/replay, fresh live and resume checks, then hook/MCP verification before enabling facts.

### Config decisions and live launch catalogs (#591 follow-up)

The config panel and Settings share the held-change decision component. Both name
main's held digest through the existing validated `config:decide` IPC; argument
approval still requires the main-owned trusted disclosure. Main publishes decision
status to all windows. The config-session-only `foom config status` command uses
the existing per-session credential, authenticates before reading and again after
awaiting ConfigService.refresh(), and has no decision or settings-write authority.
The guide requires checking it and explaining held settings to the human.

After a changed provider registry finishes discovery, main publishes setup changes
and refreshes workspace launch options, including sidebar config launchers. Board
launch options subscribe to setup changes, discarding stale asynchronous results,
and derive their entries from loaded provider identities, with absent enablement
meaning enabled. Main validates installed IDs and launch authority. The
[application command registry](commands.md) has no agent launch routes or
agent-discovery refresh; syntactic preload acceptance of via-provider commands
does not create a route. MCP tools/list resolves the current registry for each
request, including existing MCP sessions.

### Probe verification (#593)

Probe preparation clones the provider model and enables disabled discovery facts
only in that clone. Normal launches retain their loaded gates. A private hook
receiver reduces payloads through the same immutable channel mapping and retains
only bounded field paths and match facts for the credential-owned `events` command;
see [the verification contract](../contracts/agent-report.md#probe-hook-and-mcp-verification-593).
Accepted hook actions contribute to `state`; rejected or foreign sessions do not.
A per-probe MCP listener implements initialization, listing and a single `ping`
tool without importing or delegating to ControlService or the orchestration MCP
server. Its fresh credential shares only the probe launch lifetime. Environment-only
plugin launchers receive that listener’s URL and token, the probe hook binding’s
session identity, and the app-owned CLI directory; these inputs confer no
ControlService grant. Even explicitly named control/orchestration tools are
refused. Metadata stays in memory until
cleanup, never in session persistence or the renderer.
