# Architecture

Start with the [file map](map.md) and read the rules for the area you are changing. Decided rules live in the linked area and behavior documents; protocol details live in the contract documents. Changes to established decisions require their own PR and matching docs.

## Application profiles

See [Application profiles](areas/application.md#application-profiles).

## Process model

See [Process model](areas/boundaries.md#process-model).

## Security defaults

See [Security defaults](areas/boundaries.md#security-defaults).

## Source layout

See [Source layout](areas/boundaries.md#source-layout).

## Board

See [Board](areas/board.md#board).

## Renderer

See [Renderer](areas/renderer.md#renderer).

## Multiple windows

See [Multiple windows](areas/windows.md#multiple-windows).

## Terminals

See [Terminals](areas/terminals.md#terminals).

## IPC contract

See [IPC contract](areas/ipc.md#ipc-contract).

## Confirmations

See [Confirmations](areas/confirmations.md#confirmations).

## Worktrees

See [Worktrees](areas/worktrees.md#worktrees).

## Agent discovery and launch

See [Agent discovery and launch](areas/agent-launch.md#agent-discovery-and-launch).

## Control plane

See [Control plane](areas/control.md#control-plane).

## Settings and setup

See [Settings and setup](areas/settings.md#settings-and-setup).

## Agent signals

See [Agent signals](areas/agent-hooks.md#agent-signals).

## Saved conversations

See [Saved conversations](areas/sessions.md#saved-conversations).

## Evaluator pipeline

See [Evaluator pipeline](areas/evaluator.md#evaluator-pipeline).

## Secrets

See [Secrets](areas/privacy.md#secrets).

## Tile renderer measurement

See [Tile renderer measurement](areas/terminal-rendering.md#tile-renderer-measurement).

## Recorded sounds

See [Recorded sounds](areas/sound.md#recorded-sounds).

## Board shortcut definitions

See [Board shortcut definitions](areas/commands.md#board-shortcut-definitions).

## Agent execution

See [Agent execution](areas/execution.md#agent-execution).

## Sidebar panels and home shells (#197)

See [Sidebar panels and home shells (#197)](areas/panels.md#sidebar-panels-and-home-shells-197).

## Custom theme files (#205)

See [Custom theme files (#205)](areas/themes.md#custom-theme-files-205).

## Foom config environment (#84)

See [Foom config environment (#84)](areas/config.md#foom-config-environment-84).

## User interface themes version 2 (#246)

See [User interface themes version 2 (#246)](areas/themes.md#user-interface-themes-version-2-246).

## Previews

See [Previews](areas/previews.md#previews).

## Agent provider registry and manifest approval (#407)

See [Agent provider registry and manifest approval (#407)](areas/providers.md#agent-provider-registry-and-manifest-approval-407).

## Config-owned probe capability (#591)

See [Config-owned probe capability (#591)](areas/probes.md#config-owned-probe-capability-591).

<a id="launch-environment-215"></a>
See [area rules](areas/agent-launch.md#launch-environment-215).

<a id="preview-actions"></a>
See [area rules](areas/preview-actions.md#preview-actions).

<a id="agent-preview-view-actions-297"></a>
See [area rules](areas/preview-actions.md#agent-preview-view-actions-297).

<a id="mcp"></a>
See [area rules](areas/mcp.md#mcp).

<a id="console"></a>
See [area rules](areas/console.md#console).

<a id="orchestration"></a>
See [area rules](areas/orchestration.md#orchestration).

<a id="forge"></a>
See [area rules](areas/forge.md#forge).

<a id="forge-observations"></a>
See [area rules](areas/forge.md#forge-observations).

<a id="handoffs"></a>
See [area rules](areas/handoffs.md#handoffs).

<a id="action-log"></a>
See [area rules](areas/action-log.md#action-log).

<a id="child-authority"></a>
See [area rules](areas/child-authority.md#child-authority).

<a id="agent-editable-settings-format-206"></a>
See [area rules](areas/settings.md#agent-editable-settings-format-206).

<a id="shell-lifecycle-status"></a>
See [area rules](areas/shells.md#shell-lifecycle-status).

<a id="webgl-renderer-620"></a>
See [area rules](areas/terminal-rendering.md#webgl-renderer-620).

<a id="agent-title-progress-and-screen-evidence"></a>
See [area rules](areas/evaluator.md#agent-title-progress-and-screen-evidence).

<a id="stable-codex-hook-health"></a>
See [area rules](areas/execution.md#stable-codex-hook-health).

<a id="antigravity-plugin-ownership"></a>
See [area rules](areas/execution.md#antigravity-plugin-ownership).

<a id="foreground-shell-program-names"></a>
See [area rules](areas/shells.md#foreground-shell-program-names).

<a id="terminal-font-selection-363"></a>
See [area rules](areas/fonts.md#terminal-font-selection-363).

<a id="consolidated-agent-settings-409"></a>
See [area rules](areas/providers.md#consolidated-agent-settings-409).

<a id="config-decisions-and-live-launch-catalogs-591-follow-up"></a>
See [area rules](areas/probes.md#config-decisions-and-live-launch-catalogs-591-follow-up).

## Coded capability errors

See [Coded capability errors](areas/errors.md#coded-capability-errors) and [pruning stale worktrees](areas/worktrees.md#pruning-stale-worktrees).

## External lifecycle hooks

See [Agent hooks](areas/agent-hooks.md) and [public hook protocol 1](agent-plugins.md#user-authored-extensions-public-hook-protocol-1-635).

### Probe verification (#593)

See [probe verification](areas/probes.md#probe-verification-593).

## Packaging and macOS signing (#601)

Forge owns one fresh production build before packaging. It seals ASAR and fuses,
then invokes `scripts/macos-sign.mjs adhoc` on macOS, including PR CI. Every
regular Mach-O file is discovered by its header and signed before its containing
framework/helper/application bundle; symlink aliases are skipped. Developer ID
signing never uses `--deep`. Strict verification does use `--deep`.

The bundle identifier is `com.foom-term.foom`. Existing macOS installs previously
used `com.foom.desktop`. Electron's default user-data path is based on the app
name, so this identifier change keeps `~/Library/Application Support/Foom`.
The safeStorage Keychain service remains based on the product name, but the
changed signing identity/designated requirement can require Keychain access
approval for the existing `Foom Safe Storage` item. Existing encrypted data is
not migrated, copied or deleted by this change.

After the Quality gate, a main-only `Release` environment job downloads the
already-tested macOS ZIP, signs it with Developer ID and hardened runtime plus
secure timestamp, notarizes through notarytool API-key mode, staples and verifies
it. It preserves the ASAR bytes, embedded integrity record and hardened fuse
values, and re-zips with `ditto -c -k --keepParent` without rebuilding. Signing refreshes
the unpacked console manifest SHA-256 before sealing the containing app, because
the SEA code signature changes its bytes; the ASAR archive is never rewritten. It must
pass strict codesign verification, Gatekeeper assessment reporting `Notarized
Developer ID`, and stapler validation. A separate publisher with contents write
permission consumes that signed artifact alongside tested Linux/Windows installers and ZIPs;
the signing job has only contents read permission and no publication authority.

PR macOS CI uploads and downloads the tested ZIP artifact before exercising the
same signing path ad-hoc. Both modes recursively require exactly one ZIP in the
download directory: the `out/make/` upload retains `zip/darwin/arm64/`
under the artifact root. Missing or ambiguous ZIPs fail before unpacking. Failure
output masks only the six Release secret values, their PEM lines longer than 16
characters, and command-specific password/identifier arguments. ZIP and keychain
file paths remain visible; `ditto -k` is an archive option, not a password flag.

The only Developer ID entitlement is `com.apple.security.cs.allow-jit` for
Electron/V8 (main and helpers, including the utility host) and the Node 24 SEA
console. node-pty's native addon is signed with the same team and needs no
library-validation exception. Its spawn-helper and native observers need no
entitlements. No unsigned executable-memory or sandbox-inheritance exception
is granted. Ad-hoc runtime signatures additionally disable library validation
because they lack a team identity; Developer ID signatures never do.

Only `macos-sign` and `macos-credentials` declare `environment: Release` and can
read `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. Signing runs on desktop-required main pushes and scheduled/opt-in main runs;
credential checks are manual main runs only. PR jobs have no secret
references. Temporary mode-600 certificate/private-key files and a random-password
keychain are removed in an `always()` step, even on failure. Setup snapshots the
user keychain search list before creating the temporary keychain, then prepends it
while preserving existing entries. Cleanup restores the original list before
deleting the temporary keychain, including after partial setup failures. The
default keychain stays unchanged. Setup signs and strictly verifies a disposable
copy of `/usr/bin/true` with the imported identity and timestamping disabled, so
private-key lookup failures surface before application signing. Required Apple CLI
password/identifier arguments are allowed on these ephemeral runners, with env
inputs, generated/derived masking, and no command tracing or credential logging.

After merge, run CI on main with `check_macos_credentials: true` alone. This
imports the certificate, requires exactly one Developer ID Application identity
for the configured team, proves signing with the disposable binary, and runs
`notarytool history`, without an application build or artifact upload. Once it passes, run CI on main with
`publish_nightly: true` and credential checking disabled. These are human
operations; neither is dispatched by the implementation. Windows remains unsigned
(#665) and its installers ship on the nightly channel only. See
[installer validation and draft release procedure](validation.md#installers-and-versioned-drafts-602)
for DMG notarization and tag publication. Auto-update remains #603.
