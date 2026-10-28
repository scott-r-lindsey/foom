# File map and required reading

Read [AGENTS.md](../AGENTS.md), then the implementation rules and behavior for the
area you will change. Read additional contract sections only when changing that
surface. These are decided rules; changing a decision needs its own PR and docs.
[Documentation authority](README.md#authority-and-maintenance) explains precedence.

## Selection rules

The first column contains full repository-relative paths, directory prefixes ending
in `/` (all descendants), or globs (`*` matches within one path segment, `**`
spans directories). No sibling abbreviations are implied. Read the **union** of
required links from every matching row; a specific feature row adds to the process
row rather than replacing it. Follow a link's fragment when present. Responsibility
prose describes ownership but does not add patterns.

`pnpm run docs:check` checks every tracked non-instruction file under `src/`,
including assets and declarations, against these patterns, and rejects patterns
that match no tracked source. It also checks local Markdown links and anchors in
tracked documentation and instruction files. External URLs are not fetched; fenced,
indented and inline code examples are inert. Preview attack/sample documents under
`tests/fixtures/previews/`, `inspiration/`, `docs/mockups/`, `spikes/`, dependencies
and generated output are excluded from document scanning. Links to reference files
still require an existing target. Add the owning feature row when adding a feature;
a generic process route alone does not identify feature policy.

| Area / source owner | Responsibility and entry points | Required area rules / behavior |
| --- | --- | --- |
| `src/renderer/board/error-presentation.tsx`, `src/shared/application-error.d.ts`, `src/shared/application-errors.ts` | Fixed coded failures, action dialogs, focus restoration and operation-scoped background marks | [Errors](areas/errors.md), [behavior](behavior/errors.md) |
| `src/main/main.ts`, `src/main/wiring/`, `src/main/profile.ts`, `src/main/installer.ts` | Entry delegates to `application.ts` (startup/security/quit), `window.ts` (per-board composition), `workspace.ts` (app-wide services); live bindings in `application-wiring.d.ts` | [Boundaries](areas/boundaries.md), [profiles](areas/application.md) |
| `src/main/updates.ts`, `src/main/update-http.ts`, `src/main/update-package.ts` | App-owned update checks, fixed channel notices, native quit-time installation and anonymous metadata GETs | [Application](areas/application.md#updates-603), [settings](areas/settings.md), [privacy](areas/privacy.md#update-requests-603), [update policy](product.md#updates-603) |
| `src/manual/`, `src/main/window/manual-shortcuts.ts` | Bundled offline user guide and build-time shortcut tables; prose follows current behavior and area docs | [Previews](areas/previews.md#bundled-manual-root), [commands](areas/commands.md), [brand](brand.md) |
| `src/main/window/` | `window-ipc.ts` routes registered windows; `terminal-views.ts` reserves views; `window-placement.ts` persists geometry; `window-audio.ts` elects sound owner | [Windows](areas/windows.md), [behavior](behavior/windows.md) |
| `src/shared/board-commands.ts`, `src/main/window/commands.ts`, `src/main/window/app-menu.ts`, `src/main/window/attention-badge.ts` | One command registry, shortcut dispatch, menu projections and native attention counts | [Commands](areas/commands.md), [menus](behavior/menus.md) |
| `src/main/terminals/`, `src/terminal-host/` | `terminal-ipc.ts` grants ID-scoped capabilities; `terminal-host-client.ts` brokers host requests; `terminal-manager.ts` owns PTYs/headless xterms; snapshot, activity, foreground and shell integration helpers stay in the host | [Terminals](areas/terminals.md), [shell lifecycle](areas/shells.md), [tile behavior](behavior/tiles.md) |
| `src/main/workspace/workspace.ts`, `src/main/workspace/workspace-context.ts`, `src/main/workspace/workspace-feature-wiring.ts`, `src/main/workspace/workspace-ipc.ts` | Public facade delegates to the internal coordinator; context owns shared reservations/locks, terminal queues, cancellation, owner initialization, persistence delegates and shutdown; IPC validates workspace requests | [Launch/composition](areas/agent-launch.md), [worktrees](areas/worktrees.md), [sessions](areas/sessions.md), [evaluator](areas/evaluator.md) |
| `src/main/workspace/worktree-launch.ts` | Discovery caching, provider setup, agent/shell/home launches, existing checkouts and pasted resumes | [Launch](areas/agent-launch.md), [sessions](areas/sessions.md), [panels/home](areas/panels.md) |
| `src/main/workspace/sidebar-commands.ts` | Sidebar inventory/dispatch, checkout creation/removal, config sessions and probe credentials | [Worktrees](areas/worktrees.md), [config](areas/config.md), [probes](areas/probes.md), [sidebar behavior](behavior/sidebar.md) |
| `src/main/workspace/orchestration-commands.ts`, `src/main/workspace/workspace-orchestration-host.ts` | Role changes, child worktree/agent launches, terminal execution events and ordered evaluation | [Orchestration](areas/orchestration.md), [execution](areas/execution.md), [evaluator](areas/evaluator.md) |
| `src/main/workspace/workspace-capabilities.d.ts`, `src/main/workspace/workspace-types.d.ts` | Independent capability contracts per feature; dependencies and feature method signatures | [Launch/composition](areas/agent-launch.md), [boundaries](areas/boundaries.md) |
| `src/main/workspace/worktrees.ts`, `src/main/workspace/worktree-store.ts`, `src/main/workspace/worktree-identity.ts`, `src/main/workspace/worktree-fetch-state.ts`, `src/main/workspace/worktree-panel-facts.ts`, `src/main/workspace/worktree-merge-policy.ts`, `src/main/workspace/worktree-branch-cleanup.ts`, `src/main/workspace/merge-proof.ts`, `src/main/workspace/worktree-state.d.ts`, `src/main/workspace/fetch-default.ts`, `src/main/workspace/cleanup-owner.ts`, `src/main/workspace/cleanup-run.ts`, `src/main/workspace/inventory-watch.ts`, `src/main/workspace/worktree-operations.ts`, `src/main/workspace/worktree-features.d.ts`, `src/main/workspace/worktree-outcome.ts`, `src/main/workspace/review-worktrees.ts` | Git membership/identity, repository persistence, fetches, merged cleanup and local inventory watching | [Worktrees](areas/worktrees.md), [board inventory](areas/board.md), [behavior](behavior/worktrees.md) |
| `src/main/workspace/session-owner.ts`, `src/main/workspace/session-store.ts`, `src/main/workspace/session-restore.ts`, `src/main/workspace/session-lifecycle.ts`, `src/main/workspace/home-shell.ts`, `src/main/workspace/session-restore.d.ts` | Session records, restore/restart/quit freeze, exit phases/releases, home launch; owners receive narrow dependencies, never the facade/coordinator | [Sessions](areas/sessions.md), [panels/home](areas/panels.md), [behavior](behavior/sidebar.md) |
| `src/main/workspace/execution-owner.ts`, `src/main/agents/execution.ts`, `src/main/workspace/waiting-state.ts` | Invocation execution, evidence, evaluation generations, feedback and dismissal; `waiting-state.ts` projects child waiting | [Execution](areas/execution.md), [evaluator](areas/evaluator.md), [attention behavior](behavior/attention.md) |
| `src/main/evaluator/` | Pure local classification, bounded agent rules, tail redaction and verdict log | [Evaluator](areas/evaluator.md), [privacy](areas/privacy.md), [attention behavior](behavior/attention.md) |
| `src/main/agents/`, `src/main/login-shell.ts` | `agents.ts` discovers/launches; `hook-receiver.ts` authenticates observations; login-shell isolation and environment layering | [Launch](areas/agent-launch.md), [hooks](areas/agent-hooks.md), [execution](areas/execution.md) |
| `src/main/agents/providers/` | Registry, bundled/config v2 loading, launch/MCP/hooks, immutable mappings and observed health | [Providers](areas/providers.md), [manifest contracts](agent-plugins.md) |
| `src/main/agents/probe-*.ts`, `src/main/agents/probes.ts` | Config-credential-owned scratch probes, prompt/input, screen and reminder projection | [Probes](areas/probes.md), [behavior](behavior/probes.md), [capture/replay](contracts/agent-report.md#saved-screen-rule-regressions-592) |
| `src/main/control/remote-control.ts`, `src/main/control/service.ts`, `src/main/control/runtime.ts`, `src/main/control/http.ts`, `src/main/control/http-limits.ts`, `src/main/control/mcp.ts`, `src/main/control/manual.ts`, `src/main/control/manual-mcp.ts`, `src/main/control/store.ts`, `src/main/control/operations.ts`, `src/main/control/pairing.ts`, `src/main/control/metadata.ts`, `src/main/control/types.d.ts` | Authorization policy, adapters, grants, durable idempotency/audit and human pairing | [Control foundation](areas/control.md), [MCP](areas/mcp.md), [protocol contracts](orchestration.md), [validation gates](areas/control-validation.md) |
| `src/main/control/orchestration-authority.ts`, `src/main/control/orchestration-mutations.ts`, `src/main/control/orchestration.ts`, `src/main/control/orchestration.d.ts`, `src/main/control/review-loops.ts`, `src/main/control/review-loops.d.ts`, `src/main/control/orchestration-limits.ts`, `src/main/control/review-effects.ts`, `src/main/control/finished-child-closer.ts`, `src/main/control/orchestration-automation.ts`, `src/main/control/orchestration-automation.d.ts`, `src/main/workspace/review-snapshot.ts` | Authority/limits/lifecycle and optional child review loops; worktree and child mutations; dispatch/input/tails/waits; shared host/state declarations | [Orchestration](areas/orchestration.md), [child authority/input](areas/child-authority.md), [behavior](behavior/orchestration.md) |
| `src/main/control/handoffs.ts`, `src/main/control/child-events.ts`, `src/main/control/unread-child-events.ts` | Bounded child reports, shared invalidation and unread reminders | [Handoffs](areas/handoffs.md), [report contract](contracts/control-handoffs.md), [behavior](behavior/orchestration.md) |
| `src/main/control/forge*.ts` | PR/check mapping, lifecycle/interpreter, runtime routing and batched tracking; production uses the shared manifest engine | [Forge ownership](areas/forge.md), [tracking contract](contracts/forge-tracking.md), [forge status](contracts/forge-status.md) |
| `src/main/config/`, `src/main/setup/` | Config containment/live reload/holds, profile consent, repository scans, settings/environment IPC | [Config](areas/config.md), [settings](areas/settings.md), [launch environment](areas/agent-launch.md#launch-environment-215), [behavior](behavior/settings.md), [setup](behavior/setup.md) |
| `src/main/confirmations/`, `src/preload/confirmation.ts`, `src/renderer/confirmation.tsx`, `src/renderer/confirmation.html` | Arming gates, trusted dialogs, cleanup review; isolated minimal confirmation bridge | [Confirmations](areas/confirmations.md), [behavior](behavior/confirmations.md) |
| `src/main/previews/`, `src/main/control/previews.ts`, `src/renderer/preview/` | Contained files, private native views/partitions, registry/watchers, inert Markdown, owned agent view actions | [Previews](areas/previews.md), [agent actions](areas/preview-actions.md), [tile behavior](behavior/tiles.md) |
| `src/main/themes/`, `src/main/fonts/`, `src/renderer/ui/interface-theme.ts` | Palette catalogs/watchers, fixed monospace enumeration and interface token projection | [Themes](areas/themes.md), [font selection](areas/fonts.md#terminal-font-selection-363), [settings](areas/settings.md), [brand](brand.md) |
| `src/main/sounds/`, `src/renderer/sound/`, `src/sounds/` | Bounded catalogs/recording bytes, execution-based playback, controls, approved recordings/manifest/notices | [Sound](areas/sound.md), [settings behavior](behavior/settings.md), [brand](brand.md) |
| `src/preload/preload.ts` | Sandboxed typed `window.desktop` bridge and runtime response validation | [Boundaries](areas/boundaries.md), [IPC](areas/ipc.md); also the affected capability's area rules |
| `src/renderer/renderer.tsx`, `src/renderer/app.tsx`, `src/renderer/board/`, `src/renderer/index.html`, `src/renderer/css.d.ts`, `src/renderer/global.d.ts`, `src/renderer/wheel-notch.ts` | Browser entry/composition; `live-board-source.ts` adapts IPC, `sample-board-source.ts` serves explicit dev builds; components keep view state | [Renderer](areas/renderer.md), [board](areas/board.md), [sidebar behavior](behavior/sidebar.md) |
| `src/renderer/board/use-sidebar.tsx`, `src/renderer/board/use-sidebar-layout.ts`, `src/renderer/board/sidebar-*.tsx`, `src/renderer/board/panel-intent.ts`, `src/renderer/board/row-menu.tsx` | Sidebar interaction/layout hooks, tree sections, cancellable panels and keyboard menus | [Renderer](areas/renderer.md), [panels](areas/panels.md), [sidebar behavior](behavior/sidebar.md) |
| `src/renderer/board/use-board-tiles.ts`, `src/renderer/board/use-board-activity.ts`, `src/renderer/board/tiles.ts`, `src/renderer/board/tile-area.tsx` | Tile placement/reservations, DOM-only activity/wait subscriptions, immutable split geometry and keyed leaves | [Board](areas/board.md), [renderer](areas/renderer.md), [tile behavior](behavior/tiles.md) |
| `src/renderer/terminal/` | Imperative `shell-controller.ts`, serialized attachment/reply suppression, alternate wheel input and bounded WebGL ownership | [Terminals](areas/terminals.md), [rendering](areas/terminal-rendering.md), [renderer](areas/renderer.md) |
| `src/renderer/preflight/`, `src/renderer/ui/`, `src/renderer/styles/`, `src/renderer/fonts/` | Setup coordinator/steps and source, reusable controls, ordered token CSS and bundled fonts/licenses | [Settings](areas/settings.md), [setup behavior](behavior/setup.md), [renderer](areas/renderer.md), [brand](brand.md) |
| `src/shared/launch-failure.ts` | Fixed launch diagnostics shared with the remote host | [Launch](areas/agent-launch.md), [control mutations](contracts/control-mutations.md) |
| `src/shared/` | `.d.ts` contracts and browser-safe validators/data; no process-owned imports, Node or Electron; `providers/screen-rules.ts` shares live/capture matching | [Boundaries](areas/boundaries.md), [IPC](areas/ipc.md), plus the matching feature rows below |
| `src/node-common/launch-selection.ts` | Bounded child model/effort validation and manifest-declared argv replacement | [Launch](areas/agent-launch.md), [orchestration](areas/orchestration.md), [control](areas/control.md) |
| `src/node-common/` | Main/CLI-only private-file, handoff/control validators and bounded `probe-captures.ts` reads/replay (`owned-files.ts` containment); never renderer/shared/preload runtime | [Boundaries](areas/boundaries.md), [privacy](areas/privacy.md), [control](areas/control.md) |
| `src/cli/` | Separate Node SEA console, bounded command parsing/client, pairing, handoff and offline config; no policy ownership | [Console ownership](areas/console.md), [console contract](contracts/console.md), [transport](contracts/control-transport.md) |

## Feature additions to process routes

Shared contracts, validators, assets and cross-feature entry points also select
their feature rules here. These rows participate in the same union as those above.

| Area / source owner | Responsibility and entry points | Required area rules / behavior |
| --- | --- | --- |
| `src/renderer/about/`, `src/renderer/art/`, `src/renderer/ui/flight-*`, `src/renderer/ui/singularity.ts`, `src/renderer/styles/about.css` | About, legal dialogs and flight artwork | [Renderer / About](areas/renderer.md#flight-art-and-about-670-725), [menus](behavior/menus.md), [brand](brand.md) |
| `src/renderer/board/action-log-view.tsx`, `src/renderer/board/board-view.tsx`, `src/main/workspace/workspace-ipc.ts`, `src/main/control/store.ts`, `src/main/control/operations.ts`, `src/main/control/orchestration-authority.ts`, `src/shared/action-log.d.ts` | Private Action Log storage, validated board IPC and view | [Action Log](areas/action-log.md), [control validation](areas/control-validation.md), [orchestration behavior](behavior/orchestration.md) |
| `src/shared/forge*`, `src/shared/bundled-forges/`, `src/main/setup/forge-settings.ts`, `src/renderer/preflight/forges-settings.tsx`, `src/renderer/preflight/forge-readiness.tsx`, `src/renderer/board/pull-request.tsx` | Forge manifests, validators, host settings and PR status | [Forge](areas/forge.md), [manifest specification](forge-plugins.md), [tracking](contracts/forge-tracking.md), [status](contracts/forge-status.md) |
| `src/shared/remote-agent*`, `src/shared/agent-*`, `src/shared/agents.d.ts`, `src/shared/bundled-agent-data.ts`, `src/shared/bundled-agents/`, `src/shared/providers/`, `src/shared/plugin-parser.ts`, `src/shared/v2-hooks.d.ts` | Agent manifest schema/assets, capability data and browser-safe matching | [Providers](areas/providers.md), [manifests](agent-plugins.md), [launch](areas/agent-launch.md), [hooks](areas/agent-hooks.md) |
| `src/shared/agy-plugin.d.ts` | Opt-in lifecycle plugin facts | [Hooks](areas/agent-hooks.md), [providers](areas/providers.md) |
| `src/shared/environment*`, `src/shared/terminal-environment.ts`, `src/main/setup/environment*`, `src/renderer/preflight/environment-settings.tsx`, `src/renderer/styles/environment.css` | Layered environment validation, encryption and editors | [Launch environment](areas/agent-launch.md#launch-environment-215), [settings](areas/settings.md), [privacy](areas/privacy.md) |
| `src/shared/config*`, `src/shared/foom-config.d.ts`, `src/cli/config.ts` | Bounded config and offline console edits | [Config](areas/config.md), [settings](areas/settings.md), [console](areas/console.md) |
| `src/shared/sound*`, `src/cli/sound-duration.ts` | Sound contracts, settings validation and duration reading | [Sound](areas/sound.md), [settings behavior](behavior/settings.md) |
| `src/shared/handoff.d.ts`, `src/shared/review*`, `src/shared/handoff-validation.ts`, `src/shared/review-validation.ts`, `src/cli/handoff.ts` | Child handoff/review validators and presentation state | [Handoffs](areas/handoffs.md), [review loop](areas/orchestration.md), [handoff contract](contracts/control-handoffs.md) |
| `src/shared/child-input*`, `src/shared/control-tools.ts`, `src/shared/control-tool-classes.ts`, `src/shared/control-validation.ts` | Control request validation and child input | [Control](areas/control.md), [child authority](areas/child-authority.md), [validation gates](areas/control-validation.md) |
| `src/shared/probe-capture.d.ts`, `src/node-common/agent-probe.ts`, `src/node-common/probe-captures.ts` | Probe protocol, private captures and replay | [Probes](areas/probes.md), [capture contract](contracts/agent-report.md#saved-screen-rule-regressions-592), [privacy](areas/privacy.md) |
| `src/shared/evaluator.d.ts`, `src/shared/execution.d.ts`, `src/shared/agent-rule-types.d.ts`, `src/shared/agent-evidence.ts`, `src/shared/agent-conditions.ts` | Local verdicts and invocation evidence | [Evaluator](areas/evaluator.md), [execution](areas/execution.md), [attention](behavior/attention.md) |
| `src/shared/conversation.ts`, `src/shared/hooks.d.ts`, `src/shared/foreground-name.ts`, `src/shared/workspace.d.ts` | Agent/session projections, hook signals and foreground facts | [Launch](areas/agent-launch.md), [hooks](areas/agent-hooks.md), [sessions](areas/sessions.md) |
| `src/main/terminals/remote-bootstrap.ts`, `src/main/terminals/remote-transport.ts`, `src/terminal-host/remote/`, `src/shared/remote-host.d.ts`, `src/shared/remote-host-protocol.ts`, `src/shared/remote-agent*` | Developer opt-in SSH bootstrap, bounded stdio protocol and SEA daemon with persistent PTYs and replay | [Remote shell contract](areas/terminals.md#remote-shell-spike-754), [boundaries](areas/boundaries.md#remote-shell-spike-754), [privacy](areas/privacy.md#secrets) |
| `src/shared/registered-hosts*`, `src/main/setup/hosts.ts`, `src/terminal-host/remote/management.ts`, `src/renderer/preflight/hosts-settings.tsx` | Profile-only SSH host enrollment, bounded management requests, host facts and approved repository clones | [Hosts](areas/hosts.md), [settings](areas/settings.md), [launch](areas/agent-launch.md), [privacy](areas/privacy.md) |
| `src/shared/terminal-selection.ts` | Bounded terminal selection validation | [Terminals](areas/terminals.md), [settings](areas/settings.md) |
| `src/shared/terminal-host*` | Host wire protocol and terminal facts | [Terminals](areas/terminals.md), [shell lifecycle](areas/shells.md) |
| `src/shared/terminal-color*`, `src/shared/terminal-theme*`, `src/shared/theme-*`, `src/shared/interface-theme*`, `src/shared/user-interface-theme.ts` | Terminal/interface palette assets and validation | [Themes](areas/themes.md), [settings](areas/settings.md), [brand](brand.md) |
| `src/shared/terminal-fonts.ts` | Bundled font choices | [Fonts](areas/fonts.md), [settings](areas/settings.md) |
| `src/shared/updates.d.ts` | Update status IPC | [Updates](areas/application.md#updates-603), [privacy](areas/privacy.md#update-requests-603) |
| `src/shared/board-command.d.ts`, `src/shared/app-menu.d.ts`, `src/renderer/board/app-menu.tsx`, `src/renderer/board/shortcut-sheet.tsx`, `src/renderer/board/use-board-commands.ts` | Board command/menu contracts and projections | [Commands](areas/commands.md), [menus](behavior/menus.md) |
| `src/shared/cleanup.d.ts`, `src/shared/worktrees.d.ts`, `src/shared/recent-repositories.ts` | Checkout inventory and cleanup contracts | [Worktrees](areas/worktrees.md), [board](areas/board.md), [sidebar](behavior/sidebar.md) |
| `src/shared/confirmation.d.ts` | Trusted dialog contract | [Confirmations](areas/confirmations.md), [behavior](behavior/confirmations.md) |
| `src/shared/previews.d.ts`, `src/renderer/board/preview-composition.ts`, `src/renderer/board/sidebar-preview-row.tsx` | Preview metadata and board placement | [Previews](areas/previews.md), [agent actions](areas/preview-actions.md) |
| `src/shared/panel.d.ts` | Sidebar panel intents | [Panels](areas/panels.md), [sidebar](behavior/sidebar.md) |
| `src/shared/setup.d.ts`, `src/shared/readiness.d.ts` | First-run readiness and setup contracts | [Settings](areas/settings.md), [setup](behavior/setup.md) |
| `src/shared/windows.d.ts` | Window placement contract | [Windows](areas/windows.md), [behavior](behavior/windows.md) |
| `src/shared/desktop.d.ts`, `src/shared/toml.d.ts` | Aggregate desktop bridge and third-party parser declarations | [Boundaries](areas/boundaries.md), [IPC](areas/ipc.md), [config](areas/config.md) |

Every top-level `src/` directory has an intentional route: `cli`, `main`, `manual`,
`node-common`, `preload`, `renderer`, `shared`, `sounds`, and `terminal-host`.

## Tests, tooling and references

`tests/unit/` mirrors process/feature ownership. Workspace tests are split into
`workspace-{agent-setup,attention,cleanup,config-launch,config-probes,execution,forge,provider-hooks,repository-operations,sessions,sidebar}.test.ts`
plus `workspace.test.ts` and `orchestration-workspace-{authority,children,removal,restore,history,adoption,attention,review}.test.ts`; their shared setup
and helpers live in `tests/unit/main/workspace/workspace-fixture.ts` and
`orchestration-workspace-fixture.ts`, sharing the hook-free `worktree-fake.ts` builder. AgentService coverage lives in
`tests/unit/main/agents/agents-{detection,launch,resume-control,observers-config,v2-security}.test.ts`,
with shared process/fs mocks and setup in `agents-fixture.ts`. `tests/electron/agent-{config,launch,lifecycle,plugins,probe,restore,resume}.test.js`
are distinct feature suites; `antigravity-plugin.test.js` covers plugin behavior.
`preflight.test.js` and `settings-{accessibility,appearance,sound,agents,general}.test.js`
cover setup and Settings; sound affected runs select all six replacement suites
to retain the former combined suite’s coverage. Other named feature suites, `harness.js`, `agent-isolation.js`, `test-policy.js`,
`process-audit.js` and `shard-plan.json` own app fixtures, CLI isolation, deadlines,
process cleanup and CI assignment. `tests/helpers/git.js` owns test Git isolation.
Read [Electron sharding](electron-shards.md), [fixtures](electron-fixtures.md),
[development](development.md), [validation](validation.md) and [AGENTS.md](../AGENTS.md)
for the affected tooling; no real agent CLIs in automated tests.

`docs/mockups/` and `inspiration/` are read-only references. For UI changes, read the
matching [mockup README](mockups/README.md) and [brand](brand.md); decided docs win.
`docs/research/`, existing spike reports and linked issue/PR evidence are not current
behavior or mandatory area reading. [Agent measurements index](agents.md) links
historical versions and limitations. `scripts/`, `.github/`, and root build/config
files follow contributor validation rules; generated `build/`, `out/`, `coverage/`
and dependencies are not source owners.
