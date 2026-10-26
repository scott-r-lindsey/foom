# Console

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
`--idempotency-key KEY`). Orchestrators also have the commands below; each maps
to the same control API used by MCP. Main's existing API decides authorization; ordinary
agents and human CLI grants cannot query orchestration operations. Responses use
stable `{result}` / `{error}` envelopes; `--json` also makes offline output JSON.
Exit status is 0 for success, 2 for usage/schema errors, 3 for authentication or
scope denial, 4 for unavailable services, capacity, not-found or I/O errors, 5 for an
overall blocking-wait timeout (which still prints the metadata result), and 6 for
an unknown mutation outcome.

`create-worktree`, `launch`, `stop`, `close`, `remove-worktree`, `prompt` and `send-keys` wait up
to 60 seconds for a response. A timeout, lost connection or unreadable response
prints `{ "error": "unknown_outcome", "idempotencyKey": "KEY" }` to stderr and
exits 6: the action may have been accepted or succeeded. With the same credentials,
run `foom operation-status --idempotency-key KEY` to recover the operation record.
Continue checking that key if it is running or pending confirmation. Never retry
with a new key; even `not_found` does not establish that nothing happened. An
unresolved or indeterminate outcome requires human reconciliation. A received
server error keeps its existing error envelope and exit code.
No exception text or credentials are printed. Responses are bounded to 256 KiB,
including full 100-session pages with Unicode names; pairing responses are limited
to 4 KiB.

Orchestrator commands (all support `--json`):

```text
foom create-worktree BRANCH --idempotency-key KEY
foom create-worktree --pull-request N [--review] --idempotency-key KEY
foom launch WORKTREE_ID --agent claude|codex|agy [--prompt TEXT] --idempotency-key KEY
foom stop ID --idempotency-key KEY
foom close ID --idempotency-key KEY
foom remove-worktree WORKTREE_ID --idempotency-key KEY
foom read-handoff ID [--seq N]
foom tail ID [--lines 1-40]
foom wait-for ID... [--after '{"ID":"REVISION"}'] [--timeout-ms 0-30000]
foom wait-for [ID...] --until-event [--after '{"ID":"EVENT"}'] [--timeout SECONDS]
```

Every mutation requires an idempotency key. After losing a response, query
`operation-status --idempotency-key KEY`; reusing a key with different input is
refused. Removal follows the [trusted confirmation and narrow automatic-removal policies](control-mutations.md#orchestrators-and-children-155).
The optional `--review` flag is valid only with `--pull-request`; it creates a
detached review checkout without a branch, including while the author branch is
in use. `tail` retains secret
redaction, the 40-line/16 KiB cap and one request per child per second; `wait-for`
accepts one to the configured child limit of distinct IDs and waits at most 30 seconds. The console gives
that wait a 35-second transport deadline.

`--until-event` removes the transport deadline and waits for a watched child's
lifecycle state, handoff, PR state or required-check conclusion to change. Terminal
output and input alone never end it; a session `revision` also moves with output,
so long waits compare a separate `event` cursor that each returned session carries.
Without IDs it snapshots the caller's currently owned children; at least
one child is required, and children launched later are not added to that wait.
Without `--after`, it captures current cursors and waits for the next change;
`--after` takes the `event` values from a previous long-wait result, or session
`revision` values. A revision that is still current adopts the current cursor; any
other value has already changed and returns immediately. The same owned-child
checks and configured ID limit apply. `--timeout SECONDS` is an optional overall
integer deadline (0–2147483 seconds); `--timeout-ms` is also accepted with this mode
(0–2147483647), but cannot be combined with `--timeout`. The result is the same
`{ sessions, changed, timedOut }` metadata as `wait_for`, inside the usual `{result}`
envelope. Success exits 0; timeout exits 5. Role revocation returns an error.
The `whoami` tool entry advertises this form as `longWait`. The CLI sends
`wait_for` with `untilEvent: true` and optional `ids`, `after` and `timeoutMs` over
the versioned HTTP endpoint; MCP continues to reject that extra parameter.
A disconnected console releases its subscription. Main shares metadata change
notifications and one optional deadline scheduler across subscribers; a waiter
owns no polling loop, terminal attachment or per-wait timer. The MCP `wait_for`
remains bounded to 30 seconds. A background CLI command can therefore wake an
agent that supports background completion notifications without a polling loop.

Arguments are validated in both the console and main. Tokens are never accepted as arguments or printed. Ordinary
sessions, children (including taken-over children), and human pairing grants
cannot mutate or read child output through these commands; denial is exit 3.

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

Offline validation uses `foom config validate PATH`; see [the console ownership contract](../areas/control.md#control-plane).

### Public hook client (#635)

`foom hook EVENT [--channel ID]` dispatches before control discovery, pairing and
JSON output handling. It reads at most 64 KiB of UTF-8 JSON stdin and sends only
to the literal loopback hook URL using the environment's launch credential.
Missing URL/session/token makes it immediately inert with exit 0 and no output,
stdin read or network call. All outcomes are silent. See [protocol 1](../agent-plugins.md#user-authored-extensions-public-hook-protocol-1-635)
for channel selection, exit codes and extension ownership.
