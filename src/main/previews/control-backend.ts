import type { PreviewBackend } from "../control/previews";
import { ControlError } from "../../node-common/control-validation";
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
