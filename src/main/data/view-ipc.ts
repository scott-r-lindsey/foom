import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../window/window-ipc";
import { ViewRegistry } from "./view-registry";
import type { ViewReader } from "./view-registry";
import { viewChanges } from "./view-changes";

/** A registry belongs to exactly one registered board main frame. */
export function attachViews(window: BrowserWindow, ipc: WindowIpc, read: ViewReader): () => void {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === contents.mainFrame &&
    event.senderFrame.url === "app://bundle/index.html";
  const registry = new ViewRegistry(viewChanges, read);
  const clear = () => {
    registry.clear();
  };
  const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!inPlace && mainFrame) clear();
  };
  contents.on("destroyed", clear);
  contents.on("render-process-gone", clear);
  contents.on("did-start-navigation", navigate);
  ipc.handle("data:subscribe", (event, ...args) => {
    if (!trusted(event) || args.length !== 1) throw new Error("Invalid view subscription");
    registry.subscribe(args[0], (snapshot) => {
      if (!contents.isDestroyed() && contents.mainFrame.url === "app://bundle/index.html")
        contents.send("data:snapshot", snapshot);
    });
  });
  ipc.handle("data:unsubscribe", (event, ...args) => {
    if (!trusted(event) || args.length !== 1) throw new Error("Invalid view subscription");
    registry.unsubscribe(args[0]);
  });
  ipc.handle("data:ack", (event, ...args) => {
    if (!trusted(event) || args.length !== 3) throw new Error("Invalid view acknowledgement");
    registry.acknowledge(args[0], args[1], args[2]);
  });
  return () => {
    registry.dispose();
    contents.removeListener("destroyed", clear);
    contents.removeListener("render-process-gone", clear);
    contents.removeListener("did-start-navigation", navigate);
    ipc.removeHandler("data:ack");
    ipc.removeHandler("data:subscribe");
    ipc.removeHandler("data:unsubscribe");
  };
}
