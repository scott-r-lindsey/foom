# Boundaries

Decided implementation and security rules for this area. Read the [file map](../map.md) to locate related owners.

Workspace composition lives behind the public `main/workspace/workspace.ts` facade. `workspace-context.ts` owns shared locks, queues, owner wiring and shutdown; bound feature methods live in `worktree-launch.ts`, `sidebar-commands.ts` and `orchestration-commands.ts`. Narrow feature capabilities and dependency/method declarations live in `workspace-capabilities.d.ts` and `workspace-types.d.ts`. `workspace-feature-wiring.ts` constructs each dependency slice and live state view. `workspace-orchestration-host.ts` adapts orchestration effects under the context’s shared reservations. Owners receive capabilities rather than the coordinator object.

## Process model

| Process | Owns | Must not |
|---|---|---|
| Main | Terminal capabilities and IPC broker, git and worktrees, agent launch, the hook receiver, the evaluator, secrets | Trust anything from the renderer or from agents without validation |
| Terminal host (`utilityProcess`) | PTYs, headless screens and parser/view backpressure | Trust messages without validation or depend on an attached view to consume output |
| Preload (sandboxed) | A small typed bridge (`window.desktop`) | Import runtime modules beyond what the sandboxed loader allows |
| Renderer | Drawing: the board, lights, the open terminal view | Import Electron or Node APIs |

## Security defaults

The renderer uses sandboxing, context isolation and no Node integration. The board
CSP permits only local scripts; inline styles support xterm positioning and colors.
The `app://` protocol serves an explicit asset allowlist. Navigation, new windows,
webviews and permission requests are blocked. IPC validates the owning window,
sender URL, main frame and runtime payloads. Separate native preview views follow
the [preview isolation contract](previews.md#previews). Preview reads authorize the
opened descriptor before releasing bytes: Linux checks its procfs path, while
macOS/Windows re-resolve and compare file identity. Each request also verifies the
root identity captured at preview open. These are separate observations, with
accepted residual races and no native helper:

- On macOS/Windows, a writer with permission to modify an in-root ancestor's
  parent (for example, the root itself for `docs/`) can switch that ancestor to an
  outside link/junction for open and identity lookup, restoring it for containment
  resolution. A writer controlling the root's parent can also repeatedly replace
  the root between checks.
- On Linux, a writer controlling both the root's parent and the outside
  directory's parent can rename the root away, move the outside directory to the
  root's spelling during procfs lookup, then restore both before root identity
  verification. Those parents may be the same directory.

The accepted threat model's realistic writer is an agent running as the same user,
which can usually read those files directly. Preview response bytes go to the
human's preview tile; no Foom MCP or agent tool returns preview contents, and
previews have network disabled by default.
The current checks are not atomic directory traversal or a filesystem sandbox.

Production packages use ASAR and hardened Electron fuses and include compiled
application files, package metadata and production dependencies. Native node-pty
binaries and spawn helpers are unpacked. Windows uses node-pty's bundled ConPTY
DLL; RunAsNode stays disabled. Main owns secrets and uses Electron `safeStorage`.
Local evaluation makes no model requests. Terminal transport stays local except
SSH between the user's own Foom and user-provided hosts (#753). Scoped
[probe screens](probes.md) and child tails/reports can enter the requesting
agent’s context and reach its model provider. See [secrets](privacy.md#secrets)
and [control-plane privacy](../contracts/control-privacy.md#output-privacy-and-visibility).

## Source layout

Directories expose the process boundaries above, with features grouped within main and renderer:

```text
src/
  main/
    main.ts           # application entry point
    wiring/           # application lifecycle/security, window and workspace composition
    profile.ts        # profile selection, launch identity and environment scrub
    window/           # appearance and window scaling
    terminals/        # terminal IPC capabilities and utility-process client
    workspace/        # workspace coordination, worktree service and IPC
    agents/           # CLI discovery, launch and invocation-scoped hooks
      providers/      # provider launch, hook adapters and MCP attachment
    evaluator/        # local rules, tail redaction and verdict log
    setup/            # settings, repository discovery and setup IPC
    config/           # plain config files, settings/theme holds and live reload
    control/          # authorization, HTTP/MCP, orchestration, handoffs and forge tracking
    previews/         # isolated native views, contained reads, registry and watchers
    confirmations/    # trusted dialogs, arming and removal reviews
    sounds/           # recording catalog and sound IPC
    themes/           # custom palette catalog and theme IPC
    fonts/            # bounded system monospace enumeration
  cli/                # console helper: control client, pairing, handoff and offline config
  node-common/        # Node-only validation/private-file helpers shared by main and CLI
  terminal-host/      # utility-process entry, PTYs, headless screens and activity
  preload/            # sandboxed window.desktop bridge
  shared/             # declaration contracts and platform-neutral runtime helpers
  renderer/
    renderer.tsx      # browser entry
    app.tsx           # preflight/board composition
    board/            # board view, live/sample sources and the New worktree branch field
    terminal/         # imperative xterm controller and reply suppression
    preflight/        # setup source, steps and controls
    preview/          # isolated preview browser runtime and Markdown assets
    sound/            # playback and recording controls
    ui/               # reusable UI controls
    styles/           # token and application CSS
    fonts/
  sounds/             # bundled recordings, manifest and notices
tests/
  unit/               # process/feature layout mirrors src; tooling tests also live here
  electron/           # real-app and packaged tests, with their PTY probes
  fixtures/           # shared unit-test data
```

`src/main/terminals/terminal-ipc.ts` grants renderer capabilities; it does not own PTYs.
`live-board-source.ts` adapts the real bridge, while `sample-board-source.ts` serves explicit development builds and tests.
The browser-safe `shared/terminal-colors.ts` runs in both the host and renderer;
`shared/terminal-host-protocol.ts` validates messages between main and host.

Within those features:

- `main/wiring/application.ts` keeps app-scoped bindings, startup/store initialization, settings publication, window ordering, trusted-dialog routing and quit lifecycle. It also keeps privileged scheme registration, the local asset allowlist and session permission denial together. `window.ts` wires each sandboxed board and its IPC/features; `workspace.ts` connects terminals, forge tracking, hooks and control once. Feature wiring receives live application bindings through the declaration in `application-wiring.d.ts`; IPC sender validation remains in the window router and feature IPC modules.

- `preflight-view.tsx` coordinates navigation, scans, persistence, errors, heading focus and launch. `settings-frame.tsx` renders the Settings section navigation and controls frame. Welcome, agents, repositories and readiness render in their own `*-step.tsx` modules; they receive state and actions from the coordinator. The welcome step shows instead of tells: `welcome-noise.tsx` tiles ten made-up terminals like a window manager, then folds them into ten lights, one of which needs you. `welcome-noise-output.ts` generates their output: colored, bursty, with streamed prose and per-agent status lines, and each light follows its own terminal's output rate. It is decorative (`aria-hidden`) and shows its final frame under reduced motion.
- `board.ts` contains production board helpers. `sample-rows.ts` holds development fixture rows and is imported only by the sample source and tests.
- `styles/styles.css` is an ordered import manifest for base, board/terminal, preflight, appearance, welcome, welcome animation, repository picker, layout overrides, agent cards and branch field styles. The build bundles it into the existing `styles.css` asset; there are no runtime imports or new asset permissions. Keep the import order: the later preflight/layout/card rules intentionally follow the base feature rules.

The `foom/process-boundaries` ESLint rule checks static imports, re-exports, literal dynamic imports and `require` calls. Process-owned code may depend on its own process and shared modules. Shared modules cannot depend on process-owned code. Only main and the console may import `node-common` utilities; the console cannot import main, Electron or terminal-host policy. Renderer and shared modules cannot import Node, Electron, node-pty or headless xterm. The sandboxed preload may import Electron at runtime and shared declarations as types. Its sole shared runtime dependency, `shared/board-commands.ts`, is pure browser-safe data and validation bundled inline by esbuild; the sandbox loader still requires only Electron. The boundary lint rule permits only this specific shared module.

Import implementations and their types directly from their owning modules; do not
add migration-only `export *` forwarding files. Provider launch preparation lives
in `main/agents/providers/v2.ts`, including
prompt validation, MCP arguments and private launch-file cleanup. Prompt constants
live in `providers/cli-launch.ts`; hook adapters live in
`providers/{hook-launch,v2-observers}.ts`;
private-file helpers and control validation live in
`node-common/{private-files,control-validation}.ts`; browser-safe argument helpers
live in `shared/providers/arguments.ts`. Source, tests and mocks use these same
canonical locations. Main imports Node-only helpers directly from `node-common`,
without a `main/control` forwarding layer. These locations do not expand process
permissions or the sandboxed preload's runtime imports.

Tests live outside `src/`; production compilation excludes them. Coverage still includes every executable source file regardless of its directory. The build emits main at `build/main/main.js`, preload at `build/preload/preload.js`, and the host at `build/terminal-host/terminal-host.js`. Renderer TypeScript is type-checked without emitting; esbuild produces the browser bundle. This prevents the renderer compiler from overwriting main’s CommonJS shared modules with unbundled ES modules. Renderer asset URLs remain unchanged.


## Remote shell spike (#754)

`src/terminal-host/remote/` is also built as a separate Node 24 SEA with no
Electron/display imports. It reuses the terminal manager and browser-safe shared
protocol validators. Main's `remote-transport.ts` adapts the SSH stdio stream to
the existing terminal client; all renderer capabilities and sender checks stay in
`terminal-ipc.ts`. No remote operation can select a hub executable, cwd, file,
control grant, hook or MCP endpoint. Native loading is confined to the SEA's
embedded, hash-verified pinned node-pty prebuild. The remote chooses its own shell
and environment. See [the spike contract](terminals.md#remote-shell-spike-754).
