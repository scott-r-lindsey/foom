import { app, Menu, dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { createCommands, createShortcuts, nativeMenu, projectCommands } from "./commands";
import type { ZoomDirection } from "./appearance";

/** The bridge accepts command IDs only, from this window's trusted top-level frame. */
export function attachAppMenu(
  window: BrowserWindow,
  zoom: (direction: ZoomDirection) => Promise<void>,
) {
  const contents = window.webContents;
  const native = (id: string) => {
    switch (id) {
      case "quit":
      case "close-window":
        app.quit();
        break;
      case "about":
        app.showAboutPanel();
        break;
      case "licenses":
        void dialog
          .showMessageBox(window, {
            title: "Third-party licenses",
            message: "Foom includes open-source software.",
            detail:
              "Third-party license notices are bundled with Foom. The source repository lists its open-source dependencies and font licenses.",
            buttons: ["OK", "Open source repository"],
          })
          .then(({ response }) => {
            if (response === 1) void shell.openExternal("https://github.com/scott-r-lindsey/foom");
          });
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
  const commands = createCommands(process.platform, !app.isPackaged, {
    native,
    board: (command) => {
      contents.send("board:command", command);
    },
    zoom: (direction) => {
      void zoom(direction).catch((error: unknown) => {
        console.error("Unable to change interface size:", error);
      });
    },
  });
  app.setAboutPanelOptions({
    applicationName: "Foom",
    applicationVersion: app.getVersion(),
    copyright: "Licensed under Apache-2.0",
  });
  const refresh = () => {
    Menu.setApplicationMenu(
      process.platform === "darwin" ? Menu.buildFromTemplate(nativeMenu(commands)) : null,
    );
    if (process.platform !== "darwin") window.removeMenu();
  };
  refresh();
  ipcMain.handle("app-menu:view", (event, state: unknown) => {
    trusted(event);
    if (
      typeof state !== "object" ||
      state === null ||
      !("available" in state) ||
      typeof state.available !== "boolean" ||
      !("maximized" in state) ||
      typeof state.maximized !== "boolean" ||
      !("tiles" in state) ||
      typeof state.tiles !== "number" ||
      !Number.isInteger(state.tiles) ||
      state.tiles < 1 ||
      state.tiles > 256
    )
      throw new Error("Invalid menu view state");
    for (const command of commands) {
      if (
        (command.section === "View" && !command.id.startsWith("zoom-")) ||
        command.id === "new-worktree"
      )
        command.enabled = state.available;
      if (command.id.startsWith("tile-"))
        command.enabled = state.available && Number(command.id.slice(5)) <= state.tiles;
      if (command.id === "maximize") command.checked = state.maximized;
    }
    refresh();
  });
  const shortcuts = createShortcuts(commands, process.platform, () => {
    contents.send("app-menu:open");
  });
  const beforeInput = (event: Electron.Event, input: Electron.Input) => {
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
  ipcMain.handle("app-menu:list", (event) => {
    trusted(event);
    return projectCommands(commands);
  });
  ipcMain.handle("app-menu:execute", (event, id: unknown) => {
    trusted(event);
    const command = typeof id === "string" && commands.find((command) => command.id === id);
    if (!command || !command.enabled) throw new Error("Unavailable app command");
    command.run();
  });
  const newWindow = commands.find((command) => command.id === "new-window");
  if (!newWindow) throw new Error("Missing New Window command");
  return {
    newWindow,
    dispose() {
      contents.removeListener("before-input-event", beforeInput);
      window.removeListener("blur", shortcuts.reset);
      ipcMain.removeHandler("app-menu:view");
      ipcMain.removeHandler("app-menu:list");
      ipcMain.removeHandler("app-menu:execute");
    },
  };
}
