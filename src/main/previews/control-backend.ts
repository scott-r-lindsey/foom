import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { documentPathname, resolveDocument } from "./contained-files";
import { createPartition, previewPreferences } from "./partition";
import type { PreviewBackend } from "../control/previews";
import { ControlError } from "../../shared/control-validation";
import type { PreviewHost } from "./host";
import type { PreviewPlacement } from "./placement";

/** Main selects the opener's board. Registration stays lazy until its tile reports bounds. */
export function previewBackend(
  hosts: ReadonlyMap<
    number,
    Pick<PreviewHost, "open" | "close" | "visible" | "registry" | "placed">
  >,
  placements: ReadonlyMap<number, Pick<PreviewPlacement, "place">>,
  board: (terminalId: string) => number | undefined,
  agent: (terminalId: string) => string = () => "agent",
): PreviewBackend {
  return {
    open: async (actor, preview, sidebar) => {
      const existing = [...hosts.entries()].find(([, host]) =>
        host.registry.records.has(preview.previewId),
      );
      if (existing)
        return sidebar
          ? "sidebar"
          : (placements.get(existing[0])?.place(preview.previewId) ?? "sidebar");
      const windowId = board(actor.terminalId);
      if (windowId === undefined) throw new ControlError("unavailable");
      const host = hosts.get(windowId);
      if (!host) throw new ControlError("unavailable");
      if (host.registry.records.size >= 256) throw new ControlError("capacity");
      await host.open(preview.worktree, preview.path, {
        id: preview.previewId,
        openedBy: { terminalId: actor.terminalId, agent: agent(actor.terminalId) },
      });
      return sidebar
        ? "sidebar"
        : (placements.get(windowId)?.place(preview.previewId) ?? "sidebar");
    },
    close: async (id) => {
      const host = [...hosts.values()].find((host) => host.registry.records.has(id));
      if (host) await host.close(id);
    },
    visible: (id) => [...hosts.values()].some((host) => host.visible(id)),
    has: (id) => [...hosts.values()].some((host) => host.registry.records.has(id)),
  };
}

/** Only this raster leaves the preview partition. The board never embeds active content. */
export function decisionPreview() {
  let active = false;
  return async (root: string, path: string): Promise<string | null> => {
    if (active) return null;
    active = true;
    try {
      const document = await resolveDocument(join(root, path), true);
      if (document.status !== 200 || document.root.path !== (await realpath(root))) return null;
      const id = randomBytes(16).toString("hex");
      const { partition, setDocumentUrl } = createPartition(
        { id, worktree: document.root.path, relativePath: document.relative, network: false },
        document.root,
      );
      let window: BrowserWindow | undefined;
      const deadline = setTimeout(() => window?.destroy(), 5000);
      try {
        window = new BrowserWindow({
          show: false,
          width: 680,
          height: 240,
          useContentSize: true,
          webPreferences: {
            ...previewPreferences(partition),
            offscreen: true,
            javascript: false,
            devTools: false,
          },
        });
        const contents = window.webContents;
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        contents.on("will-frame-navigate", (event) => {
          event.preventDefault();
        });
        contents.on("will-redirect", (event) => {
          event.preventDefault();
        });
        const navigation = { refused: false };
        contents.on("did-navigate", (_event, _url, status) => {
          if (status >= 400) navigation.refused = true;
        });
        const url = `foom-preview://${id}${documentPathname(document.relative)}`;
        setDocumentUrl(url);
        await contents.loadURL(url);
        if (navigation.refused) return null;
        const image = await contents.capturePage();
        if (image.isEmpty()) return null;
        const png = image.toDataURL();
        return png.length <= 2 * 1024 * 1024 ? png : null;
      } finally {
        clearTimeout(deadline);
        if (window && !window.isDestroyed()) window.destroy();
        partition.protocol.unhandle("foom-preview");
      }
    } catch {
      return null;
    } finally {
      active = false;
    }
  };
}
