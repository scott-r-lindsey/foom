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

User-authored code extensions can report lifecycle observations through the
[public hook protocol 1](agent-plugins.md#user-authored-extensions-public-hook-protocol-1-635).
`foom hook` sends bounded stdin JSON using only the current launch's hook credential;
external manifest channels attach no files or arguments. The existing hook receiver
owns authentication, reduction, dedupe, conversation pinning and revocation. The
extension is installed by the user, with no global agent configuration writes by
Foom or its config agent.
