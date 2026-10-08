import type { BrowserWindow } from "electron";
import type { WindowIpc } from "./window-ipc";
import type { TerminalViews } from "./terminal-views";

/** ID-only view capabilities; the router has already validated the window/frame/page. */
export function attachWindowViews(
  window: BrowserWindow,
  ipc: WindowIpc,
  views: TerminalViews,
  deps: {
    knows(id: string): boolean;
    find(id: number): BrowserWindow | undefined;
    detach(id: string): void;
    publish(): void;
    popout(id: string): Promise<unknown>;
  },
): () => void {
  const known = (id: unknown): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= 200 && deps.knows(id);
  ipc.handle("windows:views", (_event, ...args) => {
    if (args.length) throw new Error("Invalid window request");
    return views
      .snapshot()
      .map((view) => ({ ...view, window: view.window === window.id ? 0 : view.window }));
  });
  ipc.handle("windows:select", (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !known(id)) throw new Error("Unknown terminal ID");
    const owner = views.owner(id);
    if (owner !== undefined && owner !== window.id) {
      const target = deps.find(owner);
      if (target) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
        target.webContents.send("app-menu:session", id);
        return false;
      }
    }
    return true;
  });
  ipc.handle("windows:sync", (_event, ...args) => {
    const [ids] = args;
    if (
      args.length !== 1 ||
      !Array.isArray(ids) ||
      ids.length > 256 ||
      !ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 200) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid window views");
    const accepted: string[] = [];
    for (const id of ids) if (known(id) && views.claim(id, window.id)) accepted.push(id);
    for (const view of views.snapshot())
      if (view.window === window.id && !accepted.includes(view.id)) {
        deps.detach(view.id);
        views.release(view.id, window.id);
      }
    deps.publish();
    return accepted;
  });
  ipc.handle("windows:popout", async (_event, ...args) => {
    const [id] = args;
    if (args.length !== 1 || !known(id) || views.owner(id) !== window.id)
      throw new Error("Unknown or foreign terminal view");
    await deps.popout(id);
  });
  return () => {
    views.close(window.id);
    deps.publish();
    for (const channel of ["windows:views", "windows:select", "windows:sync", "windows:popout"])
      ipc.removeHandler(channel);
  };
}
