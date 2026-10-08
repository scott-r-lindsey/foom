# Foom control plane

Research for [#119](https://github.com/scott-r-lindsey/foom/issues/119), checked
2026-10-05 on Linux. This document specifies the complete target. The security and
HTTP foundation is implemented in #152; see the [current architecture](architecture.md#control-plane)
for its exposed methods and storage contract. Read-only MCP is implemented in #153;
CLI packaging/pairing and orchestration actions remain follow-up work. The original #119 research changed no
application code.

## Decision

One main-process control service owns authorization and operations. A Streamable
HTTP MCP server and the `foom` console CLI are thin adapters to it. Attach MCP per
launch to supported agents; use the CLI fallback for Antigravity. Never install
agent configuration, plugins or skills globally or into a repository. MCP server
instructions and tool descriptions explain the workflow and limits.

Only the repository menu's **Launch as Foom orchestrator** grants orchestration.
Main permits one active orchestrator per canonical repository, with at most four
running children, each in a new worktree in that repository. Children get ordinary
read-only credentials and cannot create grandchildren through Foom. Agent-native
subagents and processes outside Foom are not controlled by this limit.

Per-agent default launch arguments (#164) apply to user launches. Orchestrator
children (#155) must not inherit bypass defaults unless their design explicitly
allows it with its own authorization rules. A user's acknowledgement for manual
launches does not authorize an orchestrator to grant bypass to children.

**Reply finding:** none of the three current PTY integrations proves that a prose
question is still the active input destination when bytes are written. An absent
permission hook is not proof of safety. Ship observation, launch and stop first;
question replies initially require review in Foom. Unattended replies remain
unavailable until a tested adapter can enforce the question/permission boundary.

## Evidence and limits

| Agent | Local version | Observed without model calls | Not established |
|---|---|---|---|
| Claude Code | `2.1.289 (Claude Code)` | Help advertises `--mcp-config`, `--strict-mcp-config`, `--settings`, `--plugin-dir` | Live MCP handshake, policy coexistence, reliable question routing |
| Codex | `codex-cli 0.160.0` | Help and `mcp get --json` accept whole HTTP and stdio server tables via `-c` | Live header delivery, approval callback coverage, question routing |
| Antigravity | `1.2.13` | Top-level and `mcp --help`; no invocation-scoped MCP option advertised | Any supported per-launch MCP attachment or reliable question routing |

Version/help probes ran in the research worktree; Codex parser probes ran in an
empty temporary directory with a temporary `CODEX_HOME`. No model calls, real
terminal tails, global config edits, repository config writes, or MCP installation
commands were used. Windows and macOS were not exercised. Documentation findings
below are distinct from these local observations; implementation must test supported
versions and managed-policy restrictions rather than infer support from a minimum
version alone.

### Claude Code

`--mcp-config` accepts JSON strings or file paths. `--strict-mcp-config` excludes
other MCP configuration, so do **not** use strict mode for ordinary Foom launches:
retain the user's integrations. Use a unique server name per launch rather than
shadowing an existing `foom` entry. `--settings` continues to carry observer hooks.
`--plugin-dir` can load a local plugin for the invocation; a plugin could contain
skills later, but no plugin or skill is needed here.
[CLI reference](https://code.claude.com/docs/en/cli-reference).

Proposed argv fragment, represented as JSON rather than a shell command:

```json
["--mcp-config", "/private/foom/launch-id/mcp.json"]
```

The file is in Foom's private launch directory, outside the checkout:

```json
{
  "mcpServers": {
    "foom_launch_id": {
      "type": "http",
      "url": "http://127.0.0.1:32199/mcp",
      "headers": { "Authorization": "Bearer ${FOOM_CONTROL_TOKEN}" }
    }
  }
}
```

The port and name are illustrative. Claude documents environment expansion in MCP
headers and HTTP transport. Supply the variable only in the launched process's
environment. Verify expansion for an externally supplied config file in a synthetic
handshake before enabling this adapter; refuse attachment if it fails. Do not put a
literal token in argv or silently replace user MCP configuration. Managed policies
can disallow a server; report that condition and expose the authorized CLI fallback.
[MCP configuration](https://code.claude.com/docs/en/mcp).

`PermissionRequest` identifies a tool approval; `Notification` with
`permission_prompt` is delayed evidence. Stop and idle notifications do not prove
a prose question. Even structured question tools are distinct from ordinary prose,
and hooks may be disabled or delayed. Foom's hooks remain observers and never
return approval decisions. [Hook reference](https://code.claude.com/docs/en/hooks).

### Codex

Use a unique server table in a per-invocation `-c` override. HTTP supports an
environment-sourced bearer token; stdio supports command, argument and environment
configuration. Neither requires `codex mcp add` or a user config edit.
[MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Proposed HTTP argv fragment:

```json
["-c", "mcp_servers.foom_launch_id={url=\"http://127.0.0.1:32199/mcp\",bearer_token_env_var=\"FOOM_CONTROL_TOKEN\"}"]
```

The local parser test used `codex -c <table> mcp get foom_probe --json`, once with
`{url="http://127.0.0.1:32199/mcp",bearer_token_env_var="FOOM_CONTROL_TOKEN"}` and
once with `{command="/nonexistent/foom",args=["mcp"],env_vars=["FOOM_CONTROL_TOKEN"]}`.
Both returned exit 0 with the corresponding transport and no `config.toml` written.
The stdio executable was deliberately nonexistent: this establishes configuration
parsing, not connection success. Codex warned that helper aliases could not be
created under `/tmp`; it still returned the effective configuration.

Keep existing hook `notify` attachment and its replacement disclosure separate.
The external completion notification does not expose every approval request;
terminal notifications are a different mechanism. No unattended PTY reply is
justified by a completed turn or missing callback.
[Notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

### Antigravity

The documented CLI MCP setup uses global or workspace configuration. Installed help
lists `mcp add/remove/list/enable/disable`, but no invocation-scoped MCP config flag.
This is a verified absence in the inspected interface, not a claim that no future
version can support it. Do not run `agy mcp add`, relocate HOME, or create
`.agents/mcp_config.json` to simulate per-launch attachment.
[MCP documentation](https://www.antigravity.google/docs/mcp/).

Launch with `FOOM_CONTROL_URL`, `FOOM_CONTROL_TOKEN`, and `FOOM_SESSION` plus Foom's
CLI directory prepended to that process's PATH. Provide short CLI guidance through
the initial prompt, using the documented-in-help `--prompt-interactive` option;
compose it with the user's prompt as data. Ordinary sessions receive read-only
access; an explicitly launched orchestrator gets its main-assigned role. When MCP
becomes verifiably available, the same control API can replace this fallback.

Permissions and sandboxing remain the user's settings. Prompt text is not a stable
permission API; Antigravity remains human-review-only for replies.
[Permissions](https://www.antigravity.google/docs/permissions/).

## Transport, packaging and discovery

Choose **Streamable HTTP on `127.0.0.1` with an OS-assigned port**. Main hosts
`/mcp` and a versioned CLI endpoint `/control/v1`; both call the same service.
This avoids spawning an MCP proxy for every agent and lets read-only MCP ship
before the console helper. HTTP is supported by both verified MCP clients.
Stdio `foom mcp` would still need an authenticated local app connection and a
packaged console helper; it is not selected and need not ship as a third adapter.

Authenticate every request, including initialization, tool listing, and stream
reconnection. Reject browser Origin headers and any Host other than the actual
loopback literal and bound port; no CORS, redirects, URL tokens, or nonloopback
binding. An MCP session ID is protocol state, never authorization. Bind it to the
principal and recheck revocation on every request. Initially use JSON responses
and bounded `wait_for` calls rather than an unbounded event stream. Negotiate the
MCP protocol version and reject unsupported versions. Bound headers to 8 KiB,
bodies to 64 KiB, connections to 32, and concurrent calls to four per principal.
[MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The Electron executable is not the CLI runtime. Keep `RunAsNode` disabled and
retain sandbox, context isolation, CSP and asset restrictions.
[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

Package `foom` / `foom.exe` as a **separate console executable**, built from bundled
TypeScript under `src/cli/` with Node 24's single-executable application machinery.
It only parses arguments and calls the API; main still owns git, PTYs and policy.
This is a packaging proposal, not a validated binary. Build and test on each target
OS/architecture; Windows must retain a console subsystem and usable stdout, stderr
and exit codes. It requires no user-installed Node. Include runtime licenses and
integrity/version checks; production signing follows the existing release work.
[Node SEA documentation](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html).

| Platform | Bundled helper and optional PATH setup |
|---|---|
| macOS | Helper inside the app's resources; explicit Install CLI action creates a symlink in a user-selected bin directory already on PATH, or explains how to add it |
| Linux | Helper beside packaged resources; same explicit user-bin symlink flow, with relocation/stale-link detection |
| Windows | Console `foom.exe` in a dedicated app helper directory; explicit Install CLI action adds that directory to the user's PATH and explains that new shells are needed |

Never overwrite an unrelated `foom` command or silently edit shell startup files.
Removal undoes only Foom-owned PATH entries/links. ZIP builds can run the helper by
absolute path without installation. Foom-launched agents receive a process-local
PATH addition, independent of human PATH installation. Package tests must cover
spaces, Unicode paths, moved installations, and execution without system Node.

The app atomically publishes a private discovery file containing only protocol
version, loopback endpoint and random app-instance ID. Validate ownership, file
permissions and endpoint before use; refuse symlinks/reparse-point substitution.
Use a 0700 user-data directory and 0600 file on Unix, an explicit current-user DACL
on Windows. Remove discovery on clean exit; after a crash, an instance handshake
rejects stale metadata. Credentials are never stored in this file.

## Identity and capability model

Reuse the hook receiver's launch identity and lifecycle, **not `FOOM_TOKEN`**.
Mint a separate random 256-bit `FOOM_CONTROL_TOKEN`; hook credentials must never
authorize control operations. `FOOM_SESSION` is correlation only. Main maps token
digests to a principal with immutable role, repository identity, terminal ID,
parent ID and generation. Neither a tool argument nor an environment role flag can
promote it. Compare fixed-length digests in constant time; unknown and revoked
tokens produce the same authentication error.

Bind credentials before exposing a session; revoke on spawn failure, exit, removal
and shutdown. No control registration depends on hooks being enabled. Scrub all
inherited Foom credentials before constructing each child's environment, then add
fresh child-scoped values. Never return tokens to the renderer, logs, MCP results
or error text. New Foom instances and resumed sessions receive fresh credentials;
#115 must not restore authority from historical metadata.

A CLI invocation with agent credentials uses exactly that scope. It never falls
back to a stronger principal when authentication fails. A person running `foom`
outside an agent starts with no authority: a bounded pairing request shows a
matching code in the CLI and Foom, and the user grants a short-lived,
repository-scoped CLI session in the app. Token delivery uses the pending local
connection; a persistent CLI process holds it only in memory. Scripts receive an
explicit expiring grant through the same UI flow, not a reusable human token file.
Mutating operations still require app-owned confirmations where specified below.
Pairing is rate-limited, expires after 60 seconds, and cannot be approved via MCP.
`foom --validate-config` performs offline schema validation without pairing or
running config content; #84 defines the eventual config-only API role.

This is a capability boundary against unauthenticated clients and accidental
cross-session access, not isolation from hostile processes running as the same OS
user. Such a process may inspect another process's environment or memory. Separate
worktrees are not sandboxes. Do not claim the no-grandchildren or repository rule
constrains arbitrary shell commands an agent can already run outside this API.

### Tools and confirmations

Every request has a validated schema, bounded strings, known IDs, and an explicit
protocol version. Reject unknown fields and cross-repository/foreign IDs. Agent
names select detected enabled executables, never caller-supplied commands. Main
chooses worktree paths and validates branch names and canonical git membership
under the existing launch/removal locks. Git and processes use argument arrays.

| Tool | Principal and scope | Contract |
|---|---|---|
| `whoami` | Every authenticated agent | Own session, role, repository/worktree and capability names; no secrets |
| `sessions` | Every agent, own repository only | Paginated metadata, 100 rows maximum; no output, prompts, arbitrary reasons or environment |
| `session_state` | Every agent, own repository only | State, server-generated reason, revision and attention kind; no terminal content |
| `create_worktree` | Orchestrator | New validated branch/worktree in its repository, main-owned provenance; never adopt existing worktrees |
| `launch` | Orchestrator | One ordinary child in its newly created empty worktree; enabled agent and ≤16 KiB initial prompt; no role/permission-policy arguments |
| `tail` | Orchestrator, own child only | Latest 1–40 physical lines, redacted, ≤16 KiB UTF-8 result, no historical pagination |
| `reply` | Orchestrator, own child only | Exact question revision plus ≤4 KiB proposal; gate below, never general terminal input |
| `stop` | Orchestrator, own child only | Graceful stop with existing bounded termination fallback; retains worktree and final screen |
| `remove_worktree` | Orchestrator, own created worktree only | Requests an app confirmation even when clean; no force option or deleting branches |
| `wait_for` | Orchestrator, own children only | Up to four IDs, after-revision cursor, timeout 0–30 seconds; returns state metadata or timeout |
| `operation_status` | Orchestrator or authorized human CLI grant, own operations only | Exactly one of operation ID or idempotency key; returns the operation record described below, never child output |

Ordinary agents never see orchestration tools in `tools/list`; the service also
rejects direct calls to hidden methods. Config-only tools for #84 are a separate
role, not privileges inherited by orchestrators. #67 remote access is out of scope.
A human CLI grant exposes only its approved operations through the same validators.

Reserve the repository orchestrator slot and child slots atomically before async
work. Count starting and stopping children until exit is confirmed; reject a fifth
launch, concurrent second orchestrator, and occupied worktrees. Bound unused
orchestrator-created worktrees to four as well. Release reservations on failure;
retain successfully created worktrees for explicit cleanup. Idempotency keys on
mutations return the prior operation result, rejecting reuse with different input;
a timed-out client must query the operation rather than launch again blindly.

Both adapters expose the same read-only lookup: MCP `operation_status` takes
exactly one of `operationId` or `idempotencyKey`; CLI
`foom operation-status --operation-id <id>` or
`foom operation-status --idempotency-key <key>` returns the same JSON record.
Scope both selectors to the authenticated actor's immutable principal generation
and repository, never a caller-supplied actor. Recheck authorization on every
lookup; revoked grants cannot query, and replacement orchestrators do not inherit
records. Unknown and foreign selectors return the same `not_found` response.

The record contains `operationId`, `action`, scoped target/result IDs when known,
`status`, creation/update timestamps and a fixed reason code. Status is one of
`pending_confirmation`, `running`, `succeeded`, `failed`, `declined`, `cancelled`
or `indeterminate`. Human refusal of removal is `declined`; completed deletion is
`succeeded`; a known failure is `failed`. Ambiguous side effects are
`indeterminate`, never reported as a definite failure. Do not include credentials,
prompts, reply text, terminal content or raw exception messages. `wait_for`
continues to report child state only; it does not report operation completion.

Persist the actor-scoped idempotency-key mapping and operation intent before side
effects, so losing the original response does not require knowing its operation
ID. Keep lookup records and deduplication mappings for the grant's lifetime,
independent of action-log rotation or clearing. Bound their storage and refuse new
mutations when full rather than evicting records for an active grant. Lookup never
replays a mutation. A timeout, `not_found` or `indeterminate` result does not prove
that no side effect occurred and must not trigger an automatic retry with a new
key; unresolved outcomes require human reconciliation.

Removal confirmation is tied to the actor, worktree identity and dirty state;
recheck all three before deletion using the existing service. Pending confirmation
returns an operation ID, so agents cannot hold the HTTP connection indefinitely.
Stopping a child needs no extra confirmation after the user has launched its
orchestrator; stopping unrelated sessions is forbidden. Parent exit revokes its
authority and cancels pending mutations/replies, but leaves children running for
the human. A replacement orchestrator does not inherit those children. Quit keeps
the existing confirmation and stops all PTYs.

## Reply gate

Add an attention kind independent of the visible light:
`question`, `permission`, `credential`, or `unknown`. Today `needs_input` and model
confidence do not carry this distinction; neither can authorize `reply`.
Permission hooks, `(y/n)`, Allow/confirm prompts, password context, and uncertain
cases remain human-only Needs you (amber plus a label). Echo-off alone does not
classify a credential prompt. A model may suggest `question`, but cannot grant a
terminal-input capability. Treat all hook and model data as untrusted evidence.

For current adapters, `reply` can only create a **proposal** for a question verdict.
Show the child, fresh context and exact text in Foom; do not send bytes automatically.
If permission, credential or unknown evidence appears, reject the proposal and
focus the terminal for the human. Approval of a proposal is a human action, not an
orchestrator permission decision. It is not advertised as eliminating the race
between review and a changing PTY. The human can always take over directly.

Any future automatic adapter must prove a question-specific input channel, or an
equivalent atomic routing guarantee that cannot feed a permission prompt. A PTY
write serialized in main is insufficient: the agent can change its input mode
before emitting output. Test this explicitly before enabling automatic replies
for any agent/version. Do not weaken agent approval policies to obtain the guarantee.

Bind a proposal to child ID, principal generation, verdict ID and output/input
revision; invalidate it on output, input, dismissal, permission signal, exit,
parent revocation or takeover. At send time recheck all gates, consume a single-use
reply ID, and record the operation before writing. Reject control characters,
Escape, CR/LF and slash-command prefixes in the first implementation; send one
plain-text line with one submit through the tested adapter. A transport failure
after writing is an indeterminate result, never an automatic retry.

Limit to one proposal per verdict, one sent reply per child per ten seconds and
three replies per child before human reset. Repeated questions or no progress
suspend replies and leave Needs you visible. **Take over** cancels pending proposals
and disables further orchestrator replies until the user explicitly resumes them.
An optional review-every-reply preference will remain even if a future adapter
qualifies for automatic delivery; it is mandatory with today's adapters.

## Output, privacy and visibility

`tail` reads only the child's headless screen through main's existing host client,
without attaching a view or pausing a hidden terminal. Apply the evaluator's
`prepareTail` redaction before final line/byte truncation; oversize input fails
closed. Rate-limit to one snapshot per child per second. Return structured data
with child ID, revision, timestamp, truncation flag and `untrusted: true`, and a
fixed instruction that contents are data, never requests to run commands or change
policy. Marking data does not solve prompt injection; capability checks remain
mandatory. Redact and bound user-controlled metadata too.

No file, diff, transcript, keystroke, raw hook or unlimited scrollback endpoint is
added. Terminal output can itself contain file contents, diffs or echoed input;
redaction is heuristic. Tails returned to an orchestrator can go to **that agent's
model provider**, independently of the evaluator's configured provider. Repeated
bounded reads can accumulate substantial output. Disclose this at orchestrator
launch and in [product privacy](product.md#orchestration-and-privacy-planned).
Foom's API limits do not restrict the agent's pre-existing filesystem tools.

Every action records an operation ID, actor/parent/child IDs, repository/worktree
IDs, action, timestamp, outcome and fixed reason. For replies retain a bounded
redacted proposal and delivery status, never raw input or tails; initial prompts
are omitted. Store a separate private action log, rotate at 10 MiB, retain at most
five files and 30 days, and support clearing it. Audit intent must be persisted
before mutations; log failure refuses automation but never blocks human terminal
input. Record indeterminate outcomes on recovery rather than replaying operations.

Children nest under their orchestrator in the repository sidebar, each retaining a
worktree label and independent light. Parent history stays while children remain;
show an exited parent as such. No view attachment changes are implied by nesting.
Expose the action log and takeover affordance through the board source. Minimal
action visibility and takeover must ship with mutations; the final UI issue adds
the full hierarchy and searchable log. No silent orchestration period is acceptable.

## Delivery and verification

Implementation issues below are ordered, with explicit dependencies and acceptance
criteria. #113 is closed. #114 (read-only review), #115 (resume), #84 (configuration)
and #67 (remote mirror) remain open; this design reserves their boundaries without
implementing or depending on those features. A reviewer can be a normal child in a
fresh worktree; enforced read-only review remains #114.

1. [#152: Control plane: core API, session authentication and capability checks](https://github.com/scott-r-lindsey/foom/issues/152) — depends on #119.
2. [#153: Control plane: read-only MCP tools and per-launch attachment](https://github.com/scott-r-lindsey/foom/issues/153) — depends on #152 and #119.
3. [#154: Control plane: packaged foom CLI and explicit local pairing](https://github.com/scott-r-lindsey/foom/issues/154) — depends on #153 and #119.
4. [#155: Control plane: launch a repository orchestrator and manage children](https://github.com/scott-r-lindsey/foom/issues/155) — depends on #154 and #119.
5. [#156: Control plane: reviewed question replies and enforceable reply gate](https://github.com/scott-r-lindsey/foom/issues/156) — depends on #155 and #119.
6. [#157: Control plane: sidebar child nesting and action log view](https://github.com/scott-r-lindsey/foom/issues/157) — depends on #156 and #119. Also builds on closed #113.

Before enabling attachment: synthetic HTTP initialize/tools-list/tool-call tests
for Claude and Codex, bearer header validation, existing user MCP coexistence,
managed-policy refusal, disabled hooks, token revocation and no config writes.
Before enabling mutations: cross-role/foreign-ID denial, simultaneous launch and
removal races, idempotency, parent exit, log failure and human confirmations. Test
operation lookup through MCP and CLI after a lost mutation response, by both ID
and idempotency key; cover pending, successful, failed and declined removal,
cancellation, indeterminate outcomes, foreign actors, revocation and record limits.
Before enabling replies: permission/question/password fixtures plus adversarial
mode switches, stale proposals, duplicate delivery, takeover and loop limits;
current PTY adapters must remain unable to auto-send. Before shipping the CLI:
packaged Linux, macOS and Windows console tests with no system Node, stale discovery,
wrong file ownership, pairing expiry and PATH installation/uninstallation.

### Read-only MCP implementation verification (#153)

`node scripts/probe-mcp.mjs` exercises the real CLI clients against Foom's production
HTTP adapter and a synthetic loopback model endpoint. It uses temporary profiles,
synthetic identity only, and no provider credentials or external model requests.
Set `FOOM_CLAUDE_EXECUTABLE` / `FOOM_CODEX_EXECUTABLE` to select an installed binary.
The script requires Linux and `bwrap`; administrator refusal is tested with private
mounts at the clients' system-policy locations, never edits to the host's `/etc`.

Verified on Linux: Claude Code **2.1.293**, Codex **0.161.0**. Both initialize,
list, and call `whoami` with environment-sourced bearer authentication, retain an
existing user-configured server, and refuse servers under a synthetic managed
allowlist denying all MCP. The probe checks the existing server definition is
preserved. Claude may update its own temporary profile bookkeeping. Codex sends
`_meta.progressToken` on listing; the adapter accepts protocol metadata without
passing it to the control service. Hook settings are independent of MCP attachment.

Attachment is enabled only for these exact releases with the appropriate help flag;
other versions and Antigravity report unverified attachment. Expanding this set
requires repeating the probe. Managed policy is still enforced by the client and
can deny an otherwise supported attachment; Foom does not override that policy.
Windows/macOS real-client policy probes remain unverified. The packaged CLI fallback
remains #154; this change does not promise a fallback executable before it exists.

### Console helper and local pairing (#154)

`foom` is a Node 24 SEA under `resources/app.asar.unpacked/build/console/`
(`Contents/Resources/` on macOS), separate from Electron's executable. ZIP users
can call its absolute path. `--version --json` reports application and protocol
versions; Node's runtime notices and a SHA-256/version manifest accompany it.
The build bundles only console and shared Node utilities, injects the SEA on the
build platform, disables runtime argument extension (including `NODE_OPTIONS`),
and ad-hoc signs the macOS helper. Electron's fuses remain unchanged.

Online commands are `whoami`, `sessions [--limit N] [--cursor ID]`,
`session-state ID`, and `operation-status --operation-id ID` (or
`--idempotency-key KEY`). Main's existing API decides authorization; ordinary
agents and human CLI grants cannot query orchestration operations. Responses use
stable `{result}` / `{error}` envelopes; `--json` also makes offline output JSON.
Exit status is 0 for success, 2 for usage/schema errors, 3 for authentication or
scope denial, and 4 for unavailable services, capacity, not-found or I/O errors.
No exception text or credentials are printed. Responses are bounded to 256 KiB,
including full 100-session pages with Unicode names; pairing responses are limited
to 4 KiB.

Human invocations add `--repository ABSOLUTE_REGISTERED_PATH` and optionally
`--profile ABSOLUTE_PROFILE_PATH` (needed for Foom Dev or custom profiles). Without
inherited credentials, Foom displays the same eight-hex-digit code as the console
in its trusted confirmation window. Approval grants only repository session metadata
for ten minutes. The request expires after 60 seconds; disconnect, shutdown,
rejection and removed registration refuse it. One request can await review,
requests are spaced by ten seconds, and at most four human grants are live.
The token is delivered over the pending connection, held only in console memory,
and released on completion or expiry. Discovery has no credentials. Ordinary
commands pair for one invocation; `foom pair --repository PATH --json` keeps one
process open and reads JSON argv arrays, one per line, for scripts or interactive
use, for example `["sessions","--limit","10"]`. No shell or arbitrary program is
executed. Any inherited session scope, including invalid or partial credentials,
prevents a fallback to pairing or another profile.

On Unix, `foom --install-cli /absolute/bin` creates an exclusive symlink and an
ownership record; `--uninstall-cli /absolute/bin` removes only the recorded link,
including a stale link after moving the ZIP. Existing commands and changed links
are refused. Foom does not edit shell startup files. On Windows, invoke the helper
by absolute path with `--install-cli` to add its dedicated directory to the user's
PATH; `--uninstall-cli` removes only its recorded entry, including the old entry
after moving the installation. Both actions broadcast the Windows environment
change so newly opened shells can inherit it. Existing shells must be reopened.
Unrelated PATH entries and registry value kind are retained. Foom-launched agents
get a process-local PATH addition independently of human installation. Antigravity
with `--prompt-interactive` support receives CLI guidance composed with initial
prompt data; no MCP configuration is installed.

`--validate-config PATH` is reserved for #84's offline, non-executing schemas.
Until those schemas ship, it returns `config_schema_unavailable` and exit 2,
without reading the path, pairing, opening a window, or accessing profile data.
#84's earlier Electron-based console recipe is superseded by this standalone
helper; its validation schemas and config-only capabilities remain #84's work.
