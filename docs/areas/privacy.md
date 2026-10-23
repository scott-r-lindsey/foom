# Privacy

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners. User-visible rules: [behavior](../behavior/orchestration.md).

## Secrets

Use Electron `safeStorage` for any secret Foom stores; never store plaintext or expose
secrets to the renderer. Terminal content stays local except the explicit
[config-owned probe screen capability](probes.md).
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
CI-stamped nightly builds on every platform anonymously GET the rolling nightly
prerelease there. Windows is notice-only and currently nightly-only. No nightly
build installs in place (#604).

These servers see the client's IP and Foom version. Requests contain version and
platform (macOS feed includes architecture), no terminal content, paths, agent
identities, cookies, tokens or account credentials. There is no telemetry.
Metadata GETs are bounded and reject redirects. Only fixed local status words
reach Settings; remote errors and release notes are never rendered. Opt-out stops
future checks and aborts a pending metadata GET; native downloads already in
progress may complete and staged macOS updates still install on normal quit.
Foom never restarts automatically. See [update behavior](../product.md#updates-603).

On stable macOS, the native updater also downloads the signed ZIP from the GitHub
release asset URL returned by update.electronjs.org, including GitHub release
asset hosts. The same switch controls metadata checks, notice API GETs and these
native downloads; no other hosts are added. GitHub's download servers also see
the client IP and request metadata. Native downloads already started cannot be
cancelled through Electron's updater API; opting out prevents new checks and
downloads, but an in-flight download may finish and a staged update may install
on normal quit.
