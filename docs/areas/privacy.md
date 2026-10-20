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
