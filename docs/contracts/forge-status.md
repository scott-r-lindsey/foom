# Forge Status

## Forge kind (#520 / #521)

[Forge manifests](../forge-plugins.md) adds `kind: "forge", version: 1` to the same
plugin system. `shared/plugin-parser.ts` dispatches before kind-specific validation;
agents accept only version 2. The config scanner now uses this dispatcher for `agents/` and `forges/`, rejects
wrong-kind files and applies its existing contained-directory, bounded-read and
watcher rules to both. Each kind has its own 50-file cap and ID namespace.

Production forge selection uses the build-locked GitHub and GitLab manifests and the same
interpreter for bundled/config copies. Dynamic batch plans keep all-check board
counts separate from required-only conclusions. Main owns bounded scheduling,
read-only argv execution, auth/executable validation and checkout/ownership policy.
Only the user's enabled `forgeHosts` assignments authorize routing; manifest host
declarations grant none. The no-approval/no-Duplicate workflow also applies to
forge cards. Recorded-fixture parity passed before the production legacy path was
removed. Optional display enrichment cannot change verified status; checks-meaning metadata
is published and persisted with observations.

See [current forge ownership](../areas/forge.md).
