# Privacy

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Secrets

Use Electron `safeStorage` for any secret Foom stores; never store plaintext or expose
secrets to the renderer. Local evaluation makes no model requests. Terminal
transport stays local except SSH between the user's own Foom and user-provided
hosts (#753). The explicit [config-owned probe screen capability](probes.md) and
[orchestrator child tails/reports](../contracts/control-privacy.md#output-privacy-and-visibility)
can return output to the requesting agent’s context, where it may reach that
agent’s model provider under its own provider settings.

The opt-in [remote shell spike](terminals.md#remote-shell-spike-754) transports
terminal input, output and screen replay through system SSH. SSH owns trust and
authentication; Foom never copies keys, agent credentials or hub environment
values to a host. There is no TCP listener on the remote host and no new
authentication system. Hosts are user-provided; Foom provisions nothing. Remote
messages grant no access to the hub control surface. PTY content and remote stderr
are excluded from transport diagnostics.

On profile load, `SettingsStore` drops legacy `inference` and `inferenceTimeoutMs`
fields and atomically saves the migrated settings. It deletes the three fixed
`inference-{anthropic,openai,google}.key` ciphertext files and strictly UUID-named
temporary key files left by interrupted writes, without decrypting them. Unrelated files are preserved.
Environment secrets (#215) are the only stored secrets; see
[Launch environment](agent-launch.md#launch-environment-215).
Cleanup is idempotent and does not require OS encryption to be available; deletion
errors fail startup instead of silently retaining secrets. Removed setup key/probe
IPC channels have no handlers, and inference fields remain invalid in IPC patches.

`terminal-tail.ts` retains `prepareTail` for control metadata redaction. It removes
likely labelled credentials, bearer/API tokens, JWTs, URL credentials and private-key
blocks before selecting at most 40 physical lines. Truncated private-key fragments
are redacted too. Oversized input is rejected. Redaction is heuristic and cannot
identify every unlabelled secret.

## Update requests (#603)

**Check for updates** in Settings → General defaults on and persists only in the
profile. It controls all update checks: stable macOS checks update.electronjs.org;
stable Linux anonymously GETs GitHub's latest-release metadata at api.github.com;
CI-stamped nightly builds anonymously GET their platform/architecture feed at
foom-term.com, with macOS installing on normal quit and Linux/Windows showing
notices only. Windows remains nightly-only. See the [nightly feed contract](../architecture.md#nightly-update-feed-604).

These servers see the client's IP and Foom version. Requests contain version and
platform (macOS feed includes architecture), no terminal content, paths, agent
identities, cookies, tokens or account credentials. There is no telemetry.
Metadata GETs are bounded and reject redirects. Only fixed local status words
reach Settings; remote errors and release notes are never rendered. Opt-out stops
future checks and aborts pending metadata and ZIP GETs. A request already sent may
have reached its server, and received bytes cannot be recalled. No native check
starts after opt-out. A local native copy/verification already started may finish
and stage an update (or fail); that update, or one staged before opt-out, may
still install on normal quit. Foom never
restarts automatically. See [update behavior](../product.md#updates-603).

Stable macOS ZIP downloads are owned by Foom, not Squirrel. The metadata must
identify a strictly newer stable version and an HTTPS ZIP under this repository's
`github.com/scott-r-lindsey/foom/releases/download/vX.Y.Z/` path, with matching
architecture and version in its filename. Foom follows at most three redirects,
only to `release-assets.githubusercontent.com/github-production-release-asset/1394006699/`
(Foom's repository ID). The chain shares one abort signal, size budget and total
deadline, with per-request inactivity limits. Redirect and error bodies are never
drained: those responses are immediately destroyed. All hops close on completion,
failure or opt-out before preparation returns.
GitHub's download hosts see the IP and request metadata, including the offered
version in the URL. No user/account credentials are attached; GitHub's temporary
asset URL query is used only for the asset request. The same Settings switch
controls macOS metadata, ZIP downloads and GitHub API notices; no other hosts
are added for stable builds. Nightlies use only foom-term.com, including the
immutable commit-scoped ZIP path, with no redirects and SHA-256 verification.
That server sees the IP and request metadata, including platform/architecture
and offered commit in archive URLs. Electron receives only private local feed and archive `file:` URLs,
with remote extra fields discarded, so native work cannot start a network request.


Remote phase-2 agent hooks are reduced on the host before SSH relay; raw payloads
and transcript paths are discarded. Only bounded authorized handoffs, fixed manual
pages and a sanitized launch alias return through the remote control endpoint.
Hub Environment settings, stored secrets and control tokens are not sent to hosts.
The remote account's existing CLI logins stay on that host. See
[the phase-2 boundary](agent-launch.md#remote-agent-phase-2-755).
## Opt-in Antigravity plugin MCP (#855)

Installing or updating the disclosed Foom lifecycle plugin also installs one
stdio MCP launcher. Only Foom launches receive its environment credentials;
ordinary agy invocations exit without contacting Foom. Plugin files store no tokens.
The launcher executes the bundled `foom mcp` bridge, which forwards authenticated
requests only to that launch's loopback server. Main retains role, child-ownership,
output-privacy and revocation checks; MCP adds no authority to prompt text.
Explicitly scoped child tails/reports can enter the requesting agent's model
context under the [existing disclosure](../contracts/control-privacy.md#output-privacy-and-visibility).
No global MCP config or credentials are written. Existing installations offer an
explicit Update, with the MCP server included in the trusted disclosure.
