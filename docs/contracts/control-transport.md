# Control Transport

## Transport, packaging and discovery

Choose **Streamable HTTP on `127.0.0.1` with an OS-assigned port**. Main hosts
`/mcp` and a versioned CLI endpoint `/control/v1`; both call the same service.
This avoids spawning an MCP proxy for every agent and lets read-only MCP ship
before the console helper. HTTP is supported by both verified MCP clients.
The opt-in Antigravity plugin (#855) uses `foom mcp` as an environment-only stdio
bridge to the same authenticated `/mcp` endpoint. It has no discovery/pairing path
and no additional policy or listener. It forwards newline-delimited JSON with
64 KiB request and 256 KiB response bounds and a 65-second request deadline;
HTTP session/protocol headers stay in memory. Redirects, invalid endpoints and
missing/malformed launch credentials fail closed.

Authenticate every request, including initialization, tool listing, and stream
reconnection. Reject browser Origin headers and any Host other than the actual
loopback literal and bound port; no CORS, redirects, URL tokens, or nonloopback
binding. An MCP session ID is protocol state, never authorization. Bind it to the
principal and recheck revocation on every request. Initially use JSON responses
and bounded `wait_for` calls or a blocking `foom wait-for --until-event` command.
Echo a supported requested MCP protocol version; otherwise return Foom's latest
supported version for the client to accept or disconnect. Validate subsequent
protocol headers against the negotiated session version. Bound headers to 8 KiB,
bodies to 64 KiB, connections to 32, and concurrent calls to four per principal.
[MCP transport requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

The Electron executable is not the CLI runtime. Keep `RunAsNode` disabled and
retain sandbox, context isolation, CSP and asset restrictions.
[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

Package `foom` / `foom.exe` as a **separate console executable**, built from bundled
TypeScript under `src/cli/` with Node 24's single-executable application machinery.
It only parses arguments and calls the API; main still owns git, PTYs and policy.
The helper ships with packaged builds. Build and test on each target
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
