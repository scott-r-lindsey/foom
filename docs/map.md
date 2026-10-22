# File map and required reading

Read [AGENTS.md](../AGENTS.md), then the implementation rules and behavior for the
area you will change. Read additional contract sections only when changing that
surface. These are decided rules; changing a decision needs its own PR and docs.
[Documentation authority](README.md#authority-and-maintenance) explains precedence.
Paths below are relative to the repository root.

| Area / source owner | Responsibility and entry points | Required area rules / behavior |
| --- | --- | --- |
| `src/renderer/board/error-presentation.tsx`, `src/shared/application-error.d.ts`, `application-errors.ts` | Fixed coded failures, action dialogs, focus restoration and operation-scoped background marks | [Errors](areas/errors.md), [behavior](behavior/errors.md) |
| `src/main/main.ts`, `src/main/wiring/` | Entry delegates to `application.ts` (startup/security/quit), `window.ts` (per-board composition), `workspace.ts` (app-wide services); live bindings in `application-wiring.d.ts` | [Boundaries](areas/boundaries.md), [profiles](areas/application.md) |
| `src/manual/`, `src/main/window/manual-shortcuts.ts` | Bundled offline user guide and build-time shortcut tables; prose follows current behavior and area docs | [Previews](areas/previews.md#bundled-manual-root), [commands](areas/commands.md), [brand](brand.md) |
| `src/main/window/` | `window-ipc.ts` routes registered windows; `terminal-views.ts` reserves views; `window-placement.ts` persists geometry; `window-audio.ts` elects sound owner | [Windows](areas/windows.md), [behavior](behavior/windows.md) |
| `src/shared/board-commands.ts`, `src/main/window/commands.ts`, `app-menu.ts`, `attention-badge.ts` | One command registry, shortcut dispatch, menu projections and native attention counts | [Commands](areas/commands.md), [menus](behavior/menus.md) |
| `src/main/terminals/`, `src/terminal-host/` | `terminal-ipc.ts` grants ID-scoped capabilities; `terminal-host-client.ts` brokers host requests; `terminal-manager.ts` owns PTYs/headless xterms; snapshot, activity, foreground and shell integration helpers stay in the host | [Terminals](areas/terminals.md), [shell lifecycle](areas/shells.md), [tile behavior](behavior/tiles.md) |
| `src/main/workspace/workspace.ts`, `workspace-context.ts`, `workspace-ipc.ts` | Public facade delegates to the internal coordinator; context owns shared reservations/locks, terminal queues, cancellation, owner initialization, persistence delegates and shutdown; IPC validates workspace requests | [Launch/composition](areas/agent-launch.md), [worktrees](areas/worktrees.md), [sessions](areas/sessions.md), [evaluator](areas/evaluator.md) |
| `src/main/workspace/worktree-launch.ts` | Discovery caching, provider setup, agent/shell/home launches, existing checkouts and pasted resumes | [Launch](areas/agent-launch.md), [sessions](areas/sessions.md), [panels/home](areas/panels.md) |
| `src/main/workspace/sidebar-commands.ts` | Sidebar inventory/dispatch, checkout creation/removal, config sessions and probe credentials | [Worktrees](areas/worktrees.md), [config](areas/config.md), [probes](areas/probes.md), [sidebar behavior](behavior/sidebar.md) |
| `src/main/workspace/orchestration-commands.ts` | Role changes, child worktree/agent launches, terminal execution events and ordered evaluation | [Orchestration](areas/orchestration.md), [execution](areas/execution.md), [evaluator](areas/evaluator.md) |
| `src/main/workspace/feature-context.d.ts`, `workspace-types.d.ts` | Narrow coordinator capability types per feature; dependencies and feature method signatures | [Launch/composition](areas/agent-launch.md), [boundaries](areas/boundaries.md) |
| `src/main/workspace/worktrees.ts`, `fetch-default.ts`, `cleanup-owner.ts`, `cleanup-run.ts`, `inventory-watch.ts` | Git membership/identity, repository persistence, fetches, merged cleanup and local inventory watching | [Worktrees](areas/worktrees.md), [board inventory](areas/board.md), [behavior](behavior/worktrees.md) |
| `src/main/workspace/session-owner.ts`, `session-store.ts`, `session-restore.ts`, `home-shell.ts` | Session records, restore/restart/quit freeze, home launch; owners receive narrow dependencies, never the facade/coordinator | [Sessions](areas/sessions.md), [panels/home](areas/panels.md), [behavior](behavior/sidebar.md) |
| `src/main/workspace/execution-owner.ts`, `src/main/agents/execution.ts` | Invocation execution, evidence, evaluation generations, feedback and dismissal; `waiting-state.ts` projects child waiting | [Execution](areas/execution.md), [evaluator](areas/evaluator.md), [attention behavior](behavior/attention.md) |
| `src/main/evaluator/` | Pure local classification, bounded agent rules, tail redaction and verdict log | [Evaluator](areas/evaluator.md), [privacy](areas/privacy.md), [attention behavior](behavior/attention.md) |
| `src/main/agents/`, `src/main/login-shell.ts` | `agents.ts` discovers/launches; `hook-receiver.ts` authenticates observations; login-shell isolation and environment layering | [Launch](areas/agent-launch.md), [hooks](areas/agent-hooks.md), [execution](areas/execution.md) |
| `src/main/agents/providers/` | Registry, bundled/config v2 loading, launch/MCP/hooks, immutable mappings and observed health | [Providers](areas/providers.md), [manifest contracts](agent-plugins.md) |
| `src/main/agents/probe-*.ts`, `probes.ts` | Config-credential-owned scratch probes, prompt/input, screen and reminder projection | [Probes](areas/probes.md), [behavior](behavior/probes.md), [capture/replay](contracts/agent-report.md#saved-screen-rule-regressions-592) |
| `src/main/control/service.ts`, `runtime.ts`, `http.ts`, `mcp.ts`, `mcp-tools.ts`, `manual.ts`, `manual-mcp.ts`, `store.ts`, `operations.ts`, `pairing.ts` | Authorization policy, adapters, grants, durable idempotency/audit and human pairing | [Control foundation](areas/control.md), [MCP](areas/mcp.md), [protocol contracts](orchestration.md) |
| `src/main/control/orchestration-authority.ts`, `orchestration-mutations.ts`, `orchestration.ts`, `orchestration.d.ts` | Authority/limits/lifecycle; worktree and child mutations; dispatch/input/tails/waits; shared host/state declarations | [Orchestration](areas/orchestration.md), [child authority/input](areas/child-authority.md), [behavior](behavior/orchestration.md) |
| `src/main/control/handoffs.ts`, `child-events.ts`, `unread-child-events.ts` | Bounded child reports, shared invalidation and unread reminders | [Handoffs](areas/handoffs.md), [report contract](contracts/control-handoffs.md), [behavior](behavior/orchestration.md) |
| `src/main/control/forge*.ts` | PR/check mapping, lifecycle/interpreter, runtime routing and batched tracking; production uses the shared manifest engine | [Forge ownership](areas/forge.md), [tracking contract](contracts/forge-tracking.md), [forge status](contracts/forge-status.md) |
| `src/main/config/`, `src/main/setup/` | Config containment/live reload/holds, profile consent, repository scans, settings/environment IPC | [Config](areas/config.md), [settings](areas/settings.md), [launch environment](areas/agent-launch.md#launch-environment-215), [behavior](behavior/settings.md), [setup](behavior/setup.md) |
| `src/main/confirmations/`, `src/preload/confirmation.ts`, `src/renderer/confirmation.tsx` | Arming gates, trusted dialogs, cleanup review; isolated minimal confirmation bridge | [Confirmations](areas/confirmations.md), [behavior](behavior/confirmations.md) |
| `src/main/previews/`, `src/main/control/previews.ts`, `src/renderer/preview/` | Contained files, private native views/partitions, registry/watchers, inert Markdown, owned agent view actions | [Previews](areas/previews.md), [agent actions](areas/preview-actions.md), [tile behavior](behavior/tiles.md) |
| `src/main/themes/`, `src/main/fonts/`, `src/renderer/ui/interface-theme.ts` | Palette catalogs/watchers, fixed monospace enumeration and interface token projection | [Themes](areas/themes.md), [font selection](areas/fonts.md#terminal-font-selection-363), [settings](areas/settings.md), [brand](brand.md) |
| `src/main/sounds/`, `src/renderer/sound/`, `src/sounds/` | Bounded catalogs/recording bytes, execution-based playback, controls, approved recordings/manifest/notices | [Sound](areas/sound.md), [settings behavior](behavior/settings.md), [brand](brand.md) |
| `src/preload/preload.ts` | Sandboxed typed `window.desktop` bridge and runtime response validation | [Boundaries](areas/boundaries.md), [IPC](areas/ipc.md); also the affected capability's area rules |
| `src/renderer/renderer.tsx`, `app.tsx`, `board/` | Browser entry/composition; `live-board-source.ts` adapts IPC, `sample-board-source.ts` serves explicit dev builds; components keep view state | [Renderer](areas/renderer.md), [board](areas/board.md), [sidebar behavior](behavior/sidebar.md) |
| `src/renderer/board/use-sidebar.tsx`, `use-sidebar-layout.ts`, `sidebar-*.tsx`, `panel-intent.ts`, `row-menu.tsx` | Sidebar interaction/layout hooks, tree sections, cancellable panels and keyboard menus | [Renderer](areas/renderer.md), [panels](areas/panels.md), [sidebar behavior](behavior/sidebar.md) |
| `src/renderer/board/use-board-tiles.ts`, `use-board-activity.ts`, `tiles.ts`, `tile-area.tsx` | Tile placement/reservations, DOM-only activity/wait subscriptions, immutable split geometry and keyed leaves | [Board](areas/board.md), [renderer](areas/renderer.md), [tile behavior](behavior/tiles.md) |
| `src/renderer/terminal/` | Imperative `shell-controller.ts`, serialized attachment/reply suppression, alternate wheel input and bounded WebGL ownership | [Terminals](areas/terminals.md), [rendering](areas/terminal-rendering.md), [renderer](areas/renderer.md) |
| `src/renderer/preflight/`, `ui/`, `styles/`, `fonts/` | Setup coordinator/steps and source, reusable controls, ordered token CSS and bundled fonts/licenses | [Settings](areas/settings.md), [setup behavior](behavior/setup.md), [renderer](areas/renderer.md), [brand](brand.md) |
| `src/shared/` | `.d.ts` contracts and browser-safe validators/data; no process-owned imports, Node or Electron; `providers/screen-rules.ts` shares live/capture matching | [Boundaries](areas/boundaries.md), [IPC](areas/ipc.md), plus the affected feature's contract |
| `src/node-common/` | Main/CLI-only private-file, handoff/control validators and bounded `probe-captures.ts` reads/replay (`owned-files.ts` containment); never renderer/shared/preload runtime | [Boundaries](areas/boundaries.md), [privacy](areas/privacy.md), [control](areas/control.md) |
| `src/cli/` | Separate Node SEA console, bounded command parsing/client, pairing, handoff and offline config; no policy ownership | [Console ownership](areas/console.md), [console contract](contracts/console.md), [transport](contracts/control-transport.md) |

Every top-level `src/` directory is covered above: `cli`, `main`, `node-common`,
`preload`, `renderer`, `shared`, `sounds`, and `terminal-host`.

## Tests, tooling and references

`tests/unit/` mirrors process/feature ownership. Workspace tests are split into
`workspace-{agent-setup,attention,cleanup,config-launch,config-probes,execution,forge,provider-hooks,repository-operations,sessions,sidebar}.test.ts`
plus `workspace.test.ts` and `orchestration-workspace.test.ts`; their shared setup
and helpers live in `tests/unit/main/workspace/workspace-fixture.ts`. `tests/electron/agent-{config,launch,lifecycle,plugins,probe,restore,resume}.test.js`
are distinct feature suites; `antigravity-plugin.test.js` covers plugin behavior.
Other named feature suites, `harness.js`, `agent-isolation.js`, `test-policy.js`,
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
