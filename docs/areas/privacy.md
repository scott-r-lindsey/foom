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
profile. Packaged builds first GET
`https://foom-term.com/u/v1/<channel>/<os>/<arch>/<version>` for update metadata.
The path contains the build channel (`stable` or `nightly`), operating system,
architecture and app version. Optional `d=1`, `w=1`, `m=1` query flags mark the
first check in each UTC day, ISO week and UTC month. Only three last-sent calendar
dates are stored in `update-activity.json` in the profile, validated at load;
invalid or missing dates mean never sent. Dates never move backwards, so turning
the clock back does not resend flags. A sent attempt consumes its flags even
when the endpoint fails. If the dates cannot be saved, the check uses the
channel's direct metadata source without activity flags; counting storage failures
never prevent update checks. No install ID, counters or request-linking identifiers
are stored or sent.

The [counting endpoint contract](https://github.com/scott-r-lindsey/foom-site/issues/34)
excludes client IP and other identifying fields from its logs; it retains only
path fields and flags for aggregate active-install counts. The server necessarily
receives the IP to serve the request. Requests have no body, terminal content,
repository paths, agent identities, cookies, tokens or account credentials.
There is no telemetry beyond these disclosed anonymous update-check counts.

Network failures, timeouts and non-2xx responses fall back to the channel's
existing source: update.electronjs.org for stable macOS, api.github.com latest
release metadata for stable Linux, and the static foom-term.com
`/updates/nightly/<os>-<arch>/latest-mac.json` (macOS) or `latest.json`
(Linux/Windows) feed for nightlies. Fallback requests contain no activity flags;
these servers see the client IP and request metadata. Windows remains nightly-only.
See the [nightly feed contract](../architecture.md#nightly-update-feed-604).
Development launches never check; automated tests inject fixture HTTP adapters.

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
controls proxy and fallback metadata, ZIP downloads and notices. Nightlies use
only foom-term.com, including the
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

## Image paste (#937)

Image paste is an explicit user action, shared by keyboard and terminal-menu Paste;
Foom never watches the clipboard. Nonempty text wins. For supported agent sessions,
Foom normalizes one image to a metadata-free PNG and inserts a labeled file reference
without Enter. When the agent reads it, the image enters that agent's context and
may reach its model provider under the agent's settings. Remote sessions first
upload the normalized PNG through SSH to the user's own host; Foom never opens the
remote path on the hub. There is no disclosure dialog or automatic model request.

Private per-session files stay outside checkouts, with size/count/pixel limits.
The session owner deletes them on exit/close, with startup purge after crashes;
hiding a tile or losing SSH does not delete a live remote session's images. There
is no age expiry. Cleanup is not secure erase and does not cover agent-made copies,
transcripts, backups or provider retention. Clipboard/image bytes, hashes and paths
are excluded from diagnostics, action-log payloads and telemetry. Reference text may
naturally appear in terminal echo, prompts, transcripts and authorized tails.

Standard image reads use Electron's supported clipboard API. Chromium decodes PNG
in the browser process before Foom can enforce byte/pixel limits or start its
disposable worker; Foom's JavaScript deadline cannot interrupt that native decode.
A user explicitly pasting a hostile or huge copied image can hang or crash Foom.
The user accepted this residual on 2026-10-30: it uses Chromium's existing web
image-paste decoding surface and adds no code-execution mechanism beyond it;
upstream Chromium vulnerabilities remain possible. Electron 44 removed raw
`readBuffer`/`availableFormats` access; revisit if it restores raw clipboard reads.
Foom performs no additional `nativeImage`/`readImage` conversion. Encoded bytes go
directly to the disposable worker for Foom's bounded normalization, and the encoded
result is validated again. See the [accepted residual](../design/937-image-paste.md#accepted-clipboard-decode-residual-user-decision-2026-10-30).
