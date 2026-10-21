import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "../../shared/agents";
import type { WindowIpc } from "./window-ipc";
import { app, Menu, dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import {
  createCommands,
  createShortcuts,
  nativeMenu,
  projectAppMenu,
  shortcutSheet,
} from "./commands";
import { agentProviders } from "../agents/providers/registry";
import type { ZoomDirection } from "./appearance";

/** The bridge accepts command IDs only, from this window's trusted top-level frame. */
export function attachAppMenu(
  window: BrowserWindow,
  zoom: (direction: ZoomDirection) => Promise<void>,
  ipc: WindowIpc = ipcMain,
  openWindow: () => void = () => undefined,
  /** The current interface size in percent, for the menu's Size row. */
  scale: () => Promise<number> = () => Promise.resolve(100),
  configAgents: () => Promise<readonly AgentId[]> = () => Promise.resolve([]),
  openManual: () => Promise<void> = () => Promise.resolve(),
  boardReady: () => void = () => undefined,
) {
  const contents = window.webContents;
  const native = (id: string) => {
    switch (id) {
      case "manual":
        return openManual();
      case "new-window":
        openWindow();
        break;
      case "close-window":
        window.close();
        break;
      case "quit":
        app.quit();
        break;
      case "licenses":
      case "notices":
        void readFile(
          join(app.getAppPath(), id === "licenses" ? "LICENSE" : "build/THIRD_PARTY_NOTICES.txt"),
          "utf8",
        )
          .then((detail) =>
            dialog.showMessageBox(window, {
              title: id === "licenses" ? "Licenses" : "Third-party notices",
              message: id === "licenses" ? "Foom · Apache-2.0" : "Third-party notices",
              detail,
              buttons: ["OK"],
            }),
          )
          .catch(() =>
            dialog.showMessageBox(window, {
              title: "Licenses",
              message: "Unable to read bundled notices.",
              buttons: ["OK"],
            }),
          );
        break;
      case "shortcuts":
        contents.send("app-menu:shortcuts");
        break;
      case "github":
        void shell.openExternal("https://github.com/scott-r-lindsey/foom");
        break;
      case "copy":
        contents.copy();
        break;
      case "paste":
        contents.paste();
        break;
      case "cut":
        contents.cut();
        break;
      case "undo":
        contents.undo();
        break;
      case "redo":
        contents.redo();
        break;
      case "selectAll":
        contents.selectAll();
        break;
      case "hide":
        app.hide();
        break;
      case "hide-others":
        Menu.sendActionToFirstResponder("hideOtherApplications:");
        break;
      case "minimize":
        window.minimize();
        break;
      case "zoom":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "front":
        window.show();
        break;
      case "reload":
        contents.reload();
        break;
      case "force-reload":
        contents.reloadIgnoringCache();
        break;
      case "devtools":
        contents.toggleDevTools();
        break;
    }
  };
  const commands = createCommands(
    process.platform,
    !app.isPackaged,
    {
      native,
      board: (command) => {
        contents.send("board:command", command);
      },
      zoom: (direction) =>
        zoom(direction).catch((error: unknown) => {
          console.error("Unable to change interface size:", error);
        }),
    },
    agentProviders(),
  );
  const refresh = () => {
    // Background boards also publish layout/settings state. Their commands must
    // never replace the native menu belonging to the focused macOS window.
    if (process.platform === "darwin" && !window.isFocused()) return;
    Menu.setApplicationMenu(
      process.platform === "darwin" ? Menu.buildFromTemplate(nativeMenu(commands)) : null,
    );
    if (process.platform !== "darwin") window.removeMenu();
  };
  let configAvailable = false;
  let generation = 0;
  let disposed = false;
  const refreshAgents = async () => {
    const current = ++generation;
    const agents: readonly AgentId[] = await configAgents().catch(() => []);
    if (disposed || current !== generation) return;
    const routes = createCommands(
      process.platform,
      !app.isPackaged,
      {
        native,
        board: (command) => {
          contents.send("board:command", command);
        },
        zoom,
      },
      agentProviders(),
    ).filter((command) => command.id.startsWith("via-"));
    for (const command of routes)
      command.enabled = configAvailable && agents.includes(command.id.slice(4));
    for (let index = commands.length - 1; index >= 0; index--)
      if (commands[index]?.id.startsWith("via-")) commands.splice(index, 1);
    commands.splice(1, 0, ...routes);
    refresh();
  };
  const focus = () => {
    refresh();
    void refreshAgents();
  };
  refresh();
  window.on("focus", focus);
  ipc.handle("app-menu:view", (event, state: unknown) => {
    trusted(event);
    if (
      typeof state !== "object" ||
      state === null ||
      !("available" in state) ||
      typeof state.available !== "boolean" ||
      ("configAvailable" in state && typeof state.configAvailable !== "boolean") ||
      ("sidebarCollapsed" in state && typeof state.sidebarCollapsed !== "boolean") ||
      !("maximized" in state) ||
      typeof state.maximized !== "boolean" ||
      !("tiles" in state) ||
      typeof state.tiles !== "number" ||
      !Number.isInteger(state.tiles) ||
      state.tiles < 0 ||
      state.tiles > 256
    )
      throw new Error("Invalid menu view state");
    configAvailable = "configAvailable" in state ? state.configAvailable === true : state.available;
    for (const command of commands) {
      if (command.id.startsWith("via-") && !configAvailable) command.enabled = false;
      if (
        (command.section === "View" && !command.id.startsWith("zoom-")) ||
        command.id === "new-worktree"
      )
        command.enabled = state.available;
      if (command.id.startsWith("tile-"))
        command.enabled = state.available && Number(command.id.slice(5)) <= state.tiles;
      if (command.id === "toggle-sidebar") {
        // Settings occupies the tiles while leaving the sidebar available.
        command.enabled = configAvailable;
        command.label =
          "sidebarCollapsed" in state && state.sidebarCollapsed === true
            ? "Expand sidebar"
            : "Collapse sidebar";
      }
      if (command.id === "maximize") command.checked = state.maximized;
    }
    refresh();
    if (state.available) boardReady();
    return refreshAgents();
  });
  const shortcuts = createShortcuts(commands, process.platform, () => {
    contents.send("app-menu:open");
  });
  const beforeInput = (event: Electron.Event, input: Electron.Input) => {
    if (event.defaultPrevented) return;
    if (shortcuts.handle(input)) event.preventDefault();
  };
  contents.on("before-input-event", beforeInput);
  window.on("blur", shortcuts.reset);
  const trusted = (event: IpcMainInvokeEvent) => {
    if (
      event.sender !== contents ||
      !event.senderFrame ||
      event.senderFrame !== contents.mainFrame ||
      event.senderFrame.url !== "app://bundle/index.html"
    )
      throw new Error("Untrusted app menu sender");
  };
  ipc.handle("app-menu:version", (event) => {
    trusted(event);
    return { app: app.getVersion(), electron: process.versions.electron };
  });
  ipc.handle("app-menu:list", async (event) => {
    trusted(event);
    await refreshAgents();
    return projectAppMenu(commands, await scale());
  });
  ipc.handle("app-menu:shortcuts", (event) => {
    trusted(event);
    return shortcutSheet(commands, process.platform);
  });
  ipc.handle("app-menu:execute", async (event, id: unknown) => {
    trusted(event);
    if (typeof id === "string" && id.startsWith("via-")) await refreshAgents();
    const command = typeof id === "string" && commands.find((command) => command.id === id);
    if (!command || !command.enabled) throw new Error("Unavailable app command");
    // Awaited so the Size row can show the size this step produced.
    await command.run();
  });
  const newWindow = commands.find((command) => command.id === "new-window");
  if (!newWindow) throw new Error("Missing New Window command");
  return {
    newWindow,
    refreshAgents,
    dispose() {
      contents.removeListener("before-input-event", beforeInput);
      window.removeListener("blur", shortcuts.reset);
      disposed = true;
      generation++;
      window.removeListener("focus", focus);
      ipc.removeHandler("app-menu:version");
      ipc.removeHandler("app-menu:view");
      ipc.removeHandler("app-menu:list");
      ipc.removeHandler("app-menu:shortcuts");
      ipc.removeHandler("app-menu:execute");
    },
  };
}

/** Native accelerators remain available when macOS has no board to receive keys. */
export function showWindowlessMenu(openWindow: (about?: boolean | "manual") => void): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Foom",
        submenu: [
          {
            id: "about",
            label: "About Foom",
            click: () => {
              openWindow(true);
            },
          },
          {
            id: "quit",
            label: "Quit Foom",
            accelerator: "Command+Q",
            registerAccelerator: true,
            click: () => {
              app.quit();
            },
          },
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            id: "manual",
            label: "Manual",
            click: () => {
              openWindow("manual");
            },
          },
        ],
      },
      {
        label: "File",
        submenu: [
          {
            id: "new-window",
            label: "New Window",
            accelerator: "Command+N",
            registerAccelerator: true,
            click: () => {
              openWindow();
            },
          },
        ],
      },
    ]),
  );
}
