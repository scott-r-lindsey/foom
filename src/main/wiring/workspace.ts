import { locationId, metadataName } from "../control/metadata";
import { hostsForStore } from "../setup/hosts";
import type { BrowserWindow } from "electron";
import { app, clipboard, Notification, powerMonitor, shell } from "electron";
import * as path from "node:path";
import { HookReceiver } from "../agents/hook-receiver";
import { ProbeNotices } from "../agents/probe-notices";
import { setupOffers } from "../agents/setup-offers";
import { ForgeTracking } from "../control/forge-tracking";
import { ControlRuntime } from "../control/runtime";
import { VerdictLog } from "../evaluator/verdict-log";
import { previewBackend } from "../previews/control-backend";
import { buildLaunchEnvironment, inheritedEnvironment } from "../setup/environment";
import { attachTerminal } from "../terminals/terminal-ipc";
import { InventoryWatch } from "../workspace/inventory-watch";
import { SessionStore } from "../workspace/session-store";
import { Workspace } from "../workspace/workspace";
import type { ApplicationWiring } from "./application-wiring";

export async function initializeWorkspace(
  wiring: ApplicationWiring,
  window: BrowserWindow,
): Promise<void> {
  // Terminal events and state updates only arrive after both objects exist.
  if (!wiring.initialized)
    wiring.terminals = attachTerminal(
      window,
      {
        onOutput: (id) => {
          wiring.workspace.output(id);
        },
        onEvidence: (id, evidence) => {
          void wiring.workspace.evidence(id, evidence);
        },
        onQuiet: (id) => void wiring.workspace.quiet(id),
        onForeground: (id, name) => {
          wiring.workspace.foreground(id, name);
        },
        onShellState: (id, state) => {
          wiring.workspace.shellState(id, state);
        },
        onExit: (id, code) => void wiring.workspace.exited(id, code),
        onInput: (id) => {
          wiring.workspace.input(id);
        },
        onRemoved: (id) => {
          wiring.workspace.removed(id);
        },
      },
      (contents, id) => {
        const entry = [...wiring.windows.values()].find(
          (entry) => entry.window.webContents === contents,
        );
        if (!entry) return false;
        const accepted = wiring.views.claim(id, entry.window.id);
        if (accepted) wiring.publishViews();
        return accepted;
      },
      () =>
        buildLaunchEnvironment({
          layers: wiring.environment.layers("shell"),
          base: inheritedEnvironment(),
        }).env,
      () => wiring.settings.get().copyOnSelect,
      wiring.settings.profileTag(),
    );
  else wiring.terminals.addWindow(window);
  if (!wiring.initialized) {
    await setupOffers.load(app.getPath("userData"));
    if (wiring.settings.get().agyPluginOfferAnswered && !setupOffers.answered("agy"))
      await setupOffers.answer("agy");
    if (
      wiring.settings.get().setupComplete &&
      wiring.settings.get().showPullRequests === undefined
    ) {
      const loggedIn = await wiring.forgeRuntime.available();
      await wiring.settings.update({ showPullRequests: loggedIn });
    }
    const forge = await ForgeTracking.open(
      app.getPath("userData"),
      async (tree, orchestrator) => {
        if (!wiring.worktrees.listRepositories().some((repo) => repo.path === tree.repository))
          return undefined;
        if (tree.remoteCheckout)
          return hostsForStore(
            wiring.settings,
            wiring.worktrees.listRepositories.bind(wiring.worktrees),
            app.getVersion(),
          ).inspectForge(tree);
        if (tree.path.startsWith("/foom-remote/")) return undefined;
        const owned = (await wiring.worktrees.listWorktrees(tree.repository)).find(
          (row) => row.path === tree.path,
        );
        if (
          !owned ||
          (orchestrator && !owned.managed) ||
          (owned.branch ??
            wiring.worktrees.reviewBranch(tree.repository, tree.path, owned.head)) !==
            tree.branch ||
          (await wiring.worktrees.launchIdentity(tree.repository, tree.path)) !== tree.identity
        )
          return undefined;
        const remote = await wiring.worktrees.forgeRemote(tree.repository);
        return remote && owned.head ? { remote, head: owned.head } : undefined;
      },
      () => {
        wiring.workspace.refresh();
      },
      wiring.forgeRuntime.provider,
    ).catch(() => undefined);
    if (forge) {
      wiring.forgeRuntime.onInvalidate = () => {
        forge.invalidate();
      };
      powerMonitor.on("suspend", () => {
        forge.pause("sleep", true);
      });
      powerMonitor.on("resume", () => {
        forge.pause("sleep", false);
      });
      powerMonitor.on("lock-screen", () => {
        forge.pause("lock", true);
      });
      powerMonitor.on("unlock-screen", () => {
        forge.pause("lock", false);
      });
      forge.onCompleted = (tree, pr) => {
        const preferences = wiring.settings.get();
        if (
          !preferences.showPullRequests ||
          !preferences.sound.alerts ||
          preferences.sound.muted ||
          !Notification.isSupported()
        )
          return;
        const active = wiring.workspace
          .snapshot()
          .terminals.some(
            (row) =>
              row.worktree === tree.path &&
              row.kind === "agent" &&
              !row.exited &&
              (row.execution
                ? row.execution.phase === "working" || row.execution.phase === "starting"
                : row.state === null || row.state.state === "working"),
          );
        if (!pr.checks || (pr.checks.failed === 0 && active)) return;
        const notice = new Notification({
          title: `${pr.requestLabel ?? "Pull request"} ${pr.numberPrefix ?? "#"}${String(pr.number)}`,
          body:
            pr.checks.failed > 0 ? `${String(pr.checks.failed)} checks failed` : "Checks passed",
          silent: true,
        });
        notice.on("click", () => {
          const target =
            [...wiring.windows.values()].find(({ window }) => window.isFocused()) ??
            wiring.windows.values().next().value;
          if (!target) return;
          if (target.window.isMinimized()) target.window.restore();
          target.window.show();
          target.window.focus();
          target.window.webContents.send("workspace:focus-worktree", tree.path);
        });
        notice.show();
      };
    }
    const probeNotices = new ProbeNotices(app.getPath("userData"));
    wiring.workspace = new Workspace({
      openExternal: (url) => shell.openExternal(url),
      pluginStagingRoot: app.getPath("userData"),
      ...(forge === undefined ? {} : { forge }),
      hosts: hostsForStore(
        wiring.settings,
        wiring.worktrees.listRepositories.bind(wiring.worktrees),
        app.getVersion(),
        (dispose) => {
          app.once("will-quit", dispose);
        },
      ),
      worktrees: wiring.worktrees,
      watcher: new InventoryWatch(
        (repository) => wiring.worktrees.watchPaths(repository),
        () => {
          wiring.workspace.refresh();
        },
      ),
      terminals: wiring.terminals,
      agentPluginDirectory: app.getPath("userData"),
      sessions: new SessionStore(app.getPath("userData")),
      copyText: (text) => clipboard.writeText(text),
      acknowledgeAgyPluginOffer: async () => {
        await wiring.settings.update({ agyPluginOfferAnswered: true });
      },
      // Local rules classify each terminal; the log stores verdict metadata only.
      verdicts: new VerdictLog(app.getPath("userData")),
      config: {
        status: () => wiring.config.refresh(),
        probeNotice: probeNotices.first.bind(probeNotices),
        root: wiring.configRoot,
        cliDirectory: path
          .join(__dirname, "../../console")
          .replace("app.asar", "app.asar.unpacked"),
        check: async () => {
          if (!wiring.config.ready) throw new Error("Foom config is unavailable");
          if (await wiring.worktrees.managesPath(wiring.configRoot))
            throw new Error("Foom config cannot be inside a repository Foom manages");
        },
      },
      control: () =>
        ControlRuntime.start(
          app.getPath("userData"),
          () => wiring.workspace.snapshot().terminals,
          {
            repository: (path) =>
              wiring.worktrees.listRepositories().find((entry) => entry.path === path)?.path,
            approve: wiring.requestPairing,
          },
          wiring.workspace.orchestration,
          (id, state) => {
            wiring.workspace.mcpConnectionChanged(id, state);
          },
          () => {
            wiring.workspace.refresh();
          },
          previewBackend(
            wiring.previewHosts,
            wiring.previewPlacements,
            (id) => {
              const owner = wiring.views.owner(id);
              return (
                (owner === undefined ? undefined : wiring.windows.get(owner)) ??
                [...wiring.windows.values()].find(({ window }) => window.isFocused()) ??
                wiring.windows.values().next().value
              )?.window.id;
            },
            (id) =>
              wiring.workspace.snapshot().terminals.find((row) => row.id === id)?.agent ?? "agent",
          ),
          () =>
            wiring.worktrees.listRepositories().map((repo) => ({
              id: locationId(repo.path),
              name: metadataName(path.basename(repo.path)),
            })),
        ).then((runtime) => {
          wiring.agentPreviews = runtime.service.previews;
          return runtime;
        }),
      dialog: wiring.requestTrusted,
      placeChild: (id, parentId) => {
        const owner = wiring.views.owner(parentId);
        const target =
          (owner === undefined ? undefined : wiring.windows.get(owner)) ??
          [...wiring.windows.values()].find(({ window }) => window.isFocused()) ??
          wiring.windows.values().next().value;
        target?.window.webContents.send("app-menu:session", id, true);
      },
      reveal: (id) => {
        wiring.revealSession(id);
      },
      receiver: () => HookReceiver.listen((signal) => void wiring.workspace.hook(signal)),
      environment: (target) => wiring.environment.layers(target),
      prepareWorktreeRemoval: async (worktree) => {
        wiring.removingPreviewWorktrees.add(worktree);
        const release = () => {
          wiring.removingPreviewWorktrees.delete(worktree);
        };
        try {
          await Promise.all(
            [...wiring.previewHosts.values()].map((host) => host.closeWorktree(worktree)),
          );
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
      onChange: () => {
        for (const entry of wiring.windows.values()) entry.workspaceIpc.sendChanged();
        for (const host of wiring.previewHosts.values())
          void host.reconcile().catch(() => {
            console.warn("Unable to reconcile previews");
          });
        wiring.attention();
      },
      onExecution: (event) => {
        for (const entry of wiring.windows.values()) entry.workspaceIpc.sendExecution(event);
      },
      onState: (state) => {
        for (const entry of wiring.windows.values()) entry.workspaceIpc.sendState(state);
        wiring.attention();
      },
    });
    await wiring.workspace.restore();
    wiring.initialized = true;
  }
}
