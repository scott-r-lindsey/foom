# Forge Status

## Forge kind (#520 / #521)

[Forge manifests](../forge-plugins.md) adds `kind: "forge", version: 1` to the same
plugin system. `shared/plugin-parser.ts` dispatches before kind-specific validation;
agents accept only version 2. The config scanner now uses this dispatcher for `agents/` and `forges/`, rejects
wrong-kind files and applies its existing contained-directory, bounded-read and
watcher rules to both. Each kind has its own 50-file cap and ID namespace.

The first #521 stage implements offline forge validation, a build-locked GitHub
manifest and a transport-injected interpreter with parity tests. The second stage
adds a declarative dynamic batch plan with the same parser and interpreter for
bundled/config copies; it keeps all-check board counts separate from required-only
conclusions. It grants no CLI,
host assignment or enablement capability. Settings cards now expose validated manifests and profile-only enablement/host assignments; active-provider migration remains gated. The no-approval/no-Duplicate workflow applies to forge cards. See [current forge ownership](../areas/forge.md).
